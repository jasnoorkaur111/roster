# Roster

Local web app. Pulls your Luma events, loads the guest list, researches every guest with Claude + web search, and picks the ten people you should find in the room.

## Run

```bash
cd ~/Desktop/roster
npm start            # http://localhost:4747
```

Needs Node 22.5+ (uses the built-in `node:sqlite`). Put `ANTHROPIC_API_KEY=...` in `.env`.

## First use

1. Settings → paste your Luma session cookie. On luma.com open DevTools → Application → Cookies → copy the value of `luma.auth-session-key`. It is saved only in `data/roster.sqlite`. It expires now and then; paste a fresh one when "Pull my Luma events" fails.
2. Settings → edit "Who I am and who I want to meet". Every score is relative to this text. Or edit `me.md` (copy from `me.example.md`).
3. "Pull my Luma events" lists everything you are going to or hosting. Or paste any luma.com link.
4. Open an event → "Load guests and rank". Pipeline: guest list → quick score of everyone (no web) → deep web research on the top 25 → final top 10 with openers and asks.

You only see a guest list when you are registered for the event and the host has the list turned on. Events added by link without a cookie only show the featured guests.

## Cost

Opus 5 list price: roughly $0.12 per person deep-researched, a few cents per person for the quick score. A 300-person event with the top 25 researched is about $5. Change the model in Settings (e.g. `claude-sonnet-5`) to cut it.

## Layout

- `src/luma.mjs` Luma private API (endpoints verified from luma.com bundles, Sep 2026)
- `src/ai.mjs` triage, research (web_search tool), ranking; structured outputs via zod
- `src/db.mjs` SQLite tables: events, guests, triage, profiles, rankings, notes
- `src/server.mjs` HTTP API + background jobs
- `public/` the UI, no build step
