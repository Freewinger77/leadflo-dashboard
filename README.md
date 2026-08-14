# Leadflo Tracker

Poll [Leadflo](https://app.leadflo.com) every minute for **Implant** leads, send each **new** lead to your webhook, then write the AI response back into Leadflo notes.

Designed like a Boxly-style integration agent: scrape → detect new → webhook → apply AI note.

## What it does

1. Logs into Leadflo (`POST /auth/session` after CSRF).
2. Scrapes due actions (`GET /actions/due`) across New Leads / Call Attempts / In Discussion.
3. Keeps **Implant** treatment types only.
4. On first sight of a patient id → `POST` outbound webhook.
5. Your AI / n8n agent replies to `POST /api/webhooks/ai-response`.
6. Writes the note via `POST /v3/patients/:id/notes`.
7. **Notes:** by default notes are written for all tracked Implant leads. Set `NOTES_ONLY_TEST_NAMES=true` to restrict writes to names containing `test`.

## Quick start

```bash
npm install
cp .env.example .env
# edit .env — set LEADFLO_PASSWORD, WEBHOOK_URL, etc.

# Live against Leadflo (needs a non-datacenter IP — see WAF note below)
npm run dev

# Or run fully offline against fixtures
LEADFLO_MODE=mock npm run dev
```

Open `http://localhost:8788`.

## Environment

| Variable | Purpose |
|----------|---------|
| `LEADFLO_EMAIL` / `LEADFLO_PASSWORD` | Leadflo login |
| `LEADFLO_MODE` | `live` or `mock` |
| `TRACKED_TREATMENT_TYPES` | Default `Implant` |
| `POLL_INTERVAL_MS` | Default `60000` |
| `WEBHOOK_URL` | Outbound new-lead webhook |
| `NOTES_ONLY_TEST_NAMES` | Default `false` — set `true` to only write notes for test names |
| `INBOUND_WEBHOOK_SECRET` | Optional shared secret for AI callback |

## Webhooks

### Outbound (new implant lead)

```json
{
  "event": "lead.created",
  "platform": "leadflo",
  "lead": {
    "patientId": "…",
    "fullName": "asif test",
    "phone": "07599 211739",
    "email": "asif@smilefast.com",
    "treatmentType": "Implant",
    "source": "Practice Website",
    "stage": "newLead",
    "isTestName": true
  },
  "callback": {
    "noteWebhook": "https://your-host/api/webhooks/ai-response"
  }
}
```

### Inbound (AI response → Leadflo note)

`POST /api/webhooks/ai-response`

```json
{
  "patientId": "…",
  "note": "AI-written note content",
  "title": "",
  "force": false
}
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Liveness |
| GET | `/api/status` | Leadflo ping + stats |
| GET | `/api/leads` | Tracked leads (all types) |
| GET | `/api/leads/:id` | Lead detail + local events |
| GET | `/api/leads/:id/timeline` | Live Leadflo notes (new vs old) |
| GET | `/api/analytics` | Leads/day + type mix + KPIs |
| GET | `/api/events` | Activity log |
| POST | `/api/poll` | Run one scrape immediately |
| POST | `/api/webhooks/ai-response` | Apply AI note |
| POST | `/api/leads/:id/notes` | Manual note (dashboard) |
| POST | `/api/leads/:id/webhook` | Resend outbound webhook |
| GET | `/api/wf1/candidates` | Preview who WF-1 would contact, and why others were skipped |
| POST | `/api/wf1/claim` | Lock a batch for WF-1 (refused unless `OUTBOUND_ENABLED`) |
| POST | `/api/wf1/result` | WF-1 reports `sent` / `failed` per lead |
| POST | `/api/wf1/release` | Return a rejected batch to the pool |
| GET | `/api/wf1/dispatches` | Outbound dispatch audit log |

## WF-1 outbound feeder

The dashboard decides *who may be contacted*; n8n WF-1 does the sending. A lead
is only offered to WF-1 when it is an implant enquiry in an early stage, has a
resolvable UK mobile, has never been contacted, and is not locked by another
run. Per-run and per-day caps and an allowlist apply on top.

All `/api/wf1/*` routes require `WF1_API_KEY`, sent as `X-WF1-Key`. They return
patient names and mobile numbers on a publicly deployed URL, so an unset key
returns 503 rather than serving the data unauthenticated — set it in the App
Service configuration before deploying.

Nothing can be sent until `OUTBOUND_ENABLED=true`; until then `/api/wf1/claim`
refuses and only the preview endpoint works. Claimed batches are locked and
auto-released after `OUTBOUND_LOCK_TTL_MS` so a crashed run cannot strand leads.

`sessionKey` in the candidate payload must stay identical to WF-2's Postgres
chat-memory key, otherwise a lead's reply starts a blank conversation instead of
continuing the one WF-1 opened.

## Leadflo API surface used

Reverse-engineered from the Leadflo web app (`api.app.leadflo.com`):

- `GET /auth/csrf-token`
- `POST /auth/session` `{ email, password }`
- `GET /actions/due?stages=newLead,…`
- `GET /v3/patients/:id`
- `POST /v3/patients/:id/notes` `{ id, title, content }`

## WAF / datacenter note

Leadflo sits behind AWS ELB/WAF. Many datacenter IPs (including AWS) get **403 Forbidden** on `/auth/session` and most API routes, while `GET /auth/csrf-token` still returns 200.

If login fails with a WAF 403:

1. Run this service on a laptop / residential VPS / non-AWS host, **or**
2. Set `LEADFLO_HTTP_PROXY` to a **UK** residential proxy (verified: UK exits reach nginx; SE/AWS get `403 awselb` on `/auth/session`), **or**
3. Set `LEADFLO_MODE=mock` for offline UI testing.

Live verified through a UK proxy: login → scrape Implant `asif test` → write note to Leadflo timeline.

## API docs

Interactive reference: **`/docs.html`** (also `/docs`).

See the endpoint table above, plus interactive docs at **`/docs.html`**.

## Production

Live (UK residential proxy → Leadflo):

- **App:** https://dental-asthetica.wasup.co  
- **Azure default:** https://dental-asthetica.azurewebsites.net  
- **Docs:** https://dental-asthetica.wasup.co/docs.html  
- **AI note webhook:** `POST https://dental-asthetica.wasup.co/api/webhooks/ai-response`

DNS: GoDaddy CNAME `dental-asthetica` → `dental-asthetica.azurewebsites.net` + Azure managed TLS.

## Azure deploy (auto)

**Pushing / merging to `main` deploys automatically** via GitHub Actions → Azure App Service `dental-asthetica` (OIDC, no publish-profile secret).

- Workflow: [`.github/workflows/deploy-azure.yml`](.github/workflows/deploy-azure.yml)
- Runs: https://github.com/Freewinger77/leadflo-dashboard/actions
- Live: https://dental-asthetica.wasup.co

Your developer does **not** need Azure portal access for routine deploys — merge to `main` (or run **Actions → Deploy to Azure → Run workflow**).

Manual zip-deploy (operators with Azure access only):

```bash
az login
export RESOURCE_GROUP=rapidspec-rg APP_NAME=dental-asthetica
# App settings (Leadflo creds, proxy, etc.) already live on the App Service — do not overwrite blindly.
./scripts/deploy-azure.sh
```

## Tests

```bash
npm test
npm run typecheck
```

## Scripts

- `npm run dev` — dashboard + poller
- `npm run scrape:once` — single scrape, print JSON
- `npm start` — production-style start via `tsx`
- `./scripts/deploy-azure.sh` — provision + zip-deploy App Service
