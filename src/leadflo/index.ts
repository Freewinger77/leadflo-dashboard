import { config } from "../config.js";
import { LiveLeadfloClient } from "./liveClient.js";
import { MockLeadfloClient } from "./mockClient.js";
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

export function isTestName(fullName: string): boolean {
  return /\btest\b/i.test(fullName) || /test/i.test(fullName);
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
