import { createHmac } from "node:crypto";
import { config } from "../config.js";
import type { TrackedLeadRow } from "../db/store.js";
import type { NormalizedLead } from "../leadflo/types.js";

/**
 * Rebuild the webhook's view of a lead from its stored row, for dispatches that
 * happen after discovery — a manual resend, or one the per-tick cap deferred.
 */
export function leadFromRow(row: TrackedLeadRow): NormalizedLead {
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
    labels: JSON.parse(row.labels_json || "[]") as string[],
    isTestName: row.is_test_name === 1,
    scrapedAt: row.last_seen_at,
  };
}

export interface WebhookPayload {
  event: "lead.created";
  platform: "leadflo";
  trackedTreatmentFilter: string[];
  lead: {
    patientId: string;
    firstName: string;
    lastName: string;
    fullName: string;
    phone: string;
    email: string;
    treatmentType: string;
    source: string;
    stage: string;
    dueDate: string | null;
    labels: string[];
    isTestName: boolean;
    scrapedAt: string;
  };
  callback: {
    noteWebhook: string;
    description: string;
  };
}

export async function sendLeadWebhook(
  lead: NormalizedLead,
  publicBaseUrl: string,
): Promise<{ ok: boolean; status?: number; body?: string; skipped?: boolean }> {
  if (!config.webhookUrl) {
    return { ok: true, skipped: true, body: "WEBHOOK_URL not configured" };
  }

  const payload: WebhookPayload = {
    event: "lead.created",
    platform: "leadflo",
    trackedTreatmentFilter: config.trackedTreatmentTypes,
    lead: {
      patientId: lead.patientId,
      firstName: lead.firstName,
      lastName: lead.lastName,
      fullName: lead.fullName,
      phone: lead.phone,
      email: lead.email,
      treatmentType: lead.treatmentType,
      source: lead.source,
      stage: lead.stage,
      dueDate: lead.dueDate,
      labels: lead.labels,
      isTestName: lead.isTestName,
      scrapedAt: lead.scrapedAt,
    },
    callback: {
      noteWebhook: `${publicBaseUrl.replace(/\/$/, "")}/api/webhooks/ai-response`,
      description:
        "POST JSON { patientId, note, title? } when AI has a response. When NOTES_ONLY_TEST_NAMES=true, notes are only written for test-named leads.",
    },
  };

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "leadflo-dashboard/1.0",
  };
  if (config.webhookSecret) {
    headers["X-Webhook-Secret"] = config.webhookSecret;
    headers["X-Signature"] = createHmac("sha256", config.webhookSecret)
      .update(body)
      .digest("hex");
  }

  const res = await globalThis.fetch(config.webhookUrl, {
    method: "POST",
    headers,
    body,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
}
