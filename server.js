const express = require("express");
const axios = require("axios");
const fs = require("fs");
require("dotenv").config();
const soap = require("soap");
const app = express();
const { parse } = require("csv-parse/sync");
app.use(express.json());

const {
    REFRESH_TOKEN,
    CLIENT_ID,
    CLIENT_SECRET,
    API_DOMAIN = "https://www.zohoapis.com",
    LANGUAGE_FIELD = "Language",
    ACTION_STEP_ID_FIELD = "ActionStepID",
    CAMPAIGN_FIELD = "Campaign",
    LAST_DISPOSITION_FIELD = "Last_Disposition",
    FIVE9_USERNAME,
    FIVE9_PASSWORD,
    FIVE9_REPORT_NAME = "All List Details - (ZOHO, ELLIOT - DO NOT USE)",
    FIVE9_FOLDER_NAME
} = process.env;

let ACCESS_TOKEN = null;
let TOKEN_TIME = 0;

const SYNC_FILE = "./sync-state.json";

let lastSyncTime = null;

// =======================
// 🔄 GET ACCESS TOKEN
// =======================
async function getAccessToken() {
    try {
        const res = await axios.post(
            "https://accounts.zoho.com/oauth/v2/token",
            null,
            {
                params: {
                    refresh_token: REFRESH_TOKEN,
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    grant_type: "refresh_token"
                }
            }
        );

        ACCESS_TOKEN = res.data.access_token;
        TOKEN_TIME = Date.now();

        console.log("🔑 Token refreshed");
    } catch (err) {
        console.log("❌ Token Error:", err.response?.data || err.message);
    }
}

// =======================
// 🔄 ENSURE TOKEN VALID
// =======================
async function ensureToken() {
    if (!ACCESS_TOKEN || Date.now() - TOKEN_TIME > 50 * 60 * 1000) {
        await getAccessToken();
    }
}

// =======================
// 🌍 NORMALIZE LANGUAGE
// =======================
function normalizeLanguage(lang) {
    if (!lang) return "English";

    const l = lang.toLowerCase();

    if (l.includes("spanish") || l.includes("es")) return "Spanish";
    if (l.includes("english") || l.includes("en")) return "English";

    return "English";
}

// =======================
// 🚀 WEBHOOK ENDPOINT
// =======================
app.post("/lead", async (req, res) => {
    try {
        const { email, name, language } = req.body;

        if (!email) {
            return res.status(400).json({ error: "Email required" });
        }

        const finalName = name || email.split("@")[0];
        const finalLang = normalizeLanguage(language);

        await ensureToken();

        await axios.post(
            `${API_DOMAIN}/crm/v2/Leads`,
            {
                data: [
                    {
                        Last_Name: finalName,
                        Customer_Name: finalName,
                        Email: email,
                        [LANGUAGE_FIELD]: finalLang
                    }
                ],
                duplicate_check_fields: ["Email"],
                trigger: ["workflow"]
            },
            {
                headers: {
                    Authorization: `Zoho-oauthtoken ${ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );

        res.json({ success: true });

    } catch (err) {
        console.log("❌ API Error:", err.response?.data || err.message);
        res.status(500).json({ error: "Failed" });
    }
});

// =======================
// 🔄 FIVE9 SOAP CONFIG
// =======================
const FIVE9_ENDPOINT = "https://api.five9.com/wsadmin/v2/AdminWebService";

async function getZohoLeadByEmail(email) {
    try {
        await ensureToken();

        const response = await axios.get(
            `${API_DOMAIN}/crm/v2/Leads/search?email=${encodeURIComponent(email)}`,
            {
                headers: {
                    Authorization: `Zoho-oauthtoken ${ACCESS_TOKEN}`
                }
            }
        );

        if (response.data.data && response.data.data.length > 0) {
            return response.data.data[0];
        }

        return null;

    } catch (err) {
        if (err.response && err.response.status === 404) {
            return null;
        }

        console.log(
            "❌ Zoho Search Error:",
            err.response?.data || err.message
        );

        return null;
    }
}

async function leadExistsInZoho(email) {
    const lead = await getZohoLeadByEmail(email);
    return lead !== null;
}

// =======================
// 🚀 SEND TO ZOHO (CREATE OR UPDATE)
// =======================

async function sendLeadToZoho({
    email,
    firstName,
    lastName,
    language,
    phone,
    actionStepId,
    campaign,
    lastDisposition
}) {

    try {

        await ensureToken();

        // =======================
        // 🔍 CHECK EXISTING LEAD
        // =======================
        const existingLead = await getZohoLeadByEmail(email);

        const leadData = {
            First_Name:
                firstName || "",

            Last_Name:
                lastName || firstName || "Unknown",

            Customer_Name:
                `${firstName} ${lastName}`.trim() || "Unknown",

            Email:
                email,

            Mobile:
                phone || "",

            [LANGUAGE_FIELD]:
                language
        };

        if (actionStepId) {
            leadData[ACTION_STEP_ID_FIELD] = actionStepId;
        }
        if (campaign) {
            leadData[CAMPAIGN_FIELD] = campaign;
        }
        if (lastDisposition) {
            leadData[LAST_DISPOSITION_FIELD] = lastDisposition;
        }

        let response;

        if (existingLead && existingLead.id) {
            console.log(
                `🔄 Updating existing Zoho Lead (${existingLead.id}): ${email}`
            );

            response = await axios.put(
                `${API_DOMAIN}/crm/v2/Leads`,
                {
                    data: [
                        {
                            id: existingLead.id,
                            ...leadData
                        }
                    ],
                    trigger: [
                        "workflow"
                    ]
                },
                {
                    headers: {
                        Authorization: `Zoho-oauthtoken ${ACCESS_TOKEN}`,
                        "Content-Type": "application/json"
                    },
                    timeout: 15000
                }
            );

            console.log(
                `✅ Updated existing lead in Zoho: ${email}`
            );

        } else {
            console.log(
                `📤 Creating new lead in Zoho: ${email}`
            );

            response = await axios.post(
                `${API_DOMAIN}/crm/v2/Leads`,
                {
                    data: [
                        {
                            duplicate_check_fields: ["Email"],
                            ...leadData
                        }
                    ],
                    trigger: [
                        "workflow"
                    ]
                },
                {
                    headers: {
                        Authorization: `Zoho-oauthtoken ${ACCESS_TOKEN}`,
                        "Content-Type": "application/json"
                    },
                    timeout: 15000
                }
            );

            console.log(
                `✅ Created new lead in Zoho: ${email}`
            );
        }

        console.log(
            "📥 Zoho Response:",
            JSON.stringify(
                response.data,
                null,
                2
            )
        );

    } catch (err) {

        console.log(
            `❌ Zoho Error for ${email}:`,
            err.response?.data ||
            err.message
        );
    }
}

function loadSyncState() {

    try {

        if (fs.existsSync(SYNC_FILE)) {

            const data =
                JSON.parse(
                    fs.readFileSync(
                        SYNC_FILE,
                        "utf8"
                    )
                );

            lastSyncTime =
                data.lastSyncTime;

            console.log(
                "✅ Loaded checkpoint:",
                lastSyncTime
            );

        } else {

            lastSyncTime =
                new Date(
                    Date.now() - 5 * 60 * 1000
                ).toISOString();

            console.log(
                "🆕 No checkpoint found."
            );

            console.log(
                "Starting fresh:",
                lastSyncTime
            );

            saveSyncState();
        }

    } catch (err) {

        console.log(
            "❌ Failed loading sync state:",
            err.message
        );
    }
}

function saveSyncState() {

    try {

        fs.writeFileSync(

            SYNC_FILE,

            JSON.stringify(
                {
                    lastSyncTime
                },
                null,
                2
            )
        );

        console.log(
            "💾 Saved checkpoint:",
            lastSyncTime
        );

    } catch (err) {

        console.log(
            "❌ Failed to save checkpoint:",
            err.message
        );
    }
}

// =======================
// 🔄 FETCH FIVE9 REPORT
// =======================
async function fetchFive9Report() {
    try {

        console.log("🔐 Using Five9 user:", FIVE9_USERNAME);

        const client = await soap.createClientAsync(
            "./AdminWebService.wsdl"
        );

        client.setSecurity(
            new soap.BasicAuthSecurity(
                FIVE9_USERNAME,
                FIVE9_PASSWORD
            )
        );

        // =======================
        // 🚀 DATE RANGE
        // =======================
        const startTime = lastSyncTime;

        const endTime =
            new Date(
                Date.now() - 5000
            ).toISOString();

        console.log("⏱️ Fetch Window:");
        console.log("START:", startTime);
        console.log("END:", endTime);
        // =======================
        // 🚀 RUN REPORT
        // =======================
        let runResult;

        for (let attempt = 1; attempt <= 3; attempt++) {

            try {

                [runResult] =
                    await client.runReportAsync({

                        folderName:
                            FIVE9_FOLDER_NAME,

                        reportName:
                            FIVE9_REPORT_NAME,

                        criteria: {
                            time: {
                                start: startTime,
                                end: endTime
                            }
                        }
                    });

                break;

            } catch (err) {

                console.log(
                    `⚠️ Five9 runReport retry ${attempt}/3`
                );

                console.log(
                    err.code || err.message
                );

                if (attempt === 3) {
                    throw err;
                }

                await new Promise(
                    (r) => setTimeout(r, 5000)
                );
            }
        }


        console.log("📥 Run Report Response:", runResult);

        const identifier = runResult.return;

        if (!identifier) {
            throw new Error("No report identifier returned");
        }

        console.log("🆔 Report ID:", identifier);

        // =======================
        // ⏳ WAIT FOR REPORT
        // =======================
        let running = true;

        while (running) {

            const [statusResult] =
                await client.isReportRunningAsync({
                    identifier
                });

            running = statusResult.return;

            if (running) {
                console.log("⏳ Waiting for report...");
                await new Promise((r) => setTimeout(r, 2000));
            }
        }

        // =======================
        // 📊 GET REPORT RESULT CSV
        // =======================

        console.log("⏳ Waiting 10s before downloading CSV...");

        await new Promise((r) =>
            setTimeout(r, 10000)
        );

        const [result] =
            await client.getReportResultCsvAsync({
                identifier
            });

        console.log("📥 Report Result:", result);

        const csvData = result.return || "";
        console.log(
            "📄 CSV Length:",
            csvData.length
        );

        const parsed = parse(csvData, {
            columns: true,
            skip_empty_lines: true,
            relax_quotes: true
        });

        console.log(`📊 Parsed CSV rows: ${parsed.length}`);

        const records = [];

        for (const row of parsed) {

            const email =
                (row.email || "").trim();

            if (
                !email ||
                email === "-" ||
                !email.includes("@")
            ) {
                continue;
            }

            const firstName = (row.first_name || "").trim();
            const lastName = (row.last_name || "").trim();
            const phone = (row.number1 || "").trim();

            const language =
                (row.Language || "English").trim();

            const actionStepId =
                (row.ActionStepID || row.actionstepid || row.Action_Step_ID || "").trim();
            const campaign =
                (row.CAMPAIGN || row.campaign || row.Campaign || "").trim();
            const lastDisposition =
                (row["Last Disposition"] || row["LAST DISPOSITION"] || row.DISPOSITION || row.disposition || "").trim();

            console.log(
                `✅ Found lead: ${email} | ${firstName} ${lastName} | ${phone} | ${language} | ActionStepID: ${actionStepId} | Campaign: ${campaign} | Last Disposition: ${lastDisposition}`
            );

            // =======================
            // 🚀 SEND TO ZOHO
            // =======================
            await sendLeadToZoho({
                email,
                firstName,
                lastName,
                language,
                phone,
                actionStepId,
                campaign,
                lastDisposition
            });

            records.push({
                email,
                firstName,
                lastName,
                phone,
                language,
                actionStepId,
                campaign,
                lastDisposition
            });
        }

        console.log(
            `✅ Valid lead rows: ${records.length}`
        );

        lastSyncTime = endTime;
        saveSyncState();
        console.log(
            "✅ Updated sync checkpoint:",
            lastSyncTime
        );

        if (records.length === 0) {

            console.log(
                "⚠️ No rows returned"
            );
        }

        return records;




    } catch (err) {

        console.log(
            "❌ Five9 Error:",
            err
        );

        return [];
    }
}
// =======================
// 🔁 SCHEDULING LOGIC
// =======================
let isPolling = false;

async function runSyncCycle() {
    if (isPolling) {
        console.log("⚠️ Previous polling still running");
        return;
    }

    isPolling = true;

    try {
        console.log("🔄 Running scheduled Five9 sync...");
        const records = await fetchFive9Report();

        if (records.length > 0) {
            console.log(`✅ ${records.length} leads synced`);
        } else {
            console.log("ℹ️ No records");
        }

    } catch (err) {
        console.log("❌ Polling Error:", err.message);

    } finally {
        isPolling = false;
    }
}

function scheduleNextRun() {
    const pollMinutes = process.env.POLL_INTERVAL_MINUTES;

    if (pollMinutes && !isNaN(parseInt(pollMinutes, 10))) {
        const ms = parseInt(pollMinutes, 10) * 60 * 1000;
        console.log(`⏱️ Scheduled next poll in ${pollMinutes} minutes`);
        setTimeout(async () => {
            await runSyncCycle();
            scheduleNextRun();
        }, ms);
        return;
    }

    const targetHourPST = parseInt(process.env.SCHEDULE_HOUR_PST || "21", 10);
    const targetMinPST  = parseInt(process.env.SCHEDULE_MIN_PST || "5", 10);

    const now = new Date();
    const pstString = now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
    const pstDate = new Date(pstString);

    const nextRunPST = new Date(pstDate);
    nextRunPST.setHours(targetHourPST, targetMinPST, 0, 0);

    if (pstDate >= nextRunPST) {
        nextRunPST.setDate(nextRunPST.getDate() + 1);
    }

    const msUntilNextRun = nextRunPST.getTime() - pstDate.getTime();
    const hoursUntil = (msUntilNextRun / (1000 * 60 * 60)).toFixed(2);

    console.log(`📅 Scheduled next daily sync at 9:05 PM PST (in ~${hoursUntil} hours)`);

    setTimeout(async () => {
        await runSyncCycle();
        scheduleNextRun();
    }, msUntilNextRun);
}

// =======================
// 🚀 START SERVER
// =======================
const PORT = process.env.PORT || 8080;

if (require.main === module) {
    loadSyncState();
    app.listen(PORT, "0.0.0.0", () => {
        console.log(`🚀 API running on port ${PORT}`);
        scheduleNextRun();
    });
}

module.exports = { app, normalizeLanguage, sendLeadToZoho, runSyncCycle };