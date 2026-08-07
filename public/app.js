const NAV = [
  { id: "dashboard", label: "Dashboard", ico: "⚡" },
  { id: "leads", label: "Leads", ico: "▦" },
  { id: "activity", label: "Activity", ico: "☰" },
  { id: "scraper", label: "Scraper", ico: "⚙" },
  { id: "docs", label: "API docs", ico: "{}" },
];

const TYPE_COLORS = [
  "rgb(28,28,30)",
  "var(--indigo)",
  "var(--teal)",
  "var(--green)",
  "var(--yellow)",
  "var(--pink)",
  "var(--purple)",
  "var(--blue)",
];

const state = {
  screen: "dashboard",
  status: null,
  leads: [],
  events: [],
  analytics: null,
  selectedId: null,
  drawer: null,
  leadFilter: "all",
  nextPollAt: Date.now() + 60_000,
  toastTimer: null,
};

const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function initials(name) {
  const parts = String(name || "?")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0][0] || "") + (parts[1]?.[0] || "")).toUpperCase();
}

function ago(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtDuration(ms) {
  if (ms == null) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function stageLabel(stage) {
  const map = {
    newLead: "New lead",
    callback1: "Call attempt 1",
    callback2: "Call attempt 2",
    callback3: "Call attempt 3",
    working: "In discussion",
    thinking: "Thinking",
    consultation: "Consultation",
  };
  return map[stage] || stage || "—";
}

function statusMeta(status) {
  const map = {
    note_written: { label: "Note written", short: "Written", cls: "ok" },
    webhook_sent: { label: "Webhook sent", short: "Webhook", cls: "info" },
    webhook_pending: { label: "Webhook pending", short: "Pending", cls: "warn" },
    ai_received: { label: "AI received", short: "AI", cls: "info" },
    note_skipped: { label: "Note skipped", short: "Skipped", cls: "warn" },
    note_failed: { label: "Note failed", short: "Failed", cls: "err" },
    webhook_failed: { label: "Webhook failed", short: "Failed", cls: "err" },
    discovered: { label: "Discovered", short: "New", cls: "warn" },
  };
  return map[status] || { label: status || "—", short: status || "—", cls: "" };
}

function isTracked(lead) {
  const types = state.status?.config?.trackedTypes || ["implant"];
  const t = String(lead.treatmentType || "").toLowerCase();
  return types.some((x) => t === x || t.includes(x));
}

function toast(msg) {
  const node = el("toast");
  node.textContent = msg;
  node.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 2800);
}

function eventTitle(kind, message) {
  if (kind === "poll.ok") return "Poll run completed";
  if (kind === "poll.error") return "Poll failed";
  if (kind === "poller.started") return "Poller started";
  if (kind === "lead.discovered") return "Lead discovered";
  if (kind === "lead.tracked") return "Lead tracked";
  if (kind === "webhook.sent") return message?.includes("Resent") ? "Webhook resent" : "Webhook sent";
  if (kind === "webhook.skipped") return "Webhook skipped";
  if (kind === "webhook.failed") return "Webhook failed";
  if (kind === "ai.received") return "AI response received";
  if (kind === "note.written") return "Note written to Leadflo";
  if (kind === "note.skipped") return "Note skipped";
  if (kind === "note.failed") return "Note failed";
  if (kind === "notes.polled") return "Notes polled";
  return kind;
}

function renderNav() {
  const trackedCount = state.leads.filter(isTracked).length;
  const mk = (target) =>
    NAV.map(
      (item) => `
      <button class="nav-item ${state.screen === item.id ? "active" : ""}" data-nav="${item.id}" type="button">
        <span class="ico">${item.ico}</span>
        <span>${item.label}</span>
        ${item.id === "leads" && trackedCount ? `<span class="nav-count">${trackedCount}</span>` : ""}
      </button>`,
    ).join("");

  el("sideNav").innerHTML = mk("side");
  el("bottomNav").innerHTML = NAV.map(
    (item) => `
    <button class="${state.screen === item.id ? "active" : ""}" data-nav="${item.id}" type="button">
      <span class="ico">${item.ico}</span>${item.label.split(" ")[0]}
    </button>`,
  ).join("");

  document.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-nav");
      if (id === "docs") {
        window.location.href = "/docs.html";
        return;
      }
      state.screen = id;
      closeDrawer();
      render();
    });
  });
}

function updateChrome() {
  const status = state.status;
  el("practiceName").textContent = status?.practiceName || status?.config?.practiceName || "Dental Asthetica";
  el("screenTitle").textContent = NAV.find((n) => n.id === state.screen)?.label || "Dashboard";
  el("modeText").textContent = status?.mode === "live" ? "live mode" : `${status?.mode || "…"} mode`;
  const last = status?.latestPoll?.finished_at || status?.latestPoll?.started_at;
  el("lastPollLabel").textContent = last ? `Last poll ${ago(last)}` : "Last poll —";

  const interval = status?.config?.pollIntervalMs || 60_000;
  const remain = Math.max(0, Math.round((state.nextPollAt - Date.now()) / 1000));
  el("pollerSub").textContent = `Next run in ${remain}s · every ${Math.round(interval / 1000)}s`;
}

function buildLineChart(series) {
  const w = 760;
  const h = 216;
  const padL = 28;
  const padR = 8;
  const padT = 12;
  const padB = 28;
  const max = Math.max(1, ...series.map((d) => Math.max(d.count, d.tracked)));
  const grid = [0, 0.33, 0.66, 1].map((t) => {
    const val = Math.round(max * (1 - t));
    const y = padT + t * (h - padT - padB);
    return { y, ty: y + 4, label: String(Math.round(max * (1 - t))) };
  });
  const xAt = (i) => padL + (i / Math.max(1, series.length - 1)) * (w - padL - padR);
  const yAt = (v) => padT + (1 - v / max) * (h - padT - padB);
  const pathFor = (key) =>
    series
      .map((d, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(d[key]).toFixed(1)}`)
      .join(" ");
  const area =
    `${pathFor("count")} L${xAt(series.length - 1).toFixed(1)},${(h - padB).toFixed(1)} L${xAt(0).toFixed(1)},${(h - padB).toFixed(1)} Z`;
  const labels = series
    .map((d, i) => {
      if (series.length > 16 && i % Math.ceil(series.length / 8) !== 0 && i !== series.length - 1)
        return "";
      const dt = new Date(d.date + "T00:00:00Z");
      const label = dt.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
      return `<text x="${xAt(i)}" y="${h - 8}" text-anchor="middle" fill="rgba(0,0,0,0.35)" font-size="11" font-family="Inter,sans-serif">${label}</text>`;
    })
    .join("");

  return `
    <div class="chart-wrap" id="dayChart" data-series='${escapeHtml(JSON.stringify(series))}'>
      <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Leads by day">
        <defs>
          <linearGradient id="lfArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(0,0,0,0.10)"></stop>
            <stop offset="100%" stop-color="rgba(0,0,0,0)"></stop>
          </linearGradient>
        </defs>
        ${grid
          .map(
            (g) => `
          <line x1="${padL}" y1="${g.y}" x2="${w}" y2="${g.y}" stroke="rgba(0,0,0,0.06)" stroke-width="1"></line>
          <text x="0" y="${g.ty}" fill="rgba(0,0,0,0.35)" font-size="11" font-family="Inter,sans-serif">${g.label}</text>`,
          )
          .join("")}
        <path d="${area}" fill="url(#lfArea)"></path>
        <path d="${pathFor("count")}" fill="none" stroke="rgb(28,28,30)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
        <path d="${pathFor("tracked")}" fill="none" stroke="rgb(173,173,251)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
        ${labels}
      </svg>
      <div class="chart-tip" id="dayTip" hidden></div>
    </div>`;
}

function buildDonut(byType, total) {
  const slices = byType.length
    ? byType
    : [{ type: "None yet", count: 1, tracked: false, _empty: true }];
  const sum = slices.reduce((a, s) => a + s.count, 0) || 1;
  const r = 78;
  const cx = 100;
  const cy = 100;
  let angle = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const frac = s.count / sum;
    const a2 = angle + frac * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy + r * Math.sin(a2);
    const large = frac > 0.5 ? 1 : 0;
    const color = TYPE_COLORS[i % TYPE_COLORS.length];
    const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
    angle = a2;
    return { ...s, color, d, pct: Math.round(frac * 100) };
  });

  return `
    <div class="donut-layout">
      <div class="donut-center-wrap">
        <svg viewBox="0 0 200 200" width="200" height="200" aria-label="Lead type mix">
          ${arcs.map((a) => `<path d="${a.d}" fill="${a.color}" stroke="#fff" stroke-width="2"></path>`).join("")}
          <circle cx="100" cy="100" r="52" fill="#fff"></circle>
        </svg>
        <div class="donut-center">
          <div class="big">${total}</div>
          <div class="sub">leads · ${state.analytics?.days || 30}d</div>
        </div>
      </div>
      <div class="donut-legend">
        ${arcs
          .filter((a) => !a._empty)
          .map(
            (a) => `
          <div class="donut-row">
            <span class="swatch" style="background:${a.color}"></span>
            <span>${escapeHtml(a.type)} ${a.tracked ? `<span class="tracked-chip">tracked</span>` : ""}</span>
            <span class="muted">${a.count}</span>
            <strong>${a.pct}%</strong>
          </div>`,
          )
          .join("") || `<div class="empty">No types yet — scrape to populate.</div>`}
      </div>
    </div>`;
}

function renderDashboard() {
  const a = state.analytics || {
    leadsPerDay: [],
    byType: [],
    totals: { discovered: 0, tracked: 0, notesWritten: 0, medianTimeToNoteMs: null },
    days: 30,
  };
  const trackedLeads = state.leads.filter(isTracked);
  const metrics = [
    {
      label: "Leads discovered",
      value: a.totals.discovered,
      delta: "",
      sub: `last ${a.days} days`,
    },
    {
      label: "Implant leads tracked",
      value: a.totals.tracked,
      delta: "",
      sub: "sent to your webhook",
    },
    {
      label: "AI notes written",
      value: a.totals.notesWritten,
      delta: "",
      sub: "test-named leads only",
    },
    {
      label: "Median time to note",
      value: fmtDuration(a.totals.medianTimeToNoteMs),
      delta: "",
      sub: "scrape → Leadflo note",
    },
  ];

  return `
    <div class="grid-12">
      <div class="span-12">
        <div class="metrics">
          ${metrics
            .map(
              (m) => `
            <article class="metric">
              <div class="label">${m.label}</div>
              <div class="row"><div class="value">${m.value}</div>${m.delta ? `<div class="delta">${m.delta}</div>` : ""}</div>
              <div class="sub">${m.sub}</div>
            </article>`,
            )
            .join("")}
        </div>
      </div>

      <div class="span-8">
        <section class="card">
          <div class="card-head">
            <div>
              <h2>Leads by day</h2>
              <p>Last ${a.days} days · scraped from Leadflo /actions/due</p>
            </div>
            <div class="legend">
              <div class="legend-item"><span class="swatch" style="background:rgb(28,28,30)"></span>All leads</div>
              <div class="legend-item"><span class="swatch" style="background:var(--indigo)"></span>Implant (tracked)</div>
            </div>
          </div>
          ${buildLineChart(a.leadsPerDay)}
        </section>
      </div>

      <div class="span-4">
        <section class="card">
          <div class="card-head">
            <div>
              <h2>Lead type mix</h2>
              <p>Treatment type on every discovered lead</p>
            </div>
          </div>
          ${buildDonut(a.byType, a.totals.discovered)}
        </section>
      </div>

      <div class="span-7">
        <section class="card">
          <div class="card-head">
            <div>
              <h2>Tracked implant leads</h2>
              <p>New leads hit your webhook once. Notes write back only for names containing <em>test</em>.</p>
            </div>
            <button class="linkish" data-go="leads" type="button">View all</button>
          </div>
          <div class="table-wrap desktop-table">
            <table class="leads">
              <thead><tr><th>Lead</th><th>Type</th><th>Stage</th><th>Status</th><th>Seen</th></tr></thead>
              <tbody>
                ${
                  trackedLeads.length
                    ? trackedLeads
                        .slice(0, 8)
                        .map((l) => leadRow(l))
                        .join("")
                    : `<tr><td colspan="5" class="empty">No tracked leads yet. Click “Scrape now”.</td></tr>`
                }
              </tbody>
            </table>
          </div>
          <div class="lead-list mobile-cards">
            ${
              trackedLeads.length
                ? trackedLeads
                    .slice(0, 8)
                    .map((l) => leadCard(l))
                    .join("")
                : `<div class="empty">No tracked leads yet.</div>`
            }
          </div>
        </section>
      </div>

      <div class="span-5">
        <section class="card">
          <div class="card-head">
            <div>
              <h2>Activity</h2>
              <p>Poll runs, webhooks, and note writes.</p>
            </div>
            <button class="linkish" data-go="activity" type="button">Full log</button>
          </div>
          <div class="activity">
            ${
              state.events.length
                ? state.events
                    .slice(0, 10)
                    .map(
                      (e) => `
              <div class="activity-item">
                <div class="activity-top">
                  <div class="activity-title">${escapeHtml(eventTitle(e.kind, e.message))}</div>
                  <div class="activity-time">${ago(e.created_at)}</div>
                </div>
                <div class="activity-detail">${escapeHtml(e.message)}</div>
              </div>`,
                    )
                    .join("")
                : `<div class="empty">No events yet.</div>`
            }
          </div>
        </section>
      </div>
    </div>`;
}

function leadRow(l) {
  const st = statusMeta(l.status);
  return `<tr data-lead="${escapeHtml(l.patientId)}" class="${state.selectedId === l.patientId ? "active" : ""}">
    <td><div class="lead-cell">
      <div class="avatar">${escapeHtml(initials(l.fullName))}</div>
      <div><div class="lead-name">${escapeHtml(l.fullName)}</div><div class="lead-phone">${escapeHtml(l.phone || "—")}</div></div>
    </div></td>
    <td>${escapeHtml(l.treatmentType || "—")}</td>
    <td>${escapeHtml(stageLabel(l.stage))}</td>
    <td><span class="pill ${st.cls}">${escapeHtml(st.label)}</span></td>
    <td class="muted small">${ago(l.lastSeenAt || l.firstSeenAt)}</td>
  </tr>`;
}

function leadCard(l) {
  const st = statusMeta(l.status);
  return `<button class="lead-card" data-lead="${escapeHtml(l.patientId)}" type="button">
    <div class="avatar">${escapeHtml(initials(l.fullName))}</div>
    <div class="meta">
      <div class="lead-name">${escapeHtml(l.fullName)}${l.isTestName ? ' <span class="pill warn">test</span>' : ""}</div>
      <div class="lead-phone">${escapeHtml(l.treatmentType || "—")} · ${escapeHtml(l.source || "—")}</div>
    </div>
    <div>
      <span class="pill ${st.cls}">${escapeHtml(st.short)}</span>
      <div class="muted small" style="margin-top:4px;text-align:right">${ago(l.lastSeenAt || l.firstSeenAt)}</div>
    </div>
  </button>`;
}

function renderLeads() {
  let list = [...state.leads];
  if (state.leadFilter === "implant") list = list.filter(isTracked);
  if (state.leadFilter === "attention") {
    list = list.filter((l) =>
      ["note_failed", "webhook_failed", "webhook_pending", "discovered"].includes(l.status),
    );
  }
  const tracked = state.leads.filter(isTracked).length;
  return `
    <section class="card">
      <div class="card-head">
        <div>
          <h2>All leads</h2>
          <p>${list.length} of ${state.leads.length} leads · ${tracked} implant tracked</p>
        </div>
      </div>
      <div class="filters">
        ${[
          ["all", "All"],
          ["implant", "Implant only"],
          ["attention", "Needs attention"],
        ]
          .map(
            ([id, label]) =>
              `<button class="chip ${state.leadFilter === id ? "active" : ""}" data-filter="${id}" type="button">${label}</button>`,
          )
          .join("")}
      </div>
      <div class="table-wrap desktop-table">
        <table class="leads">
          <thead><tr><th>Lead</th><th>Type</th><th>Source</th><th>Stage</th><th>Status</th><th>Seen</th></tr></thead>
          <tbody>
            ${
              list.length
                ? list
                    .map((l) => {
                      const st = statusMeta(l.status);
                      return `<tr data-lead="${escapeHtml(l.patientId)}" class="${state.selectedId === l.patientId ? "active" : ""}">
                        <td><div class="lead-cell">
                          <div class="avatar">${escapeHtml(initials(l.fullName))}</div>
                          <div>
                            <div class="lead-name">${escapeHtml(l.fullName)} ${l.isTestName ? '<span class="pill warn">test</span>' : ""}</div>
                            <div class="lead-phone">${escapeHtml(l.email || l.phone || "—")}</div>
                          </div>
                        </div></td>
                        <td>${escapeHtml(l.treatmentType || "—")}</td>
                        <td>${escapeHtml(l.source || "—")}</td>
                        <td>${escapeHtml(stageLabel(l.stage))}</td>
                        <td><span class="pill ${st.cls}">${escapeHtml(st.label)}</span></td>
                        <td class="muted small">${ago(l.lastSeenAt || l.firstSeenAt)}</td>
                      </tr>`;
                    })
                    .join("")
                : `<tr><td colspan="6" class="empty">No leads match this filter.</td></tr>`
            }
          </tbody>
        </table>
      </div>
      <div class="lead-list mobile-cards">
        ${list.length ? list.map((l) => leadCard(l)).join("") : `<div class="empty">No leads match this filter.</div>`}
      </div>
    </section>`;
}

function renderActivity() {
  return `
    <section class="card">
      <div class="card-head">
        <div>
          <h2>Event log</h2>
          <p>GET /api/events — poll, webhook and note events, newest first.</p>
        </div>
      </div>
      <div class="activity" style="max-height:none">
        ${
          state.events.length
            ? state.events
                .map(
                  (e) => `
          <div class="activity-item">
            <div class="activity-top">
              <div class="activity-title">${escapeHtml(eventTitle(e.kind, e.message))}</div>
              <div class="activity-time">${ago(e.created_at)}</div>
            </div>
            <div class="activity-detail"><span class="pill warn">${escapeHtml(e.kind)}</span> ${escapeHtml(e.message)}</div>
          </div>`,
                )
                .join("")
            : `<div class="empty">No events yet.</div>`
        }
      </div>
    </section>`;
}

function renderScraper() {
  const c = state.status?.config || {};
  const interval = c.pollIntervalMs || 60000;
  const types = state.analytics?.byType || [];
  return `
    <div class="scraper-grid">
      <section class="card">
        <div class="card-head"><div><h2>Poll frequency</h2><p>How often the scraper hits Leadflo /actions/due.</p></div></div>
        <div class="kv">
          <div class="kv-row"><span>Interval</span><strong>${Math.round(interval / 1000)}s</strong></div>
          <div class="kv-row"><span>pollIntervalMs</span><code>${interval}</code></div>
          <div class="kv-row"><span>Runs / day</span><strong>~${Math.round(86400000 / interval)}</strong></div>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Tracked treatment types</h2><p>Leads outside this list are logged but never sent to your webhook.</p></div></div>
        <div class="kv">
          ${(c.trackedTypes || ["implant"])
            .map((t) => {
              const count = types.find((x) => x.type.toLowerCase().includes(t))?.count || 0;
              return `<div class="kv-row"><span>✓ ${escapeHtml(t)}</span><strong>${count}</strong></div>`;
            })
            .join("")}
        </div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Write-back rules</h2><p>Controls when an AI response becomes a Leadflo note.</p></div></div>
        <div class="kv">
          <div class="kv-row"><span>NOTES_ONLY_TEST_NAMES</span><strong>${c.notesOnlyTestNames ? "true" : "false"}</strong></div>
          <div class="kv-row"><span>Hint</span><span class="muted small">Only names containing “test” get notes unless force=true</span></div>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><div><h2>Webhooks</h2><p>Outbound lead.created target and the inbound note endpoint.</p></div></div>
        <div class="kv">
          <div class="kv-row"><span>WEBHOOK_URL</span><code>${c.webhookConfigured ? "[set]" : "not set"}</code></div>
          <div class="kv-row"><span>INBOUND_WEBHOOK_SECRET</span><code>${c.inboundSecretConfigured ? "[set]" : "not set"}</code></div>
        </div>
      </section>
      <section class="card span-full" style="grid-column:1/-1">
        <div class="card-head"><div><h2>Runtime config</h2><p>Mirrors GET /api/health + status.</p></div></div>
        <pre class="pre">${escapeHtml(JSON.stringify({ health: state.status?.config, mode: state.status?.mode, leadflo: state.status?.leadflo }, null, 2))}</pre>
        <div style="margin-top:14px">
          <button class="btn primary" id="scrapeFromSettings" type="button">Scrape now</button>
        </div>
      </section>
    </div>`;
}

function render() {
  renderNav();
  updateChrome();
  const content = el("content");
  if (state.screen === "dashboard") content.innerHTML = renderDashboard();
  else if (state.screen === "leads") content.innerHTML = renderLeads();
  else if (state.screen === "activity") content.innerHTML = renderActivity();
  else if (state.screen === "scraper") content.innerHTML = renderScraper();

  content.querySelectorAll("[data-go]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.screen = btn.getAttribute("data-go");
      render();
    });
  });
  content.querySelectorAll("[data-lead]").forEach((node) => {
    node.addEventListener("click", () => openLead(node.getAttribute("data-lead")));
  });
  content.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.leadFilter = btn.getAttribute("data-filter");
      render();
    });
  });
  const scrapeBtn = content.querySelector("#scrapeFromSettings");
  if (scrapeBtn) scrapeBtn.addEventListener("click", () => el("pollBtn").click());

  wireDayChart();
  // mobile cards visibility via CSS media — hide table on small screens
  document.querySelectorAll(".desktop-table").forEach((n) => {
    n.style.display = window.matchMedia("(max-width: 860px)").matches ? "none" : "block";
  });
  document.querySelectorAll(".mobile-cards").forEach((n) => {
    n.style.display = window.matchMedia("(max-width: 860px)").matches ? "grid" : "none";
  });
}

function wireDayChart() {
  const wrap = document.getElementById("dayChart");
  const tip = document.getElementById("dayTip");
  if (!wrap || !tip) return;
  let series = [];
  try {
    series = JSON.parse(wrap.getAttribute("data-series") || "[]");
  } catch {
    series = [];
  }
  wrap.addEventListener("mousemove", (ev) => {
    const rect = wrap.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const i = Math.round((x / rect.width) * (series.length - 1));
    const d = series[Math.max(0, Math.min(series.length - 1, i))];
    if (!d) return;
    const dt = new Date(d.date + "T00:00:00Z").toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    tip.hidden = false;
    tip.style.left = `${(i / Math.max(1, series.length - 1)) * 100}%`;
    tip.style.top = "24px";
    tip.innerHTML = `<strong>${dt}</strong><br>${d.count} leads<br>${d.tracked} implant tracked`;
  });
  wrap.addEventListener("mouseleave", () => {
    tip.hidden = true;
  });
}

function closeDrawer() {
  state.selectedId = null;
  state.drawer = null;
  el("drawer").hidden = true;
  el("drawerBackdrop").hidden = true;
}

async function openLead(patientId) {
  state.selectedId = patientId;
  el("drawer").hidden = false;
  el("drawerBackdrop").hidden = false;
  el("drawerInner").innerHTML = `<div class="empty">Loading lead & notes…</div>`;
  render(); // refresh active row

  try {
    const [detailRes, timelineRes] = await Promise.all([
      fetch(`/api/leads/${encodeURIComponent(patientId)}`),
      fetch(`/api/leads/${encodeURIComponent(patientId)}/timeline`),
    ]);
    const detail = await detailRes.json();
    const timeline = timelineRes.ok
      ? await timelineRes.json()
      : { notes: [], newNotes: [], oldNotes: [], activity: [], localEvents: detail.events || [], error: true };

    if (!detailRes.ok) throw new Error(detail.error || "Lead not found");
    state.drawer = { detail, timeline };
    paintDrawer();
  } catch (err) {
    el("drawerInner").innerHTML = `<div class="empty">${escapeHtml(err.message || String(err))}</div>`;
  }
}

function paintDrawer() {
  const lead = state.drawer.detail.lead;
  const timeline = state.drawer.timeline;
  const st = statusMeta(lead.status);
  const fields = [
    ["Treatment type", lead.treatmentType || "—"],
    ["Source", lead.source || "—"],
    ["Stage", stageLabel(lead.stage)],
    ["Status", st.label],
    ["Phone", lead.phone || "—"],
    ["Email", lead.email || "—"],
    ["First seen", ago(lead.firstSeenAt)],
    ["Tracked", isTracked(lead) ? "Yes — in trackedTypes" : "No — logged only"],
  ];

  const local = (timeline.localEvents || state.drawer.detail.events || []).map((e) => ({
    kind: "local",
    title: eventTitle(e.kind, e.message),
    time: e.created_at,
    detail: e.message,
    body: e.meta_json || "",
    isNew: false,
  }));

  const notes = (timeline.notes || []).map((n) => ({
    kind: "note",
    title: n.isNew ? "New Leadflo note" : "Leadflo note",
    time: n.datetime,
    detail: n.title || "Note",
    body: n.content,
    isNew: n.isNew,
  }));

  const activity = (timeline.activity || []).map((a) => ({
    kind: "activity",
    title: a.type.replace(/_/g, " "),
    time: a.datetime,
    detail: a.summary,
    body: "",
    isNew: false,
  }));

  const items = [...notes, ...activity, ...local].sort((a, b) =>
    String(b.time).localeCompare(String(a.time)),
  );

  el("drawerInner").innerHTML = `
    <div class="drawer-head">
      <div class="avatar">${escapeHtml(initials(lead.fullName))}</div>
      <div style="flex:1;min-width:0">
        <h3>${escapeHtml(lead.fullName)} ${lead.isTestName ? '<span class="pill warn">test name</span>' : ""}</h3>
        <div class="muted small" style="margin-top:4px">${escapeHtml(lead.patientId)}</div>
      </div>
      <button class="icon-btn" id="closeDrawer" type="button" aria-label="Close">×</button>
    </div>
    <div class="drawer-actions">
      <button class="btn ghost small" data-act="note" type="button">Write AI note</button>
      <button class="btn ghost small" data-act="webhook" type="button">Resend webhook</button>
      <a class="btn ghost small" href="${escapeHtml(state.drawer.detail.leadfloUrl || "https://app.leadflo.com/")}" target="_blank" rel="noopener">Open in Leadflo</a>
    </div>
    <div class="fields">
      ${fields
        .map(
          ([lab, val]) => `
        <div class="field"><div class="lab">${lab}</div><div class="val">${escapeHtml(val)}</div></div>`,
        )
        .join("")}
    </div>
    ${
      lead.labels?.length
        ? `<div class="section-title">Labels</div><div class="labels">${lead.labels
            .map((x) => `<span class="pill">${escapeHtml(x)}</span>`)
            .join("")}</div>`
        : ""
    }
    <div class="section-title">Notes & actions</div>
    <p class="section-sub">Live Leadflo notes for ${escapeHtml(lead.firstName || lead.fullName)} — new vs previously seen.</p>
    ${
      timeline.error
        ? `<div class="empty">Could not refresh Leadflo timeline (showing local history).</div>`
        : ""
    }
    <div class="timeline">
      ${
        items.length
          ? items
              .map(
                (t) => `
        <div class="tl-item ${t.isNew ? "new" : ""}">
          <div class="tl-top">
            <div class="tl-title">${escapeHtml(t.title)}${t.isNew ? ' <span class="pill ok">new</span>' : ""}</div>
            <div class="tl-time">${ago(t.time)}</div>
          </div>
          <div class="tl-detail">${escapeHtml(t.detail)}</div>
          ${
            t.body
              ? `<div class="tl-body ${t.kind === "note" ? (t.isNew ? "note-new" : "note-old") : ""}">${escapeHtml(t.body)}</div>`
              : ""
          }
        </div>`,
              )
              .join("")
          : `<div class="empty">No notes or actions yet.</div>`
      }
    </div>`;

  el("closeDrawer").addEventListener("click", closeDrawer);
  el("drawerInner").querySelector('[data-act="note"]').addEventListener("click", () => {
    openNoteDialog(lead);
  });
  el("drawerInner").querySelector('[data-act="webhook"]').addEventListener("click", async () => {
    const res = await fetch(`/api/leads/${encodeURIComponent(lead.patientId)}/webhook`, {
      method: "POST",
    });
    const data = await res.json();
    toast(data.skipped ? "No WEBHOOK_URL configured" : data.ok ? "Webhook resent" : data.message || "Webhook failed");
    await refresh();
    openLead(lead.patientId);
  });
}

function openNoteDialog(lead) {
  el("noteLead").textContent = `Lead: ${lead.fullName} (${lead.patientId})`;
  el("noteEndpoint").textContent = `POST /api/leads/${lead.patientId}/notes`;
  el("noteText").value = "";
  el("noteForce").checked = false;
  el("noteDialog").dataset.patientId = lead.patientId;
  el("noteDialog").showModal();
}

async function refresh() {
  const [statusRes, leadsRes, eventsRes, analyticsRes] = await Promise.all([
    fetch("/api/status"),
    fetch("/api/leads"),
    fetch("/api/events"),
    fetch("/api/analytics?days=30"),
  ]);
  state.status = await statusRes.json();
  state.leads = (await leadsRes.json()).leads || [];
  state.events = (await eventsRes.json()).events || [];
  state.analytics = await analyticsRes.json();
  const interval = state.status?.config?.pollIntervalMs || 60_000;
  const last = state.status?.latestPoll?.finished_at || state.status?.latestPoll?.started_at;
  state.nextPollAt = last ? new Date(last).getTime() + interval : Date.now() + interval;
  render();
}

el("pollBtn").addEventListener("click", async () => {
  const btn = el("pollBtn");
  btn.disabled = true;
  btn.textContent = "Scraping…";
  try {
    await fetch("/api/poll", { method: "POST" });
    toast("Scrape complete");
    await refresh();
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<span class="btn-icon" aria-hidden="true">⇅</span> Scrape now`;
  }
});

el("drawerBackdrop").addEventListener("click", closeDrawer);
el("menuBtn").addEventListener("click", () => {
  toast("Poller live · scrape from the header on desktop, or Scraper tab");
});

el("noteForm").addEventListener("submit", async (event) => {
  const submitter = event.submitter;
  if (!submitter || submitter.value === "cancel") return;
  event.preventDefault();
  const patientId = el("noteDialog").dataset.patientId;
  if (!patientId) return;
  const note = el("noteText").value;
  const force = el("noteForce").checked;
  const res = await fetch(`/api/leads/${encodeURIComponent(patientId)}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note, force }),
  });
  const data = await res.json();
  if (!res.ok) {
    toast(data.message || "Failed to write note");
    return;
  }
  el("noteDialog").close();
  toast(data.message || "Note written");
  await refresh();
  openLead(patientId);
});

window.addEventListener("resize", () => {
  document.querySelectorAll(".desktop-table").forEach((n) => {
    n.style.display = window.matchMedia("(max-width: 860px)").matches ? "none" : "block";
  });
  document.querySelectorAll(".mobile-cards").forEach((n) => {
    n.style.display = window.matchMedia("(max-width: 860px)").matches ? "grid" : "none";
  });
});

setInterval(() => updateChrome(), 1000);
refresh();
setInterval(refresh, 15000);
