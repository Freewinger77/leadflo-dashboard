# Leadflo Dashboard — Developer Guide

Practice: **Dental Asthetica**  
Live: https://dental-asthetica.wasup.co  
Azure App Service: `dental-asthetica` (RG `rapidspec-rg`)  
Repo: https://github.com/Freewinger77/leadflo-dashboard

This document is the full map of how the feeder works, what talks to what, and every HTTP endpoint.

---

## What this app is

A Node/Express service that:

1. **Polls Leadflo** every minute for early-stage enquiries.
2. **Tracks Implant + Ortho** leads in a local SQLite DB (Ortho = Invisalign in this practice’s Leadflo typing).
3. Feeds **n8n WF-1** (WhatsApp outbound) via claim/result APIs — the app never sends WhatsApp itself.
4. Optionally posts classic **HTTP webhooks** for new tracked leads and writes **AI notes** back into Leadflo.

Think: scrape → store → decide who may be messaged → hand a locked batch to WF-1 → record send result → (optional) write AI note.

---

## Architecture (high level)

```
Leadflo API (api.app.leadflo.com)
        ↑
        │  HTTPS via LEADFLO_HTTP_PROXY (residential proxy — Azure IPs are WAF’d)
        │
┌───────┴────────────────────────────────────────┐
│  dental-asthetica (Azure App Service / Node)   │
│                                                │
│  Poller ──► SQLite (/home/site/data/leadflo.db)│
│     │              ▲                           │
│     │              │ archive scrape (optional) │
│     ▼              │                           │
│  Outbound feeder (WF-1 claim/result)           │
│  Classic webhook dispatcher (optional)         │
│  Notes writer ←── POST /api/webhooks/ai-response│
└───────────────┬────────────────────────────────┘
                │
                ▼
         n8n WF-1 (Wasup WhatsApp)
```

### Important processes

| Piece | Role |
|-------|------|
| `src/services/poller.ts` | Every `POLL_INTERVAL_MS`, login → `GET /actions/due` → upsert leads → optional webhook |
| `src/services/outbound.ts` | Eligibility rules + claim locks for WF-1 |
| `src/services/archive.ts` | One-shot / on-demand full Pipeline scrape into SQLite |
| `src/leadflo/liveClient.ts` | Session, CSRF, proxy-aware undici client |
| `src/db/store.ts` | SQLite schema, leads, events, outbound dispatches |
| `startup.sh` | Azure entrypoint: `tsx src/index.ts` |

### Treatment types

`TRACKED_TREATMENT_TYPES=Implant,Ortho` (Azure app setting + code default).

Matching is case-insensitive (`isTrackedTreatment`). Leadflo stores Invisalign enquiries as type **Ortho** for this practice — there is usually no separate `Invisalign` type in the DB.

### Stages

Discovery / contact windows (defaults):

- `newLead`, `callback1`, `callback2`, `callback3`, `working`

Leads already known are still refreshed into later stages (consultation, lost, etc.) but **will not** be claimed for outbound once past `WEBHOOK_STAGES`.

---

## Environments & URLs

| Env | URL |
|-----|-----|
| Production custom domain | https://dental-asthetica.wasup.co |
| Azure default hostname | https://dental-asthetica.azurewebsites.net |
| Local | http://localhost:8788 |
| Interactive API docs | `/docs` → `public/docs.html` |
| Lead archive UI | `/history` → `public/history.html` |
| Dashboard UI | `/` → `public/index.html` |

DNS: GoDaddy CNAME `dental-asthetica` → `dental-asthetica.azurewebsites.net` + Azure managed TLS.

---

## Leadflo HTTP proxy (critical)

Azure App Service egress is treated as a datacenter IP. Leadflo’s WAF often returns **403** without a residential proxy.

App setting: **`LEADFLO_HTTP_PROXY`**

Format:

```text
http://USER:PASSWORD@HOST:PORT
```

### Current production proxy (swap anytime)

| Field | Value |
|-------|--------|
| Host | `195.40.128.249` |
| Port | `6969` |
| User | `rktwwipc` |
| Pass | `baq3spf64bhx` |

### How to swap the proxy

**Option A — GitHub Action (preferred)**

1. Edit defaults in `.github/workflows/set-leadflo-proxy.yml` (`PROXY_HOST` / `PORT` / `USER` / `PASS`), **or** run **workflow_dispatch** with inputs.
2. Bump / push `SET_LEADFLO_PROXY_NOW` on `main`, **or** dispatch the workflow.
3. Action probes Leadflo CSRF through the proxy, writes `LEADFLO_HTTP_PROXY`, restarts the app, forced-polls, asserts `/api/status` Leadflo `ok`.

**Option B — local Azure CLI**

```bash
chmod +x scripts/set-leadflo-proxy.sh
PROXY_HOST=… PROXY_PORT=… PROXY_USER=… PROXY_PASS=… ./scripts/set-leadflo-proxy.sh
```

**Symptom when proxy is wrong:** `/api/status` → `leadflo.ok: false`, poll events `poll.error` with `fetch failed` / `407 Proxy Authentication Required`.

---

## Auth keys

| Key | Header | Used for |
|-----|--------|----------|
| `WF1_API_KEY` | `X-WF1-Key` or `Authorization: Bearer …` | All `/api/wf1/*`, large lead pages, archive scrape/list, outbound settings mutations, outbound reset |
| `INBOUND_WEBHOOK_SECRET` | `X-Webhook-Secret` / Bearer / `?secret=` | Optional gate on `POST /api/webhooks/ai-response` |

If `WF1_API_KEY` is unset, gated routes return **503** (not open).

---

## HTTP API reference

Base: `https://dental-asthetica.wasup.co`

### Public / ops

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/health` | — | Liveness + tracked types + outbound flags |
| `GET` | `/api/status` | — | Leadflo ping, latest poll, stats, config snapshot |
| `GET` | `/api/events` | — | Recent activity log |
| `POST` | `/api/poll` | — | Run one poll tick immediately |
| `GET` | `/api/analytics?days=30` | — | Leads/day, type mix, KPIs |

### Leads (tracker DB)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/leads?limit=200` | Key if `limit > 200` | Page of tracked leads |
| `GET` | `/api/leads/:patientId` | — | Lead + local events + stage history |
| `GET` | `/api/leads/:patientId/timeline` | — | Live Leadflo timeline/notes |
| `POST` | `/api/leads/:patientId/webhook` | — | Re-dispatch classic outbound webhook |
| `POST` | `/api/leads/:patientId/notes` | — | Manual note write to Leadflo |
| `POST` | `/api/leads/:patientId/outbound/reset` | WF-1 key | Clear outbound status so lead can be claimed again |

### Archive (full book scrape)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/archive/status` | — | Last scrape job status |
| `GET` | `/api/archive/leads` | Key if large page | Filterable full lead list |
| `POST` | `/api/archive/scrape` | WF-1 key | Pull Pipeline patients into SQLite (`from`/`to`/`types`/`stages` body) |

Does **not** fire webhooks.

### WF-1 outbound feeder

All require `X-WF1-Key`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/wf1/candidates?limit=N` | Preview selection + skip reasons (no locks) |
| `POST` | `/api/wf1/claim` | Lock a batch (`{ limit? }`) — requires `OUTBOUND_ENABLED` |
| `POST` | `/api/wf1/result` | Report per-lead `sent` / `failed` |
| `POST` | `/api/wf1/release` | Unlock a rejected batch |
| `GET` | `/api/wf1/dispatches` | Recent dispatch rows |

**Eligibility (simplified):** tracked treatment, contact stage, usable UK mobile, not already sent/opted-out/locked, country allowlist (allowlist overrides), daily/run caps.

### Reactivation (implant maybe-future)

Separate from WF-1. Same `X-WF1-Key`. Off until `REACTIVATION_ENABLED=true`. Does not widen scrape stages.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/reactivation/candidates?kind=first\|followup&limit=N` | Preview. Empty until reasons are set |
| `POST` | `/api/reactivation/claim` | Lock a batch (`{ kind, limit }`) — requires `REACTIVATION_ENABLED` |
| `POST` | `/api/reactivation/result` | Report per-lead `sent` / `failed` |
| `POST` | `/api/reactivation/release` | Unlock a rejected batch |
| `POST` | `/api/reactivation/reasons` | Set `discard_reason` from `{ reasons: [{ patientId, phone?, reason? }] }` |

**First message:** implant + `maybeFuture` + enquired on/after `REACTIVATION_SINCE` (default 2025-09-25) + never WF-1 messaged. Oldest **100** only (`REACTIVATION_MAX_POOL`). 10 new/day (UK day).  
**Follow-up:** 7 days later if still maybe-future and no reply. Extra to the 10.  
Copy is composed on the feeder so the workflow sends it verbatim.

`sessionKey` for chat memory: `da_<msisdn>` (phone-only — must stay stable for WF-2).

### Outbound settings (runtime overrides)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/settings/outbound` | WF-1 key | Effective outbound settings |
| `PUT` | `/api/settings/outbound` | WF-1 key | Persist overrides (`OUTBOUND_ENABLED`, allowlist, etc.) |

Overrides are stored on disk and survive restarts; `WF1_API_KEY` itself is **not** overridable via API.

### Classic AI note webhook

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/webhooks/ai-response` | inbound secret if set | Body: `{ patientId, note, title?, force? }` → Leadflo note |

### Pages

| Path | File |
|------|------|
| `/` | Dashboard UI |
| `/history` | Archive UI |
| `/docs` | Human API docs page |

---

## Poller behaviour

Each tick (`POLL_INTERVAL_MS`, default 60s):

1. Ensure Leadflo session (CSRF + login) through proxy.
2. `GET /actions/due` for scrape stages.
3. Upsert each patient into SQLite.
4. On **new** lead: if tracked + contact stage → classic webhook (if `WEBHOOK_URL` set) or mark pending; else log skip reason.
5. Refresh a batch of known leads’ stages.
6. Optionally backfill enquiry dates from timelines.

Failures surface on `/api/status` as `leadflo` / `latestPoll` / `lastPollerError` and `poll.error` events.

---

## WF-1 / n8n contract (summary)

1. n8n polls `GET /api/wf1/candidates` (optional preview).
2. `POST /api/wf1/claim` → locked candidates with `msisdn`, `sessionKey`, names, type.
3. n8n sends WhatsApp via Wasup.
4. `POST /api/wf1/result` with outcomes.
5. Caps: `OUTBOUND_MAX_PER_RUN`, `OUTBOUND_MAX_PER_DAY` (health shows remaining).

`OUTBOUND_ALLOWLIST_ONLY=false` in production (ungated). Allowlist still bypasses country checks for named testers.

---

## Key environment variables

| Variable | Purpose | Prod notes |
|----------|---------|------------|
| `LEADFLO_EMAIL` / `LEADFLO_PASSWORD` | Leadflo login | Azure app settings |
| `LEADFLO_HTTP_PROXY` | Residential proxy URL | **Required on Azure** |
| `LEADFLO_MODE` | `live` / `mock` | `live` |
| `TRACKED_TREATMENT_TYPES` | Comma list | `Implant,Ortho` (quote commas in `az`) |
| `POLL_INTERVAL_MS` | Poll period | `60000` |
| `SCRAPE_STAGES` / `WEBHOOK_STAGES` | Stage filters | early contact stages |
| `WF1_API_KEY` | Feeder auth | set |
| `OUTBOUND_ENABLED` | Allow claims | `true` |
| `OUTBOUND_ALLOWLIST_ONLY` | Restrict to allowlist | `false` |
| `OUTBOUND_MAX_PER_RUN` / `_PER_DAY` | Caps | often `1` / `5` |
| `NOTES_ONLY_TEST_NAMES` | Restrict note writes | `false` |
| `WEBHOOK_URL` | Classic new-lead webhook | often empty (WF-1 path used instead) |
| `DATABASE_PATH` | SQLite file | `/home/site/data/leadflo.db` |
| `PUBLIC_BASE_URL` | Absolute URLs in payloads | `https://dental-asthetica.wasup.co` |

---

## Deploy & CI

Push / merge to **`main`** runs:

1. **Deploy to Azure** — zip with `node_modules`, `SCM_DO_BUILD_DURING_DEPLOYMENT=false` (avoids Oryx hangs), set go-live settings, restart, smoke health + Ortho tracked types + WF-1 candidates.
2. Path-triggered helpers:
   - `SET_LEADFLO_PROXY_NOW` → set proxy workflow
   - `RESTART_POLLER_NOW` → diagnose + restart
   - `EXPORT_LOSSES_NOW` → Losses CSV scrape (OIDC → Azure secrets → artifact)
   - `CLEAR_PROXY_TRY_DIRECT` → emergency direct-Leadflo test

OIDC app: `leadflo-github-deploy`  
Federated subject must match GitHub’s ID-qualified `repo:…:ref:refs/heads/main` claim.

Local package/deploy helper: `scripts/deploy-azure.sh`.

---

## Local development

```bash
npm ci
cp .env.example .env   # if present; else create with LEADFLO_* + WF1_API_KEY
# Live needs proxy or a non-datacenter IP:
# LEADFLO_HTTP_PROXY=http://user:pass@host:port
npm run dev            # http://localhost:8788
LEADFLO_MODE=mock npm run dev   # offline fixtures
npm test
npm run typecheck
```

---

## SQLite data

Default Azure path: `/home/site/data/leadflo.db` (persists across deploys if on `/home/site/data`).

Stores: leads, events, poll runs, outbound locks/dispatches, runtime setting overrides, archive scrape metadata.

---

## Operational playbooks

### Poller showing `fetch failed`

1. `GET /api/status` → read `leadflo.detail` / `latestPoll.error` (now includes undici cause chain).
2. If **407** → proxy user/pass expired → run **Set Leadflo HTTP proxy** workflow with new creds.
3. If **403 WAF** → proxy missing or egress not residential.
4. Restart: push `RESTART_POLLER_NOW` or Azure restart `dental-asthetica`.

### Site 503 during deploy

Usually mid zip-deploy / Oryx. Current pipeline skips remote Oryx and cancels superseded deploys (`cancel-in-progress: true`). Wait for green **Deploy to Azure** or restart App Service.

### Export Losses CSV

Path-trigger `EXPORT_LOSSES_NOW` on `main` (or workflow_dispatch). Artifact `leadflo-losses-csv`. Do not commit patient CSVs.

---

## Repo layout (short)

```
src/
  index.ts          boot + poll loop
  app.ts            HTTP routes
  config.ts         env → config
  leadflo/          live + mock clients
  services/         poller, outbound, archive, notes, webhook
  db/store.ts       SQLite
public/             dashboard, history, docs UIs
scripts/            deploy + proxy swap + one-shot exports
.github/workflows/  deploy, proxy set, restart, export, …
```

---

## Related reading

- Root `README.md` — quick start + webhook shapes  
- Live `/docs` — interactive-ish endpoint page  
- n8n WF-1 workflow on Azure (claims feeder; title may say draft even when live — always verify `DRY_RUN` / send nodes)

---

*Last updated for Dental Asthetica feeder with Implant+Ortho tracking and swappable `LEADFLO_HTTP_PROXY`.*
