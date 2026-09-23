const $ = s => document.querySelector(s);
const state = { events: [], current: null, data: null, filter: "all", search: "", job: null, poll: null, selected: null, showAll: false };

const api = async (method, path, body) => {
  const r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${path}`);
  return j;
};

let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 3000);
}

const safeUrl = u => (/^https?:\/\//i.test(String(u || "")) ? String(u) : null);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = n => n.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// photo with fallback chain: profile.photo_url, then luma avatar, then unavatar sources, then initials
function photoEl(g, cls = "avatar") {
  const list = [g.profile?.photo_url, ...(g.photos || [])].map(safeUrl).filter(Boolean);
  const holder = document.createElement("div");
  holder.className = cls + " fallback";
  holder.textContent = initials(g.name);
  if (!list.length) return holder;
  const img = document.createElement("img");
  img.className = cls === "faceimg" ? "" : cls;
  img.alt = g.name;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  let i = 0;
  img.onerror = () => {
    i++;
    if (i < list.length) img.src = list[i];
    else img.replaceWith(holder);
  };
  img.src = list[0];
  return img;
}

// ---------- events rail ----------
async function loadEvents() {
  state.events = await api("GET", "/api/events");
  renderRail();
}

function canLoad(e) {
  return e.is_host || e.approval_status === "approved";
}
function renderRail() {
  const now = Date.now();
  const hiddenCount = state.events.filter(e => !canLoad(e)).length;
  const toggle = $("#rail-toggle");
  toggle.hidden = !hiddenCount;
  toggle.textContent = state.showAll ? "Hide the events I'm not approved for" : `Show ${hiddenCount} more (pending, invited, waitlisted)`;
  const visible = state.showAll ? state.events : state.events.filter(canLoad);
  const up = visible.filter(e => !e.start_at || new Date(e.start_at).getTime() >= now - 6 * 3600e3).sort((a, b) => (a.start_at || "").localeCompare(b.start_at || ""));
  const past = visible.filter(e => e.start_at && new Date(e.start_at).getTime() < now - 6 * 3600e3);
  for (const [sel, list] of [["#events-upcoming", up], ["#events-past", past]]) {
    const box = $(sel);
    box.hidden = !list.length;
    box.querySelector(".event-list").innerHTML = list
      .map(e => {
        const d = e.start_at ? new Date(e.start_at) : null;
        return `<button class="event-item ${e.api_id === state.current ? "active" : ""}" data-id="${esc(e.api_id)}">
          <div class="event-date"><b>${d ? d.getDate() : "?"}</b><span>${d ? d.toLocaleString(undefined, { month: "short" }) : ""}</span></div>
          <div><div class="event-name">${esc(e.name)}</div>
          <div class="event-count">${e.guest_count_loaded ? `${e.guest_count_loaded} guests loaded` : e.guest_count != null ? `${e.guest_count} going` : ""}${e.is_host ? " · hosting" : ""}${!canLoad(e) ? ` · ${e.approval_status || "not registered"}` : !e.show_guest_list ? " · list hidden" : ""}</div></div>
        </button>`;
      })
      .join("");
  }
}

document.addEventListener("click", e => {
  const item = e.target.closest(".event-item");
  if (item) openEvent(item.dataset.id);
});
$("#rail-toggle").onclick = () => { state.showAll = !state.showAll; renderRail(); };

// ---------- event view ----------
async function openEvent(id) {
  state.current = id;
  state.selected = null;
  closeDossier();
  renderRail();
  await refreshEvent();
}

async function refreshEvent() {
  if (!state.current) return;
  try {
    state.data = await api("GET", `/api/events/${state.current}`);
  } catch (e) {
    toast(e.message, true);
    return;
  }
  $("#empty").hidden = true;
  $("#event-view").hidden = false;
  renderEvent();
  if (state.data.job) watchJob(state.data.job.id);
}

function renderEvent() {
  const { event: ev, guests, ranking } = state.data;
  $("#ev-name").textContent = ev.name;
  const parts = [fmtDate(ev.start_at), ev.location, ev.hosts?.length ? `hosted by ${ev.hosts.join(", ")}` : null].filter(Boolean);
  const status = guests.length
    ? `${guests.length} guests loaded${ev.guests_synced_at ? "" : " (featured only, pull the full list)"}`
    : !ev.show_guest_list && !ev.is_host ? "host hides the guest list"
    : ev.guest_count != null ? `${ev.guest_count} going, guest list not loaded yet` : "guest list not loaded yet";
  $("#ev-sub").innerHTML = `${esc(parts.join(" · "))}<br>${esc(status)}${ev.slug ? ` · <a href="https://luma.com/${esc(ev.slug)}" target="_blank" rel="noreferrer">open on Luma</a>` : ""}`;
  const researched = guests.filter(g => g.profile).length;
  const scored = guests.filter(g => g.triage).length;
  $("#btn-run").textContent = !guests.length ? "Load guests and rank"
    : ranking && researched >= Math.min(25, guests.length) ? "Up to date, run again"
    : scored || researched ? "Continue where it stopped" : "Rank this room";

  // top ten
  const top = $("#top");
  if (ranking?.top?.length) {
    top.hidden = false;
    $("#strategy").textContent = ranking.strategy || "";
    const byId = Object.fromEntries(guests.map(g => [g.user_api_id, g]));
    const row = $("#top-row");
    row.innerHTML = "";
    for (const t of ranking.top) {
      const g = byId[t.user_api_id];
      if (!g) continue;
      const b = document.createElement("button");
      b.className = "pick";
      b.dataset.uid = g.user_api_id;
      const face = document.createElement("div");
      face.className = "face";
      face.appendChild(photoEl(g, "faceimg"));
      face.insertAdjacentHTML("beforeend", `<span class="rank">${t.rank}</span>${g.note?.status === "met" ? '<span class="met">met</span>' : ""}`);
      b.appendChild(face);
      b.insertAdjacentHTML("beforeend", `<div class="body"><div class="name">${esc(g.name)}</div><div class="liner">${esc(t.one_liner)}</div></div>`);
      row.appendChild(b);
    }
  } else top.hidden = true;

  renderChips();
  renderWall();
}

const TAGS = ["investor", "founder", "operator", "engineer", "customer", "press", "academic", "student", "community", "unknown"];
function renderChips() {
  const { guests } = state.data;
  const counts = {};
  for (const g of guests) if (g.triage?.tag) counts[g.triage.tag] = (counts[g.triage.tag] || 0) + 1;
  const researched = guests.filter(g => g.profile).length;
  const chips = [["all", `All ${guests.length}`], researched ? ["researched", `Researched ${researched}`] : null, ...TAGS.filter(t => counts[t]).map(t => [t, `${t} ${counts[t]}`])].filter(Boolean);
  $("#chips").innerHTML = chips.map(([k, l]) => `<button class="chip ${state.filter === k ? "on" : ""}" data-f="${k}">${esc(l)}</button>`).join("");
}

$("#chips").addEventListener("click", e => {
  const c = e.target.closest(".chip");
  if (!c) return;
  state.filter = c.dataset.f;
  renderChips();
  renderWall();
});
$("#search").addEventListener("input", e => {
  state.search = e.target.value.trim().toLowerCase();
  renderWall();
});

function renderWall() {
  const { guests, event: ev } = state.data;
  const q = state.search;
  const list = guests.filter(g => {
    if (state.filter === "researched" && !g.profile) return false;
    if (TAGS.includes(state.filter) && g.triage?.tag !== state.filter) return false;
    if (!q) return true;
    const hay = [g.name, g.bio_short, g.profile?.headline, g.profile?.company, g.profile?.summary].join(" ").toLowerCase();
    return hay.includes(q);
  });
  const wall = $("#wall");
  wall.innerHTML = "";
  const empty = $("#wall-empty");
  if (!guests.length) {
    empty.hidden = false;
    empty.textContent = ev.guest_count
      ? "No guests loaded. Click “Load guests and rank”. You need to be registered for the event and the host has to show the guest list."
      : "No guests loaded yet.";
    return;
  }
  empty.hidden = list.length > 0;
  empty.textContent = "Nobody matches that filter.";
  const frag = document.createDocumentFragment();
  for (const g of list) {
    const b = document.createElement("button");
    b.className = "person" + (g.triage && g.triage.score < 25 && !g.profile ? " dim" : "");
    b.dataset.uid = g.user_api_id;
    b.appendChild(photoEl(g));
    const line = g.profile?.headline || g.bio_short || (g.urls && Object.keys(g.urls).filter(k => k !== "luma").join(", ")) || "";
    const score = g.profile?.relevance?.score ?? g.triage?.score;
    b.insertAdjacentHTML(
      "beforeend",
      `<div class="txt"><div class="name">${g.rank ? `<span class="score hi">#${g.rank.rank}</span> ` : ""}${esc(g.name)}</div><div class="line">${esc(line)}</div></div>
       <div class="score ${g.profile ? "deep" : ""} ${score >= 70 ? "hi" : ""}">${score ?? ""}</div>`,
    );
    frag.appendChild(b);
  }
  wall.appendChild(frag);
}

document.addEventListener("click", e => {
  const p = e.target.closest(".person, .pick");
  if (p) openDossier(p.dataset.uid);
});

// ---------- dossier ----------
function openDossier(uid) {
  const g = state.data.guests.find(x => x.user_api_id === uid);
  if (!g) return;
  state.selected = uid;
  const d = $("#dossier");
  d.hidden = false;
  renderDossier(g);
}
function closeDossier() {
  $("#dossier").hidden = true;
  state.selected = null;
}
$("#dossier-close").onclick = closeDossier;
document.addEventListener("keydown", e => { if (e.key === "Escape") closeDossier(); });

function renderDossier(g) {
  const p = g.profile;
  const body = $("#dossier-body");
  body.innerHTML = "";
  const head = document.createElement("div");
  head.className = "d-head";
  head.appendChild(photoEl(g));
  const links = Object.entries(g.urls || {})
    .concat(p ? [["github", p.links?.github], ...(p.links?.other || []).map(u => ["source", u])] : [])
    .map(([k, u]) => [k, safeUrl(u)])
    .filter(([, u]) => u)
    .map(([k, u]) => `<a href="${esc(u)}" target="_blank" rel="noreferrer">${esc(k)}</a>`)
    .join("");
  head.insertAdjacentHTML(
    "beforeend",
    `<div><h2>${esc(g.name)}</h2>
      <div class="headline">${esc(p?.headline || g.bio_short || "")}</div>
      ${p ? `<div class="conf">${esc([p.location, p.company_stage, `${p.confidence} confidence`].filter(Boolean).join(" · "))}${p.identity_note ? ` — ${esc(p.identity_note)}` : ""}</div>` : ""}
      <div class="d-links">${links}</div></div>`,
  );
  body.appendChild(head);

  if (g.rank) {
    body.insertAdjacentHTML(
      "beforeend",
      `<div class="d-rank"><b>#${g.rank.rank} to find tonight</b><p>${esc(g.rank.why)}</p><p><b>Ask:</b> ${esc(g.rank.ask)}</p></div>`,
    );
  }
  const opener = g.rank?.opener || p?.opener;
  if (opener) body.insertAdjacentHTML("beforeend", `<div class="d-block"><h3>Say this first</h3><p class="d-opener">${esc(opener)}</p></div>`);

  if (p) {
    body.insertAdjacentHTML("beforeend", `<div class="d-block"><h3>Why they matter for you</h3><p>${esc(p.relevance.why)} <b>${p.relevance.score}</b></p><p style="color:var(--ink-2);margin-top:4px">${esc(p.relevance.angle)}</p></div>`);
    body.insertAdjacentHTML("beforeend", `<div class="d-block"><h3>Who they are</h3><p>${esc(p.summary)}</p></div>`);
    if (p.facts?.length) body.insertAdjacentHTML("beforeend", `<div class="d-block"><h3>Facts</h3><ul>${p.facts.map(f => `<li>${esc(f.text)}${safeUrl(f.source_url) ? `<a href="${esc(f.source_url)}" target="_blank" rel="noreferrer">source</a>` : ""}</li>`).join("")}</ul></div>`);
    if (p.mutual?.length) body.insertAdjacentHTML("beforeend", `<div class="d-block"><h3>You have in common</h3><ul>${p.mutual.map(m => `<li>${esc(m)}</li>`).join("")}</ul></div>`);
    if (p.personal?.length) body.insertAdjacentHTML("beforeend", `<div class="d-block"><h3>Outside work</h3><ul>${p.personal.map(f => `<li>${esc(f.text)}${safeUrl(f.source_url) ? `<a href="${esc(f.source_url)}" target="_blank" rel="noreferrer">source</a>` : ""}</li>`).join("")}</ul></div>`);
    if (p.recent?.length) body.insertAdjacentHTML("beforeend", `<div class="d-block"><h3>Recent</h3><ul>${p.recent.map(f => `<li>${esc(f.text)}${safeUrl(f.source_url) ? `<a href="${esc(f.source_url)}" target="_blank" rel="noreferrer">source</a>` : ""}</li>`).join("")}</ul></div>`);
    if (p.stale) body.insertAdjacentHTML("beforeend", `<div class="d-stale">Researched with an earlier version. "Research again" adds interests outside work and what you have in common.</div>`);
    if (safeUrl(p.photo_url)) body.insertAdjacentHTML("beforeend", `<div class="d-photo-note">Photo found at <a href="${esc(p.photo_url)}" target="_blank" rel="noreferrer">${esc(new URL(p.photo_url).hostname)}</a></div>`);
  } else if (g.triage) {
    body.insertAdjacentHTML("beforeend", `<div class="d-block"><h3>Quick read</h3><p>${esc(g.triage.why)} <b>${g.triage.score}</b> · ${esc(g.triage.tag)}</p></div>`);
  }
  if (g.bio_short && p) body.insertAdjacentHTML("beforeend", `<div class="d-block"><h3>Luma bio</h3><p>${esc(g.bio_short)}</p></div>`);

  const st = g.note?.status;
  body.insertAdjacentHTML(
    "beforeend",
    `<div class="d-status">
      <button class="small ${st === "want" ? "on" : ""}" data-status="want">Want to meet</button>
      <button class="small ${st === "met" ? "on" : ""}" data-status="met">Met</button>
      <button class="small ${st === "skip" ? "on" : ""}" data-status="skip">Skip</button>
    </div>
    <textarea class="d-note" placeholder="Notes after you talk">${esc(g.note?.note || "")}</textarea>
    <div class="d-actions"><button class="small" id="d-research">${p ? "Research again" : "Research this person"}</button></div>`,
  );
  body.querySelectorAll("[data-status]").forEach(b => (b.onclick = () => saveNote(g, b.dataset.status === st ? null : b.dataset.status, body.querySelector(".d-note").value)));
  body.querySelector(".d-note").onchange = e => saveNote(g, st, e.target.value);
  $("#d-research").onclick = async () => {
    try {
      const job = await api("POST", `/api/events/${state.current}/research`, { ids: [g.user_api_id], force: true });
      watchJob(job.id);
    } catch (e) { toast(e.message, true); }
  };
}

async function saveNote(g, status, note) {
  await api("POST", `/api/events/${state.current}/notes/${g.user_api_id}`, { status, note });
  g.note = { status, note };
  renderDossier(g);
  renderEvent();
}

// ---------- jobs ----------
function watchJob(id) {
  clearInterval(state.poll);
  const box = $("#job");
  box.hidden = false;
  const tick = async () => {
    let j;
    try { j = await api("GET", `/api/jobs/${id}`); } catch { clearInterval(state.poll); return; }
    const fill = $("#job-fill");
    if (j.total) { fill.className = "job-fill"; fill.style.width = `${Math.round((100 * j.done) / j.total)}%`; }
    else { fill.className = "job-fill indeterminate"; }
    $("#job-msg").textContent = `${j.kind}: ${j.message}`;
    $("#job-cost").textContent = j.est_cost > 0.005 ? `~$${j.est_cost.toFixed(2)}` : "";
    if (j.status !== "running") {
      clearInterval(state.poll);
      if (j.status === "error") toast(j.error, true);
      else { fill.style.width = "100%"; setTimeout(() => (box.hidden = true), 2500); }
      loadNotices();
      await loadEvents();
      await refreshEvent();
      if (state.selected) openDossier(state.selected);
      return;
    }
    if (j.kind === "run" || j.kind === "research" || j.kind === "guests") {
      // refresh the view as results land
      state.data = await api("GET", `/api/events/${state.current}`);
      renderEvent();
    }
  };
  tick();
  state.poll = setInterval(tick, 2500);
}

async function act(path, body) {
  try {
    const job = await api("POST", `/api/events/${state.current}/${path}`, body || {});
    watchJob(job.id);
  } catch (e) { toast(e.message, true); }
}

$("#btn-run").onclick = () => act("run", { top: 25 });
document.querySelector(".more .menu").addEventListener("click", async e => {
  const b = e.target.closest("button");
  if (!b) return;
  e.target.closest("details").open = false;
  const a = b.dataset.act;
  if (a === "delete") {
    await api("DELETE", `/api/events/${state.current}`);
    state.current = null;
    $("#event-view").hidden = true;
    $("#empty").hidden = false;
    closeDossier();
    return loadEvents();
  }
  if (a === "research") return act("research", { top: 25 });
  if (a === "rank") return act("rank", { top: 10 });
  act(a);
});

// ---------- sync / add ----------
$("#btn-sync").onclick = async () => {
  const b = $("#btn-sync");
  b.disabled = true;
  b.textContent = "Pulling…";
  try {
    const r = await api("POST", "/api/events/sync", { period: "all" });
    toast(`${r.synced} events pulled`);
    await loadEvents();
  } catch (e) { toast(e.message, true); }
  b.disabled = false;
  b.textContent = "Pull my Luma events";
};
$("#add-form").onsubmit = async e => {
  e.preventDefault();
  const url = $("#add-url").value.trim();
  if (!url) return;
  try {
    const ev = await api("POST", "/api/events/add", { url });
    $("#add-url").value = "";
    await loadEvents();
    openEvent(ev.api_id);
  } catch (err) { toast(err.message, true); }
};

// ---------- settings ----------
const dlg = $("#settings");
async function openSettings() {
  const s = await api("GET", "/api/settings");
  $("#s-cookie").value = "";
  $("#s-cookie").placeholder = s.has_cookie ? `saved (${s.cookie_hint}), paste to replace` : "paste the value of luma.auth-session-key";
  $("#s-cookie-state").textContent = s.has_cookie ? "Cookie saved." : "No cookie yet.";
  $("#s-me").value = s.me;
  $("#s-model").value = s.model;
  $("#s-research-model").value = s.research_model || "";
  $("#s-research-model").placeholder = s.provider === "claude-code" ? "claude-sonnet-5 (default in Claude Code mode)" : "same as model";
  $("#s-self").value = s.self_user_api_id || "";
  $("#s-provider").value = s.provider;
  $("#s-key-state").textContent = [
    s.claude_cli ? "Claude Code: found." : "Claude Code: not installed.",
    s.codex_cli ? "Codex: found." : "Codex: not installed.",
    s.has_anthropic_key ? "API key: saved." : "API key: none.",
  ].join(" ");
  $("#s-apikey").value = "";
  $("#s-apikey").placeholder = s.api_key_hint ? `saved (${s.api_key_hint}), paste to replace` : "sk-ant-…";
  $("#s-apikey-state").textContent = s.has_anthropic_key && !s.api_key_hint ? "Using ANTHROPIC_API_KEY from .env." : "";
  $("#s-draft").disabled = !s.claude_cli;
  $("#s-draft-state").textContent = s.claude_cli ? "" : "Needs Claude Code.";
  $("#s-err").textContent = "";
  dlg.showModal();
}
$("#btn-settings").onclick = openSettings;
$("#s-draft").onclick = async () => {
  const b = $("#s-draft");
  b.disabled = true;
  $("#s-draft-state").textContent = "Reading your memory and instruction files… about a minute.";
  try {
    const r = await api("POST", "/api/settings/draft-me");
    $("#s-me").value = r.profile;
    $("#s-draft-state").textContent = `Drafted from ${r.sources.length ? r.sources.slice(0, 3).join(", ") : "your Claude Code context"}. Edit, then Save.`;
  } catch (e) {
    $("#s-draft-state").textContent = e.message;
  }
  b.disabled = false;
};
$("#s-cancel").onclick = () => dlg.close();
$("#settings-form").onsubmit = async e => {
  e.preventDefault();
  const body = { me: $("#s-me").value, model: $("#s-model").value, research_model: $("#s-research-model").value, self_user_api_id: $("#s-self").value, provider: $("#s-provider").value, anthropic_api_key: $("#s-apikey").value };
  if ($("#s-cookie").value.trim()) body.luma_cookie = $("#s-cookie").value.trim();
  try {
    await api("PUT", "/api/settings", body);
    dlg.close();
    toast("Saved");
    hint();
    loadNotices();
  } catch (err) { $("#s-err").textContent = err.message; }
};

async function loadNotices() {
  let st;
  try { st = await api("GET", "/api/status"); } catch { return; }
  $("#notices").innerHTML = st.notices
    .map(n => `<div class="notice ${n.level}"><span>${esc(n.text)}</span>${n.action === "settings" ? '<button class="small" data-open-settings>Open Settings</button>' : ""}</div>`)
    .join("");
}
$("#notices").addEventListener("click", e => { if (e.target.closest("[data-open-settings]")) openSettings(); });

async function hint() {
  const s = await api("GET", "/api/settings");
  $("#empty-hint").textContent = !s.claude_cli && !s.has_anthropic_key
    ? "Install Claude Code, or add ANTHROPIC_API_KEY to roster/.env and restart."
    : !s.has_cookie ? "Start in Settings: paste your Luma session cookie." : "";
}

(async () => {
  await loadEvents();
  await hint();
  loadNotices();
  setInterval(loadNotices, 5 * 60e3);
  // Open the soonest upcoming event that has guests loaded, else the most recent one.
  const now = Date.now();
  const loaded = state.events.filter(e => e.guest_count_loaded);
  const upcoming = loaded.filter(e => e.start_at && new Date(e.start_at).getTime() >= now - 6 * 3600e3).sort((a, b) => a.start_at.localeCompare(b.start_at));
  const first = upcoming[0] || loaded[0] || null;
  if (first) openEvent(first.api_id);
})();
