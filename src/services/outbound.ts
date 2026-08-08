import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { Store, TrackedLeadRow } from "../db/store.js";
import { isTrackedTreatment, isWebhookStage } from "../leadflo/index.js";

/**
 * WF-1 outbound feeder.
 *
 * Selection and dispatch are deliberately separate: this module decides who is
 * *allowed* to be contacted and hands out a locked batch, while WF-1 owns the
 * actual WhatsApp send. Nothing here contacts anybody.
 */

export interface PhoneResult {
  ok: boolean;
  /** Digits only, country code included — the format Wasup expects. */
  msisdn: string;
  e164: string;
  reason?: string;
}

/**
 * Leadflo stores numbers inconsistently (+44…, 07…, spaces). WhatsApp needs an
 * unambiguous MSISDN, and a wrong guess means messaging a stranger, so anything
 * we cannot resolve confidently is rejected rather than coerced.
 */
export function normalizePhone(raw: string | null | undefined): PhoneResult {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: false, msisdn: "", e164: "", reason: "no phone number" };

  const cc = config.outbound.defaultCountryCode;
  const hadPlus = trimmed.startsWith("+") || trimmed.startsWith("00");
  let digits = trimmed.replace(/\D/g, "");

  if (trimmed.startsWith("00")) digits = digits.slice(2);

  if (!hadPlus) {
    if (digits.startsWith("0")) {
      digits = cc + digits.slice(1);
    } else if (!digits.startsWith(cc)) {
      return {
        ok: false,
        msisdn: "",
        e164: "",
        reason: `ambiguous national number (no country code): ${trimmed}`,
      };
    }
  }

  if (digits.length < 10 || digits.length > 15) {
    return { ok: false, msisdn: "", e164: "", reason: `implausible length: ${trimmed}` };
  }

  // A UK practice messaging a non-UK number is nearly always a bad record.
  if (cc === "44" && !/^447\d{9}$/.test(digits)) {
    return {
      ok: false,
      msisdn: "",
      e164: "",
      reason: `not a UK mobile: ${trimmed}`,
    };
  }

  return { ok: true, msisdn: digits, e164: `+${digits}` };
}

export interface Candidate {
  patientId: string;
  firstName: string;
  fullName: string;
  phone: string;
  msisdn: string;
  email: string;
  treatmentType: string;
  source: string;
  stage: string;
  isTestName: boolean;
  /** Session key WF-2 reads, so the reply lands in the same conversation. */
  sessionKey: string;
}

export interface SkippedCandidate {
  patientId: string;
  fullName: string;
  reason: string;
}

export interface CandidateSelection {
  selected: Candidate[];
  skipped: SkippedCandidate[];
  limit: number;
  filters: {
    trackedTreatmentTypes: string[];
    webhookStages: string[];
    allowlistOnly: boolean;
    allowlistCount: number;
  };
  caps: {
    maxPerRun: number;
    maxPerDay: number;
    sentToday: number;
    remainingToday: number;
  };
  outboundEnabled: boolean;
}

/**
 * Chat-memory key WF-1 must seed so a lead's reply continues this conversation
 * rather than starting a blank one.
 *
 * Must stay identical to WF-2's Postgres Chat Memory key. Both derive it from
 * the phone number alone, deliberately: keying off a CRM lead id would silently
 * change the key the moment a lead row starts existing, orphaning live threads.
 */
export function sessionKeyFor(msisdn: string): string {
  return `da_${msisdn}`;
}

function toCandidate(row: TrackedLeadRow, msisdn: string): Candidate {
  return {
    patientId: row.patient_id,
    firstName: row.first_name,
    fullName: row.full_name,
    phone: row.phone,
    msisdn,
    email: row.email,
    treatmentType: row.treatment_type,
    source: row.source,
    stage: row.stage,
    isTestName: row.is_test_name === 1,
    sessionKey: sessionKeyFor(msisdn),
  };
}

/** Reason this lead may not be contacted, or null if it may. */
function ineligibleReason(row: TrackedLeadRow, phone: PhoneResult): string | null {
  if (!isTrackedTreatment(row.treatment_type)) {
    return `treatment "${row.treatment_type || "unknown"}" is not tracked`;
  }
  if (!isWebhookStage(row.stage)) {
    return `stage "${row.stage}" is past the contact stages`;
  }
  if (!phone.ok) return phone.reason ?? "unusable phone number";
  if (row.outbound_status === "sent") return "already contacted";
  if (row.outbound_status === "opted_out") return "opted out";
  if (row.outbound_status === "locked") return "already claimed by a running batch";
  if (
    config.outbound.allowlistOnly &&
    !config.outbound.allowlist.includes(phone.msisdn)
  ) {
    return "not on the outbound allowlist";
  }
  return null;
}

export function selectCandidates(store: Store, limit: number): CandidateSelection {
  store.releaseExpiredOutboundLocks(
    new Date(Date.now() - config.outbound.lockTtlMs).toISOString(),
  );

  const sentToday = store.countOutboundSentSince(startOfTodayIso());
  const remainingToday = Math.max(0, config.outbound.maxPerDay - sentToday);
  const cap = Math.max(
    0,
    Math.min(limit, config.outbound.maxPerRun, remainingToday),
  );

  const selected: Candidate[] = [];
  const skipped: SkippedCandidate[] = [];

  for (const row of store.listLeads(500)) {
    const phone = normalizePhone(row.phone);
    const reason = ineligibleReason(row, phone);
    if (reason) {
      skipped.push({ patientId: row.patient_id, fullName: row.full_name, reason });
      continue;
    }
    if (selected.length >= cap) {
      skipped.push({
        patientId: row.patient_id,
        fullName: row.full_name,
        reason: "eligible, held back by run cap",
      });
      continue;
    }
    selected.push(toCandidate(row, phone.msisdn));
  }

  return {
    selected,
    skipped,
    limit: cap,
    filters: {
      trackedTreatmentTypes: config.trackedTreatmentTypes,
      webhookStages: config.webhookStages,
      allowlistOnly: config.outbound.allowlistOnly,
      allowlistCount: config.outbound.allowlist.length,
    },
    caps: {
      maxPerRun: config.outbound.maxPerRun,
      maxPerDay: config.outbound.maxPerDay,
      sentToday,
      remainingToday,
    },
    outboundEnabled: config.outbound.enabled,
  };
}

export interface ClaimResult {
  ok: boolean;
  batchId: string | null;
  reason?: string;
  selection: CandidateSelection;
}

/**
 * Hand a locked batch to WF-1. Locking before dispatch is what stops two
 * concurrent runs from messaging the same lead twice.
 */
export function claimBatch(store: Store, limit: number): ClaimResult {
  const selection = selectCandidates(store, limit);

  if (!config.outbound.enabled) {
    return {
      ok: false,
      batchId: null,
      reason: "OUTBOUND_ENABLED is false — preview only",
      selection,
    };
  }
  if (!selection.selected.length) {
    return { ok: false, batchId: null, reason: "no eligible candidates", selection };
  }

  const batchId = randomUUID();
  store.lockOutboundBatch(
    selection.selected.map((c) => c.patientId),
    batchId,
  );
  store.logEvent(
    "outbound.claimed",
    `WF-1 claimed ${selection.selected.length} lead(s) in batch ${batchId}`,
    null,
    { batchId, patientIds: selection.selected.map((c) => c.patientId) },
  );
  return { ok: true, batchId, selection };
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
