import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { profileUrls } from "./luma.mjs";

export const DEFAULT_MODEL = process.env.MODEL || "claude-opus-5";

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

const SYSTEM_CORE = `You help a founder decide who to talk to at events. You are given the founder's profile and goals ("ME"), an event, and Luma guest records (name, short bio, social handles). Be concrete and honest: base judgments on evidence in the records or on what you actually find online. Never invent employers, titles, or facts. When a person's identity online is ambiguous, say so and lower confidence. Score relevance to ME's goals, not general impressiveness.`;

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

export async function triageGuests({ event, guests, me, model = DEFAULT_MODEL, onProgress }) {
  const chunks = [];
  for (let i = 0; i < guests.length; i += 50) chunks.push(guests.slice(i, i + 50));
  const results = [];
  let done = 0;
  const usage = { input: 0, output: 0, cache_read: 0, searches: 0 };
  await mapLimit(chunks, 3, async chunk => {
    const res = await client().messages.parse({
      model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: zodOutputFormat(TriageSchema) },
      system: [{ type: "text", text: SYSTEM_CORE, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `ME:\n${me}\n\n${eventBlock(event)}\n\nGUESTS (score every one of them, using only the record; 0 = no evidence of relevance, 50 = plausibly worth a hello, 80+ = clearly worth seeking out for ME's goals; "tag" is your best read of who they are):\n${chunk.map(guestLine).join("\n")}`,
        },
      ],
    });
    assertNotRefused(res);
    addUsage(usage, usageOf(res));
    const parsed = res.parsed_output;
    if (!parsed) throw new Error("Triage response did not parse");
    results.push(...parsed.scores);
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

export async function researchGuest({ guest, event, me, model = DEFAULT_MODEL, maxSearches = 6 }) {
  const urls = profileUrls(guest);
  const known = Object.entries(urls)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const format = zodOutputFormat(ProfileSchema);
  const stream = client().messages.stream({
    model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches }],
    system: [{ type: "text", text: SYSTEM_CORE, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `ME:\n${me}\n\n${eventBlock(event)}\n\nRESEARCH THIS GUEST. Use web search (up to ${maxSearches} searches) to find who they are: current role and company, what they are building or investing in, recent activity, and a public photo if one exists on a site they control or a team page. Start from the known links. Quote sources as URLs. If you cannot confirm identity, keep to what the Luma record says and mark confidence low.\n\nLUMA RECORD:\nname: ${guest.name}\nbio: ${guest.bio_short || "(none)"}\n${known || "(no links)"}\nluma avatar: ${guest.avatar_url || "(none)"}`,
      },
    ],
  });
  const msg = await stream.finalMessage();
  assertNotRefused(msg);
  const text = textOf(msg);
  const profile = parseJson(text, ProfileSchema);
  return { profile, usage: usageOf(msg) };
}

// ---------- 3. Final ranking (top 10 from researched candidates) ----------

const RankSchema = z.object({
  strategy: z.string().describe("3-4 sentences: how ME should work this room, who to find first, what to skip"),
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

export async function rankEvent({ event, candidates, me, model = DEFAULT_MODEL, topN = 10 }) {
  const lines = candidates.map(c => {
    const p = c.profile;
    return [
      `### id=${c.user_api_id} | ${c.name}`,
      p ? `headline: ${p.headline}` : `bio: ${c.bio_short || "(none)"}`,
      p ? `summary: ${p.summary}` : null,
      p ? `relevance: ${p.relevance.score} - ${p.relevance.why} | angle: ${p.relevance.angle}` : `triage: ${c.triage_score ?? "?"} - ${c.triage_why || ""}`,
      p ? `confidence: ${p.confidence}${p.identity_note ? ` (${p.identity_note})` : ""}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
  const res = await client().messages.parse({
    model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(RankSchema) },
    system: [{ type: "text", text: SYSTEM_CORE, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `ME:\n${me}\n\n${eventBlock(event)}\n\nCANDIDATES (already researched):\n\n${lines.join("\n\n")}\n\nPick the top ${topN} people ME should talk to at this event, ranked. Weigh: fit with ME's stated goals, how much ME can realistically get from a 5-minute conversation, and identity confidence (drop low-confidence guesses unless the Luma bio alone justifies it). Prefer a mix that covers ME's different goals over ten of the same type.`,
      },
    ],
  });
  assertNotRefused(res);
  const parsed = res.parsed_output;
  if (!parsed) throw new Error("Ranking response did not parse");
  parsed.top.sort((a, b) => a.rank - b.rank);
  return { ranking: parsed, usage: usageOf(res) };
}

// ---------- helpers ----------

export function addUsage(acc, u) {
  acc.input += u.input;
  acc.output += u.output;
  acc.cache_read += u.cache_read;
  acc.searches += u.searches;
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

/** Rough cost in USD for display only (Opus 5 list price; search at $10/1k). */
export function estimateCost(u, model = DEFAULT_MODEL) {
  const opus = /opus/.test(model);
  const sonnet = /sonnet/.test(model);
  const inP = opus ? 5 : sonnet ? 2 : 10;
  const outP = opus ? 25 : sonnet ? 10 : 50;
  return (u.input * inP + u.cache_read * inP * 0.1 + u.output * outP) / 1e6 + u.searches * 0.01;
}
