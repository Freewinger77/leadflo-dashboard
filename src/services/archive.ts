import type { Store } from "../db/store.js";
import {
  ALL_LEADFLO_STAGES,
  createLeadfloClient,
  normalizePatient,
  type LeadfloClient,
} from "../leadflo/index.js";

export interface ArchiveScrapeOptions {
  /** Inclusive window start (YYYY-MM-DD). Default: 5 years ago. */
  from?: string;
  /** Inclusive window end (YYYY-MM-DD). Default: today (UTC). */
  to?: string;
  /** Restrict to treatment types. Empty / omitted = every type. */
  types?: string[];
  /** Restrict to stages. Empty / omitted = every Leadflo stage. */
  stages?: string[];
  /** Page size for Leadflo's patient table (SPA uses 50). */
  pageSize?: number;
  /** Hard stop so a runaway report cannot loop forever. */
  maxPages?: number;
}

export interface ArchiveScrapeResult {
  ok: boolean;
  from: string;
  to: string;
  pages: number;
  reportedTotal: number;
  fetched: number;
  upserted: number;
  created: number;
  updated: number;
  skipped: number;
  error?: string;
}

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultFrom(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 5);
  return utcDate(d);
}

function defaultTo(): string {
  return utcDate(new Date());
}

/**
 * Pull every patient Leadflo's Pipeline report will return for a date window
 * and upsert into SQLite. Does not dispatch webhooks — history ingest must
 * never fan out WhatsApp messages.
 */
export class ArchiveScraper {
  private running = false;
  private last: ArchiveScrapeResult | null = null;

  constructor(
    private readonly store: Store,
    private readonly client: LeadfloClient = createLeadfloClient(),
  ) {}

  get status(): { running: boolean; last: ArchiveScrapeResult | null } {
    return { running: this.running, last: this.last };
  }

  async scrape(opts: ArchiveScrapeOptions = {}): Promise<ArchiveScrapeResult> {
    if (this.running) {
      return {
        ok: false,
        from: opts.from ?? defaultFrom(),
        to: opts.to ?? defaultTo(),
        pages: 0,
        reportedTotal: 0,
        fetched: 0,
        upserted: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        error: "archive scrape already running",
      };
    }

    this.running = true;
    const from = opts.from ?? defaultFrom();
    const to = opts.to ?? defaultTo();
    const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);
    const maxPages = Math.min(Math.max(opts.maxPages ?? 200, 1), 500);
    const stages = opts.stages?.length ? opts.stages : [...ALL_LEADFLO_STAGES];
    const types = opts.types?.length ? opts.types : undefined;

    const result: ArchiveScrapeResult = {
      ok: true,
      from,
      to,
      pages: 0,
      reportedTotal: 0,
      fetched: 0,
      upserted: 0,
      created: 0,
      updated: 0,
      skipped: 0,
    };

    this.store.logEvent(
      "archive.started",
      `Archive scrape ${from} → ${to} (pageSize=${pageSize})`,
      null,
      { from, to, pageSize, types: types ?? null, stages },
    );

    try {
      let page = 1;
      let total = Infinity;

      while (page <= maxPages && result.fetched < total) {
        const batch = await this.client.listPatients({
          from,
          to,
          report: "pipeline",
          page,
          limit: pageSize,
          types,
          stages,
        });

        if (page === 1) {
          total = batch.total;
          result.reportedTotal = batch.total;
        }
        result.pages += 1;

        if (!batch.patients.length) break;

        for (const patient of batch.patients) {
          result.fetched += 1;
          const lead = normalizePatient(patient);
          if (!lead) {
            result.skipped += 1;
            continue;
          }
          const { isNew } = this.store.upsertScrapedLead(lead, {
            detailFetched: true,
          });
          result.upserted += 1;
          if (isNew) result.created += 1;
          else result.updated += 1;
        }

        if (batch.patients.length < pageSize) break;
        if (result.fetched >= total) break;
        page += 1;
      }

      this.store.logEvent(
        "archive.finished",
        `Archive scrape done: ${result.created} new, ${result.updated} updated, ${result.fetched}/${result.reportedTotal} fetched`,
        null,
        { ...result },
      );
    } catch (err) {
      result.ok = false;
      result.error = err instanceof Error ? err.message : String(err);
      this.store.logEvent("archive.failed", result.error);
    } finally {
      this.running = false;
      this.last = result;
    }

    return result;
  }
}
