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
    const leads = store.listLeads().map((row) => serializeLead(row));
    res.json({ leads });
  });

  app.get("/api/analytics", (_req, res) => {
    const days = Number(_req.query.days ?? 14);
    res.json(store.analytics(Number.isFinite(days) ? days : 14));
  });

  app.get("/api/leads/:patientId", (req, res) => {
    const row = store.getLead(req.params.patientId);
    if (!row) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.json({ lead: serializeLead(row) });
  });

  /** Live Leadflo timeline + notes (new vs previously seen). */
  app.get("/api/leads/:patientId/timeline", async (req, res) => {
    const patientId = req.params.patientId;
    const row = store.getLead(patientId);
    if (!row) {
      res.status(404).json({ error: "Lead not found — scrape first" });
      return;
    }

    try {
      const items = await client.getTimeline(patientId);
      const rawNotes = items
        .filter((item) => String(item.type).toLowerCase() === "note")
        .map((item) => ({
          id: String(item.id),
          title: String(item.title ?? ""),
          content: String(item.content ?? item.message ?? ""),
          datetime: String(item.datetime ?? ""),
        }));

      const notes = store.syncLeadNotes(patientId, rawNotes);
      const newNotes = notes.filter((n) => n.isNew);
      const oldNotes = notes.filter((n) => !n.isNew);

      const activity = items
        .filter((item) => String(item.type).toLowerCase() !== "note")
        .map((item) => ({
          id: String(item.id),
          type: String(item.type),
          datetime: String(item.datetime ?? ""),
          summary: timelineSummary(item),
          raw: item,
        }))
        .sort((a, b) => b.datetime.localeCompare(a.datetime));

      store.logEvent(
        "notes.polled",
        `Timeline for ${row.full_name}: ${notes.length} note(s), ${newNotes.length} new`,
        patientId,
        { newCount: newNotes.length, noteCount: notes.length },
      );

      res.json({
        patientId,
        lead: serializeLead(row),
        notes,
        newNotes,
        oldNotes,
        activity,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: "Failed to fetch Leadflo timeline", message });
    }
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

  app.get("/docs", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "docs.html"));
  });

  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  return app;
}

function serializeLead(row: ReturnType<Store["listLeads"]>[number]) {
  return {
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
  };
}

function timelineSummary(item: {
  type: string;
  title?: string;
  content?: string;
  message?: string;
  form?: string;
  comm_type?: string;
  text_content?: string;
  [key: string]: unknown;
}): string {
  const type = String(item.type).toLowerCase();
  if (type === "form_submission") {
    return `Form: ${item.form || item.message || "submission"}`;
  }
  if (type === "communication") {
    const body = String(item.text_content || item.message || "").trim();
    const head = item.comm_type ? `${item.comm_type}` : "Message";
    return body ? `${head} — ${body.slice(0, 160)}` : head;
  }
  return String(item.content || item.message || item.title || item.type);
}
