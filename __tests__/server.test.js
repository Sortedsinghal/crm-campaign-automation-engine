const { normalizeLanguage, app, sendLeadToZoho } = require("../server");
const request = require("supertest");
const axios = require("axios");

jest.mock("axios");

// ─── normalizeLanguage ────────────────────────────────────────────────────────

describe("normalizeLanguage()", () => {
  test("returns English for null input", () => {
    expect(normalizeLanguage(null)).toBe("English");
  });

  test("returns English for empty string", () => {
    expect(normalizeLanguage("")).toBe("English");
  });

  test("returns English for undefined", () => {
    expect(normalizeLanguage(undefined)).toBe("English");
  });

  test("returns English for 'English'", () => {
    expect(normalizeLanguage("English")).toBe("English");
  });

  test("returns English for 'english' (case-insensitive)", () => {
    expect(normalizeLanguage("english")).toBe("English");
  });

  test("returns English for 'EN'", () => {
    expect(normalizeLanguage("EN")).toBe("English");
  });

  test("returns Spanish for 'Spanish'", () => {
    expect(normalizeLanguage("Spanish")).toBe("Spanish");
  });

  test("returns Spanish for 'spanish' (case-insensitive)", () => {
    expect(normalizeLanguage("spanish")).toBe("Spanish");
  });

  test("returns Spanish for 'ES'", () => {
    expect(normalizeLanguage("ES")).toBe("Spanish");
  });

  test("returns Spanish for 'Español'", () => {
    expect(normalizeLanguage("Español")).toBe("Spanish");
  });

  test("defaults to English for unknown values", () => {
    expect(normalizeLanguage("French")).toBe("English");
    expect(normalizeLanguage("mandarin")).toBe("English");
  });
});

// ─── POST /lead ───────────────────────────────────────────────────────────────

describe("POST /lead — input validation", () => {
  test("returns 400 when email is missing", async () => {
    const res = await request(app)
      .post("/lead")
      .send({ name: "Test User" })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Email required");
  });

  test("returns 400 when body is empty", async () => {
    const res = await request(app)
      .post("/lead")
      .send({})
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Email required");
  });

  test("returns 400 when email is null", async () => {
    const res = await request(app)
      .post("/lead")
      .send({ email: null })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Email required");
  });
});

// ─── sendLeadToZoho ───────────────────────────────────────────────────────────

describe("sendLeadToZoho() with report fields", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("includes ActionStepID, Campaign, and Last_Disposition in Zoho payload when present", async () => {
    axios.post.mockResolvedValueOnce({
      data: { access_token: "mock_token" }
    });

    axios.get.mockResolvedValueOnce({
      data: { data: [] }
    });

    axios.post.mockResolvedValueOnce({
      data: { data: [{ status: "success" }] }
    });

    await sendLeadToZoho({
      email: "caller@example.com",
      firstName: "Jane",
      lastName: "Doe",
      language: "Spanish",
      phone: "1234567890",
      actionStepId: "STEP_987",
      campaign: "IB - LFECR",
      lastDisposition: "Transferred"
    });

    const actionStepField = process.env.ACTION_STEP_ID_FIELD || "ActionStepID";
    const campaignField = process.env.CAMPAIGN_FIELD || "Campaign";
    const lastDispField = process.env.LAST_DISPOSITION_FIELD || "Last_Disposition";

    expect(axios.post).toHaveBeenCalledTimes(2);
    const leadCall = axios.post.mock.calls[1];
    expect(leadCall[0]).toContain("/crm/v2/Leads");
    expect(leadCall[1].data[0]).toMatchObject({
      First_Name: "Jane",
      Last_Name: "Doe",
      Email: "caller@example.com",
      Mobile: "1234567890",
      Language: "Spanish",
      [actionStepField]: "STEP_987",
      [campaignField]: "IB - LFECR",
      [lastDispField]: "Transferred"
    });
  });
});
