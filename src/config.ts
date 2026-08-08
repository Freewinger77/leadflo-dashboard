import "dotenv/config";
import path from "node:path";

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value?.trim()) return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

export const config = {
  port: Number(process.env.PORT ?? 8788),
  host: process.env.HOST ?? "0.0.0.0",
  leadflo: {
    email: process.env.LEADFLO_EMAIL ?? "",
    password: process.env.LEADFLO_PASSWORD ?? "",
    apiBase: (process.env.LEADFLO_API_BASE ?? "https://api.app.leadflo.com").replace(
      /\/$/,
      "",
    ),
    appOrigin: process.env.LEADFLO_APP_ORIGIN ?? "https://app.leadflo.com",
    mode: (process.env.LEADFLO_MODE ?? "live").toLowerCase() as "live" | "mock",
    /** Optional HTTP(S) proxy to bypass datacenter WAF blocks */
    httpProxy: process.env.LEADFLO_HTTP_PROXY ?? process.env.HTTPS_PROXY ?? "",
  },
  trackedTreatmentTypes: list(process.env.TRACKED_TREATMENT_TYPES, ["Implant"]).map((t) =>
    t.toLowerCase(),
  ),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 60_000),
  scrapeStages: list(process.env.SCRAPE_STAGES, [
    "newLead",
    "callback1",
    "callback2",
    "callback3",
    "working",
    "thinking",
    "consultation",
    "txPlanConsult",
    "inTx",
  ]),
  /** Discovery is wider than dispatch: later stages are tracked for funnel
   *  reporting but must not trigger outbound contact. */
  webhookStages: list(process.env.WEBHOOK_STAGES, [
    "newLead",
    "callback1",
    "callback2",
    "callback3",
    "working",
  ]),
  /** Re-read a known lead's patient record at most this often. */
  stageRefreshIntervalMs: Number(process.env.STAGE_REFRESH_INTERVAL_MS ?? 15 * 60_000),
  /** Cap patient refreshes per tick to bound API volume. */
  stageRefreshBatchSize: Number(process.env.STAGE_REFRESH_BATCH_SIZE ?? 25),
  webhookUrl: process.env.WEBHOOK_URL ?? "",
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  /** WF-1 outbound feeder. Every gate here defaults to the safe value: the
   *  feeder previews but refuses to hand out a sendable batch until it is
   *  deliberately switched on. */
  outbound: {
    enabled: bool(process.env.OUTBOUND_ENABLED, false),
    /** Restrict live sends to known testers until the first run is signed off. */
    allowlistOnly: bool(process.env.OUTBOUND_ALLOWLIST_ONLY, true),
    allowlist: list(process.env.OUTBOUND_ALLOWLIST, []).map(digitsOnly).filter(Boolean),
    maxPerRun: Number(process.env.OUTBOUND_MAX_PER_RUN ?? 1),
    maxPerDay: Number(process.env.OUTBOUND_MAX_PER_DAY ?? 5),
    /** A claimed batch that never reports back is reclaimable after this. */
    lockTtlMs: Number(process.env.OUTBOUND_LOCK_TTL_MS ?? 15 * 60_000),
    /** Shared secret WF-1 must present to claim a batch or report results. */
    apiKey: process.env.WF1_API_KEY ?? "",
    /** Country code assumed for local-format numbers (UK practice). */
    defaultCountryCode: process.env.OUTBOUND_COUNTRY_CODE ?? "44",
    /**
     * Countries the practice will message unprompted. Allowlisted numbers
     * bypass this, so a tester abroad does not need the policy widened.
     */
    allowedCountryCodes: list(process.env.OUTBOUND_ALLOWED_COUNTRIES, ["44"]).map(
      digitsOnly,
    ),
  },
  notesOnlyTestNames: bool(process.env.NOTES_ONLY_TEST_NAMES, true),
  inboundWebhookSecret: process.env.INBOUND_WEBHOOK_SECRET ?? "",
  databasePath: path.resolve(process.env.DATABASE_PATH ?? "./data/leadflo.db"),
  practiceName: process.env.PRACTICE_NAME ?? "Dental Asthetica",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
};

export function assertLiveConfig(): void {
  if (config.leadflo.mode === "mock") return;
  if (!config.leadflo.email || !config.leadflo.password) {
    throw new Error("LEADFLO_EMAIL and LEADFLO_PASSWORD are required in live mode");
  }
}
