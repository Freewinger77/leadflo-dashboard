import type { LeadfloTimelineItem } from "./types.js";

/**
 * When the patient actually enquired, read from their Leadflo timeline.
 *
 * Leadflo's patient record carries no creation date — only next_action_at,
 * which points forward — so the timeline is the only place the enquiry moment
 * exists. Without it a lead is dated by when our scraper first saw it, which
 * for anything discovered in a backfill is the backfill, not the enquiry.
 */
export function enquiryDateFromTimeline(
  items: readonly LeadfloTimelineItem[] | null | undefined,
): string | null {
  if (!items?.length) return null;

  const dated = items
    .map((item) => ({ item, at: Date.parse(String(item?.datetime ?? "")) }))
    .filter((entry) => Number.isFinite(entry.at));
  if (!dated.length) return null;

  // The form submission is what created the lead, so it is preferred over
  // simply the oldest entry: some patients were already known to the practice
  // and have an earlier phone call on file, and dating the lead from that would
  // place its arrival before it was ever a lead.
  const submissions = dated.filter(
    (entry) => String(entry.item.type ?? "").toLowerCase() === "form_submission",
  );
  const pool = submissions.length ? submissions : dated;

  const earliest = pool.reduce((a, b) => (a.at <= b.at ? a : b));
  return new Date(earliest.at).toISOString();
}
