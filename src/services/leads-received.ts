import { normalizePatient, type LeadfloClient, type LeadfloPatient } from "../leadflo/index.js";

/*
 * Practice Overview → Leads received.
 *
 * This is the list behind that tile (`overview/leadsReceived`), from the
 * date asked to the date asked, with no stage, source, label or type sent.
 * Sending any of those would make a missing Lost lead look like zero losses.
 *
 * Nothing here is written to the feeder's lead book. That book is who
 * WhatsApp may contact. This list is only handed back to the caller.
 */

export const LEADS_RECEIVED_REPORT = "overview/leadsReceived";

const PAGE_SIZE = 50;
const MAX_PAGES = 200;

export type ReportedLead = {
  patientId: string;
  fullName: string;
  phone: string;
  email: string;
  treatmentType: string;
  source: string;
  stage: string;
  enquiredAt: string | null;
  labels: string[];
  isTestName: boolean;
};

export type LeadsReceivedResult = {
  ok: boolean;
  report: typeof LEADS_RECEIVED_REPORT;
  from: string;
  to: string;
  total: number;
  leads: ReportedLead[];
  skippedNoDate: number;
  /** False when Leadflo's own total was not all fetched. Caller must not save a short list. */
  complete: boolean;
  error?: string;
};

function hasEnquiryDate(patient: LeadfloPatient): boolean {
  const created = patient.created_at ?? (patient as { createdAt?: string }).createdAt;
  return Boolean(created && String(created).trim());
}

export async function pullLeadsReceived(
  client: LeadfloClient,
  from: string,
  to: string,
): Promise<LeadsReceivedResult> {
  const base: LeadsReceivedResult = {
    ok: false,
    report: LEADS_RECEIVED_REPORT,
    from,
    to,
    total: 0,
    leads: [],
    skippedNoDate: 0,
    complete: false,
  };
  if (!from.trim() || !to.trim()) {
    return { ...base, error: "from and to are required" };
  }

  let page = 1;
  let total = Infinity;
  let fetched = 0;
  const leads: ReportedLead[] = [];
  let skippedNoDate = 0;

  while (page <= MAX_PAGES && fetched < total) {
    const batch = await client.listPatients({
      report: LEADS_RECEIVED_REPORT,
      from,
      to,
      page,
      limit: PAGE_SIZE,
    });
    if (page === 1) {
      total = batch.total;
      if (batch.patients.length > 0 && !batch.patients.some(hasEnquiryDate)) {
        return { ...base, total, error: "no enquiry dates on the first page" };
      }
    }
    if (!batch.patients.length) break;
    for (const patient of batch.patients) {
      fetched += 1;
      if (!hasEnquiryDate(patient)) {
        skippedNoDate += 1;
        continue;
      }
      const lead = normalizePatient(patient);
      if (!lead?.enquiredAt) {
        skippedNoDate += 1;
        continue;
      }
      leads.push({
        patientId: lead.patientId,
        fullName: lead.fullName,
        phone: lead.phone,
        email: lead.email,
        treatmentType: lead.treatmentType,
        source: lead.source,
        stage: lead.stage,
        enquiredAt: lead.enquiredAt,
        labels: lead.labels,
        isTestName: lead.isTestName,
      });
    }
    if (batch.patients.length < PAGE_SIZE) break;
    page += 1;
  }

  const complete = Number.isFinite(total) && fetched >= total;
  if (!complete) {
    return {
      ...base,
      total: Number.isFinite(total) ? total : 0,
      skippedNoDate,
      error: "report did not finish",
    };
  }

  return {
    ok: true,
    report: LEADS_RECEIVED_REPORT,
    from,
    to,
    total,
    leads,
    skippedNoDate,
    complete: true,
  };
}
