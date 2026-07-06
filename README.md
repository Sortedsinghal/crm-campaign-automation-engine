# Five9 → Zoho CRM Sync Service

A Node.js background service that automatically syncs call log data from **Five9** (cloud contact center) into **Zoho CRM** as leads. It polls Five9 every 2 minutes via SOAP API, extracts caller information, deduplicates against existing records, and creates new leads in Zoho CRM — with persistent checkpointing so no records are missed across restarts.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [How It Works](#how-it-works)
- [Project Structure](#project-structure)
- [Environment Variables](#environment-variables)
- [Local Development](#local-development)
- [Deployment (AWS EC2)](#deployment-aws-ec2)
- [API Endpoints](#api-endpoints)
- [Sync State & Checkpointing](#sync-state--checkpointing)
- [Integration Details](#integration-details)
  - [Five9 SOAP API](#five9-soap-api)
  - [Zoho CRM OAuth 2.0](#zoho-crm-oauth-20)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

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
                                               │                      │
                                               │      Zoho CRM        │
                                               │   (Leads Module)     │
                                               │                      │
                                               └──────────────────────┘
```

---

## How It Works

The service runs two things in parallel:

### 1. Automated Polling Loop (`server.js`)

On startup, the service reads `sync-state.json` to find the last time it successfully synced. It then runs a polling loop every **2 minutes**:

```
loadSyncState()           ← read lastSyncTime from sync-state.json
setInterval(2 min)
  └─▶ fetchFive9Report()
        ├─▶ Connect to Five9 via SOAP (AdminWebService.wsdl)
        ├─▶ Run report for the time window [lastSyncTime → now]
        ├─▶ Wait for report to finish generating
        ├─▶ Download CSV result
        ├─▶ Parse each row (email, name, phone, language)
        └─▶ For each valid row:
              ├─▶ Check if lead already exists in Zoho (by email)
              └─▶ If new → create lead in Zoho CRM
  └─▶ saveSyncState()     ← update lastSyncTime checkpoint
```

### 2. Webhook Endpoint (`POST /lead`)

An Express HTTP endpoint that lets external systems (e.g. Zoho Flow, Zapier) push a lead directly into Zoho CRM on demand — bypassing the Five9 report flow entirely.

### 3. Bulk CSV Import (`process.js`)

A standalone one-time script to bulk-import historical call data from a local `input.csv` file into Zoho CRM. Used for backfilling records; not part of the main service.

---

## Project Structure

```
five9-zoho-sync/
├── server.js            # Main service — polling loop + Express webhook
├── process.js           # One-shot bulk CSV import script
├── sync-state.json      # Persistent checkpoint (last synced timestamp)
├── AdminWebService.wsdl # Five9 SOAP WSDL (excluded from repo — see note below)
├── package.json         # NPM dependencies
├── package-lock.json    # Locked dependency versions
├── .env                 # Local secrets (never committed)
├── .env.example         # Template showing required environment variables
└── .gitignore
```

> **Note on WSDL:** `AdminWebService.wsdl` is required at runtime but is not included in this repo (962 KB). You must download it from your Five9 admin account or developer portal and place it in the project root before starting the service.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `REFRESH_TOKEN` | Zoho OAuth 2.0 refresh token |
| `CLIENT_ID` | Zoho API client ID |
| `CLIENT_SECRET` | Zoho API client secret |
| `API_DOMAIN` | Zoho API base URL (e.g. `https://www.zohoapis.com`) |
| `LANGUAGE_FIELD` | Zoho CRM API name for the Language field (e.g. `Language`) |
| `FIVE9_USERNAME` | Five9 admin/API username |
| `FIVE9_PASSWORD` | Five9 account password |
| `FIVE9_REPORT_NAME` | Exact name of the report in Five9 (case-sensitive) |
| `FIVE9_FOLDER_NAME` | Five9 folder containing the report (e.g. `Shared Reports`) |
| `PORT` | HTTP server port — defaults to `8080` |

### Getting Zoho OAuth Credentials

1. Go to [Zoho API Console](https://api-console.zoho.com/) and create a **Server-based Application**
2. Add the scope: `ZohoCRM.modules.leads.ALL`
3. Use **Self Client** to generate a grant code, then exchange it for a refresh token:

```bash
curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "code=YOUR_GRANT_CODE" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "redirect_uri=https://www.zohoapis.com" \
  -d "grant_type=authorization_code"
```

The `refresh_token` from the response goes into `.env`.

---

## Local Development

**Prerequisites:** Node.js v18+, `AdminWebService.wsdl` in the project root.

```bash
# Install dependencies
npm install

# Start the service
npm start
```

On startup you'll see:

```
✅ Loaded checkpoint: 2026-06-10T20:41:00.000Z
🚀 API running on port 8080
🔄 Fetching Five9...
⏱️ Fetch Window:
START: 2026-06-10T20:41:00.000Z
END:   2026-06-10T20:43:00.000Z
```

### Bulk Backfill

To import historical data from a CSV export:

```bash
# Place your exported CSV as input.csv in the project root
node process.js
```

Required CSV columns: `email`, `CUSTOMER NAME`, `Language`.

---

## Deployment (AWS EC2)

The service runs as a persistent Node.js process on an EC2 instance. The recommended setup is:

- **Instance:** `t3.micro` (free tier eligible, sufficient for this workload)
- **OS:** Amazon Linux 2023 or Ubuntu 22.04 LTS
- **Runtime:** Node.js 20 via `nvm`
- **Process manager:** PM2 — keeps the service alive across SSH disconnects and reboots
- **Port:** The service listens on `0.0.0.0:8080`; optionally front it with Nginx on port 80

### Key deployment steps (high level):

1. Launch EC2 instance with port `8080` open in the security group
2. SSH in, install Node.js and git, clone this repo
3. Upload `AdminWebService.wsdl` and `.env` to the server (these are not in the repo)
4. Run `npm install` and start with PM2: `pm2 start server.js --name five9-zoho-sync`
5. Run `pm2 save` + `pm2 startup` so the service restarts on reboot

### Updating

```bash
cd ~/five9-zoho-sync
git pull origin main
pm2 restart five9-zoho-sync
```

> `sync-state.json` is written locally to disk — it persists between restarts and `git pull` updates on EC2. No checkpoint data is lost during normal deployments.

---

## API Endpoints

### `POST /lead`

Push a single lead directly into Zoho CRM.

**Request Body:**
```json
{
  "email": "caller@example.com",
  "name": "Alex Rivera",
  "language": "Spanish"
}
```

**Success Response:**
```json
{ "success": true }
```

**Error Response (missing email):**
```json
{ "error": "Email required" }
```

**Example:**
```bash
curl -X POST http://YOUR_SERVER:8080/lead \
  -H "Content-Type: application/json" \
  -d '{"email":"caller@example.com","name":"Alex Rivera","language":"Spanish"}'
```

---

## Sync State & Checkpointing

The service tracks its position in time using `sync-state.json`:

```json
{
  "lastSyncTime": "2026-06-10T20:41:00.000Z"
}
```

- **On startup** — reads this file and resumes from the stored timestamp
- **After each poll** — updates the timestamp to the end of the fetched window
- **If file is missing** — defaults to syncing the last 5 minutes and creates the file

### Manual Reset

To force a re-sync from a specific point in time:

```bash
echo '{"lastSyncTime":"2026-07-01T00:00:00.000Z"}' > sync-state.json
pm2 restart five9-zoho-sync
```

---

## Integration Details

### Five9 SOAP API

| Setting | Value |
|---------|-------|
| Protocol | SOAP via `soap` npm package |
| Auth | HTTP Basic Auth (username + password) |
| WSDL | Local file: `AdminWebService.wsdl` |
| Endpoint | `https://api.five9.com/wsadmin/v2/AdminWebService` |

**Report execution flow:**

| Step | SOAP Method | What it does |
|------|------------|--------------|
| 1 | `runReportAsync` | Submits the report for a given time window; returns a report `identifier` |
| 2 | `isReportRunningAsync` | Polls until Five9 finishes generating the report |
| 3 | `getReportResultCsvAsync` | Downloads the final CSV output |

**CSV fields extracted:**

| CSV Column | Maps to Zoho Field |
|------------|-------------------|
| `email` | `Email` |
| `first_name` | `First_Name` |
| `last_name` | `Last_Name` |
| `number1` | `Mobile` |
| `Language` | Custom language field |

Rows without a valid email (empty, `-`, or no `@`) are automatically skipped.
`runReport` retries up to **3 times** with 5-second delays on network failure.

---

### Zoho CRM OAuth 2.0

| Setting | Value |
|---------|-------|
| Flow | Refresh Token (no user interaction at runtime) |
| Token URL | `https://accounts.zoho.com/oauth/v2/token` |
| Token lifetime | 1 hour |
| Auto-refresh | Triggered when token age > 50 minutes |

**Duplicate prevention:** Before creating any lead, the service calls `GET /crm/v2/Leads/search?email=...`. If a record already exists, the lead is skipped.

**Zoho fields written on lead creation:**

| Zoho API Field | Source |
|---------------|--------|
| `First_Name` | Five9 `first_name` |
| `Last_Name` | Five9 `last_name` |
| `Customer_Name` | Concatenated full name |
| `Email` | Five9 `email` |
| `Mobile` | Five9 `number1` |
| `Language` | Normalized to `"English"` or `"Spanish"` |

`trigger: ["workflow"]` is included on every lead creation call so Zoho automation rules fire normally.

---

## Troubleshooting

**Token refresh fails on startup**
- Double-check `REFRESH_TOKEN`, `CLIENT_ID`, and `CLIENT_SECRET` in `.env`
- Confirm the Zoho OAuth app has the `ZohoCRM.modules.leads.ALL` scope
- Refresh tokens expire after ~60 days of inactivity — regenerate one via the API Console

**`No report identifier returned` from Five9**
- `FIVE9_REPORT_NAME` must match the report name in Five9 exactly (case-sensitive, spaces included)
- Verify `FIVE9_FOLDER_NAME` is correct
- Ensure the Five9 API user account has permission to run that report

**SOAP / WSDL connection errors**
- Confirm `AdminWebService.wsdl` exists in the project root directory
- Verify Five9 credentials are correct and the account is not locked or expired

**Leads appearing as duplicates in Zoho**
- The dedup check is keyed on `email` — ensure Five9 report rows contain clean, valid email addresses
- Check that Zoho's own duplicate-blocking rules aren't suppressing the API's built-in check

**Viewing live logs on EC2**

```bash
pm2 logs five9-zoho-sync              # live tail
pm2 logs five9-zoho-sync --lines 200  # last 200 lines
```
