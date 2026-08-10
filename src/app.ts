import express, { type Express, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import type { Store } from "./db/store.js";
import { createLeadfloClient, type LeadfloClient } from "./leadflo/index.js";
import {
  clearOverride,
  effective,
  isOverridableKey,
  OVERRIDABLE_KEYS,
  setOverride,
} from "./runtime-settings.js";
import { applyAiNote } from "./services/notes.js";
import {
  claimBatch,
  normalizePhone,
  selectCandidates,
  type CandidateSelection,
} from "./services/outbound.js";
import type { Poller } from "./services/poller.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A full read returns every tracked patient's name, mobile and treatment in one
 * response, so the unauthenticated default stays a single page and anything
 * larger has to present the WF-1 key.
 */
const DEFAULT_LEAD_PAGE = 200;
const MAX_LEAD_PAGE = 5000;

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

/**
 * The per-lead skip list is a diagnostic sample. Once most of a practice's
 * table is ineligible it runs to hundreds of entries, so only a sample goes
 * over the wire; skippedByReason carries the full breakdown.
 */
function forWire(selection: CandidateSelection): CandidateSelection {
  return { ...selection, skipped: selection.skipped.slice(0, 25) };
}

/**
 * Claiming and reporting change who gets messaged, so they are key-gated.
 *
 * A missing key refuses the request rather than waving it through: these
 * routes expose patient names and mobile numbers, and the app is deployed to a
 * public URL, so an unset environment variable must not silently publish them.
 */
function requireOutboundKey(req: Request, res: Response): boolean {
  if (!config.outbound.apiKey) {
    res.status(503).json({ error: "WF1_API_KEY is not configured" });
    return false;
  }
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

  app.get("/api/leads", (req, res) => {
    const requested = Number(req.query.limit ?? DEFAULT_LEAD_PAGE);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LEAD_PAGE)
      : DEFAULT_LEAD_PAGE;
    if (limit > DEFAULT_LEAD_PAGE && !requireOutboundKey(req, res)) return;

    const leads = store.listLeads(limit).map((row) => serializeLead(row));
    res.json({ leads, limit, count: leads.length });
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
    const { sendLeadWebhook, leadFromRow } = await import("./services/webhook.js");
    const lead = leadFromRow(row);
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
    if (!requireOutboundKey(req, res)) return;
    const limit = Number(req.query.limit ?? config.outbound.maxPerRun);
    res.json({
      preview: true,
      source: "leadflo-dashboard",
      practice: config.practiceName,
      ...forWire(selectCandidates(store, Number.isFinite(limit) ? limit : 1)),
    });
  });

  /**
   * Runtime settings. Key-gated in both directions: this decides whether the
   * service may message patients at all, so an open write here would let anyone
   * switch on sending, and an open read would disclose the tester allowlist.
   */
  app.get("/api/settings/outbound", (req, res) => {
    if (!requireOutboundKey(req, res)) return;
    res.json({
      settings: Object.fromEntries(
        OVERRIDABLE_KEYS.map((key) => [key, effective(key)]),
      ),
      inForce: {
        outboundEnabled: config.outbound.enabled,
        allowlistOnly: config.outbound.allowlistOnly,
        allowlist: config.outbound.allowlist,
        maxPerRun: config.outbound.maxPerRun,
        maxPerDay: config.outbound.maxPerDay,
        webhookUrl: config.webhookUrl,
      },
    });
  });

  app.put("/api/settings/outbound", (req, res) => {
    if (!requireOutboundKey(req, res)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(body).filter((key) => !isOverridableKey(key));
    if (unknown.length) {
      res.status(400).json({ error: `not overridable: ${unknown.join(", ")}` });
      return;
    }

    for (const key of Object.keys(body)) {
      if (!isOverridableKey(key)) continue;
      const value = body[key];
      // null clears the override, handing the setting back to the environment.
      if (value === null) {
        store.deleteSetting(key);
        clearOverride(key);
        continue;
      }
      const asString = String(value);
      store.setSetting(key, asString);
      setOverride(key, asString);
    }

    store.logEvent(
      "settings.changed",
      `Runtime settings updated: ${Object.keys(body).join(", ")}`,
      null,
      { keys: Object.keys(body), outboundEnabled: config.outbound.enabled },
    );

    res.json({
      ok: true,
      inForce: {
        outboundEnabled: config.outbound.enabled,
        allowlist: config.outbound.allowlist,
        webhookUrl: config.webhookUrl,
      },
    });
  });

  app.post("/api/wf1/claim", (req, res) => {
    if (!requireOutboundKey(req, res)) return;
    const limit = Number(req.body?.limit ?? config.outbound.maxPerRun);
    const result = claimBatch(store, Number.isFinite(limit) ? limit : 1);
    res
      .status(result.ok ? 200 : 409)
      .json({ ...result, selection: forWire(result.selection) });
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

  app.get("/api/wf1/dispatches", (req, res) => {
    if (!requireOutboundKey(req, res)) return;
    res.json({ dispatches: store.listOutboundDispatches(100) });
  });

  /**
   * Let one already-contacted lead be messaged again.
   *
   * Key-gated because it removes a safety rule: everything else in the outbound
   * path exists to stop a patient hearing the opener twice, and this is the
   * single deliberate way past it. Named per patient with no bulk form, so the
   * cost of a mistake is one message rather than the whole table.
   */
  app.post("/api/leads/:patientId/outbound/reset", (req, res) => {
    if (!requireOutboundKey(req, res)) return;

    const patientId = req.params.patientId;
    const row = store.getLead(patientId);
    if (!row) {
      res.status(404).json({ ok: false, error: "Lead not found" });
      return;
    }

    const previousStatus = row.outbound_status;
    const result = store.resetOutbound(patientId);
    store.logEvent(
      "outbound.reset",
      `Outbound reset for ${row.full_name} (was ${previousStatus ?? "never contacted"})`,
      patientId,
      { previousStatus, dispatchesReset: result.dispatches },
    );

    res.json({
      ok: true,
      previousStatus,
      dispatchesReset: result.dispatches,
      lead: serializeLead(store.getLead(patientId)!),
    });
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
  // Leadflo stores numbers inconsistently (+44…, 07…, spaces). Resolving them
  // here means consumers mirroring this data share one implementation instead of
  // each re-deriving it, which is what keeps the dashboard's stored number
  // matching the one WhatsApp reports for the same patient.
  const phone = normalizePhone(row.phone);
  return {
    patientId: row.patient_id,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: row.full_name,
    phone: row.phone,
    phoneE164: phone.ok ? phone.e164 : null,
    msisdn: phone.ok ? phone.msisdn : null,
    email: row.email,
    treatmentType: row.treatment_type,
    source: row.source,
    stage: row.stage,
    dueDate: row.due_date,
    labels: JSON.parse(row.labels_json || "[]"),
    isTestName: row.is_test_name === 1,
    status: row.status,
    /** When the patient enquired. firstSeenAt is only when we discovered them. */
    enquiredAt: row.enquired_at,
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
