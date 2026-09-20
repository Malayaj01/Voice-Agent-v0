#!/usr/bin/env node
/**
 * Place one outbound call.
 *
 *   node dist/dial.js --to +91XXXXXXXXXX [--preflight] [--dry-run]
 *
 * This is the manual one-shot used to prove the media path, not the dialer. The dialer (§3.2)
 * owns pacing, retries and claiming work; this places a single call an operator asked for.
 *
 * IT RUNS THE SAME GATES. assertDialAllowed() is the one implementation of the TRAI/DLT rules
 * (§2), and it runs here before anything touches SIP. A manual dial path that skipped the
 * gates would be exactly the hole the gates exist to close — and at Rs 1,000-10,000 per
 * non-compliant call, the cheapest possible bug to avoid.
 *
 * Every gate defaults to FAILING. Registration in particular cannot pass until Phase 0 lands
 * (PE + TM registered, linkage active, a 140x number), and there is deliberately no flag that
 * turns it off: the only way to dial is to actually be registered and say so through
 * DLT_* environment variables that a registered entity can truthfully set.
 */

import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'

import {
  DialBlockedError,
  Fsm,
  InMemoryTurnSink,
  assertDialAllowed,
  evaluateGates,
  isE164,
  optionalEnv,
  parseFlow,
  toE164,
  type DialFacts,
  type Lang,
  type NumberSeries,
  type Voice,
} from '@voice-agent/shared'
import { MockIntentClassifier } from '@voice-agent/shared/mocks'

import { FasterWhisperSTTProvider } from './faster-whisper-stt.js'
import { placeOutboundCall } from './livekit/call.js'
import { envToTtsRuntimeEnv, startTtsRuntime } from './tts-runtime.js'

const USAGE = `voice-dial — place one outbound call

  node dist/dial.js --to +91XXXXXXXXXX [options]

  --to <e164>        number to call, E.164
  --flow <file>      flow document (default db/seed/flow-v1.yaml)
  --lang <lang>      en-IN | hi-IN | hi-IN-hinglish   (default en-IN)
  --lead <file>      JSON of template variables for this lead
  --preflight        run the compliance gates and print the result, then stop
  --dry-run          everything except the SIP dial: loads the flow, warms TTS/STT, gates

Telephony (LiveKit)
  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
  SIP_TRUNK_ID           outbound trunk whose number is the registered line
  SIP_FROM_NUMBER        optional override of the trunk's from-number

TRAI/DLT — §2. Every one of these must be truthfully set by a registered entity.
  DLT_PE_REGISTERED=true     Principal Entity registered on DLT
  DLT_TM_REGISTERED=true     Telemarketer registered
  DLT_LINKAGE_ACTIVE=true    PE-TM linkage active
  DLT_NUMBER_SERIES=140x     140x promotional/sales, 1600 transactional
  DLT_CONSENT_ID=<id>        DLT-registered consent for this number
  CALLING_HOURS=9-21         local window, CALLING_TZ=Asia/Kolkata
`

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function bool(name: string): boolean {
  return optionalEnv(name, 'false').toLowerCase() === 'true'
}

/**
 * Facts from the environment.
 *
 * Reading registration from env rather than inferring it is deliberate: someone has to
 * assert, in a deployment, that the entity is registered. Nothing here can discover that, and
 * anything that guessed would guess in the direction of dialling.
 */
function factsFromEnv(to: string, now: Date): DialFacts {
  const [startHour, endHour] = optionalEnv('CALLING_HOURS', '9-21')
    .split('-')
    .map((h) => Number(h))

  const series = optionalEnv('DLT_NUMBER_SERIES', '')
  const consentId = optionalEnv('DLT_CONSENT_ID', '')

  return {
    phoneE164: toE164(to),
    promotional: optionalEnv('CALL_TYPE', 'promotional') === 'promotional',
    registration: {
      peRegistered: bool('DLT_PE_REGISTERED'),
      tmRegistered: bool('DLT_TM_REGISTERED'),
      linkageActive: bool('DLT_LINKAGE_ACTIVE'),
      numberSeries: series === '140x' || series === '1600' ? (series as NumberSeries) : null,
    },
    // A single manual dial has no DNC table in front of it; the dialer reads the real one.
    // Defaulting to "on the list" would block every call, so this trusts the operator for the
    // one-shot path and the dialer for everything at volume.
    onDnc: bool('LEAD_ON_DNC'),
    consent: {
      dltConsentId: consentId === '' ? null : consentId,
      grantedAt: consentId === '' ? null : new Date(optionalEnv('DLT_CONSENT_GRANTED_AT', now.toISOString())),
      expiresAt: null,
      revokedAt: null,
    },
    activeHours: {
      startHour: Number.isFinite(startHour) ? (startHour as number) : 9,
      endHour: Number.isFinite(endHour) ? (endHour as number) : 21,
      timeZone: optionalEnv('CALLING_TZ', 'Asia/Kolkata'),
    },
    callsInWindow: Number(optionalEnv('LEAD_CALLS_TODAY', '0')),
    frequencyCap: Number(optionalEnv('FREQUENCY_CAP_PER_DAY', '3')),
    now,
  }
}

function printGates(facts: DialFacts): boolean {
  const results = evaluateGates(facts)
  process.stdout.write(`compliance preflight for ${facts.phoneE164}\n`)
  for (const r of results) {
    process.stdout.write(
      `  ${r.passed ? 'PASS' : 'FAIL'}  ${r.gate.padEnd(22)} ${r.reason ?? ''}\n`,
    )
  }
  const blocked = results.filter((r) => !r.passed)
  process.stdout.write(
    blocked.length === 0
      ? '\nall gates pass — this number may be dialled\n'
      : `\n${blocked.length} gate(s) block this dial\n`,
  )
  return blocked.length === 0
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      to: { type: 'string' },
      flow: { type: 'string' },
      lang: { type: 'string', default: 'en-IN' },
      lead: { type: 'string' },
      preflight: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })

  if (values.help === true || values.to === undefined) {
    process.stdout.write(USAGE)
    return values.to === undefined ? 1 : 0
  }
  if (!isE164(values.to)) fail(`--to must be E.164, got ${values.to}`)

  const facts = factsFromEnv(values.to, new Date())

  if (values.preflight === true) return printGates(facts) ? 0 : 1

  // The gate runs before any provider is loaded, any room is joined, and any SIP request is
  // made. Nothing expensive happens on a call that is not allowed to be placed.
  try {
    assertDialAllowed(facts)
  } catch (err: unknown) {
    if (err instanceof DialBlockedError) {
      printGates(facts)
      process.stderr.write(
        '\nRefusing to dial. These are TRAI/DLT requirements (ARCHITECTURE.md §2), not\n' +
          'configuration: a non-compliant call is Rs 1,000-10,000 each and risks the number\n' +
          'being blacklisted. Phase 0 has to land before this path can run.\n',
      )
      return 1
    }
    throw err
  }

  const flowPath = values.flow ?? 'db/seed/flow-v1.yaml'
  const flow = parseFlow(await readFile(flowPath, 'utf8'))
  const lang = (values.lang ?? 'en-IN') as Lang
  const vars =
    values.lead === undefined
      ? {}
      : (JSON.parse(await readFile(values.lead, 'utf8')) as Record<string, string>)

  const callId = randomUUID()
  const tts = await startTtsRuntime(envToTtsRuntimeEnv(), flow)
  const voice: Voice = tts.voice.lang === lang ? tts.voice : { id: tts.voice.id, lang }

  const stt = new FasterWhisperSTTProvider({ model: optionalEnv('STT_MODEL', 'distil-small.en') })
  await stt.warmup()

  const fsm = new Fsm({ flow, lang, vars })
  const turns = new InMemoryTurnSink()

  if (values['dry-run'] === true) {
    process.stdout.write(
      `dry run: gates pass, flow v${flow.version} loaded, TTS and STT warm.\n` +
        `Would dial ${facts.phoneE164} via trunk ${optionalEnv('SIP_TRUNK_ID', '(unset)')}.\n`,
    )
    await stt.close()
    return 0
  }

  const result = await placeOutboundCall(
    {
      callId,
      roomName: `call-${callId}`,
      to: facts.phoneE164,
      trunkId: optionalEnv('SIP_TRUNK_ID', ''),
      lang,
      voice,
      fsm,
      ...(optionalEnv('SIP_FROM_NUMBER', '') === ''
        ? {}
        : { fromNumber: optionalEnv('SIP_FROM_NUMBER', '') }),
    },
    {
      livekit: {
        url: optionalEnv('LIVEKIT_URL', ''),
        apiKey: optionalEnv('LIVEKIT_API_KEY', ''),
        apiSecret: optionalEnv('LIVEKIT_API_SECRET', ''),
      },
      stt,
      tts: tts.tts,
      intent: new MockIntentClassifier(),
      turns,
    },
  )

  await stt.close()

  process.stdout.write(`\ncall ${callId}: ${result.connected ? 'connected' : 'failed'}\n`)
  if (result.failure !== undefined) process.stdout.write(`  ${result.failure}\n`)
  for (const row of turns.rows) {
    process.stdout.write(`  ${String(row.seq).padStart(2)} ${row.role.padEnd(6)} ${row.text}\n`)
  }
  return result.connected ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exitCode = 1
  })
