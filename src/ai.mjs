import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { spawn, execSync } from "node:child_process";
import os from "node:os";
import { profileUrls } from "./luma.mjs";

export const DEFAULT_MODEL = process.env.MODEL || "claude-opus-5";

export function claudeCliAvailable() {
  try {
    execSync("command -v claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
export const DEFAULT_PROVIDER = claudeCliAvailable() ? "claude-code" : "api";

let _client = null;
function client() {
  if (!_client) _client = new Anthropic();
  return _client;
}

export class RefusalError extends Error {}

function assertNotRefused(msg) {
  if (msg.stop_reason === "refusal") {
    throw new RefusalError(msg.stop_details?.explanation || "The model declined this request.");
  }
}

function textOf(msg) {
  return msg.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
}

function parseJson(text, schema) {
  const s = text.trim();
  const candidates = [s];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.unshift(fence[1]);
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1));
  let lastErr;
  for (const c of candidates) {
    try {
      return schema.parse(JSON.parse(c));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("No JSON in model output");
}

function usageOf(msg) {
  const u = msg.usage || {};
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0,
    searches: u.server_tool_use?.web_search_requests || 0,
  };
}

// ---------- Claude Code headless provider ----------
// Runs `claude -p` (Claude Code's headless mode) so the work bills the user's Claude Code
// plan, not an API key. The prompt goes in on stdin; --json-schema gives structured output.

function jsonSchemaFor(schema) {
  const js = z.toJSONSchema(schema);
  delete js.$schema; // the claude CLI's validator rejects the draft-2020-12 $schema pointer
  return JSON.stringify(js);
}

function cleanEnv() {
  const env = { ...process.env };
  // Strip the parent Claude Code session's markers so a nested headless run is allowed.
  for (const k of Object.keys(env)) if (/^CLAUDE/.test(k)) delete env[k];
  // The user chose their login; never let a stray key in the environment get billed instead.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function runClaude(args, stdin, { cwd = os.tmpdir() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { env: cleanEnv(), cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("error", reject);
    child.on("close", code => {
      if (stdout.trim()) resolve(stdout);
      else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400) || "no output"}`));
    });
    child.stdin.end(stdin);
  });
}

function parseClaudeJson(out, schema) {
  let d;
  try {
    d = JSON.parse(out);
  } catch {
    throw new Error(`claude -p returned non-JSON: ${out.slice(0, 200)}`);
  }
  if (d.is_error) throw new Error(`claude -p: ${String(d.result || d.subtype).slice(0, 300)}`);
  const usage = {
    input: d.usage?.input_tokens || 0,
    output: d.usage?.output_tokens || 0,
    cache_read: d.usage?.cache_read_input_tokens || 0,
    searches: 0,
    cost_usd: d.total_cost_usd || 0, // what it would have cost on the API; the plan absorbs it
  };
  const parsed = d.structured_output ? schema.parse(d.structured_output) : parseJson(String(d.result || ""), schema);
  return { parsed, usage };
}

/** One structured call through Claude Code. Isolated: no project settings, no memory, our system prompt only. */
async function ccStructured({ system, user, schema, webSearch, model, effort = "medium", maxBudgetUsd = 2 }) {
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", jsonSchemaFor(schema),
    "--system-prompt", system,
    "--no-session-persistence",
    "--setting-sources", "",
    "--permission-mode", "bypassPermissions",
    "--effort", effort,
    "--max-budget-usd", String(maxBudgetUsd),
  ];
  if (webSearch) args.push("--allowedTools", "WebSearch,WebFetch", "--tools", "WebSearch,WebFetch");
  else args.push("--tools", "");
  if (model) args.push("--model", model);
  const out = await runClaude(args, user);
  return parseClaudeJson(out, schema);
}

const MeDraftSchema = z.object({
  profile: z.string().describe("The finished profile text, plain prose plus a numbered priority list"),
  sources: z.array(z.string()).describe("Which memory notes or files informed it"),
});

/**
 * Draft the "who I am and who I want to meet" text from the user's own Claude Code context:
 * their CLAUDE.md files and auto-memory. Runs in the user's home directory with normal
 * settings so that context loads, read-only tools only.
 */
export async function draftMeProfile({ model = "claude-sonnet-5" } = {}) {
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", jsonSchemaFor(MeDraftSchema),
    "--append-system-prompt",
    "You are drafting a networking profile for the person you are talking to, using what you already know about them from your memory and instruction files. Do not invent facts; if you know little, say so in the profile and leave placeholders in [brackets].",
    "--no-session-persistence",
    "--permission-mode", "bypassPermissions",
    "--allowedTools", "Read,Glob,Grep",
    "--tools", "Read,Glob,Grep",
    "--effort", "low",
    "--max-budget-usd", "5",
    "--model", model || "claude-sonnet-5",
  ];
  const prompt = `Write my "who I am and who I want to meet at events" profile for an event-networking tool. It is the prompt every guest gets scored against, so make it specific.

Format:
- 3-6 lines: who I am, what I am building or working on, stage, location, relevant background.
- "WHO I WANT TO MEET, in priority order:" then a numbered list of 4-6 types of people, each with the concrete reason.
- "NOT a priority:" one line.

Use only what you actually know about me from memory and instruction files. Check your memory directory for project and profile notes before answering. Where you do not know something, put a [placeholder].`;
  const out = await runClaude(args, prompt, { cwd: os.homedir() });
  const { parsed, usage } = parseClaudeJson(out, MeDraftSchema);
  return { profile: parsed.profile, sources: parsed.sources, usage };
}

// ---------- prompts ----------

function eventBlock(event) {
  const desc = (event.description || "").replace(/\s+/g, " ").slice(0, 1500);
  return [
    `EVENT: ${event.name}`,
    event.start_at ? `When: ${event.start_at}` : null,
    event.location ? `Where: ${event.location}` : null,
    event.hosts?.length ? `Hosts: ${event.hosts.join(", ")}` : null,
    desc ? `About: ${desc}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function guestLine(g) {
  const urls = profileUrls(g);
  const links = Object.entries(urls)
    .filter(([k]) => k !== "luma")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `- id=${g.user_api_id} | ${g.name}${g.bio_short ? ` | bio: ${g.bio_short.replace(/\s+/g, " ").slice(0, 240)}` : ""}${links ? ` | ${links}` : ""}`;
}

const SYSTEM_CORE = `You help a person decide who to talk to at events. You are given their profile and goals ("ME"), an event, and Luma guest records (name, short bio, social handles). Everything is relative to ME's stated goals: an investor is only valuable if ME wants investors, a physio only if ME wants physios. Be concrete and honest: base judgments on evidence in the records or on what you actually find online. Never invent employers, titles, or facts. When a person's identity online is ambiguous, say so and lower confidence. Score relevance to ME's goals, not general impressiveness.`;

// ---------- 1. Triage (no web search; cheap, all guests) ----------

const TriageSchema = z.object({
  scores: z.array(
    z.object({
      user_api_id: z.string(),
      score: z.number().int().min(0).max(100),
      tag: z.enum(["investor", "founder", "operator", "engineer", "customer", "press", "academic", "student", "community", "unknown"]),
      why: z.string().max(200),
    }),
  ),
});

function triagePrompt(me, event, chunk) {
  return `ME:\n${me}\n\n${eventBlock(event)}\n\nGUESTS (score every one of them, using only the record; 0 = no evidence of relevance, 50 = plausibly worth a hello, 80+ = clearly worth seeking out for ME's goals; "tag" is your best read of who they are):\n${chunk.map(guestLine).join("\n")}`;
}

export async function triageGuests({ event, guests, me, model = DEFAULT_MODEL, provider = DEFAULT_PROVIDER, onProgress }) {
  const chunks = [];
  for (let i = 0; i < guests.length; i += 50) chunks.push(guests.slice(i, i + 50));
  const results = [];
  let done = 0;
  const usage = { input: 0, output: 0, cache_read: 0, searches: 0 };
  await mapLimit(chunks, 3, async chunk => {
    const user = triagePrompt(me, event, chunk);
    let scores;
    if (provider === "claude-code") {
      const r = await ccStructured({ system: SYSTEM_CORE, user, schema: TriageSchema, webSearch: false, model, effort: "medium", maxBudgetUsd: 3 });
      addUsage(usage, r.usage);
      scores = r.parsed.scores;
    } else {
      const res = await client().messages.parse({
        model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium", format: zodOutputFormat(TriageSchema) },
        system: [{ type: "text", text: SYSTEM_CORE, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
      });
      assertNotRefused(res);
      addUsage(usage, usageOf(res));
      if (!res.parsed_output) throw new Error("Triage response did not parse");
      scores = res.parsed_output.scores;
    }
    results.push(...scores);
    done += chunk.length;
    onProgress?.(done, guests.length);
  });
  return { scores: results, usage };
}

// ---------- 2. Deep research (web search; one guest) ----------

const ProfileSchema = z.object({
  headline: z.string().describe("One line: role @ company, or the best one-line description"),
  role: z.string().nullable(),
  company: z.string().nullable(),
  company_stage: z.string().nullable().describe("e.g. pre-seed, Series A, public, nonprofit, university"),
  location: z.string().nullable(),
  summary: z.string().describe("3-5 sentences on who they are and what they are working on now"),
  facts: z.array(z.object({ text: z.string(), source_url: z.string().nullable() })).describe("5-10 concrete facts with sources"),
  recent: z.array(z.object({ text: z.string(), source_url: z.string().nullable() })).describe("Recent activity: posts, launches, funding, talks (last ~6 months)"),
  personal: z.array(z.object({ text: z.string(), source_url: z.string().nullable() })).describe("Outside work, only what they share publicly themselves: hobbies, sports, causes, hometown, communities, things they post about. Empty if nothing public. Never family, health, religion, politics, or addresses."),
  mutual: z.array(z.string()).describe("Overlaps with ME: same school, city, community, investor, interest, or people in common. Empty if none."),
  links: z.object({
    linkedin: z.string().nullable(),
    twitter: z.string().nullable(),
    website: z.string().nullable(),
    github: z.string().nullable(),
    other: z.array(z.string()),
  }),
  photo_url: z.string().nullable().describe("Direct URL to a public photo of this person (their own site, GitHub, company team page, conference bio). Not LinkedIn. null if none found."),
  relevance: z.object({
    score: z.number().int().min(0).max(100),
    why: z.string().describe("Why this person matters for ME's goals, 1-2 sentences"),
    angle: z.string().describe("The specific overlap or ask to lead with"),
  }),
  opener: z.string().describe("What ME should say in the first 15 seconds, in ME's voice, specific to this person"),
  confidence: z.enum(["high", "medium", "low"]),
  identity_note: z.string().nullable().describe("If the online identity match is uncertain, explain"),
});

function researchPrompt(me, event, guest, maxSearches) {
  const known = Object.entries(profileUrls(guest))
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `ME:\n${me}\n\n${eventBlock(event)}\n\nRESEARCH THIS GUEST. Use web search (at most ${maxSearches} searches, and fetch at most 2 full pages; prefer search snippets) to find who they are: current role and company, what they are building or investing in, recent activity, what they are into outside work if they share it publicly (rapport material, not private life), any overlap with ME, and a public photo if one exists on a site they control or a team page. Start from the known links. Quote sources as URLs. If you cannot confirm identity, keep to what the Luma record says and mark confidence low.\n\nLUMA RECORD:\nname: ${guest.name}\nbio: ${guest.bio_short || "(none)"}\n${known || "(no links)"}\nluma avatar: ${guest.avatar_url || "(none)"}`;
}

export async function researchGuest({ guest, event, me, model = DEFAULT_MODEL, provider = DEFAULT_PROVIDER, maxSearches = 6 }) {
  const user = researchPrompt(me, event, guest, maxSearches);
  if (provider === "claude-code") {
    const { parsed, usage } = await ccStructured({ system: SYSTEM_CORE, user, schema: ProfileSchema, webSearch: true, model, effort: "medium", maxBudgetUsd: 4 });
    return { profile: parsed, usage };
  }
  const stream = client().messages.stream({
    model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(ProfileSchema) },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches }],
    system: [{ type: "text", text: SYSTEM_CORE, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  const msg = await stream.finalMessage();
  assertNotRefused(msg);
  const profile = parseJson(textOf(msg), ProfileSchema);
  return { profile, usage: usageOf(msg) };
}

// ---------- 3. Final ranking (top 10 from researched candidates) ----------

const RankSchema = z.object({
  strategy: z.string().describe("Two sentences, under 45 words total: who to find first and how to pitch this room. Plain prose, no lists, no parentheses, no names beyond two."),
  top: z.array(
    z.object({
      user_api_id: z.string(),
      rank: z.number().int().min(1),
      one_liner: z.string().describe("Who they are in under 12 words"),
      why: z.string().describe("Why they are in the top 10 for ME"),
      opener: z.string().describe("First thing to say, in ME's voice"),
      ask: z.string().describe("The concrete ask or next step to aim for"),
    }),
  ),
});

function rankPrompt(me, event, candidates, topN) {
  const lines = candidates.map(c => {
    const p = c.profile;
    return [
      `### id=${c.user_api_id} | ${c.name}`,
      p ? `headline: ${p.headline}` : `bio: ${c.bio_short || "(none)"}`,
      p ? `summary: ${p.summary}` : null,
      p ? `relevance: ${p.relevance.score} - ${p.relevance.why} | angle: ${p.relevance.angle}` : `triage: ${c.triage_score ?? "?"} - ${c.triage_why || ""}`,
      p?.personal?.length ? `outside work: ${p.personal.map(x => x.text).join("; ")}` : null,
      p?.mutual?.length ? `in common with ME: ${p.mutual.join("; ")}` : null,
      p ? `confidence: ${p.confidence}${p.identity_note ? ` (${p.identity_note})` : ""}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return `ME:\n${me}\n\n${eventBlock(event)}\n\nCANDIDATES (already researched):\n\n${lines.join("\n\n")}\n\nPick the top ${topN} people ME should talk to at this event, ranked. Weigh: fit with ME's stated goals, how much ME can realistically get from a 5-minute conversation, and identity confidence (drop low-confidence guesses unless the Luma bio alone justifies it). Prefer a mix that covers ME's different goals over ten of the same type.`;
}

export async function rankEvent({ event, candidates, me, model = DEFAULT_MODEL, provider = DEFAULT_PROVIDER, topN = 10 }) {
  const user = rankPrompt(me, event, candidates, topN);
  let ranking, usage;
  if (provider === "claude-code") {
    const r = await ccStructured({ system: SYSTEM_CORE, user, schema: RankSchema, webSearch: false, model, effort: "high", maxBudgetUsd: 3 });
    ranking = r.parsed;
    usage = r.usage;
  } else {
    const res = await client().messages.parse({
      model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: zodOutputFormat(RankSchema) },
      system: [{ type: "text", text: SYSTEM_CORE, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    assertNotRefused(res);
    if (!res.parsed_output) throw new Error("Ranking response did not parse");
    ranking = res.parsed_output;
    usage = usageOf(res);
  }
  ranking.top.sort((a, b) => a.rank - b.rank);
  return { ranking, usage };
}

// ---------- helpers ----------

export function addUsage(acc, u) {
  acc.input += u.input;
  acc.output += u.output;
  acc.cache_read += u.cache_read;
  acc.searches += u.searches;
  acc.cost_usd = (acc.cost_usd || 0) + (u.cost_usd || 0);
  return acc;
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Rough cost in USD for display. In Claude Code mode this is what the API would have charged. */
export function estimateCost(u, model = DEFAULT_MODEL) {
  if (u.cost_usd) return u.cost_usd;
  const opus = /opus/.test(model);
  const sonnet = /sonnet/.test(model);
  const inP = opus ? 5 : sonnet ? 2 : 10;
  const outP = opus ? 25 : sonnet ? 10 : 50;
  return (u.input * inP + u.cache_read * inP * 0.1 + u.output * outP) / 1e6 + u.searches * 0.01;
}
