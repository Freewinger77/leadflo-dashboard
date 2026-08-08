import express, { type Express, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import type { Store } from "./db/store.js";
import { createLeadfloClient, type LeadfloClient } from "./leadflo/index.js";
import { applyAiNote } from "./services/notes.js";
import { claimBatch, selectCandidates } from "./services/outbound.js";
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

/** Claiming and reporting change who gets messaged, so they are key-gated. */
function requireOutboundKey(req: Request, res: Response): boolean {
  if (!config.outbound.apiKey) return true;
  const provided =
    req.get("x-wf1-key") || req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== config.outbound.apiKey) {
    res.status(401).json({ error: "Invalid WF-1 key" });
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
      practiceName: config.practiceName,
      publicBaseUrl: config.publicBaseUrl || null,
      outbound: {
        enabled: config.outbound.enabled,
        allowlistOnly: config.outbound.allowlistOnly,
        allowlistCount: config.outbound.allowlist.length,
        maxPerRun: config.outbound.maxPerRun,
        maxPerDay: config.outbound.maxPerDay,
        keyConfigured: Boolean(config.outbound.apiKey),
      },
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
      practiceName: config.practiceName,
      config: {
        stages: config.scrapeStages,
        trackedTypes: config.trackedTreatmentTypes,
        pollIntervalMs: config.pollIntervalMs,
        notesOnlyTestNames: config.notesOnlyTestNames,
        webhookConfigured: Boolean(config.webhookUrl),
        webhookUrl: config.webhookUrl ? "[set]" : "",
        inboundSecretConfigured: Boolean(config.inboundWebhookSecret),
        practiceName: config.practiceName,
      },
    });
  });

  app.get("/api/leads", (_req, res) => {
    const leads = store.listLeads().map((row) => serializeLead(row));
    res.json({ leads });
  });

  app.get("/api/analytics", (_req, res) => {
    const days = Number(_req.query.days ?? 30);
    res.json(
      store.analytics(
        Number.isFinite(days) ? days : 30,
        config.trackedTreatmentTypes,
      ),
    );
  });

  app.get("/api/leads/:patientId", (req, res) => {
    const row = store.getLead(req.params.patientId);
    if (!row) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.json({
      lead: serializeLead(row),
      events: store.listEventsForLead(row.patient_id, 80),
      stageHistory: store.listStageHistory(row.patient_id),
      leadfloUrl: `${config.leadflo.appOrigin}/`,
    });
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
        localEvents: store.listEventsForLead(patientId, 80),
        stageHistory: store.listStageHistory(patientId),
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

  /** Re-dispatch outbound webhook for a tracked lead */
  app.post("/api/leads/:patientId/webhook", async (req, res) => {
    const row = store.getLead(req.params.patientId);
    if (!row) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const { sendLeadWebhook } = await import("./services/webhook.js");
    const lead = {
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
      labels: JSON.parse(row.labels_json || "[]") as string[],
      isTestName: row.is_test_name === 1,
      scrapedAt: row.last_seen_at,
    };
    const base =
      config.publicBaseUrl ||
      `${req.protocol}://${req.get("host")}`;
    try {
      const result = await sendLeadWebhook(lead, base);
      if (result.skipped) {
        store.setStatus(row.patient_id, "webhook_sent", {
          webhook_sent_at: new Date().toISOString(),
          last_error: null,
        });
        store.logEvent(
          "webhook.skipped",
          `No WEBHOOK_URL; marked ${row.full_name} as tracked`,
          row.patient_id,
        );
        res.json({ ok: true, skipped: true, message: "WEBHOOK_URL not configured" });
        return;
      }
      if (!result.ok) {
        store.setStatus(row.patient_id, "webhook_failed", {
          last_error: `HTTP ${result.status}: ${result.body}`,
        });
        store.logEvent(
          "webhook.failed",
          `Resend failed for ${row.full_name}: ${result.status}`,
          row.patient_id,
          result,
        );
        res.status(502).json({
          ok: false,
          status: result.status,
          body: result.body,
        });
        return;
      }
      store.setStatus(row.patient_id, "webhook_sent", {
        webhook_sent_at: new Date().toISOString(),
        last_error: null,
      });
      store.logEvent(
        "webhook.sent",
        `Resent ${row.full_name} to webhook`,
        row.patient_id,
        result,
      );
      res.json({
        ok: true,
        status: result.status,
        body: result.body,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, message });
    }
  });

  /**
   * WF-1 outbound feeder.
   *
   * Preview is free; claiming a batch is the only way to get sendable
   * recipients, and it stays refused until OUTBOUND_ENABLED is set.
   */
  app.get("/api/wf1/candidates", (req, res) => {
    const limit = Number(req.query.limit ?? config.outbound.maxPerRun);
    res.json({
      preview: true,
      source: "leadflo-dashboard",
      practice: config.practiceName,
      ...selectCandidates(store, Number.isFinite(limit) ? limit : 1),
    });
  });

  app.post("/api/wf1/claim", (req, res) => {
    if (!requireOutboundKey(req, res)) return;
    const limit = Number(req.body?.limit ?? config.outbound.maxPerRun);
    const result = claimBatch(store, Number.isFinite(limit) ? limit : 1);
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.post("/api/wf1/result", (req, res) => {
    if (!requireOutboundKey(req, res)) return;
    const batchId = String(req.body?.batchId ?? "");
    const patientId = String(req.body?.patientId ?? "");
    const status = String(req.body?.status ?? "");

    if (!batchId || !patientId) {
      res.status(400).json({ ok: false, error: "batchId and patientId are required" });
      return;
    }
    if (status !== "sent" && status !== "failed") {
      res.status(400).json({ ok: false, error: 'status must be "sent" or "failed"' });
      return;
    }
    if (!store.getLead(patientId)) {
      res.status(404).json({ ok: false, error: "Lead not found" });
      return;
    }

    store.recordOutboundResult(patientId, {
      batchId,
      status,
      msisdn: req.body?.msisdn ? String(req.body.msisdn) : undefined,
      message: req.body?.message ? String(req.body.message) : null,
      providerMessageId: req.body?.providerMessageId
        ? String(req.body.providerMessageId)
        : null,
      error: req.body?.error ? String(req.body.error) : null,
    });
    store.logEvent(
      status === "sent" ? "outbound.sent" : "outbound.failed",
      `WF-1 ${status} for ${patientId} (batch ${batchId})`,
      patientId,
      { batchId, providerMessageId: req.body?.providerMessageId ?? null },
    );
    res.json({ ok: true, lead: serializeLead(store.getLead(patientId)!) });
  });

  app.post("/api/wf1/release", (req, res) => {
    if (!requireOutboundKey(req, res)) return;
    const batchId = String(req.body?.batchId ?? "");
    if (!batchId) {
      res.status(400).json({ ok: false, error: "batchId is required" });
      return;
    }
    const released = store.releaseOutboundBatch(batchId);
    store.logEvent("outbound.released", `Released batch ${batchId}`, null, { released });
    res.json({ ok: true, released });
  });

  app.get("/api/wf1/dispatches", (_req, res) => {
    res.json({ dispatches: store.listOutboundDispatches(100) });
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
    stageCheckedAt: row.stage_checked_at,
    detailFetchedAt: row.detail_fetched_at,
    outboundStatus: row.outbound_status,
    outboundSentAt: row.outbound_sent_at,
    outboundMessage: row.outbound_message,
    outboundError: row.outbound_error,
    outboundAttempts: row.outbound_attempts,
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
