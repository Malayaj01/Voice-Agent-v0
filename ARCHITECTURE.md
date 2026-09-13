# Voice Agent V1 — Production Architecture

**Status:** Design · **Date:** 2026-09-14
**Target:** 2,000 outbound calls/day on a real Indian phone number
**Predecessor:** `AI-Voice-Agent` (browser demo — in-memory sessions, no telephony, not production)

---

## 1. The number that decides the architecture

Run Little's Law before choosing anything.

```
TRAI-legal calling window        ≈ 9 hours
2000 dials / 9h                  ≈ 222 dials/hour ≈ 3.7 dials/min   (λ)
Avg line occupancy (ring+talk)   ≈ 40s = 0.67 min                   (W)

L = λ × W = 3.7 × 0.67           ≈ 2.5 concurrent calls  (average)
                      3× burst   ≈ 8  concurrent
              design target      ≈ 25 concurrent
```

**2,000 calls/day is ~5 concurrent calls. That is one server.** A second is for
redundancy, not capacity.

### Decision: modular monolith, NOT microservices

Not a compromise — microservices would make the product *worse*.

The entire quality bar is a **sub-800ms turn latency**. Splitting
`STT service → LLM service → TTS service` inserts a network hop at every stage of
the exact budget being fought for: +20–60ms per hop, plus new failure modes, plus
ops burden — to solve a scaling problem that does not exist at this volume.

**Trigger to split a service out later:** team size, or a genuinely different
scaling profile. *Never* call volume at this scale. Revisit at ~50,000/day.

---

## 2. Blocker: TRAI / DLT compliance (gates the first real dial)

Under TRAI's DLT framework, every outbound commercial call from an Indian entity
to an Indian subscriber must be registered. **TRAI draws no distinction between an
AI bot and a human caller.**

| Requirement | Detail |
|---|---|
| Principal Entity (PE) registration | On DLT via any operator (Airtel/Jio/Vi/BSNL/Tata) — mirrors to all |
| Telemarketer (TM) registration | The entity placing calls on the PE's behalf |
| PE ↔ TM linkage | Must be active or calls are illegitimate |
| Number series | **`140x` = promotional/sales** · `1600` = transactional/service |
| Consent | DLT-registered consent mandatory for promotional calls |
| Penalty | **₹1,000 – ₹10,000 per non-compliant call** |
| Lead time | 24–72h after documents submitted |

A sales bot dialling from a normal 10-digit mobile number is a violation. At
2,000 calls/day non-compliant, exposure reaches ~₹2 crore/day and the number gets
blacklisted.

**Architectural consequences:**

- Telephony provider = Indian carrier with DLT linkage (Exotel, Plivo, Knowlarity,
  Ozonetel) — not Twilio-by-default.
- **`consent` is a first-class table**, not an afterthought.
- Also in scope: **DPDP Act 2023** for recordings and personal data.

Start PE/TM registration in parallel with Phase 1. It is the only phase with
rupee-denominated downside.

---

## 3. System architecture

Three deployables plus async workers, split by **latency criticality — not by noun**.

```
┌──────────────────────────────────────────────────────────┐
│ 1. CONTROL PLANE          stateless · scale trivially    │
│    campaigns · leads · DNC · consent · script versions   │
│    dashboard · reporting · REST API                      │
└───────────────────────────┬──────────────────────────────┘
                            │ enqueue
                ┌───────────▼────────────┐
                │ 2. DIALER / PACER      │  ← ALL compliance gates
                │ calling hours · DNC    │     live here, in code
                │ consent · freq caps    │
                │ retry policy · pacing  │   Postgres SKIP LOCKED
                └───────────┬────────────┘
                            │ place call (SIP)
┌───────────────────────────▼──────────────────────────────┐
│ 3. CALL WORKERS      ← the ONLY latency-critical process │
│   ┌────────────────────────────────────────────────────┐ │
│   │ per-call session, in-process, checkpointed to PG   │ │
│   │  audio in → VAD/endpoint → STT(stream)             │ │
│   │    → intent → FSM → line → TTS(stream) → audio out │ │
│   │    ↑ barge-in cancels TTS mid-utterance            │ │
│   └────────────────────────────────────────────────────┘ │
│   N concurrent calls per worker · target 25 · scale by N │
└───────────────────────────┬──────────────────────────────┘
                            │ emit call.ended
                ┌───────────▼────────────┐
                │ 4. POST-CALL WORKERS   │  async, off hot path
                │ scoring · CRM · email  │
                │ recording → S3 · BI    │
                └────────────────────────┘
```

### The one rule that matters

> **Never put a service boundary inside the turn loop.**

Everything between *"caller stopped speaking"* and *"bot starts speaking"* happens
in a single process. Vendor API calls are hops you cannot avoid — do not stack your
own service boundaries on top of them.

- **Hot path** (in-process): VAD → STT → intent → FSM → TTS → audio out
- **Warm path** (queue): dialing, pacing, retries
- **Cold path** (async workers): scoring, CRM sync, email, analytics

---

## 4. Framework: don't write the media layer

Barge-in, VAD, jitter buffers and SIP are months of work and already solved.

| Option | Choose if |
|---|---|
| **LiveKit Agents** ← **recommended** | Staying TypeScript. Node SDK, **native SIP trunking** (in/out), barge-in from the RTC layer rather than retrofitted, server-side VAD |
| **Pipecat** | Willing to move to Python. Better pipeline-level latency control, most provider-swappable — but telephony via transports means more manual SIP work |

**For this project:** TypeScript codebase, solo developer, Indian SIP trunk to
terminate → **LiveKit Agents**. Native SIP is precisely where the pain would
otherwise be, and it keeps everything in one language.

Both are free; cost is models + hosting.

---

## 5. Provider abstraction — the free→paid swap

This is the core requirement: **start on free models, replace with paid later
without a rewrite.**

### What the old repo got wrong

`voice/routing.ts` returned *metadata about* a vendor (`{provider: "sarvam",
voiceId: null}`) instead of *an implementation*. So `tts.ts` ignored it entirely and
always used Edge TTS. **Return implementations, not descriptions.**

### Interfaces

```ts
interface STTStream {
  push(pcm: Buffer): void
  on(e: 'partial' | 'final' | 'endpoint', cb: (text: string) => void): void
  close(): void
}
interface STTProvider {
  open(lang: Lang, opts: STTOpts): STTStream
}

interface TTSProvider {
  synthesize(text: string, voice: Voice): AsyncIterable<Buffer>  // ALWAYS streaming
  cancel(): void                                                  // ALWAYS cancellable
}

interface IntentClassifier {
  classify(ctx: CallCtx, utterance: string): Promise<Intent>
}
```

Registry keyed by `(stage, language)`, driven by config. Swapping
Kokoro → Sarvam Bulbul becomes an env var.

### Design rule — do not skip

**Make the TTS interface streaming AND cancellable from day one**, even though the
free provider returns a complete file (wrap it as a single-chunk async iterable).

If the design assumes "generate the complete MP3":

- a latency floor is baked in permanently, and
- **barge-in becomes impossible to retrofit.**

That is the structural mistake in the old `tts.ts`.

### Stack

| Stage | Free now | Paid later |
|---|---|---|
| STT | `faster-whisper` distil (MIT) | Deepgram Nova-3 / Flux · **Sarvam Saarika** for Hinglish |
| TTS | **Kokoro-82M** (Apache 2.0, CPU-capable) · Chatterbox Turbo (~75ms) | **Sarvam Bulbul v3** (Indic) · Cartesia Sonic-3 · ElevenLabs Flash v2.5 |
| Brain | regex FSM + local Llama / Groq | classifier fine-tuned on the 50k call corpus |

> **Caveat:** Groq's free tier will rate-limit well before 2,000 calls/day.
> Free is correct for building; budget paid or self-hosted before go-live.

---

## 6. Latency budget — this is the product spec

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

**Instrument every stage separately; alert on p95 per stage.** Total-latency-only
telemetry tells you that you are slow, never where.

### Free win: pre-cache the scripted audio

Because the FSM selects from a **closed set of lines**, their audio can be generated
ahead of time — key the cache on `hash(text + voice + language)`. Pre-warm a lead's
reachable lines at session creation.

Most turns then have **0ms TTS**. A free-form LLM agent cannot do this, because it
does not know what it will say. This is the payoff for the locked-script design.

FAQ answers are also a fixed set — cache those too.

---

## 7. Script, prompt and FAQ control

Five layers. Together they keep the anti-hallucination guarantee while still
answering real questions.

### 7.1 Flow = data, not code

YAML stored in Postgres, versioned, hot-reloadable. Defining lines as TypeScript
functions (old `lines.ts`) means they cannot be A/B tested or edited without a
deploy. That is the thing to kill.

```yaml
version: 12
states:
  OPENING:
    say:
      en-IN: "Hi {{contact_first_name}}, this is {{company}} assistant. Got a minute?"
      hi-IN-hinglish: "Namaste {{contact_first_name}}, main {{company}} se bol raha hoon. Ek minute hai?"
    on:
      acknowledge: CONTEXT_BRIDGE
      no_time: OBJ_NO_TIME
      dnc: END_DNC
```

### 7.2 FSM spine stays deterministic

Keep it. It is the differentiator, it is what makes TTS caching possible, and it is
what prevents the bot inventing a price on a live sales call.

### 7.3 FAQ = retrieval of approved answers, never generation

```
off-script question
  → vector search over approved FAQ table
  → speak the stored answer VERBATIM
  → return to the flow anchor
```

This is how general FAQs get added **without** giving up script control.

### 7.4 Hard guardrails

A deny-list of topics the model may never generate on: **price, dates, legal,
medical claims.** Those come from tool lookups only.

### 7.5 Version stamping

Script version + prompt version + model versions recorded on **every** call. This is
what turns the 50k-recording corpus into an optimisation loop — conversion becomes
attributable to a specific script revision.

---

## 8. Data model (Postgres)

```
campaigns        id, name, script_version_id, pacing, active_hours, created_at
leads            id, campaign_id, name, phone_e164, language, priority_tier, meta
consent_records  id, phone_e164, dlt_consent_id, source, granted_at, expires_at, revoked_at
dnc              phone_e164 PK, reason, source (own | DND_registry), added_at
calls            id, campaign_id, lead_id, script_version_id, prompt_version_id,
                 provider_call_id, started_at, ended_at, duration_s, connected,
                 disposition, lead_score, next_action, recording_uri
turns            id, call_id, seq, role, text, intent, state,
                 t_endpoint_ms, t_stt_ms, t_intent_ms, t_tts_first_byte_ms
script_versions  id, version, yaml, created_by, created_at, active
faq_entries      id, question, approved_answer, embedding, language, active
```

`calls` is the fact table for all reporting. `turns` carries the per-stage latency
breakdown — that is the production telemetry that matters.

---

## 9. Build order

| Phase | Work | Why here |
|---|---|---|
| **0** | DLT/PE + TM registration · carrier · `140x` number · consent schema | Gates every real dial. Start immediately, runs in parallel. |
| **1** | LiveKit Agents + free stack — **one** concurrent call end-to-end | Prove the media loop before anything else |
| **2** | Per-stage latency instrumentation | Cannot tune what cannot be seen |
| **3** | Script-as-data + FAQ retrieval + guardrails | The control layer |
| **4** | Dialer/pacer + compliance gates + retry policy | Only now is dialing safe |
| **5** | Load-test to 25 concurrent · chaos-test mid-call restarts | Prove durability |
| **6** | Swap free→paid per stage, **measured against the eval set** | Data-driven, one stage at a time |

---

## 10. The 50k call recordings

A real asset. Ranked by value:

1. **Discover the true intent taxonomy** — cluster caller utterance embeddings.
   The current 19 labels were guessed; real data shows what actually occurs, how
   often, and what is collapsing into `unclear`.
2. **Build the eval set** — hand-label ~1,000 utterances. Every later
   "is X better than Y?" becomes a measurement instead of a vendor blog quote.
3. **Fine-tune a small intent classifier** — 50k calls ≈ 200–500k labelled
   utterances. A tiny fine-tuned model (or logistic regression over embeddings)
   beats a 120B general model on this narrow domain, at <10ms and ~zero cost.
4. **Score the script against outcomes** — which opening reduces hangups, which
   rebuttal recovers a "not interested", which FSM state bleeds callers.
5. **Settle the STT vendor question on your own audio** — measure WER on real
   Hinglish rather than trusting benchmarks.

**Handling constraints:**

- Confirm ownership/consent basis before the data moves anywhere (recording for QA
  is not the same as consent to train models).
- **Never commit derived data to a public repo.** Private repo or gitignored dir
  from the start — scrubbing git history later is far worse.
- Transcribe **locally**, redact phone numbers and names early, work on transcripts
  rather than shipping audio to a third-party API.

Start with **500 calls stratified by outcome**, not 50,000.

---

## 11. Open questions

- [ ] Registered Principal Entity — which legal entity, and is this IndiaMART data/infra or personal?
- [ ] Carrier choice: Exotel vs Plivo vs Knowlarity vs Ozonetel (SIP quality, DLT support, pricing)
- [ ] Recording format from carrier: mono or **channel-split stereo**? (stereo = free diarization)
- [ ] Language mix across the 50k corpus
- [ ] Hosting: cloud VM vs on-prem — GPU needed only if STT/TTS are self-hosted
- [ ] Budget ceiling per call-minute once on paid models

---

## Reference links

- [TRAI DLT compliance for AI outbound calling](https://caller.digital/blog/trai-dlt-compliance-ai-outbound-calling-india-2026)
- [AI calling India — DPDP / TRAI / DLT guide](https://www.autointerviewai.com/blog/ai-calling-india-dpdp-trai-dlt-compliance-complete-guide-2026)
- [TRAI compliance checklist 2026](https://expressivr.com/trai-compliance-for-outbound-calls-business-messaging-in-india-your-2026-checklist/)
- [Pipecat vs LiveKit](https://www.cekura.ai/blogs/pipecat-vs-livekit-the-real-difference)
- [Voice agent frameworks wiki](https://soniox.com/wiki/voice-agent-frameworks)
- [Open-source TTS 2026](https://www.tryspeakeasy.io/blog/open-source-text-to-speech-2026)
- [Local self-hosted voice AI models](https://d-central.tech/local-voice-ai-models/)
- [Deepgram STT comparison 2026](https://deepgram.com/learn/best-speech-to-text-apis-2026)
- [Gradium TTS latency benchmark](https://gradium.ai/content/tts-latency-benchmark-2026)
- [Sarvam AI TTS](https://www.sarvam.ai/text-to-speech)
