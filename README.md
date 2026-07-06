# crm-campaign-automation-engine

A Node.js service that polls Five9 (cloud contact center) for call log data every 2 minutes via SOAP, creates leads in Zoho CRM, and triggers a Zoho Campaigns automation that sends a follow-up email in the lead's language (English or Spanish).

The service runs continuously on an EC2 instance and processes inbound call leads around the clock for a live company.

---

## Table of Contents

- [System Overview](#system-overview)
- [Architecture](#architecture)
- [Architectural Decisions](#architectural-decisions)
- [Security](#security)
- [Testing](#testing)
- [CI/CD](#cicd)
- [Project Structure](#project-structure)
- [Environment Variables](#environment-variables)
- [Local Development](#local-development)
- [Deployment (AWS EC2)](#deployment-aws-ec2)
- [API Endpoints](#api-endpoints)
- [Sync State & Checkpointing](#sync-state--checkpointing)
- [Integration Details](#integration-details)
  - [Five9 SOAP API](#five9-soap-api)
  - [Zoho CRM OAuth 2.0](#zoho-crm-oauth-20)
  - [Zoho Campaigns Automation](#zoho-campaigns-automation)
- [Metrics](#metrics)
- [Troubleshooting](#troubleshooting)

---

## System Overview

```
Five9 (call logs, polled every 2 min via SOAP)
  → Node.js service parses CSV, deduplicates by email
  → Zoho CRM lead created (REST API, OAuth 2.0)
  → Zoho Campaigns: contact added to Five9 List
  → Campaigns automation evaluates Language field
  → Email sent: English or Spanish template
```

---

## Architecture

```
┌─────────────────┐        SOAP / WSDL        ┌──────────────────────┐
│                 │ ────────────────────────▶  │                      │
│   Five9 Cloud   │   runReport (every 2 min)  │   Node.js Service    │
│  Contact Center │ ◀────────────────────────  │   (Express + SOAP)   │
│                 │      CSV Report Data        │                      │
└─────────────────┘                            └──────────┬───────────┘
                                                          │
                                               REST API / OAuth 2.0
                                                          │
                                                          ▼
                                               ┌──────────────────────┐
                                               │      Zoho CRM        │  ── syncs ──▶
                                               │   (Leads Module)     │
                                               └──────────────────────┘
                                                                       │
                                                                       ▼
                                                        ┌──────────────────────────┐
                                                        │      Zoho Campaigns      │
                                                        │   "Five9 List" contact   │
                                                        └────────────┬─────────────┘
                                                                     │ On List Entry
                                                                     ▼
                                                        ┌────────────────────────────┐
                                                        │   Language Condition       │
                                                        └──────┬─────────────┬───────┘
                                                          False │             │ True
                                                               ▼             ▼
                                                        English Email   Spanish Email
```

---

## Architectural Decisions

### Polling instead of webhooks
Five9's Admin API does not support outbound webhooks for call events. The only supported method for extracting call log data programmatically is polling via SOAP `runReportAsync`. The interval is set to 2 minutes as a balance between latency and API load.

### Local WSDL file
The `AdminWebService.wsdl` is stored as a local file rather than fetched at runtime. Fetching it on startup would add a network dependency that could delay or break startup if Five9's WSDL endpoint is slow or unavailable. The file is stable and does not change between deployments.

### Application-level deduplication
Before every Zoho CRM write, the service calls `GET /crm/v2/Leads/search?email=...`. If a matching record exists, the write is skipped. This is done in addition to Zoho's native duplicate rules because Zoho's dedup behavior is not consistent across all API patterns, particularly when `trigger: ["workflow"]` is set.

### Checkpoint file for sync state
`sync-state.json` is written to disk after every successful poll cycle. If the process crashes or is restarted, it resumes from the saved timestamp rather than re-processing the full backlog or defaulting to the current time. On EC2 with PM2, this file survives restarts and `git pull` updates.

### Token refresh at 50 minutes
Zoho access tokens expire after 60 minutes. The service refreshes at 50 minutes to maintain a buffer against clock drift, slow poll cycles, or delayed HTTP responses. This prevents mid-poll token expiry.

### `isPolling` guard flag
A boolean flag prevents a second poll from starting while the previous one is still running. Five9 report generation plus CSV download can exceed 2 minutes under load. Without this guard, overlapping polls would create race conditions on `lastSyncTime` and risk writing duplicate leads.

### Language normalization at sync time
The `Language` field in Five9 CSV output can appear in inconsistent formats (`"ES"`, `"español"`, `"Spanish"`, `"en-US"`, etc.). The service normalizes this to exactly `"English"` or `"Spanish"` before writing to Zoho CRM. This is required because the Zoho Campaigns Simple Condition node performs an exact string match — any variation would route leads to the wrong branch.

---

## Security

### Secret Management

- All credentials (Zoho OAuth tokens, Five9 username and password, API domain, field names) are loaded from a `.env` file at runtime using `dotenv`.
- `.env` is excluded from version control via `.gitignore`. It is uploaded to the EC2 instance manually via `scp` and never passes through git.
- `.env.example` is committed with placeholder values only. It documents the required variables without exposing real secrets.
- No credentials are hardcoded anywhere in the source files.

### OAuth 2.0 (Zoho CRM)

- The service authenticates with Zoho CRM using the OAuth 2.0 refresh token flow. No Zoho account password is stored or transmitted.
- The access token is short-lived (1 hour) and refreshed automatically every 50 minutes.
- Token values are never written to logs. Only the status (`"Token refreshed"`) is logged.

### Input Validation — `POST /lead`

- The `/lead` webhook validates that an `email` field is present and non-null in the request body before making any external API call.
- Requests missing `email` return `400 Bad Request` immediately.

**Not currently implemented:**
- Email format validation (RFC 5322 regex)
- Request authentication (API key or HMAC signature on the webhook)
- Rate limiting on the `/lead` endpoint

### Data Filtering (Polling Path)

Rows from the Five9 CSV are filtered before any Zoho write:
- Rows with an empty `email` field are skipped
- Rows where `email === "-"` are skipped
- Rows without `"@"` in the email value are skipped

### Transport Security

All external API calls use HTTPS:
- Five9 SOAP endpoint: `https://api.five9.com/wsadmin/v2/AdminWebService`
- Zoho OAuth: `https://accounts.zoho.com/oauth/v2/token`
- Zoho CRM API: `https://www.zohoapis.com/crm/v2/...`

---

## Testing

Tests are written with **Jest** and **Supertest**. Run with:

```bash
npm test
```

### Unit Tests — `normalizeLanguage()`

Tests the language normalization function across all input variants:

| Input | Expected Output |
|-------|----------------|
| `null` | `"English"` |
| `""` (empty string) | `"English"` |
| `undefined` | `"English"` |
| `"English"` | `"English"` |
| `"english"` (lowercase) | `"English"` |
| `"EN"` | `"English"` |
| `"Spanish"` | `"Spanish"` |
| `"spanish"` (lowercase) | `"Spanish"` |
| `"ES"` | `"Spanish"` |
| `"Español"` | `"Spanish"` |
| `"French"`, `"mandarin"` | `"English"` (default) |

### API Tests — `POST /lead`

Integration tests using Supertest against the Express app (no real Zoho API calls are made — the request fails at the validation layer before any external call):

| Scenario | Expected Status | Expected Body |
|----------|----------------|---------------|
| Missing `email` field | `400` | `{ "error": "Email required" }` |
| Empty request body `{}` | `400` | `{ "error": "Email required" }` |
| `email: null` | `400` | `{ "error": "Email required" }` |

### Known Gaps

- The Five9 SOAP polling flow (`fetchFive9Report`) requires a live Five9 account and WSDL. It is not unit tested. Testing it would require mocking the `soap` client.
- `sendLeadToZoho` and `leadExistsInZoho` require a live Zoho token. Integration tests for these would need mocked `axios` responses.
- `loadSyncState` / `saveSyncState` are not currently covered. They could be tested with a temporary file path.

---

## CI/CD

A GitHub Actions workflow runs on every push and pull request to `main`.

**File:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml)

```
Trigger: push or PR to main
  │
  ├─ Checkout repository (actions/checkout@v4)
  ├─ Set up Node.js 20 with npm cache (actions/setup-node@v4)
  ├─ npm ci            ← clean install from package-lock.json
  ├─ npm run lint      ← ESLint across all .js files
  └─ npm test          ← Jest test suite
```

The workflow does not deploy. Deployment to EC2 is done manually (see [Deployment](#deployment-aws-ec2)).

ESLint is configured in `.eslintrc.json` and enforces: no `var`, prefer `const`, strict equality (`===`).

---

## Project Structure

```
crm-campaign-automation-engine/
├── server.js                 # Main service: polling loop + Express webhook endpoint
├── process.js                # One-shot bulk CSV import script (used for backfilling)
├── sync-state.json           # Persistent sync checkpoint (last polled timestamp)
├── AdminWebService.wsdl      # Five9 SOAP WSDL — excluded from repo, place in root
├── __tests__/
│   └── server.test.js        # Jest: normalizeLanguage() unit tests + /lead API tests
├── .github/
│   └── workflows/
│       └── ci.yml            # GitHub Actions: install → lint → test
├── .eslintrc.json            # ESLint rules
├── package.json
├── package-lock.json
├── .env                      # Runtime secrets — not committed
├── .env.example              # Required variable names with placeholder values
└── .gitignore
```

> `AdminWebService.wsdl` is required at runtime (~962 KB). It is excluded from the repo. Download it from your Five9 admin account and place it in the project root.

---

## Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `REFRESH_TOKEN` | Zoho OAuth 2.0 refresh token |
| `CLIENT_ID` | Zoho API client ID |
| `CLIENT_SECRET` | Zoho API client secret |
| `API_DOMAIN` | Zoho API base URL — `https://www.zohoapis.com` |
| `LANGUAGE_FIELD` | Zoho CRM API name of the Language field |
| `FIVE9_USERNAME` | Five9 admin/API username |
| `FIVE9_PASSWORD` | Five9 account password |
| `FIVE9_REPORT_NAME` | Report name in Five9, must match exactly (case-sensitive) |
| `FIVE9_FOLDER_NAME` | Five9 folder containing the report |
| `PORT` | HTTP port, defaults to `8080` |

### Getting a Zoho Refresh Token

1. Go to [Zoho API Console](https://api-console.zoho.com/) → create a **Server-based Application**
2. Add scope: `ZohoCRM.modules.leads.ALL`
3. Use **Self Client** to generate a grant code, then exchange it:

```bash
curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "code=YOUR_GRANT_CODE" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "redirect_uri=https://www.zohoapis.com" \
  -d "grant_type=authorization_code"
```

The `refresh_token` value in the response goes into `.env`.

---

## Local Development

**Prerequisites:** Node.js v18+, `AdminWebService.wsdl` in the project root.

```bash
npm install
npm start
```

---

## Deployment (AWS EC2)

The service runs as a persistent process managed by PM2 on a `t3.micro` EC2 instance (Amazon Linux 2023, Node.js 20 via nvm).

**Setup (high level):**
1. Launch EC2 with port `8080` open in the security group
2. Install Node.js via nvm, clone the repo
3. Copy `AdminWebService.wsdl` and `.env` to the server via `scp` — these are not in the repo
4. `npm install`
5. `pm2 start server.js --name crm-campaign-automation-engine`
6. `pm2 save && pm2 startup`

**Updating:**

```bash
cd ~/crm-campaign-automation-engine
git pull origin main
pm2 restart crm-campaign-automation-engine
```

`sync-state.json` is written to the local filesystem and is not affected by `git pull`. The checkpoint persists across deployments.

---

## API Endpoints

### `POST /lead`

Creates a lead in Zoho CRM directly. The lead then flows through Zoho Campaigns and triggers the same language-based email automation as leads created by the polling loop.

**Request body:**
```json
{
  "email": "caller@example.com",
  "name": "Alex Rivera",
  "language": "Spanish"
}
```

| Status | Body | Condition |
|--------|------|-----------|
| `200` | `{ "success": true }` | Lead created |
| `400` | `{ "error": "Email required" }` | `email` missing or null |
| `500` | `{ "error": "Failed" }` | Zoho API error |

---

## Sync State & Checkpointing

`sync-state.json` stores the end timestamp of the last successfully completed poll:

```json
{
  "lastSyncTime": "2026-06-10T20:41:00.000Z"
}
```

- On startup: read from file, used as the start of the next Five9 report window
- After each poll: updated to the end time of the window just processed
- If missing: defaults to 5 minutes ago and creates the file

**Manual reset** (re-sync from a specific point):
```bash
echo '{"lastSyncTime":"2026-07-01T00:00:00.000Z"}' > sync-state.json
pm2 restart crm-campaign-automation-engine
```

---

## Integration Details

### Five9 SOAP API

| Setting | Value |
|---------|-------|
| Protocol | SOAP (`soap` npm package) |
| Auth | HTTP Basic Auth |
| WSDL | Local file: `AdminWebService.wsdl` |
| Endpoint | `https://api.five9.com/wsadmin/v2/AdminWebService` |

**Report execution sequence:**

| Step | Method | Description |
|------|--------|-------------|
| 1 | `runReportAsync` | Submits report for window `[lastSyncTime, now]`; returns `identifier` |
| 2 | `isReportRunningAsync` | Polls until generation is complete |
| 3 | 10s wait | Buffer before download |
| 4 | `getReportResultCsvAsync` | Downloads CSV result |

`runReport` retries up to 3 times with 5-second delays on network error.

**CSV fields used:**

| CSV Column | Zoho CRM Field |
|------------|---------------|
| `email` | `Email` |
| `first_name` | `First_Name` |
| `last_name` | `Last_Name` |
| `number1` | `Mobile` |
| `Language` | Custom language field (normalized) |

---

### Zoho CRM OAuth 2.0

| Setting | Value |
|---------|-------|
| Flow | Refresh token |
| Token endpoint | `https://accounts.zoho.com/oauth/v2/token` |
| Token lifetime | 60 minutes |
| Refresh trigger | Token age > 50 minutes |

Dedup check before every write: `GET /crm/v2/Leads/search?email=...`. If a record is found, the write is skipped.

**Fields written on lead creation:**

| Zoho API Field | Source |
|---------------|--------|
| `First_Name` | Five9 `first_name` |
| `Last_Name` | Five9 `last_name` |
| `Customer_Name` | Concatenated full name |
| `Email` | Five9 `email` |
| `Mobile` | Five9 `number1` |
| `Language` | Normalized: `"English"` or `"Spanish"` |

`trigger: ["workflow"]` is set on every write.

---

### Zoho Campaigns Automation

Workflow: **Day 0 - Outbound Campaign** (active since July 2, 2026)

| Setting | Value |
|---------|-------|
| Trigger | On List Entry — Five9 List |
| Condition | Simple Condition on `Language` field |
| Branch True | Send Spanish Template |
| Branch False | Send English Template |

```
[ON LIST ENTRY — Five9 List]
         │
         ▼
 [Simple Condition: Language = Spanish?]
    ┌────┴──────┐
  False        True
    │            │
    ▼            ▼
[English     [Spanish
 Template]    Template]
```

The condition evaluates reliably because `Language` is always normalized to exactly `"English"` or `"Spanish"` before the lead is written to Zoho CRM.

---

## Metrics

Production data as of early July 2026 (system has been live since July 2, 2026):

| Metric | Before | After |
|--------|--------|-------|
| Time from call end to CRM entry | 4–8 hours (manual CSV export + entry) | ~2 minutes (automated polling) |
| Time from call end to follow-up email | 1–2 days | ~3–5 minutes |
| Manual CRM entry per lead | Required | Eliminated |
| Leads receiving correct language email | 0% | 100% |
| Duplicate lead prevention | None | Enforced at application layer before every write |
| Leads processed (as of July 2026) | — | 178+, continuously growing |

---

## Troubleshooting

**Token refresh fails**
- Verify `REFRESH_TOKEN`, `CLIENT_ID`, `CLIENT_SECRET` in `.env`
- Confirm the Zoho OAuth app has `ZohoCRM.modules.leads.ALL` scope
- Refresh tokens expire after ~60 days of inactivity

**`No report identifier returned` from Five9**
- `FIVE9_REPORT_NAME` must match the report name exactly (case-sensitive, including spaces)
- Verify `FIVE9_FOLDER_NAME`
- Confirm the Five9 API user has permission to run that report

**WSDL / SOAP errors**
- Confirm `AdminWebService.wsdl` is in the project root
- Check Five9 credentials and account status

**Duplicate leads in Zoho**
- Application-level dedup is keyed on `email` — ensure Five9 CSV rows contain valid email values
- Check Zoho's native duplicate-handling settings

**Logs on EC2**

```bash
pm2 logs crm-campaign-automation-engine
pm2 logs crm-campaign-automation-engine --lines 200
```
