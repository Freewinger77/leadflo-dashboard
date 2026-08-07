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
  ]),
  webhookUrl: process.env.WEBHOOK_URL ?? "",
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  notesOnlyTestNames: bool(process.env.NOTES_ONLY_TEST_NAMES, true),
  inboundWebhookSecret: process.env.INBOUND_WEBHOOK_SECRET ?? "",
  databasePath: path.resolve(process.env.DATABASE_PATH ?? "./data/leadflo.db"),
};

export function assertLiveConfig(): void {
  if (config.leadflo.mode === "mock") return;
  if (!config.leadflo.email || !config.leadflo.password) {
    throw new Error("LEADFLO_EMAIL and LEADFLO_PASSWORD are required in live mode");
  }
}
