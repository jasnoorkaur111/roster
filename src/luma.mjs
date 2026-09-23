// Luma private API client (the same JSON API the luma.com web app uses).
// Verified against luma.com bundles on 2026-09-23:
//   GET /url?url=<slug>                     public   -> { kind:"event", data:{...} }
//   GET /event/get?event_api_id=evt-...     public   -> event page data
//   GET /home/get-events?period=future|past signed-in, paginated
//   GET /event/get-guest-list?event_api_id=&ticket_key=  signed-in, paginated
// Pagination: pagination_limit / pagination_cursor -> { entries:[...], next_cursor, has_more }

const API = "https://api.luma.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

export class LumaError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function lumaGet(path, params = {}, cookie = null) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers = {
    accept: "application/json",
    origin: "https://luma.com",
    referer: "https://luma.com/",
    "user-agent": UA,
  };
  if (cookie) headers.cookie = `luma.auth-session-key=${cookie}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    throw new LumaError(body?.message || `Luma ${res.status} on ${path}`, res.status, body);
  }
  return body;
}

async function paginate(path, args, cookie, { limit = 100, max = 5000, onPage } = {}) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 200; i++) {
    const page = await lumaGet(
      path,
      { ...args, pagination_limit: limit, pagination_cursor: cursor || undefined },
      cookie,
    );
    const entries = page.entries || page.items || firstArray(page) || [];
    out.push(...entries);
    onPage?.(out.length);
    if (!page.has_more || !page.next_cursor || out.length >= max || entries.length === 0) break;
    cursor = page.next_cursor;
  }
  return out;
}

function firstArray(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const v of Object.values(obj)) if (Array.isArray(v)) return v;
  return null;
}

/** Cheap cookie check: one page of the signed-in home feed. */
export async function checkCookie(cookie) {
  const page = await lumaGet("/home/get-events", { period: "future", pagination_limit: 1 }, cookie);
  return { ok: true, sample: (page.entries || [])[0]?.event?.name || null };
}

/** Events on the signed-in user's home feed (going / hosting / invited). */
export async function listMyEvents(cookie, period = "future") {
  const entries = await paginate("/home/get-events", { period }, cookie, { limit: 25, max: 500 });
  return entries.map(normalizeHomeEntry).filter(Boolean);
}

function normalizeHomeEntry(e) {
  const ev = e.event || e;
  if (!ev?.api_id) return null;
  return {
    api_id: ev.api_id,
    slug: ev.url || null,
    name: ev.name || "(untitled)",
    start_at: ev.start_at || e.start_at || null,
    end_at: ev.end_at || null,
    timezone: ev.timezone || null,
    location: locationOf(ev),
    cover_url: ev.cover_url || e.cover_image?.url || null,
    description: ev.description_md || ev.description || null,
    guest_count: e.guest_count ?? ev.guest_count ?? null,
    ticket_key: e.guest_info?.ticket_key || null,
    approval_status: e.guest_info?.approval_status || null,
    is_host: !!e.host_info || !!e.is_host,
    hosts: (e.hosts || []).map(h => h.name).filter(Boolean),
    raw: e,
  };
}

function locationOf(ev) {
  const g = ev.geo_address_info || ev.geo_address_json || {};
  return (
    g.full_address ||
    [g.address, g.city, g.region].filter(Boolean).join(", ") ||
    g.city_state ||
    (ev.location_type === "online" ? "Online" : null) ||
    null
  );
}

/** Public event lookup by slug (from a luma.com/<slug> link) or evt- id. */
export async function getEventPublic(slugOrId, cookie = null) {
  let data;
  if (/^evt-/.test(slugOrId)) {
    data = await lumaGet("/event/get", { event_api_id: slugOrId }, cookie);
  } else {
    const r = await lumaGet("/url", { url: slugOrId }, cookie);
    if (r.kind !== "event") throw new LumaError(`luma.com/${slugOrId} is a ${r.kind}, not an event`, 400);
    data = r.data;
  }
  const ev = data.event || {};
  return {
    api_id: data.api_id || ev.api_id,
    slug: ev.url || slugOrId,
    name: ev.name,
    start_at: ev.start_at || data.start_at,
    end_at: ev.end_at || null,
    timezone: ev.timezone || null,
    location: locationOf(ev),
    cover_url: data.cover_image?.url || ev.cover_url || null,
    description: ev.description_md || ev.description || null,
    guest_count: data.guest_count ?? null,
    ticket_count: data.ticket_count ?? null,
    ticket_key: data.guest_data?.ticket_key || data.guest_info?.ticket_key || null,
    approval_status: data.guest_data?.approval_status || null,
    is_host: !!data.host_info,
    hosts: (data.hosts || []).map(h => h.name).filter(Boolean),
    featured_guests: (data.featured_guests || []).map(normalizeGuest),
    raw: data,
  };
}

/** Full guest list. Requires the signed-in user to be registered (or host) and the host to show the list. */
export async function getGuestList(eventApiId, ticketKey, cookie, onPage) {
  const entries = await paginate(
    "/event/get-guest-list",
    { event_api_id: eventApiId, ticket_key: ticketKey || undefined },
    cookie,
    { limit: 100, max: 5000, onPage },
  );
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const g = normalizeGuest(e);
    if (!g || seen.has(g.user_api_id)) continue;
    seen.add(g.user_api_id);
    out.push(g);
  }
  return out;
}

export function normalizeGuest(e) {
  const u = e?.user || e?.guest || e || {};
  const id = u.api_id || u.user_api_id || e?.api_id;
  if (!id) return null;
  const name = u.name || [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "Unknown";
  return {
    user_api_id: id,
    name,
    first_name: u.first_name || null,
    last_name: u.last_name || null,
    username: u.username || null,
    avatar_url: u.avatar_url || null,
    bio_short: u.bio_short || u.bio || null,
    linkedin: cleanHandle(u.linkedin_handle, "linkedin"),
    twitter: cleanHandle(u.twitter_handle, "twitter"),
    instagram: cleanHandle(u.instagram_handle, "instagram"),
    tiktok: cleanHandle(u.tiktok_handle, "tiktok"),
    youtube: cleanHandle(u.youtube_handle, "youtube"),
    website: u.website || null,
    timezone: u.timezone || null,
    is_verified: !!u.is_verified,
    approval_status: e?.approval_status || e?.guest_info?.approval_status || null,
    raw: e,
  };
}

function cleanHandle(h, kind) {
  if (!h) return null;
  let s = String(h).trim();
  s = s.replace(/^https?:\/\/(www\.)?/i, "");
  if (kind === "linkedin") {
    s = s.replace(/^linkedin\.com\//i, "").replace(/\/$/, "");
    if (!/^(in|company|school)\//i.test(s)) s = "in/" + s.replace(/^\/+/, "");
    return s;
  }
  s = s
    .replace(/^(twitter|x|instagram|tiktok|youtube)\.com\//i, "")
    .replace(/^@/, "")
    .replace(/\/$/, "");
  return s || null;
}

export function profileUrls(g) {
  const urls = {};
  if (g.linkedin) urls.linkedin = `https://www.linkedin.com/${g.linkedin}`;
  if (g.twitter) urls.twitter = `https://x.com/${g.twitter}`;
  if (g.instagram) urls.instagram = `https://instagram.com/${g.instagram}`;
  if (g.tiktok) urls.tiktok = `https://tiktok.com/@${g.tiktok}`;
  if (g.youtube) urls.youtube = `https://youtube.com/${g.youtube.startsWith("@") ? "" : "@"}${g.youtube}`;
  if (g.website) urls.website = /^https?:\/\//.test(g.website) ? g.website : `https://${g.website}`;
  if (g.username) urls.luma = `https://luma.com/user/${g.username}`;
  return urls;
}

/** Candidate photo URLs, best first. Luma default avatars are skipped. */
export function photoCandidates(g) {
  const out = [];
  const isDefault = !g.avatar_url || /avatars-default/.test(g.avatar_url);
  if (!isDefault) out.push(g.avatar_url);
  if (g.twitter) out.push(`https://unavatar.io/x/${encodeURIComponent(g.twitter)}?fallback=false`);
  if (g.instagram) out.push(`https://unavatar.io/instagram/${encodeURIComponent(g.instagram)}?fallback=false`);
  if (g.website) {
    try {
      const host = new URL(profileUrls(g).website).hostname;
      out.push(`https://unavatar.io/${host}?fallback=false`);
    } catch {}
  }
  return out;
}
