import express, { type Express, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import type { Store } from "./db/store.js";
import { createLeadfloClient, type LeadfloClient } from "./leadflo/index.js";
import { applyAiNote } from "./services/notes.js";
import type { Poller } from "./services/poller.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AppDeps {
  store: Store;
  poller: Poller;
  client?: LeadfloClient;
}

function requireInboundSecret(req: Request, res: Response): boolean {
  if (!config.inboundWebhookSecret) return true;
  const provided =
    req.get("x-webhook-secret") ||
    req.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    (req.query.secret as string | undefined);
  if (provided !== config.inboundWebhookSecret) {
    res.status(401).json({ error: "Invalid webhook secret" });
    return false;
  }
  return true;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  const client = deps.client ?? createLeadfloClient();
  const { store, poller } = deps;

  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      mode: config.leadflo.mode,
      trackedTypes: config.trackedTreatmentTypes,
      pollIntervalMs: config.pollIntervalMs,
      notesOnlyTestNames: config.notesOnlyTestNames,
      webhookConfigured: Boolean(config.webhookUrl),
    });
  });

  app.get("/api/status", async (_req, res) => {
    const ping = await client.ping();
    res.json({
      leadflo: ping,
      mode: config.leadflo.mode,
      stats: store.stats(),
      latestPoll: store.latestPollRun(),
      lastPollerError: poller.lastError,
      config: {
        stages: config.scrapeStages,
        trackedTypes: config.trackedTreatmentTypes,
        pollIntervalMs: config.pollIntervalMs,
        notesOnlyTestNames: config.notesOnlyTestNames,
        webhookConfigured: Boolean(config.webhookUrl),
      },
    });
  });

  app.get("/api/leads", (_req, res) => {
    const leads = store.listLeads().map((row) => ({
      patientId: row.patient_id,
      firstName: row.first_name,
      lastName: row.last_name,
      fullName: row.full_name,
      phone: row.phone,
      email: row.email,
      treatmentType: row.treatment_type,
      source: row.source,
      stage: row.stage,
      dueDate: row.due_date,
      labels: JSON.parse(row.labels_json || "[]"),
      isTestName: row.is_test_name === 1,
      status: row.status,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      webhookSentAt: row.webhook_sent_at,
      aiResponseAt: row.ai_response_at,
      noteWrittenAt: row.note_written_at,
      lastError: row.last_error,
      aiNote: row.ai_note,
    }));
    res.json({ leads });
  });

  app.get("/api/events", (_req, res) => {
    res.json({ events: store.listEvents(150) });
  });

  app.post("/api/poll", async (_req, res) => {
    const result = await poller.tick();
    res.json(result);
  });

  /** Inbound: AI / n8n / agent posts the note to write back into Leadflo */
  app.post("/api/webhooks/ai-response", async (req, res) => {
    if (!requireInboundSecret(req, res)) return;
    const patientId = String(
      req.body?.patientId ?? req.body?.patient_id ?? req.body?.id ?? "",
    );
    const note = String(req.body?.note ?? req.body?.content ?? req.body?.message ?? "");
    const title = req.body?.title ? String(req.body.title) : undefined;
    const force = Boolean(req.body?.force);

    const result = await applyAiNote(store, client, {
      patientId,
      note,
      title,
      force,
    });
    res.status(result.ok ? 200 : 400).json(result);
  });

  /** Manual note write helper for dashboard testing */
  app.post("/api/leads/:patientId/notes", async (req, res) => {
    const result = await applyAiNote(store, client, {
      patientId: req.params.patientId,
      note: String(req.body?.note ?? ""),
      title: req.body?.title ? String(req.body.title) : undefined,
      force: Boolean(req.body?.force),
    });
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  return app;
}
