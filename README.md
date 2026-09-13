# Voice Agent V1

Production architecture for an outbound AI voice sales agent placing **2,000 calls/day
on a real Indian phone number**, under TRAI/DLT compliance, at a **sub-800ms turn latency**.

**Status:** Design · no code yet — this repo currently holds the architecture decision record.
**Predecessor:** `AI-Voice-Agent` (browser demo — in-memory sessions, no telephony, not production).

> 📄 **[ARCHITECTURE.md](./ARCHITECTURE.md)** — the full design document.

---

## The short version

**2,000 calls/day is ~2.5 concurrent calls** (Little's Law: `L = λ × W`), with a design
target of 25 for burst headroom. That is *one server*. A second is redundancy, not capacity.
Every architectural choice below follows from that number.

| Decision | Why |
|---|---|
| **Modular monolith**, not microservices | The whole quality bar is sub-800ms per turn. `STT→LLM→TTS` as separate services adds 20–60ms per hop to the exact budget being fought for — to solve a scaling problem that doesn't exist. Revisit at ~50,000/day. |
| **Deterministic FSM spine**, not a free-form LLM agent | Prevents the bot inventing a price on a live sales call — and makes TTS pre-caching possible. |
| **LiveKit Agents** as the media framework | Native SIP trunking (in/out), barge-in from the RTC layer, server-side VAD, Node SDK. Don't write the media layer. |
| **Providers behind interfaces** returning *implementations*, not metadata | Start free, swap to paid per-stage via an env var — no rewrite. |
| **TTS streaming + cancellable from day one** | Even while the free provider returns a complete file. Otherwise a latency floor is baked in and barge-in can never be retrofitted. |

## Compliance is the blocker, not the tech

Under TRAI's DLT framework **every** outbound commercial call from an Indian entity must be
registered — TRAI draws no distinction between an AI bot and a human caller.

- Principal Entity (PE) + Telemarketer (TM) registration, with an active PE↔TM linkage
- **`140x` number series** for promotional/sales (`1600` = transactional)
- DLT-registered consent for promotional calls → `consent` is a first-class table
- **₹1,000–₹10,000 penalty per non-compliant call** — at 2,000/day that is ~₹2 crore/day exposure
- Also in scope: **DPDP Act 2023** for recordings and personal data

Consequence: the telephony provider must be an Indian carrier with DLT linkage
(Exotel / Plivo / Knowlarity / Ozonetel) — not Twilio-by-default. Registration takes
24–72h and runs in parallel with Phase 1.

## System shape

Three deployables plus async workers, split by **latency criticality — not by noun**:

1. **Control plane** — campaigns, leads, DNC, consent, script versions, dashboard, REST API *(stateless)*
2. **Dialer / pacer** — every compliance gate lives here, in code *(Postgres `SKIP LOCKED`)*
3. **Call workers** — the only latency-critical process; per-call session in-process, checkpointed to PG
4. **Post-call workers** — scoring, CRM sync, email, recordings → S3 *(off the hot path)*

> **The one rule that matters: never put a service boundary inside the turn loop.**

## Latency budget

```
caller stops speaking
  ├─ VAD endpoint detect      150–300ms   ← tune FIRST, biggest single lever
  ├─ STT final                100–200ms
  ├─ intent classify            0–150ms   ← 0ms on the regex fast path
  ├─ FSM picks line               ~1ms
  ├─ TTS first audio byte       0–250ms   ← 0ms when cached
  └─ audio reaches caller      50–100ms
                              ─────────
                       target  < 800ms p95
```

Instrument **every stage separately** and alert on p95 per stage — total-latency-only
telemetry tells you that you're slow, never where.

**Free win:** because the FSM selects from a closed set of lines, their audio is generated
ahead of time and keyed on `hash(text + voice + language)`. Most turns then have **0ms TTS** —
a payoff a free-form LLM agent cannot have, because it doesn't know what it will say.

## Stack

| Stage | Free now | Paid later |
|---|---|---|
| STT | `faster-whisper` distil (MIT) | Deepgram Nova-3 / Flux · **Sarvam Saarika** for Hinglish |
| TTS | **Kokoro-82M** (Apache 2.0, CPU-capable) · Chatterbox Turbo (~75ms) | **Sarvam Bulbul v3** · Cartesia Sonic-3 · ElevenLabs Flash v2.5 |
| Brain | regex FSM + local Llama / Groq | classifier fine-tuned on the 50k call corpus |

Groq's free tier rate-limits well before 2,000 calls/day — free is correct for building,
budget paid or self-hosted before go-live.

## Script control

Five layers that keep the anti-hallucination guarantee while still answering real questions:
flow-as-YAML in Postgres (versioned, hot-reloadable) · deterministic FSM spine ·
FAQ answered by **retrieval of approved answers spoken verbatim, never generation** ·
a hard deny-list (price, dates, legal, medical) · script + prompt + model versions stamped
on every call.

## Build order

| Phase | Work |
|---|---|
| **0** | DLT/PE + TM registration · carrier · `140x` number · consent schema — *start immediately, runs in parallel* |
| **1** | LiveKit Agents + free stack — **one** concurrent call end-to-end |
| **2** | Per-stage latency instrumentation |
| **3** | Script-as-data + FAQ retrieval + guardrails |
| **4** | Dialer/pacer + compliance gates + retry policy |
| **5** | Load-test to 25 concurrent · chaos-test mid-call restarts |
| **6** | Swap free→paid per stage, measured against the eval set |

## The 50k call recordings

A real asset: discover the true intent taxonomy by clustering utterance embeddings (the
current 19 labels were guessed) · hand-label ~1,000 utterances into an eval set · fine-tune
a small intent classifier · score the script against outcomes · settle the STT vendor
question on your own Hinglish audio.

**Never commit derived data to a public repo** — private repo or gitignored dir from the
start. Transcribe locally, redact phone numbers and names early, and confirm the consent
basis before the data moves anywhere. Start with **500 calls stratified by outcome**, not 50,000.

## Open questions

See [§11 of ARCHITECTURE.md](./ARCHITECTURE.md#11-open-questions) — registered legal entity,
carrier choice, mono vs channel-split stereo recordings, corpus language mix, hosting, and
the per-call-minute budget ceiling.
