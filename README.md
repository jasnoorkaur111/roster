# Roster

A local web app for people who go to a lot of Luma events. It pulls your events, loads the guest list, researches every guest, and picks the ten people you should find in the room, with an opener and an ask for each.

Everything runs on your machine. Guest data, research, and notes live in one SQLite file. Nothing is uploaded anywhere except the questions it asks Claude.

## How it decides who matters

The ranking is relative to **you**. In Settings there is a text box, "Who I am and who I want to meet". Every guest is scored against that text, so a health founder raising a pre-seed gets a different top ten than a recruiter or a journalist at the same event. Write it once, in priority order, and be specific. `me.example.md` shows the shape.

If you use Claude Code, the "Draft it from my Claude Code memory" button writes a first version from what Claude already knows about you (your CLAUDE.md files and memory notes). Edit it and save.

Pipeline for an event:

1. Quick score of every guest from their Luma bio and links. No web, cheap.
2. Deep web research on the top 25: role, company, what they are building or investing in, recent activity, sources, a public photo if one exists on a site they control.
3. Final top 10 with a room strategy, why each person, what to say first, and the ask.

Each guest gets a dossier you can open from the wall. Mark people as want-to-meet, met, or skip, and leave notes.

## Run it

```bash
git clone <this repo> roster && cd roster
npm install
cp .env.example .env
npm start            # http://localhost:4747
```

Needs Node 22.5 or newer (it uses the built-in `node:sqlite`). No build step.

## Connect Luma

Roster reads Luma the same way the luma.com web app does, with your session cookie. There is no official attendee-side API for guest lists.

1. Open luma.com while signed in and press Cmd+Option+I (Ctrl+Shift+I on Windows).
2. In DevTools open the **Application** tab. If you don't see it, it's behind the `>>` button at the end of the tab strip.
3. Left sidebar: Storage, Cookies, `https://luma.com`. Find the row named `luma.auth-session-key` and copy its **Value**.
4. In Roster, open Settings and paste it into "Luma session cookie". Save. Roster checks it against Luma before storing it.

Or put it in `.env` as `LUMA_COOKIE=...`. Either way it is stored only on your machine (`data/roster.sqlite` and `.env` are both gitignored). It expires every few weeks; when "Pull my Luma events" says you are not signed in, paste a fresh one.

Two limits from Luma's side: you only see a guest list for events you are registered for, and only when the host has the guest list turned on. Roster labels hidden lists.

Optional: put your own Luma user id (`usr-...`) in Settings so you are left out of your own guest lists. It is the id on your row in any list Roster loads.

## Connect Claude

Pick one in Settings under "Runs on".

**Claude Code login (default).** Roster runs the research through `claude -p`, Claude Code's headless mode, so it uses your Claude plan and never touches an API key. You need Claude Code installed and signed in:

```bash
npm install -g @anthropic-ai/claude-code
claude          # sign in once, then quit
```

That's it. Be aware it counts against your plan's usage: a 300-person event with the top 25 researched is a meaningful slice of a session's quota on Opus.

**Anthropic API key (optional).** Pay per use instead. Put `ANTHROPIC_API_KEY=...` in `.env`, restart, and choose "Anthropic API key" in Settings. On Opus 5 a 300-person event with the top 25 researched costs about $5; roughly $0.12 per person deep-researched. Switch the model to `claude-sonnet-5` in Settings to cut that.

Neither option is billed for the other: in Claude Code mode the API key is stripped from the environment before `claude` runs.

## Files

- `src/luma.mjs` Luma's private web API (endpoints verified from luma.com bundles, Sep 2026). Public event lookup, your home feed, paginated guest lists.
- `src/ai.mjs` triage, deep research, ranking. One set of prompts, two providers: Claude Code headless or the Anthropic SDK with server-side web search. Structured outputs via zod.
- `src/db.mjs` SQLite: events, guests, triage, profiles, rankings, notes.
- `src/server.mjs` HTTP API and background jobs.
- `public/` the UI, plain HTML and JS.
- `me.example.md` template for the profile text. `me.md` (gitignored) is read as the default if you'd rather keep it in a file than in Settings.
