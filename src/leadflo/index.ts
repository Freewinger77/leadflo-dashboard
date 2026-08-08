import { config } from "../config.js";
import { LiveLeadfloClient } from "./liveClient.js";
import { MockLeadfloClient } from "./mockClient.js";
import { isTestName } from "./testName.js";
import type { LeadfloClient, LeadfloPatient, NormalizedLead } from "./types.js";
import type { LeadfloAction } from "./types.js";

export function createLeadfloClient(): LeadfloClient {
  if (config.leadflo.mode === "mock") {
    return new MockLeadfloClient();
  }
  return new LiveLeadfloClient();
}

export function isTrackedTreatment(type: string | null | undefined): boolean {
  if (!type) return false;
  const normalized = type.trim().toLowerCase();
  return config.trackedTreatmentTypes.some(
    (t) => normalized === t || normalized.includes(t),
  );
}

export { isTestName };

export function isWebhookStage(stage: string | null | undefined): boolean {
  if (!stage) return false;
  return config.webhookStages.includes(stage);
}

export function normalizeLead(
  action: LeadfloAction,
  patient?: LeadfloPatient | null,
): NormalizedLead {
  const firstName = patient?.first_name || action.first_name || "";
  const lastName = patient?.last_name || action.last_name || "";
  const fullName = `${firstName} ${lastName}`.trim();
  const treatmentType = String(patient?.type || action.type || "");
  const email = String(patient?.email || action.email || "");
  const phone = String(patient?.phone || action.phone || "");
  const source = String(patient?.source || action.source || "");
  const labels = (patient?.labels || action.labels || []).map(String);

  return {
    patientId: action.patient_id,
    firstName,
    lastName,
    fullName,
    phone,
    email,
    treatmentType,
    source,
    stage: action.stage,
    dueDate: action.date ?? null,
    labels,
    isTestName: isTestName(fullName),
    scrapedAt: new Date().toISOString(),
    raw: { action, patient },
  };
}

export type { LeadfloClient, NormalizedLead, LeadfloAction, LeadfloPatient };
