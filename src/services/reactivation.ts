import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { Store, TrackedLeadRow } from "../db/store.js";
import type { ReactivationKind } from "../db/store.js";
import {
  normalizePhone,
  sessionKeyFor,
  type Candidate,
  type CandidateSelection,
  type PhoneResult,
  type SkippedCandidate,
} from "./outbound.js";

export const FIRST_MESSAGE =
  "Hi {name}, it's Poppy from Dental Aesthetica. You enquired with us a while back about dental implants, and we never managed to catch you. Are you still thinking about replacing a missing tooth, or a few teeth? I can help with prices, finance options and the next step";

export const FOLLOWUP_MESSAGE =
  "Just a quick follow-up, If dental implants are still on your mind, I'm happy to help. Would you like me to check some consultation times for you?";

export type ReactivationCandidate = Candidate & {
  kind: ReactivationKind;
  message: string;
  discardReason: string | null;
};

export interface ReactivationSelection extends Omit<CandidateSelection, "selected"> {
  selected: ReactivationCandidate[];
  kind: ReactivationKind;
}

export interface ReactivationClaimResult {
  ok: boolean;
  batchId: string | null;
  kind: ReactivationKind;
  reason?: string;
  selection: ReactivationSelection;
}

function compactStage(stage: string | null | undefined): string {
  return String(stage ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isImplant(type: string | null | undefined): boolean {
  return String(type ?? "").trim().toLowerCase() === config.reactivation.requiredTreatment;
}

function isMaybeFuture(stage: string | null | undefined): boolean {
  return compactStage(stage) === compactStage(config.reactivation.requiredStage);
}

function isAllowedCountry(msisdn: string): boolean {
  return config.outbound.allowedCountryCodes.some((cc) => msisdn.startsWith(cc));
}

function startOfLondonDayIso(now = new Date()): string {
  const calendar = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const offset = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
  })
    .formatToParts(now)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = offset?.match(/GMT([+-]?)(\d{1,2})(?::?(\d{2}))?/);
  const sign = match?.[1] === "-" ? "-" : "+";
  const hours = String(match?.[2] ?? "0").padStart(2, "0");
  const minutes = String(match?.[3] ?? "00").padStart(2, "0");
  return new Date(`${calendar}T00:00:00${sign}${hours}:${minutes}`).toISOString();
}

function londonOffset(at: Date): string {
  const offset = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    timeZoneName: "shortOffset",
  })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = offset?.match(/GMT([+-]?)(\d{1,2})(?::?(\d{2}))?/);
  const sign = match?.[1] === "-" ? "-" : "+";
  const hours = String(match?.[2] ?? "0").padStart(2, "0");
  const minutes = String(match?.[3] ?? "00").padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

export function enquiryAt(row: TrackedLeadRow): string | null {
  if (row.enquired_at) return row.enquired_at;
  try {
    const raw = JSON.parse(row.payload_json || "{}") as {
      patient?: { created_at?: string };
      created_at?: string;
    };
    const created = raw.patient?.created_at || raw.created_at;
    if (created) return String(created);
  } catch {
    /* ignore broken payload */
  }
  return null;
}

export function reactivationSinceIso(): string {
  const day = config.reactivation.sinceDate;
  const noon = new Date(`${day}T12:00:00Z`);
  return new Date(`${day}T00:00:00${londonOffset(noon)}`).toISOString();
}

export function firstMessage(firstName: string): string {
  const first = firstName.trim();
  const name = first
    ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
    : "there";
  return FIRST_MESSAGE.replace("{name}", name);
}

export function followupMessage(): string {
  return FOLLOWUP_MESSAGE;
}

function toCandidate(
  row: TrackedLeadRow,
  msisdn: string,
  kind: ReactivationKind,
): ReactivationCandidate {
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
    kind,
    message: kind === "first" ? firstMessage(row.first_name) : followupMessage(),
    discardReason: row.discard_reason,
  };
}

function sharedPhoneGate(
  row: TrackedLeadRow,
  phone: PhoneResult,
): string | null {
  if (!phone.ok) return phone.reason ?? "unusable phone number";
  if (row.outbound_status === "opted_out" || row.reactivation_status === "opted_out") {
    return "opted out";
  }
  const onAllowlist = config.outbound.allowlist.includes(phone.msisdn);
  if (config.reactivation.allowlistOnly && !onAllowlist) {
    return "not on the outbound allowlist";
  }
  if (!onAllowlist && !isAllowedCountry(phone.msisdn)) {
    return `country not in OUTBOUND_ALLOWED_COUNTRIES (+${phone.msisdn.slice(0, 3)}…)`;
  }
  return null;
}

function firstIneligible(
  row: TrackedLeadRow,
  phone: PhoneResult,
  contacted: ReadonlySet<string>,
): string | null {
  if (!isImplant(row.treatment_type)) {
    return `treatment "${row.treatment_type || "unknown"}" is not implant`;
  }
  if (!isMaybeFuture(row.stage)) {
    return `stage "${row.stage}" is not maybeFuture`;
  }
  const enquired = enquiryAt(row);
  if (!enquired) return "enquiry date unknown";
  if (Date.parse(enquired) < Date.parse(reactivationSinceIso())) {
    return "enquired before reactivation window";
  }
  if (row.outbound_status === "sent" || contacted.has(row.patient_id)) {
    return "already contacted by first-touch outbound";
  }
  if (row.reactivation_first_sent_at) return "already sent reactivation first message";
  if (row.reactivation_status === "locked") return "already claimed by a running batch";
  return sharedPhoneGate(row, phone);
}

function followupIneligible(row: TrackedLeadRow, phone: PhoneResult): string | null {
  if (!row.reactivation_first_sent_at) return "reactivation first message not sent";
  if (row.reactivation_followup_sent_at) return "reactivation follow-up already sent";
  if (!isImplant(row.treatment_type)) {
    return `treatment "${row.treatment_type || "unknown"}" is not implant`;
  }
  if (!isMaybeFuture(row.stage)) {
    return `stage "${row.stage}" is not maybeFuture`;
  }
  const dueAt =
    Date.parse(row.reactivation_first_sent_at) + config.reactivation.followupAfterMs;
  if (Number.isNaN(dueAt) || Date.now() < dueAt) {
    return "follow-up not due yet";
  }
  if (
    row.ai_response_at &&
    Date.parse(row.ai_response_at) >= Date.parse(row.reactivation_first_sent_at)
  ) {
    return "patient already replied";
  }
  if (row.reactivation_status === "locked") return "already claimed by a running batch";
  return sharedPhoneGate(row, phone);
}

export function selectReactivation(
  store: Store,
  kind: ReactivationKind,
  limit: number,
): ReactivationSelection {
  store.releaseExpiredReactivationLocks(
    new Date(Date.now() - config.outbound.lockTtlMs).toISOString(),
  );

  const since = startOfLondonDayIso();
  const sentToday =
    kind === "first"
      ? store.countReactivationFirstSentSince(since)
      : store.countReactivationFollowupSentSince(since);
  const dailyCap =
    kind === "first"
      ? config.reactivation.maxNewPerDay
      : config.reactivation.maxFollowupsPerDay;
  const remainingToday = Math.max(0, dailyCap - sentToday);
  const cap = Math.max(
    0,
    Math.min(limit, config.reactivation.maxPerRun, remainingToday),
  );

  const selected: ReactivationCandidate[] = [];
  const skipped: SkippedCandidate[] = [];
  let scanned = 0;
  const contacted = store.listContactedPatientIds();
  const eligible: ReactivationCandidate[] = [];

  const rows = store.listAllLeads().slice().sort((a, b) => {
    const ae = enquiryAt(a) || a.first_seen_at || "";
    const be = enquiryAt(b) || b.first_seen_at || "";
    return ae.localeCompare(be);
  });

  for (const row of rows) {
    scanned += 1;
    const phone = normalizePhone(row.phone);
    const reason =
      kind === "first"
        ? firstIneligible(row, phone, contacted)
        : followupIneligible(row, phone);
    if (reason) {
      skipped.push({ patientId: row.patient_id, fullName: row.full_name, reason });
      continue;
    }
    eligible.push(toCandidate(row, phone.msisdn, kind));
  }

  const pool =
    kind === "first" ? eligible.slice(0, Math.max(0, config.reactivation.maxPool)) : eligible;
  if (kind === "first") {
    for (const extra of eligible.slice(pool.length)) {
      skipped.push({
        patientId: extra.patientId,
        fullName: extra.fullName,
        reason: `outside oldest ${config.reactivation.maxPool} pool`,
      });
    }
  }

  for (const candidate of pool) {
    if (selected.length >= cap) {
      skipped.push({
        patientId: candidate.patientId,
        fullName: candidate.fullName,
        reason: "eligible, held back by run cap",
      });
      continue;
    }
    selected.push(candidate);
  }

  const skippedByReason: Record<string, number> = {};
  for (const s of skipped) {
    const key = s.reason.replace(/"[^"]*"/, '"…"');
    skippedByReason[key] = (skippedByReason[key] ?? 0) + 1;
  }

  return {
    selected,
    skipped,
    scanned,
    skippedCount: skipped.length,
    skippedByReason,
    limit: cap,
    kind,
    filters: {
      trackedTreatmentTypes: [config.reactivation.requiredTreatment],
      webhookStages: [config.reactivation.requiredStage],
      allowlistOnly: config.reactivation.allowlistOnly,
      allowlistCount: config.outbound.allowlist.length,
    },
    caps: {
      maxPerRun: config.reactivation.maxPerRun,
      maxPerDay: dailyCap,
      sentToday,
      remainingToday,
    },
    outboundEnabled: config.reactivation.enabled,
  };
}

export function claimReactivation(
  store: Store,
  kind: ReactivationKind,
  limit: number,
): ReactivationClaimResult {
  const selection = selectReactivation(store, kind, limit);

  if (!config.reactivation.enabled) {
    return {
      ok: false,
      batchId: null,
      kind,
      reason: "REACTIVATION_ENABLED is false — preview only",
      selection,
    };
  }
  if (!selection.selected.length) {
    return { ok: false, batchId: null, kind, reason: "no eligible candidates", selection };
  }

  const batchId = randomUUID();
  store.lockReactivationBatch(
    selection.selected.map((c) => c.patientId),
    batchId,
    kind,
  );
  store.logEvent(
    "reactivation.claimed",
    `Reactivation claimed ${selection.selected.length} ${kind} lead(s) in batch ${batchId}`,
    null,
    { batchId, kind, patientIds: selection.selected.map((c) => c.patientId) },
  );
  return { ok: true, batchId, kind, selection };
}

export function parseKind(value: unknown): ReactivationKind {
  return String(value ?? "first") === "followup" ? "followup" : "first";
}

export function importDiscardReasons(
  store: Store,
  rows: Array<{ patientId?: string; phone?: string; reason?: string }>,
): { updated: number; unmatched: number } {
  let updated = 0;
  let unmatched = 0;
  for (const row of rows) {
    const nextReason = String(row.reason ?? "").trim();
    if (!nextReason) {
      unmatched += 1;
      continue;
    }
    let lead = row.patientId ? store.getLead(row.patientId) : undefined;
    if (!lead && row.phone) {
      const phone = normalizePhone(row.phone);
      lead = store.findLeadByMsisdn(phone.ok ? phone.msisdn : String(row.phone).replace(/\D/g, ""));
    }
    if (!lead) {
      unmatched += 1;
      continue;
    }
    if (store.setDiscardReason(lead.patient_id, nextReason)) updated += 1;
  }
  return { updated, unmatched };
}
