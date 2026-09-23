import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "roster.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS events (
    api_id TEXT PRIMARY KEY,
    slug TEXT, name TEXT, start_at TEXT, end_at TEXT, location TEXT, cover_url TEXT,
    description TEXT, guest_count INTEGER, ticket_key TEXT, approval_status TEXT,
    is_host INTEGER DEFAULT 0, hosts TEXT, source TEXT, json TEXT,
    guests_synced_at TEXT, synced_at TEXT
  );
  CREATE TABLE IF NOT EXISTS guests (
    event_api_id TEXT, user_api_id TEXT, name TEXT, avatar_url TEXT, bio_short TEXT,
    linkedin TEXT, twitter TEXT, instagram TEXT, website TEXT, username TEXT,
    json TEXT, PRIMARY KEY (event_api_id, user_api_id)
  );
  CREATE TABLE IF NOT EXISTS triage (
    event_api_id TEXT, user_api_id TEXT, score INTEGER, tag TEXT, why TEXT,
    PRIMARY KEY (event_api_id, user_api_id)
  );
  CREATE TABLE IF NOT EXISTS profiles (
    user_api_id TEXT PRIMARY KEY, json TEXT, model TEXT, researched_at TEXT
  );
  CREATE TABLE IF NOT EXISTS rankings (
    event_api_id TEXT PRIMARY KEY, json TEXT, ranked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS notes (
    event_api_id TEXT, user_api_id TEXT, status TEXT, note TEXT, updated_at TEXT,
    PRIMARY KEY (event_api_id, user_api_id)
  );
`);

const q = {
  getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
  setSetting: db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
  upsertEvent: db.prepare(`
    INSERT INTO events (api_id, slug, name, start_at, end_at, location, cover_url, description, guest_count,
      ticket_key, approval_status, is_host, hosts, source, json, synced_at)
    VALUES (@api_id, @slug, @name, @start_at, @end_at, @location, @cover_url, @description, @guest_count,
      @ticket_key, @approval_status, @is_host, @hosts, @source, @json, @synced_at)
    ON CONFLICT(api_id) DO UPDATE SET
      slug = COALESCE(excluded.slug, slug), name = excluded.name, start_at = excluded.start_at,
      end_at = COALESCE(excluded.end_at, end_at), location = COALESCE(excluded.location, location),
      cover_url = COALESCE(excluded.cover_url, cover_url), description = COALESCE(excluded.description, description),
      guest_count = COALESCE(excluded.guest_count, guest_count), ticket_key = COALESCE(excluded.ticket_key, ticket_key),
      approval_status = COALESCE(excluded.approval_status, approval_status), is_host = excluded.is_host,
      hosts = COALESCE(excluded.hosts, hosts), json = excluded.json, synced_at = excluded.synced_at
  `),
  listEvents: db.prepare("SELECT * FROM events ORDER BY start_at DESC"),
  getEvent: db.prepare("SELECT * FROM events WHERE api_id = ?"),
  deleteEvent: db.prepare("DELETE FROM events WHERE api_id = ?"),
  setGuestsSynced: db.prepare("UPDATE events SET guests_synced_at = ?, guest_count = ? WHERE api_id = ?"),
  upsertGuest: db.prepare(`
    INSERT INTO guests (event_api_id, user_api_id, name, avatar_url, bio_short, linkedin, twitter, instagram, website, username, json)
    VALUES (@event_api_id, @user_api_id, @name, @avatar_url, @bio_short, @linkedin, @twitter, @instagram, @website, @username, @json)
    ON CONFLICT(event_api_id, user_api_id) DO UPDATE SET
      name = excluded.name, avatar_url = excluded.avatar_url, bio_short = excluded.bio_short, linkedin = excluded.linkedin,
      twitter = excluded.twitter, instagram = excluded.instagram, website = excluded.website, username = excluded.username, json = excluded.json
  `),
  listGuests: db.prepare("SELECT * FROM guests WHERE event_api_id = ? ORDER BY name"),
  countGuests: db.prepare("SELECT COUNT(*) AS n FROM guests WHERE event_api_id = ?"),
  getGuest: db.prepare("SELECT * FROM guests WHERE event_api_id = ? AND user_api_id = ?"),
  upsertTriage: db.prepare(`
    INSERT INTO triage (event_api_id, user_api_id, score, tag, why) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(event_api_id, user_api_id) DO UPDATE SET score = excluded.score, tag = excluded.tag, why = excluded.why
  `),
  listTriage: db.prepare("SELECT * FROM triage WHERE event_api_id = ?"),
  getProfile: db.prepare("SELECT * FROM profiles WHERE user_api_id = ?"),
  upsertProfile: db.prepare(`
    INSERT INTO profiles (user_api_id, json, model, researched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_api_id) DO UPDATE SET json = excluded.json, model = excluded.model, researched_at = excluded.researched_at
  `),
  profilesFor: db.prepare("SELECT p.* FROM profiles p JOIN guests g ON g.user_api_id = p.user_api_id WHERE g.event_api_id = ?"),
  getRanking: db.prepare("SELECT * FROM rankings WHERE event_api_id = ?"),
  setRanking: db.prepare(`
    INSERT INTO rankings (event_api_id, json, ranked_at) VALUES (?, ?, ?)
    ON CONFLICT(event_api_id) DO UPDATE SET json = excluded.json, ranked_at = excluded.ranked_at
  `),
  listNotes: db.prepare("SELECT * FROM notes WHERE event_api_id = ?"),
  setNote: db.prepare(`
    INSERT INTO notes (event_api_id, user_api_id, status, note, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(event_api_id, user_api_id) DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = excluded.updated_at
  `),
};

export const settings = {
  get: k => q.getSetting.get(k)?.value ?? null,
  set: (k, v) => q.setSetting.run(k, v == null ? null : String(v)),
};

export function upsertEvent(ev, source) {
  q.upsertEvent.run({
    api_id: ev.api_id,
    slug: ev.slug ?? null,
    name: ev.name ?? "(untitled)",
    start_at: ev.start_at ?? null,
    end_at: ev.end_at ?? null,
    location: ev.location ?? null,
    cover_url: ev.cover_url ?? null,
    description: ev.description ?? null,
    guest_count: ev.guest_count ?? null,
    ticket_key: ev.ticket_key ?? null,
    approval_status: ev.approval_status ?? null,
    is_host: ev.is_host ? 1 : 0,
    hosts: ev.hosts?.length ? JSON.stringify(ev.hosts) : null,
    source,
    json: JSON.stringify(stripRaw(ev)),
    synced_at: new Date().toISOString(),
  });
}

function stripRaw(o) {
  const { raw, featured_guests, ...rest } = o;
  return rest;
}

export function replaceGuests(eventApiId, guests) {
  const tx = db.transaction ? null : null; // node:sqlite has no transaction helper; use exec
  db.exec("BEGIN");
  try {
    for (const g of guests) {
      q.upsertGuest.run({
        event_api_id: eventApiId,
        user_api_id: g.user_api_id,
        name: g.name,
        avatar_url: g.avatar_url,
        bio_short: g.bio_short,
        linkedin: g.linkedin,
        twitter: g.twitter,
        instagram: g.instagram,
        website: g.website,
        username: g.username,
        json: JSON.stringify(stripRaw(g)),
      });
    }
    q.setGuestsSynced.run(new Date().toISOString(), guests.length, eventApiId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  void tx;
}

export const events = {
  list: () => q.listEvents.all().map(rowEvent),
  get: id => {
    const r = q.getEvent.get(id);
    return r ? rowEvent(r) : null;
  },
  delete: id => q.deleteEvent.run(id),
};

function rowEvent(r) {
  return {
    ...r,
    is_host: !!r.is_host,
    hosts: r.hosts ? JSON.parse(r.hosts) : [],
    guest_count_loaded: q.countGuests.get(r.api_id)?.n ?? 0,
    json: undefined,
  };
}

export const guests = {
  list: eventId => q.listGuests.all(eventId).map(r => JSON.parse(r.json)),
  get: (eventId, userId) => {
    const r = q.getGuest.get(eventId, userId);
    return r ? JSON.parse(r.json) : null;
  },
};

export const triage = {
  set: (eventId, userId, score, tag, why) => q.upsertTriage.run(eventId, userId, score, tag, why),
  map: eventId => Object.fromEntries(q.listTriage.all(eventId).map(r => [r.user_api_id, r])),
};

export const profiles = {
  get: userId => {
    const r = q.getProfile.get(userId);
    return r ? { ...JSON.parse(r.json), model: r.model, researched_at: r.researched_at } : null;
  },
  set: (userId, profile, model) => q.upsertProfile.run(userId, JSON.stringify(profile), model, new Date().toISOString()),
  mapFor: eventId =>
    Object.fromEntries(
      q.profilesFor.all(eventId).map(r => [r.user_api_id, { ...JSON.parse(r.json), model: r.model, researched_at: r.researched_at }]),
    ),
};

export const rankings = {
  get: eventId => {
    const r = q.getRanking.get(eventId);
    return r ? { ...JSON.parse(r.json), ranked_at: r.ranked_at } : null;
  },
  set: (eventId, ranking) => q.setRanking.run(eventId, JSON.stringify(ranking), new Date().toISOString()),
};

export const notes = {
  map: eventId => Object.fromEntries(q.listNotes.all(eventId).map(r => [r.user_api_id, r])),
  set: (eventId, userId, status, note) => q.setNote.run(eventId, userId, status || null, note || null, new Date().toISOString()),
};
