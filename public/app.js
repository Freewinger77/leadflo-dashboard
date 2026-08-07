const statusPill = (status) => {
  if (["note_written", "webhook_sent", "ai_received"].includes(status)) return "ok";
  if (["webhook_failed", "note_failed"].includes(status)) return "err";
  if (["note_skipped", "webhook_pending", "discovered"].includes(status)) return "warn";
  return "";
};

const fmtTime = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

let notePatientId = null;

async function refresh() {
  const [statusRes, leadsRes, eventsRes] = await Promise.all([
    fetch("/api/status"),
    fetch("/api/leads"),
    fetch("/api/events"),
  ]);
  const status = await statusRes.json();
  const { leads } = await leadsRes.json();
  const { events } = await eventsRes.json();

  document.getElementById("modeBadge").textContent =
    `${status.mode} · ${status.config.trackedTypes.join(", ")} · every ${Math.round(status.config.pollIntervalMs / 1000)}s`;

  const s = status.stats;
  document.getElementById("stats").innerHTML = [
    ["Tracked", s.total],
    ["Webhooked", s.webhookSent],
    ["Notes written", s.notesWritten],
    ["Test leads", s.testLeads],
  ]
    .map(
      ([label, value]) =>
        `<article class="stat"><p class="label">${label}</p><p class="value">${value}</p></article>`,
    )
    .join("");

  const body = document.getElementById("leadsBody");
  if (!leads.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty">No implant leads tracked yet. Click “Scrape now”.</td></tr>`;
  } else {
    body.innerHTML = leads
      .map((lead) => {
        const test = lead.isTestName
          ? `<span class="pill warn">test</span>`
          : "";
        return `<tr>
          <td>
            <span class="lead-name">${escapeHtml(lead.fullName)} ${test}</span>
            <span class="lead-meta">${escapeHtml(lead.phone || "—")} · ${escapeHtml(lead.email || "—")}</span>
            <span class="lead-meta">${escapeHtml(lead.source || "Unknown source")}</span>
          </td>
          <td>${escapeHtml(lead.treatmentType)}</td>
          <td>${escapeHtml(lead.stage)}</td>
          <td><span class="pill ${statusPill(lead.status)}">${escapeHtml(lead.status)}</span></td>
          <td><span class="lead-meta">${fmtTime(lead.firstSeenAt)}</span></td>
          <td><button class="btn small ghost" data-note="${escapeHtml(lead.patientId)}" data-name="${escapeHtml(lead.fullName)}" type="button">Note</button></td>
        </tr>`;
      })
      .join("");
  }

  document.getElementById("events").innerHTML = events
    .slice(0, 40)
    .map(
      (e) => `<li>
        <span class="kind">${escapeHtml(e.kind)}</span>
        <span class="msg">${escapeHtml(e.message)}</span>
        <span class="time">${fmtTime(e.created_at)}</span>
      </li>`,
    )
    .join("");

  body.querySelectorAll("[data-note]").forEach((btn) => {
    btn.addEventListener("click", () => {
      notePatientId = btn.getAttribute("data-note");
      document.getElementById("noteLead").textContent =
        `Lead: ${btn.getAttribute("data-name")} (${notePatientId})`;
      document.getElementById("noteText").value = "";
      document.getElementById("noteForce").checked = false;
      document.getElementById("noteDialog").showModal();
    });
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

document.getElementById("pollBtn").addEventListener("click", async () => {
  const btn = document.getElementById("pollBtn");
  btn.disabled = true;
  btn.textContent = "Scraping…";
  try {
    await fetch("/api/poll", { method: "POST" });
    await refresh();
  } finally {
    btn.disabled = false;
    btn.textContent = "Scrape now";
  }
});

document.getElementById("noteForm").addEventListener("submit", async (event) => {
  const submitter = event.submitter;
  if (!submitter || submitter.value === "cancel") return;
  event.preventDefault();
  if (!notePatientId) return;
  const note = document.getElementById("noteText").value;
  const force = document.getElementById("noteForce").checked;
  const res = await fetch(`/api/leads/${encodeURIComponent(notePatientId)}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note, force }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.message || "Failed to write note");
    return;
  }
  document.getElementById("noteDialog").close();
  await refresh();
  alert(data.message);
});

refresh();
setInterval(refresh, 15000);
