# CLAUDE.md

## What this is

**Voice Agent V1** — an outbound AI voice sales agent: 2,000 calls/day on a real Indian
phone number, TRAI/DLT compliant, **sub-800ms p95 turn latency**. TypeScript, solo developer.

**The repo is design-only right now** — `ARCHITECTURE.md` (full design) and `README.md`.
No code yet. Read `ARCHITECTURE.md` for detail beyond this file: data model §8, build
order §9, open questions §11.

**Current phase: 0 and 1, in parallel.**
- **0** — DLT/PE + TM registration, carrier choice, `140x` number, consent schema. Gates
  every real dial; nothing technical unblocks it, so it runs from day one.
- **1** — LiveKit Agents + the free stack, one concurrent call end-to-end. Prove the media
  loop before anything else.

## Key decisions, and why

These are settled. If you're about to contradict one, say so explicitly rather than quietly.

**Modular monolith, not microservices.** 2,000 calls/day is ~2.5 concurrent calls
(Little's Law), design target 25 for burst — one server. Splitting `STT → LLM → TTS` into
services adds 20–60ms per hop to the 800ms budget that *is* the product spec, to solve a
scaling problem that doesn't exist. Trigger to reconsider: team size, or a genuinely
different scaling profile — never call volume. Revisit at ~50,000/day.

**Never put a service boundary inside the turn loop.** Everything between "caller stopped
speaking" and "bot starts speaking" runs in one process: VAD → STT → intent → FSM → TTS →
audio out. Vendor API calls are hops you can't avoid; don't stack your own on top. Dialing,
pacing and retries go on a queue (warm path); scoring, CRM sync, email and recordings go to
async workers (cold path).

**The FSM owns dialogue; the LLM only classifies.** The state machine picks every line the
bot speaks, from a closed approved set. The model's only job in the turn loop is
`utterance → intent`. Two payoffs: it stops the bot inventing a price on a live sales call,
and because the reachable lines are known in advance their audio is pre-cached on
`hash(text + voice + language)` — most turns are then **0ms TTS**. A free-form LLM agent
can't do that; it doesn't know what it will say.

Off-script questions are answered by vector search over an approved FAQ table, spoken
**verbatim**, then return to the flow anchor — retrieval, never generation. Hard deny-list
regardless of source: **price, dates, legal, medical claims** come from tool lookups only.

**Provider interfaces return implementations, not metadata.** The core requirement is
start free, swap to paid per stage with no rewrite. The predecessor repo's `voice/routing.ts`
returned `{provider: "sarvam", voiceId: null}` — a *description* of a vendor — so `tts.ts`
ignored it and always used Edge TTS. Registry keyed by `(stage, language)`, driven by
config: swapping Kokoro → Sarvam Bulbul is an env var.

**TTS is streaming and cancellable from day one.** `synthesize()` returns
`AsyncIterable<Buffer>`; `cancel()` always exists — even though the free provider returns a
complete file (wrap it as a single-chunk async iterable). If the design assumes "generate
the complete MP3", a latency floor is permanent and **barge-in becomes impossible to
retrofit**. That is the structural mistake in the old `tts.ts`. Same rule for STT: streaming,
with `partial` / `final` / `endpoint` events.

## Conventions

No code exists yet — these are rules for writing it, not patterns to copy from.

- TypeScript/Node. **LiveKit Agents** for media; do not hand-write VAD, jitter buffers,
  barge-in or SIP.
- Postgres for everything stateful. Dialer queue uses `SKIP LOCKED`. Per-call session lives
  in-process, checkpointed to PG.
- **Conversation flow is YAML data in Postgres** — versioned, hot-reloadable. Never
  TypeScript functions. The old `lines.ts` made lines un-A/B-testable without a deploy;
  that's the thing being killed.
- Every compliance gate (calling hours, DNC, consent, frequency caps) lives in the
  dialer/pacer, in code. Not in config, not assumed handled upstream.
- Stamp `script_version`, `prompt_version` and model versions on every `calls` row — that's
  what makes conversion attributable to a script revision.
- Record per-stage latency on every `turns` row (`t_endpoint_ms`, `t_stt_ms`, `t_intent_ms`,
  `t_tts_first_byte_ms`) and alert on **p95 per stage**. Total-latency-only telemetry tells
  you that you're slow, never where.
- Settle provider comparisons against the eval set, not vendor blog benchmarks.

## Git

- **Conventional commits**: `feat:` `fix:` `docs:` `refactor:` `chore:` `test:`, with a
  scope where it helps (`feat(dialer): enforce calling-hours gate`). Imperative subject,
  no trailing period. Use the body to explain *why* when the diff doesn't already say it.
- **Small, focused commits** — one logical change each. A provider swap and a schema
  change are two commits, not one. Keeps `git log` a usable record of how the system got
  here, and makes a bad change revertable on its own.
- **Push at the end of every work phase.** Don't leave finished work sitting unpushed.

## Hard rules

- **Never commit call recordings, transcripts, or anything derived from the 50k corpus.**
  This repo is public. Private repo or gitignored dir from the start — scrubbing git history
  later is far worse. Transcribe locally, redact phone numbers and names early.
- Phone numbers are E.164 everywhere.
- No real dial before Phase 0 lands. Non-compliant calls are ₹1,000–₹10,000 **each**.
