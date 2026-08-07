import { config } from "../config.js";
import type { Store } from "../db/store.js";
import {
  createLeadfloClient,
  isTrackedTreatment,
  normalizeLead,
  type LeadfloClient,
  type NormalizedLead,
} from "../leadflo/index.js";
import { sendLeadWebhook } from "./webhook.js";

export interface PollerOptions {
  store: Store;
  client?: LeadfloClient;
  publicBaseUrl?: string;
}

export class Poller {
  private readonly store: Store;
  private readonly client: LeadfloClient;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  publicBaseUrl: string;
  lastError: string | null = null;

  constructor(opts: PollerOptions) {
    this.store = opts.store;
    this.client = opts.client ?? createLeadfloClient();
    this.publicBaseUrl = opts.publicBaseUrl ?? `http://localhost:${config.port}`;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), config.pollIntervalMs);
    this.store.logEvent(
      "poller.started",
      `Polling every ${config.pollIntervalMs}ms (mode=${config.leadflo.mode})`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<{
    discovered: number;
    newLeads: number;
    leads: NormalizedLead[];
  }> {
    if (this.running) {
      return { discovered: 0, newLeads: 0, leads: [] };
    }
    this.running = true;
    const runId = this.store.startPollRun();
    try {
      const actions = await this.client.getDueActions(config.scrapeStages);
      const implantActions = actions.filter((a) => isTrackedTreatment(a.type));

      const leads: NormalizedLead[] = [];
      let newLeads = 0;

      for (const action of implantActions) {
        let patient = null;
        try {
          patient = await this.client.getPatient(action.patient_id);
        } catch (err) {
          this.store.logEvent(
            "patient.fetch_failed",
            err instanceof Error ? err.message : String(err),
            action.patient_id,
          );
        }

        const lead = normalizeLead(action, patient);
        // Re-check type from patient detail if present
        if (!isTrackedTreatment(lead.treatmentType)) continue;

        const { isNew } = this.store.upsertScrapedLead(lead);
        leads.push(lead);

        if (isNew) {
          newLeads += 1;
          await this.dispatchNewLead(lead);
        }
      }

      this.lastError = null;
      this.store.finishPollRun(runId, {
        ok: true,
        discovered: leads.length,
        newLeads,
      });
      this.store.logEvent(
        "poll.ok",
        `Scraped ${leads.length} implant lead(s), ${newLeads} new`,
      );
      return { discovered: leads.length, newLeads, leads };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.store.finishPollRun(runId, {
        ok: false,
        discovered: 0,
        newLeads: 0,
        error: message,
      });
      this.store.logEvent("poll.error", message);
      return { discovered: 0, newLeads: 0, leads: [] };
    } finally {
      this.running = false;
    }
  }

  private async dispatchNewLead(lead: NormalizedLead): Promise<void> {
    this.store.setStatus(lead.patientId, "webhook_pending");
    try {
      const result = await sendLeadWebhook(lead, this.publicBaseUrl);
      if (result.skipped) {
        this.store.setStatus(lead.patientId, "webhook_sent", {
          webhook_sent_at: new Date().toISOString(),
          last_error: null,
        });
        this.store.logEvent(
          "webhook.skipped",
          `No WEBHOOK_URL; marked ${lead.fullName} as tracked`,
          lead.patientId,
        );
        return;
      }
      if (!result.ok) {
        this.store.setStatus(lead.patientId, "webhook_failed", {
          last_error: `HTTP ${result.status}: ${result.body}`,
        });
        this.store.logEvent(
          "webhook.failed",
          `Webhook failed for ${lead.fullName}: ${result.status}`,
          lead.patientId,
          result,
        );
        return;
      }
      this.store.setStatus(lead.patientId, "webhook_sent", {
        webhook_sent_at: new Date().toISOString(),
        last_error: null,
      });
      this.store.logEvent(
        "webhook.sent",
        `Sent ${lead.fullName} to webhook`,
        lead.patientId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.setStatus(lead.patientId, "webhook_failed", {
        last_error: message,
      });
      this.store.logEvent("webhook.failed", message, lead.patientId);
    }
  }
}
