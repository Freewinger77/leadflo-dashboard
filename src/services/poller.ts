import { config } from "../config.js";
import type { Store } from "../db/store.js";
import {
  createLeadfloClient,
  isTrackedTreatment,
  isWebhookStage,
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
    refreshed: number;
    leads: NormalizedLead[];
  }> {
    if (this.running) {
      return { discovered: 0, newLeads: 0, refreshed: 0, leads: [] };
    }
    this.running = true;
    const runId = this.store.startPollRun();
    try {
      const actions = await this.client.getDueActions(config.scrapeStages);

      const leads: NormalizedLead[] = [];
      const seen = new Set<string>();
      let newLeads = 0;
      let webhooked = 0;

      for (const action of actions) {
        seen.add(action.patient_id);
        const existing = this.store.getLead(action.patient_id);

        // Patient detail is only needed once per lead; the due-action payload
        // is enough to keep an already-enriched row current.
        let patient = null;
        if (!existing || !existing.detail_fetched_at) {
          try {
            patient = await this.client.getPatient(action.patient_id);
          } catch (err) {
            this.store.logEvent(
              "patient.fetch_failed",
              err instanceof Error ? err.message : String(err),
              action.patient_id,
            );
          }
        }

        const lead = normalizeLead(action, patient);
        const { isNew } = this.store.upsertScrapedLead(lead, {
          detailFetched: Boolean(patient),
        });
        leads.push(lead);

        if (isNew) {
          newLeads += 1;
          if (!isTrackedTreatment(lead.treatmentType)) {
            this.store.logEvent(
              "lead.tracked",
              `Tracked ${lead.fullName} (${lead.treatmentType}) — no webhook (not in TRACKED_TREATMENT_TYPES)`,
              lead.patientId,
            );
          } else if (!isWebhookStage(lead.stage)) {
            this.store.logEvent(
              "lead.tracked",
              `Tracked ${lead.fullName} at stage ${lead.stage} — no webhook (not in WEBHOOK_STAGES)`,
              lead.patientId,
            );
          } else {
            webhooked += 1;
            await this.dispatchNewLead(lead);
          }
        }
      }

      const refreshed = await this.refreshKnownLeads(seen);

      this.lastError = null;
      this.store.finishPollRun(runId, {
        ok: true,
        discovered: leads.length,
        newLeads,
      });
      this.store.logEvent(
        "poll.ok",
        `Scraped ${leads.length} lead(s), ${newLeads} new, ${webhooked} webhooked, ${refreshed} refreshed`,
      );
      return { discovered: leads.length, newLeads, refreshed, leads };
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
      return { discovered: 0, newLeads: 0, refreshed: 0, leads: [] };
    } finally {
      this.running = false;
    }
  }

  /**
   * Leads disappear from /actions/due once they progress, so their stage would
   * otherwise stay frozen forever. Re-read a bounded batch of the least
   * recently checked leads each tick to pick up downstream movement.
   */
  private async refreshKnownLeads(skip: Set<string>): Promise<number> {
    const batchSize = config.stageRefreshBatchSize;
    if (batchSize <= 0) return 0;

    const staleBefore = new Date(
      Date.now() - config.stageRefreshIntervalMs,
    ).toISOString();
    const candidates = this.store
      .listLeadsNeedingRefresh(staleBefore, batchSize + skip.size)
      .filter((row) => !skip.has(row.patient_id))
      .slice(0, batchSize);

    let refreshed = 0;
    for (const row of candidates) {
      try {
        const patient = await this.client.getPatient(row.patient_id);
        const result = this.store.markLeadRefreshed(row.patient_id, {
          stage: patient.stage,
          treatmentType: patient.type,
        });
        refreshed += 1;
        if (result.changed) {
          this.store.logEvent(
            "lead.stage_changed",
            `${row.full_name}: ${result.fromStage} → ${result.toStage}`,
            row.patient_id,
            result,
          );
        }
        if (result.treatmentChanged) {
          this.store.logEvent(
            "lead.treatment_changed",
            `${row.full_name}: ${result.fromTreatment} → ${result.toTreatment}`,
            row.patient_id,
            result,
          );
        }
      } catch (err) {
        // Still mark it checked so one broken record cannot stall the queue.
        this.store.touchStageChecked(row.patient_id);
        this.store.logEvent(
          "patient.refresh_failed",
          err instanceof Error ? err.message : String(err),
          row.patient_id,
        );
      }
    }
    return refreshed;
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
