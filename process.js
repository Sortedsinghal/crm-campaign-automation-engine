const fs = require("fs");
const axios = require("axios");
const csv = require("csv-parser");

// 🔐 YOUR CREDENTIALS
require("dotenv").config();

const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const API_DOMAIN = process.env.API_DOMAIN || "https://www.zohoapis.com";
const LANGUAGE_FIELD = process.env.LANGUAGE_FIELD || "Language";
const CUSTOMER_NAME_FIELD = "Customer_Name";
const ACTION_STEP_ID_FIELD = process.env.ACTION_STEP_ID_FIELD || "ActionStepID";
const CAMPAIGN_FIELD = process.env.CAMPAIGN_FIELD || "Campaign";
const LAST_DISPOSITION_FIELD = process.env.LAST_DISPOSITION_FIELD || "Last_Disposition";

// 🔄 Normalize Language
function normalizeLanguage(lang) {
  if (!lang) return "English";

  const l = lang.toLowerCase();

  if (l.includes("spanish") || l.includes("es") || l.includes("español")) {
    return "Spanish";
  }

  if (l.includes("english") || l.includes("en")) {
    return "English";
  }

  return "English";
}

// 🔄 Get Access Token
async function getAccessToken() {
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

  console.log("🔑 Access token generated");
  return res.data.access_token;
}

// 🚀 Send to Zoho CRM
async function sendToCRM(row, ACCESS_TOKEN) {
  const email = (row["email"] || "").trim();

  const rawName = (row["CUSTOMER NAME"] || "").trim();
  const name = rawName || email.split("@")[0];

  const rawLang =
    row["Language"] ||
    row["LANGUAGE"] ||
    row["language"] ||
    "English";

  const language = normalizeLanguage(rawLang);

  const actionStepId =
    (row["ActionStepID"] || row["actionstepid"] || row["Action_Step_ID"] || "").trim();
  const campaign =
    (row["CAMPAIGN"] || row["campaign"] || row["Campaign"] || "").trim();
  const lastDisposition =
    (row["Last Disposition"] || row["LAST DISPOSITION"] || row["DISPOSITION"] || row["disposition"] || "").trim();

  if (!email) {
    console.log("⚠️ Skipping (no email)");
    return;
  }

  console.log(`➡️ ${email} | ${language} | ActionStepID: ${actionStepId} | Campaign: ${campaign} | Last Disposition: ${lastDisposition}`);

  try {
    const leadData = {
      Last_Name: name,                       // Required field
      [CUSTOMER_NAME_FIELD]: name,           // ✅ Full name stored here
      Email: email,
      [LANGUAGE_FIELD]: language
    };

    if (actionStepId) leadData[ACTION_STEP_ID_FIELD] = actionStepId;
    if (campaign) leadData[CAMPAIGN_FIELD] = campaign;
    if (lastDisposition) leadData[LAST_DISPOSITION_FIELD] = lastDisposition;

    await axios.post(
      `${API_DOMAIN}/crm/v2/Leads`,
      {
        data: [leadData],
        duplicate_check_fields: ["Email"],        // Prevent duplicates
        trigger: ["workflow"]                     // Trigger Zoho workflows
      },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log(`✅ Added: ${email}`);

  } catch (err) {
    const error = err.response?.data;

    if (error?.data?.[0]?.code === "DUPLICATE_DATA") {
      console.log(`⚠️ Duplicate skipped: ${email}`);
    }
    else if (error?.data?.[0]?.code === "INVALID_DATA") {
      console.log(`❌ Field issue (check API names): ${email}`);
    }
    else {
      console.log(`❌ Error for ${email}:`, error || err.message);
    }
  }
}

// 🚀 MAIN PROCESS
async function processCSV() {
  const rows = [];

  fs.createReadStream("input.csv")
    .pipe(csv())
    .on("data", (data) => rows.push(data))
    .on("end", async () => {
      console.log(`📊 Total rows: ${rows.length}`);

      let ACCESS_TOKEN = await getAccessToken();
      let tokenTime = Date.now();

      for (const row of rows) {
        try {
          // 🔄 Refresh token every 50 minutes
          if (Date.now() - tokenTime > 50 * 60 * 1000) {
            ACCESS_TOKEN = await getAccessToken();
            tokenTime = Date.now();
            console.log("🔄 Token refreshed");
          }

          await sendToCRM(row, ACCESS_TOKEN);

          // ⏱️ Safe delay (avoid rate limit)
          await new Promise((r) => setTimeout(r, 80));

        } catch (err) {
          console.log("❌ Unexpected Error:", err.message);
        }
      }

      console.log("🚀 DONE — CRM sync complete");
    });
}

// ▶️ RUN
processCSV();