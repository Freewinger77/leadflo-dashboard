#!/usr/bin/env npx tsx
/**
 * One-shot: scrape Leadflo Reporting → Overview / Losses and write a CSV.
 *
 * Env:
 *   LEADFLO_EMAIL, LEADFLO_PASSWORD, LEADFLO_HTTP_PROXY (optional)
 *   REPORT   default overview/losses
 *   FROM     default 2025-08-28T00:00:00.000Z  (past year)
 *   TO       default 2026-08-28T23:59:59.999Z
 *   OUT      default /tmp/leadflo-losses.csv
 *   OMIT_IDS default true — drop id / patient_id columns
 *   EXCLUDE_COLUMNS optional comma-separated extra columns to drop
 */
import fs from "node:fs";
import path from "node:path";
import { LiveLeadfloClient } from "../src/leadflo/liveClient.js";

const REPORT = process.env.REPORT ?? "overview/losses";
const FROM = process.env.FROM ?? "2025-08-28T00:00:00.000Z";
const TO = process.env.TO ?? "2026-08-28T23:59:59.999Z";
const OUT = process.env.OUT ?? "/tmp/leadflo-losses.csv";
const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 50);
const OMIT_IDS = (process.env.OMIT_IDS ?? "true").toLowerCase() !== "false";

const EXCLUDE = new Set(
  [
    ...(OMIT_IDS ? ["id", "patient_id"] : []),
    ...(process.env.EXCLUDE_COLUMNS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ].map((s) => s.toLowerCase()),
);

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s =
    typeof value === "string"
      ? value
      : Array.isArray(value) || typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function flattenPatient(p: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (EXCLUDE.has(k.toLowerCase())) continue;
    if (v === null || v === undefined) {
      out[k] = "";
    } else if (Array.isArray(v) || typeof v === "object") {
      out[k] = JSON.stringify(v);
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

async function main() {
  if (!process.env.LEADFLO_EMAIL || !process.env.LEADFLO_PASSWORD) {
    throw new Error("LEADFLO_EMAIL and LEADFLO_PASSWORD are required");
  }

  // Force live client regardless of LEADFLO_MODE in App Service settings.
  process.env.LEADFLO_MODE = "live";

  const client = new LiveLeadfloClient();
  await client.login();

  const patients: Record<string, unknown>[] = [];
  let page = 1;
  let total = Infinity;

  console.log(`Scraping report=${REPORT} from=${FROM} to=${TO} omitIds=${OMIT_IDS}`);

  while (patients.length < total && page <= 200) {
    const batch = await client.listPatients({
      report: REPORT,
      from: FROM,
      to: TO,
      page,
      limit: PAGE_SIZE,
    });
    if (page === 1) {
      total = batch.total;
      console.log(`Leadflo reports total=${total}`);
    }
    console.log(
      `page ${page}: got ${batch.patients.length} (have ${patients.length + batch.patients.length}/${total})`,
    );
    for (const p of batch.patients) {
      patients.push(p as unknown as Record<string, unknown>);
    }
    if (!batch.patients.length) break;
    if (batch.patients.length < PAGE_SIZE) break;
    page += 1;
  }

  const flat = patients.map((p) => flattenPatient(p));
  const columns = Array.from(
    flat.reduce((set, row) => {
      for (const k of Object.keys(row)) set.add(k);
      return set;
    }, new Set<string>()),
  ).sort((a, b) => {
    const preferred = [
      "first_name",
      "last_name",
      "name",
      "email",
      "phone",
      "phone_number",
      "stage",
      "type",
      "source",
      "labels",
      "next_action_at",
      "value",
      "gdpr",
      "created_at",
      "marketing_consent",
    ];
    const ia = preferred.indexOf(a);
    const ib = preferred.indexOf(b);
    if (ia !== -1 || ib !== -1) {
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    }
    return a.localeCompare(b);
  });

  const lines = [
    columns.map(csvEscape).join(","),
    ...flat.map((row) => columns.map((c) => csvEscape(row[c] ?? "")).join(",")),
  ];
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${patients.length} rows → ${OUT}`);
  console.log(`Columns (${columns.length}): ${columns.join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
