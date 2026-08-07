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
7. **Safety:** with `NOTES_ONLY_TEST_NAMES=true` (default), notes are only written when the lead name contains `test` (e.g. `asif test`).

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
| `NOTES_ONLY_TEST_NAMES` | Default `true` — only write notes for test names |
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
| GET | `/api/leads` | Tracked implant leads |
| GET | `/api/events` | Activity log |
| POST | `/api/poll` | Run one scrape immediately |
| POST | `/api/webhooks/ai-response` | Apply AI note |
| POST | `/api/leads/:id/notes` | Manual note (dashboard) |

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
2. Set `LEADFLO_HTTP_PROXY` to a residential proxy, **or**
3. Set `LEADFLO_MODE=mock` to exercise the dashboard + webhook loop locally.

This cloud agent environment is AWS-hosted and receives that WAF 403, so live scrape was verified only up to the auth gate here; the full loop is covered under `LEADFLO_MODE=mock`.

## Tests

```bash
npm test
npm run typecheck
```

## Scripts

- `npm run dev` — dashboard + poller
- `npm run scrape:once` — single scrape, print JSON
- `npm start` — production-style start via `tsx`
