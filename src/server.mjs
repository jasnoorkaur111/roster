import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, settings, events, guests, triage, profiles, rankings, notes, upsertEvent, replaceGuests } from "./db.mjs";
import { LumaError, checkCookie, listMyEvents, getEventPublic, getGuestList, profileUrls, photoCandidates } from "./luma.mjs";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, PROVIDERS, claudeCliAvailable, codexCliAvailable, configureApiKey, hasApiKey, draftMeProfile, RefusalError, triageGuests, researchGuest, rankEvent, mapLimit, addUsage, estimateCost } from "./ai.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const PORT = Number(process.env.PORT || 4747);

// .env loader (no dependency): KEY=value lines
try {
  for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

// ---------- settings ----------
function cookie() {
  return settings.get("luma_cookie") || process.env.LUMA_COOKIE || null;
}
function meProfile() {
  const s = settings.get("me");
  if (s) return s;
  try {
    return fs.readFileSync(path.join(root, "me.md"), "utf8");
  } catch {}
  return fs.readFileSync(path.join(root, "me.example.md"), "utf8");
}
function model() {
  return settings.get("model") || DEFAULT_MODEL;
}
function selfId() {
  return settings.get("self_user_api_id") || process.env.SELF_USER_API_ID || null;
}
function provider() {
  return settings.get("provider") || DEFAULT_PROVIDER;
}
configureApiKey(settings.get("anthropic_api_key"));

// Cookie health: set bad on any Luma auth failure, re-verified lazily (10 min cache) by /api/status.
const cookieHealth = { ok: null, checked_at: 0, error: null };
function markCookie(ok, error = null) {
  cookieHealth.ok = ok;
  cookieHealth.error = error;
  cookieHealth.checked_at = Date.now();
}
async function cookieStatus(force = false) {
  if (!cookie()) return { ok: false, missing: true };
  if (!force && Date.now() - cookieHealth.checked_at < 10 * 60e3 && cookieHealth.ok !== null) return { ok: cookieHealth.ok, error: cookieHealth.error };
  try {
    await checkCookie(cookie());
    markCookie(true);
  } catch (e) {
    markCookie(false, e.message);
  }
  return { ok: cookieHealth.ok, error: cookieHealth.error };
}
function isAuthError(e) {
  return e instanceof LumaError && (e.status === 401 || e.status === 403 || /not signed in|sign in/i.test(e.message));
}
function researchModel() {
  const m = settings.get("research_model") || process.env.RESEARCH_MODEL;
  if (m) return m;
  return provider() === "claude-code" ? "claude-sonnet-5" : model();
}
function aiOpts() {
  return { me: meProfile(), model: model(), provider: provider() };
}

// ---------- jobs ----------
const jobs = new Map();
function newJob(kind, eventId) {
  const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    id, kind, eventId, status: "running", started_at: new Date().toISOString(), finished_at: null,
    done: 0, total: 0, message: "", error: null, log: [],
    usage: { input: 0, output: 0, cache_read: 0, searches: 0 },
  };
  jobs.set(id, job);
  return job;
}
function logJob(job, msg) {
  job.message = msg;
  job.log.push(`${new Date().toLocaleTimeString()} ${msg}`);
  if (job.log.length > 200) job.log.shift();
  console.log(`[${job.kind}] ${msg}`);
}
function finishJob(job, err) {
  job.status = err ? "error" : "done";
  job.error = err ? String(err.message || err) : null;
  job.finished_at = new Date().toISOString();
  if (err) logJob(job, `failed: ${job.error}`);
  else logJob(job, `done. est. cost $${estimateCost(job.usage, model()).toFixed(2)}`);
}
function runningJobFor(eventId) {
  for (const j of jobs.values()) if (j.status === "running" && j.eventId === eventId) return j;
  return null;
}

// ---------- event assembly ----------
function assembleEvent(id) {
  const ev = events.get(id);
  if (!ev) return null;
  const gs = guests.list(id);
  const tr = triage.map(id);
  const pr = profiles.mapFor(id);
  const nt = notes.map(id);
  const ranking = rankings.get(id);
  const rankById = Object.fromEntries((ranking?.top || []).map(t => [t.user_api_id, t]));
  const list = gs.map(g => ({
    ...g,
    urls: profileUrls(g),
    photos: photoCandidates(g),
    triage: tr[g.user_api_id] ? { score: tr[g.user_api_id].score, tag: tr[g.user_api_id].tag, why: tr[g.user_api_id].why } : null,
    profile: pr[g.user_api_id] ? { ...pr[g.user_api_id], stale: !("personal" in pr[g.user_api_id]) } : null,
    rank: rankById[g.user_api_id] || null,
    note: nt[g.user_api_id] ? { status: nt[g.user_api_id].status, note: nt[g.user_api_id].note } : null,
  }));
  list.sort((a, b) => {
    const ra = a.rank?.rank ?? 999, rb = b.rank?.rank ?? 999;
    if (ra !== rb) return ra - rb;
    const sa = a.profile?.relevance?.score ?? a.triage?.score ?? -1;
    const sb = b.profile?.relevance?.score ?? b.triage?.score ?? -1;
    if (sa !== sb) return sb - sa;
    return a.name.localeCompare(b.name);
  });
  return { event: ev, guests: list, ranking, job: runningJobFor(id) };
}

// ---------- pipelines ----------
async function pipelineGuests(job, id) {
  const ev = events.get(id);
  if (!cookie()) throw new Error("Add your Luma session cookie in Settings first.");
  if (!ev.show_guest_list && !ev.is_host) throw new Error("The host hides the guest list for this event.");
  logJob(job, `fetching guest list for ${ev.name}`);
  let gs;
  try {
    gs = await getGuestList(ev.api_id, ev.ticket_key, cookie(), n => {
      job.done = n;
      job.message = `fetched ${n} guests`;
    });
    markCookie(true);
  } catch (e) {
    if (isAuthError(e)) {
      markCookie(false, e.message);
      throw new Error("Luma says you are not signed in. Your cookie has expired; paste a fresh one in Settings.");
    }
    throw e;
  }
  if (selfId()) gs = gs.filter(g => g.user_api_id !== selfId());
  replaceGuests(id, gs);
  job.total = job.done = gs.length;
  logJob(job, `saved ${gs.length} guests`);
  return gs;
}

async function pipelineTriage(job, id, { force = false } = {}) {
  const ev = events.get(id);
  const all = guests.list(id);
  if (!all.length) throw new Error("No guests loaded yet.");
  const have = triage.map(id);
  const gs = force ? all : all.filter(g => !have[g.user_api_id]);
  if (!gs.length) {
    logJob(job, "everyone already scored, skipping triage");
    return [];
  }
  job.total = gs.length;
  logJob(job, `scoring ${gs.length} of ${all.length} guests with ${provider()}`);
  const { scores, usage } = await triageGuests({
    event: ev, guests: gs, ...aiOpts(),
    onProgress: (d, t) => { job.done = d; job.message = `triaged ${d}/${t}`; },
  });
  addUsage(job.usage, usage);
  db.exec("BEGIN");
  try {
    for (const s of scores) triage.set(id, s.user_api_id, s.score, s.tag, s.why);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  logJob(job, `triage scored ${scores.length} guests`);
  return scores;
}

async function pipelineResearch(job, id, { top = 25, ids = null, force = false } = {}) {
  const ev = events.get(id);
  const gs = guests.list(id);
  const tr = triage.map(id);
  let targets;
  if (ids?.length) {
    targets = gs.filter(g => ids.includes(g.user_api_id));
  } else {
    targets = [...gs]
      .filter(g => tr[g.user_api_id])
      .sort((a, b) => tr[b.user_api_id].score - tr[a.user_api_id].score)
      .slice(0, top);
  }
  if (!force) targets = targets.filter(g => !profiles.get(g.user_api_id));
  job.total = targets.length;
  job.done = 0;
  const parallel = provider() === "claude-code" ? 3 : 4;
  logJob(job, `deep-researching ${targets.length} guests via ${provider()} (${parallel} at a time)`);
  const failures = [];
  let fatal = null;
  await mapLimit(targets, parallel, async g => {
    if (fatal) return;
    try {
      const { profile, usage } = await researchGuest({ guest: g, event: ev, ...aiOpts(), model: researchModel() });
      profiles.set(g.user_api_id, profile, `${provider()}:${researchModel()}`);
      addUsage(job.usage, usage);
    } catch (e) {
      failures.push(`${g.name}: ${e.message}`);
      console.error(`research failed for ${g.name}:`, e);
      // Billing or auth problems will fail every remaining call; stop instead of burning through the list.
      if (/credit balance|authentication|api key|not logged in|log in/i.test(e.message)) fatal = e;
    }
    job.done++;
    job.message = `researched ${job.done}/${job.total}${failures.length ? ` (${failures.length} failed)` : ""}`;
  });
  if (failures.length) logJob(job, `failed: ${failures.slice(0, 5).join(" | ")}${failures.length > 5 ? " ..." : ""}`);
  if (fatal) throw fatal;
  return targets.length;
}

async function pipelineRank(job, id, topN = 10, { force = false } = {}) {
  const ev = events.get(id);
  const gs = guests.list(id);
  const tr = triage.map(id);
  const pr = profiles.mapFor(id);
  const prev = rankings.get(id);
  if (!force && prev?.ranked_at && !Object.values(pr).some(p => p.researched_at > prev.ranked_at)) {
    logJob(job, "top 10 already current, skipping rank");
    return prev;
  }
  const candidates = gs
    .map(g => ({
      user_api_id: g.user_api_id, name: g.name, bio_short: g.bio_short,
      profile: pr[g.user_api_id] || null,
      triage_score: tr[g.user_api_id]?.score, triage_why: tr[g.user_api_id]?.why,
    }))
    .filter(c => c.profile || (c.triage_score ?? 0) >= 50)
    .sort((a, b) => (b.profile?.relevance.score ?? b.triage_score ?? 0) - (a.profile?.relevance.score ?? a.triage_score ?? 0))
    .slice(0, 40);
  if (!candidates.length) throw new Error("Nothing to rank. Run triage first.");
  logJob(job, `ranking ${candidates.length} candidates`);
  const { ranking, usage } = await rankEvent({ event: ev, candidates, ...aiOpts(), topN });
  addUsage(job.usage, usage);
  rankings.set(id, ranking);
  logJob(job, `top ${ranking.top.length} picked`);
  return ranking;
}

function startJob(kind, id, fn) {
  if (runningJobFor(id)) throw new HttpError(409, "A job is already running for this event.");
  const job = newJob(kind, id);
  fn(job)
    .then(() => finishJob(job))
    .catch(e => finishJob(job, e));
  return job;
}

// ---------- http ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function send(res, status, data) {
  const s = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(s);
}

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, re, keys, handler });
}

route("GET", "/api/settings", () => ({
  has_cookie: !!cookie(),
  cookie_hint: cookie() ? cookie().slice(0, 6) + "…" : null,
  me: meProfile(),
  model: model(),
  research_model: settings.get("research_model") || null,
  research_model_effective: researchModel(),
  provider: provider(),
  claude_cli: claudeCliAvailable(),
  self_user_api_id: selfId(),
  has_anthropic_key: hasApiKey(),
  api_key_hint: settings.get("anthropic_api_key") ? "…" + settings.get("anthropic_api_key").slice(-4) : null,
  codex_cli: codexCliAvailable(),
}));

route("PUT", "/api/settings", async req => {
  const b = await readJson(req);
  if (typeof b.luma_cookie === "string") {
    const c = b.luma_cookie.trim().replace(/^luma\.auth-session-key=/, "");
    if (c) {
      try {
        await checkCookie(c);
      } catch (e) {
        throw new HttpError(400, isAuthError(e) ? "Luma rejected that cookie. Copy the Value of luma.auth-session-key again while signed in." : e.message);
      }
      settings.set("luma_cookie", c);
      markCookie(true);
    } else settings.set("luma_cookie", null);
  }
  if (typeof b.me === "string") settings.set("me", b.me);
  if (typeof b.model === "string" && b.model.trim()) settings.set("model", b.model.trim());
  if (typeof b.self_user_api_id === "string") settings.set("self_user_api_id", b.self_user_api_id.trim() || null);
  if (PROVIDERS.includes(b.provider)) settings.set("provider", b.provider);
  if (typeof b.anthropic_api_key === "string") {
    const k = b.anthropic_api_key.trim();
    if (k === "") { /* untouched */ } else if (k === "-") { settings.set("anthropic_api_key", null); configureApiKey(null); } else { settings.set("anthropic_api_key", k); configureApiKey(k); }
  }
  if (typeof b.research_model === "string") settings.set("research_model", b.research_model.trim() || null);
  return { ok: true };
});

// Things the user should know right now. Polled by the UI.
route("GET", "/api/status", async (req, p, url) => {
  const notices = [];
  const ck = await cookieStatus(url.searchParams.get("recheck") === "1");
  if (ck.missing) notices.push({ level: "info", key: "cookie", text: "No Luma cookie yet. Paste it in Settings to pull your events.", action: "settings" });
  else if (ck.ok === false) notices.push({ level: "error", key: "cookie", text: "Your Luma cookie has expired. Paste a fresh one in Settings.", action: "settings" });
  const pv = provider();
  if (pv === "claude-code" && !claudeCliAvailable()) notices.push({ level: "error", key: "provider", text: "Set to run on Claude Code, but the claude command was not found. Install it or switch provider in Settings.", action: "settings" });
  if (pv === "codex" && !codexCliAvailable()) notices.push({ level: "error", key: "provider", text: "Set to run on Codex, but the codex command was not found. Install it or switch provider in Settings.", action: "settings" });
  if (pv === "api" && !hasApiKey()) notices.push({ level: "error", key: "provider", text: "Set to run on an Anthropic API key, but none is saved. Add it in Settings.", action: "settings" });
  const recentFail = [...jobs.values()].filter(j => j.status === "error" && Date.now() - new Date(j.finished_at).getTime() < 15 * 60e3).pop();
  if (recentFail) notices.push({ level: "warn", key: "job", text: `Last ${recentFail.kind} run failed: ${recentFail.error}`, action: null });
  return { notices, provider: pv, cookie: ck };
});

// Draft the "me" profile from the user's own Claude Code memory and CLAUDE.md files.
route("POST", "/api/settings/draft-me", async () => {
  if (!claudeCliAvailable()) throw new HttpError(400, "Claude Code CLI not found on this machine.");
  const { profile, sources } = await draftMeProfile({ model: researchModel() });
  return { profile, sources };
});

route("GET", "/api/events", () => events.list());

route("POST", "/api/events/sync", async req => {
  const b = await readJson(req);
  if (!cookie()) throw new HttpError(400, "Add your Luma session cookie in Settings first.");
  const periods = b.period === "all" ? ["future", "past"] : [b.period || "future"];
  let n = 0;
  try {
    for (const p of periods) {
      const list = await listMyEvents(cookie(), p);
      for (const ev of list) { upsertEvent(ev, "home"); n++; }
    }
    markCookie(true);
  } catch (e) {
    if (isAuthError(e)) {
      markCookie(false, e.message);
      throw new HttpError(401, "Luma says you are not signed in. Your cookie has expired; paste a fresh one in Settings.");
    }
    throw e;
  }
  return { synced: n, events: events.list() };
});

route("POST", "/api/events/add", async req => {
  const b = await readJson(req);
  const m = String(b.url || "").trim().match(/(?:lu\.ma|luma\.com)\/([A-Za-z0-9_-]+)|^([A-Za-z0-9_-]+)$/);
  const slug = m?.[1] || m?.[2];
  if (!slug) throw new HttpError(400, "Paste a luma.com event link.");
  const ev = await getEventPublic(slug, cookie());
  upsertEvent(ev, "manual");
  if (ev.featured_guests?.length && !guests.list(ev.api_id).length) replaceGuests(ev.api_id, ev.featured_guests);
  return events.get(ev.api_id);
});

route("GET", "/api/events/:id", (req, p) => {
  const data = assembleEvent(p.id);
  if (!data) throw new HttpError(404, "Unknown event");
  return data;
});

route("DELETE", "/api/events/:id", (req, p) => { events.delete(p.id); return { ok: true }; });

route("POST", "/api/events/:id/guests", (req, p) => {
  if (!events.get(p.id)) throw new HttpError(404, "Unknown event");
  return startJob("guests", p.id, job => pipelineGuests(job, p.id));
});

route("POST", "/api/events/:id/triage", async (req, p) => {
  const b = await readJson(req);
  if (!events.get(p.id)) throw new HttpError(404, "Unknown event");
  return startJob("triage", p.id, job => pipelineTriage(job, p.id, { force: b.force !== false }));
});

route("POST", "/api/events/:id/research", async (req, p) => {
  const b = await readJson(req);
  if (!events.get(p.id)) throw new HttpError(404, "Unknown event");
  return startJob("research", p.id, job => pipelineResearch(job, p.id, { top: b.top || 25, ids: b.ids || null, force: !!b.force }));
});

route("POST", "/api/events/:id/rank", async (req, p) => {
  const b = await readJson(req);
  if (!events.get(p.id)) throw new HttpError(404, "Unknown event");
  return startJob("rank", p.id, job => pipelineRank(job, p.id, b.top || 10, { force: b.force !== false }));
});

// One click: guests -> triage -> research top N -> rank
route("POST", "/api/events/:id/run", async (req, p) => {
  const b = await readJson(req);
  if (!events.get(p.id)) throw new HttpError(404, "Unknown event");
  const top = b.top || 25;
  // Incremental: each step only does what is missing, so re-running costs nothing once done.
  return startJob("run", p.id, async job => {
    if (b.refetch || !guests.list(p.id).length) await pipelineGuests(job, p.id);
    await pipelineTriage(job, p.id, { force: !!b.force });
    await pipelineResearch(job, p.id, { top, force: !!b.force });
    await pipelineRank(job, p.id, 10, { force: !!b.force });
  });
});

route("POST", "/api/events/:id/notes/:uid", async (req, p) => {
  const b = await readJson(req);
  notes.set(p.id, p.uid, b.status, b.note);
  return { ok: true };
});

route("GET", "/api/jobs/:id", (req, p) => {
  const j = jobs.get(p.id);
  if (!j) throw new HttpError(404, "Unknown job");
  return { ...j, est_cost: estimateCost(j.usage, model()) };
});

route("GET", "/api/jobs", () => [...jobs.values()].slice(-20));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const out = await r.handler(req, params, url);
      return send(res, 200, out);
    }
    // static
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    const fp = path.join(root, "public", path.normalize(file));
    if (fp.startsWith(path.join(root, "public")) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream", "cache-control": "no-store" });
      return fs.createReadStream(fp).pipe(res);
    }
    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof LumaError ? (e.status === 401 || e.status === 403 ? 401 : 502) : e instanceof RefusalError ? 422 : 500;
    if (status >= 500) console.error(e);
    send(res, status, { error: e.message || String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`roster running at http://localhost:${PORT}  (runs on: ${provider()}, model: ${model()}, luma cookie: ${cookie() ? "set" : "missing"}, anthropic key: ${hasApiKey() ? "set" : "missing"}, claude: ${claudeCliAvailable()}, codex: ${codexCliAvailable()})`);
});
