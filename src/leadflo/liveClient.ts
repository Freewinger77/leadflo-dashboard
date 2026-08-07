import { randomUUID } from "node:crypto";
import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { config } from "../config.js";
import type {
  LeadfloAction,
  LeadfloClient,
  LeadfloPatient,
  LeadfloTimelineItem,
} from "./types.js";

type FetchFn = (input: string, init?: UndiciRequestInit) => Promise<Response>;

interface CookieJar {
  [name: string]: string;
}

function parseSetCookie(header: string | null): CookieJar {
  const jar: CookieJar = {};
  if (!header) return jar;
  // Node fetch joins multiple set-cookie with comma in some versions; handle carefully
  const parts = header.split(/,(?=[^;]+?=)/);
  for (const part of parts) {
    const [pair] = part.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) jar[name] = value;
  }
  return jar;
}

export class LiveLeadfloClient implements LeadfloClient {
  private cookies: CookieJar = {};
  private loggedIn = false;
  private lastLoginAt = 0;
  private readonly fetchImpl: FetchFn;

  constructor(
    private readonly email = config.leadflo.email,
    private readonly password = config.leadflo.password,
    private readonly apiBase = config.leadflo.apiBase,
    private readonly appOrigin = config.leadflo.appOrigin,
    httpProxy = config.leadflo.httpProxy,
  ) {
    if (httpProxy) {
      const agent = new ProxyAgent(httpProxy);
      this.fetchImpl = (input, init) =>
        undiciFetch(input, { ...init, dispatcher: agent }) as unknown as Promise<Response>;
    } else {
      this.fetchImpl = (input, init) =>
        undiciFetch(input, init) as unknown as Promise<Response>;
    }
  }

  private cookieHeader(): string {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  private xsrfToken(): string {
    const raw = this.cookies["XSRF-TOKEN"];
    return raw ? decodeURIComponent(raw) : "";
  }

  private mergeCookies(res: Response): void {
    // undici/node exposes getSetCookie when available
    const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
    const list =
      typeof anyHeaders.getSetCookie === "function"
        ? anyHeaders.getSetCookie()
        : [];
    if (list.length) {
      for (const c of list) {
        Object.assign(this.cookies, parseSetCookie(c));
      }
      return;
    }
    Object.assign(this.cookies, parseSetCookie(res.headers.get("set-cookie")));
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T; rawText: string }> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      Origin: this.appOrigin,
      Referer: `${this.appOrigin}/`,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
      "X-Requested-With": "XMLHttpRequest",
    };
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    const xsrf = this.xsrfToken();
    if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = (await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    })) as unknown as Response;
    this.mergeCookies(res);
    const rawText = await res.text();
    let data: T = undefined as T;
    if (rawText) {
      try {
        data = JSON.parse(rawText) as T;
      } catch {
        data = rawText as unknown as T;
      }
    }
    return { status: res.status, data, rawText };
  }

  async login(): Promise<void> {
    const csrf = await this.request("GET", "/auth/csrf-token");
    if (csrf.status !== 200) {
      throw new Error(
        `Leadflo CSRF failed (${csrf.status}). Often AWS WAF blocks datacenter IPs. Body: ${csrf.rawText.slice(0, 160)}`,
      );
    }

    const session = await this.request("POST", "/auth/session", {
      email: this.email,
      password: this.password,
    });

    if (session.status === 403 && /Forbidden/i.test(session.rawText)) {
      throw new Error(
        "Leadflo login blocked by WAF (403 from awselb). Run this service from a non-datacenter IP (local machine, residential VPS, or with LEADFLO_HTTP_PROXY). Set LEADFLO_MODE=mock for local UI testing.",
      );
    }
    if (session.status < 200 || session.status >= 300) {
      throw new Error(
        `Leadflo login failed (${session.status}): ${session.rawText.slice(0, 300)}`,
      );
    }

    this.loggedIn = true;
    this.lastLoginAt = Date.now();
  }

  async ensureSession(): Promise<void> {
    const stale = Date.now() - this.lastLoginAt > 60 * 60 * 1000;
    if (!this.loggedIn || stale) {
      await this.login();
      return;
    }
    const check = await this.request("GET", "/auth/session");
    if (check.status === 401 || check.status === 403 || check.status === 419) {
      await this.login();
    }
  }

  async getDueActions(stages: string[]): Promise<LeadfloAction[]> {
    await this.ensureSession();
    // Match axios default array serialization used by the Leadflo SPA: stages[]=a&stages[]=b
    const params = new URLSearchParams();
    for (const stage of stages) params.append("stages[]", stage);

    const res = await this.request<unknown>("GET", `/actions/due?${params.toString()}`);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `getDueActions failed (${res.status}): ${res.rawText.slice(0, 300)}`,
      );
    }
    return normalizeActions(res.data);
  }

  async getPatient(patientId: string): Promise<LeadfloPatient> {
    await this.ensureSession();
    const res = await this.request<LeadfloPatient>(
      "GET",
      `/v3/patients/${encodeURIComponent(patientId)}`,
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `getPatient failed (${res.status}): ${res.rawText.slice(0, 300)}`,
      );
    }
    const data = res.data as LeadfloPatient & { data?: LeadfloPatient };
    return (data?.data ?? data) as LeadfloPatient;
  }

  async getTimeline(patientId: string): Promise<LeadfloTimelineItem[]> {
    await this.ensureSession();
    const res = await this.request<{ items?: LeadfloTimelineItem[] } | LeadfloTimelineItem[]>(
      "GET",
      `/v3/patients/${encodeURIComponent(patientId)}/timeline`,
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `getTimeline failed (${res.status}): ${res.rawText.slice(0, 300)}`,
      );
    }
    const data = res.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object" && Array.isArray(data.items)) {
      return data.items;
    }
    return [];
  }

  async addNote(patientId: string, content: string, title = ""): Promise<void> {
    await this.ensureSession();
    const payload = {
      id: randomUUID(),
      title,
      content,
    };
    const res = await this.request(
      "POST",
      `/v3/patients/${encodeURIComponent(patientId)}/notes`,
      payload,
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `addNote failed (${res.status}): ${res.rawText.slice(0, 300)}`,
      );
    }
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const csrf = await this.request("GET", "/auth/csrf-token");
      if (csrf.status !== 200) {
        return { ok: false, detail: `csrf ${csrf.status}` };
      }
      if (!this.email || !this.password) {
        return { ok: true, detail: "csrf ok (credentials not set)" };
      }
      await this.ensureSession();
      return { ok: true, detail: "authenticated" };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

function normalizeActions(data: unknown): LeadfloAction[] {
  if (!data) return [];
  if (Array.isArray(data)) {
    return data.map(coerceAction).filter(Boolean) as LeadfloAction[];
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    // Common shapes: { data: [] }, { actions: [] }, { newLead: [] }, map by stage
    for (const key of ["data", "actions", "results"]) {
      if (Array.isArray(obj[key])) {
        return (obj[key] as unknown[]).map(coerceAction).filter(Boolean) as LeadfloAction[];
      }
    }
    const collected: LeadfloAction[] = [];
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          const a = coerceAction(item);
          if (a) collected.push(a);
        }
      } else if (value && typeof value === "object") {
        const nested = value as Record<string, unknown>;
        if (Array.isArray(nested.actions)) {
          for (const item of nested.actions) {
            const a = coerceAction(item);
            if (a) collected.push(a);
          }
        } else {
          // maybe the action itself is wrapped: { action: {...} }
          const a = coerceAction(value);
          if (a) collected.push(a);
        }
      }
    }
    return collected;
  }
  return [];
}

function coerceAction(item: unknown): LeadfloAction | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const action = (raw.action && typeof raw.action === "object"
    ? (raw.action as Record<string, unknown>)
    : raw) as Record<string, unknown>;

  const patientId = String(
    action.patient_id ?? action.patientId ?? action.id ?? "",
  );
  if (!patientId) return null;

  return {
    patient_id: patientId,
    stage: String(action.stage ?? "unknown"),
    first_name: String(action.first_name ?? action.firstName ?? ""),
    last_name: String(action.last_name ?? action.lastName ?? ""),
    phone: String(action.phone ?? ""),
    type: String(action.type ?? action.tx_type ?? action.treatment_type ?? ""),
    date: action.date ? String(action.date) : undefined,
    snooze: (action.snooze as LeadfloAction["snooze"]) ?? null,
    source: action.source ? String(action.source) : undefined,
    email: action.email ? String(action.email) : undefined,
    labels: Array.isArray(action.labels)
      ? action.labels.map(String)
      : undefined,
  };
}
