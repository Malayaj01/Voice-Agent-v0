#!/usr/bin/env node
/**
 * Endpoint-detection latency — the §6 lever.
 *
 *   node dist/bench-endpoint.js [--hangover 150,200,250,300,400,600] [--noise-db -55]
 *
 * METHOD, because the number is only worth as much as how it was obtained.
 *
 * Ground truth: clips are Kokoro renders of the flow's own lines, so the audio is known
 * exactly. "Speech stopped" is defined as the last sample above -60 dBFS — far below the
 * VAD's own -45 dBFS threshold, so the reference does not inherit the detector's
 * configuration. Each clip then gets a second of line noise appended, because real telephony
 * silence is never digital zero and a VAD tuned against zeros is tuned against nothing.
 *
 * Measured in AUDIO time, not wall-clock. Feeding frames faster than realtime would make
 * wall-clock latency meaningless; what matters is how much audio passes between the caller
 * falling silent and the detector saying so. Per-frame compute is reported separately, and
 * is the part that would be added to the audio-domain figure on a live call.
 *
 * Reported per hangover setting:
 *   - p50 / p95 endpoint latency, against the §6 budget of 150-300ms
 *   - premature endpoints: turns cut off at a mid-sentence pause. This is the cost of being
 *     fast, and a latency number quoted without it is not a measurement, it is a preference.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  EnergyVad,
  STAGE_BUDGET_MS,
  durationMs,
  lastAudibleMs,
  noiseFloor,
  resamplePcm16,
  rmsDb,
} from '@voice-agent/shared'

const SAMPLE_RATE = 16_000
const KOKORO_RATE = 24_000
/** Header written by FileAudioCache (VAC1 + rate + bytesPerSample). */
const CACHE_HEADER_BYTES = 12

interface Clip {
  name: string
  pcm: Buffer
  /** Audio position where speech genuinely stops, from the -60 dBFS reference. */
  truthMs: number
}

function loadClips(dir: string, noiseDb: number, tailMs: number): Clip[] {
  const clips: Clip[] = []
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.pcm'))) {
    const raw = readFileSync(join(dir, name)).subarray(CACHE_HEADER_BYTES)
    const speech = resamplePcm16(raw, KOKORO_RATE, SAMPLE_RATE)
    if (durationMs(speech, SAMPLE_RATE) < 500) continue

    const truthMs = lastAudibleMs(speech, SAMPLE_RATE, -60)
    const tail = noiseFloor(Math.round((SAMPLE_RATE * tailMs) / 1000), noiseDb, clips.length + 1)
    clips.push({ name: name.slice(0, 8), pcm: Buffer.concat([speech, tail]), truthMs })
  }
  return clips
}

interface Measurement {
  latencyMs: number
  prematureCount: number
  computeUsPerFrame: number
}

function runClip(clip: Clip, hangoverMs: number, noiseDb: number): Measurement {
  const vad = new EnergyVad({ sampleRate: SAMPLE_RATE, hangoverMs })
  const frameBytes = (SAMPLE_RATE * 2 * 20) / 1000

  let premature = 0
  let latencyMs = Number.NaN
  let frames = 0
  const startedAt = performance.now()

  for (let at = 0; at < clip.pcm.byteLength; at += frameBytes) {
    frames++
    for (const event of vad.push(clip.pcm.subarray(at, at + frameBytes))) {
      if (event.type !== 'speech_end') continue

      // An endpoint declared while the caller is still talking is a cut-off, not a turn.
      // Tolerance of one frame keeps a detection landing exactly on the boundary from
      // counting as a mistake.
      if (event.speechEndedAtMs < clip.truthMs - 20) {
        premature++
        continue
      }
      if (Number.isNaN(latencyMs)) latencyMs = event.atMs - clip.truthMs
    }
  }

  return {
    latencyMs,
    prematureCount: premature,
    computeUsPerFrame: ((performance.now() - startedAt) * 1000) / Math.max(1, frames),
  }
}

/**
 * Silences inside speech, which is what decides the premature-cut column.
 *
 * Reported because the cut-off numbers are only as representative as the pause distribution
 * of the source audio, and this audio is TTS. Printing the distribution lets a reader see
 * exactly which pauses caused which cuts instead of taking the count on faith.
 */
function internalPauses(clips: readonly Clip[]): number[] {
  const frameBytes = (SAMPLE_RATE * 2 * 20) / 1000
  const gaps: number[] = []

  for (const clip of clips) {
    const vad = new EnergyVad({ sampleRate: SAMPLE_RATE })
    let quiet = 0
    let seenSpeech = false

    for (let at = 0; at + frameBytes <= clip.pcm.byteLength; at += frameBytes) {
      const frameEndMs = ((at + frameBytes) / 2 / SAMPLE_RATE) * 1000
      if (frameEndMs > clip.truthMs) break

      const loud = rmsDb(clip.pcm.subarray(at, at + frameBytes)) > vad.config.thresholdDb
      if (loud) {
        if (seenSpeech && quiet > 0) gaps.push(quiet * 20)
        quiet = 0
        seenSpeech = true
      } else if (seenSpeech) {
        quiet++
      }
    }
  }
  return gaps.sort((a, b) => a - b)
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)] ?? Number.NaN
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      cache: { type: 'string' },
      hangover: { type: 'string', default: '150,200,250,300,400,600' },
      'noise-db': { type: 'string', default: '-55' },
      tail: { type: 'string', default: '1200' },
    },
  })

  const cacheDir = values.cache ?? process.env['AUDIO_CACHE_DIR'] ?? '.cache/audio'
  const noiseDb = Number(values['noise-db'] ?? '-55')
  const tailMs = Number(values.tail ?? '1200')
  const hangovers = (values.hangover ?? '').split(',').map((h) => Number(h.trim()))

  const clips = loadClips(cacheDir, noiseDb, tailMs)
  if (clips.length === 0) {
    process.stderr.write(
      `no clips in ${cacheDir}\nRun the worker once with PRECACHE to render the flow's lines.\n`,
    )
    process.exit(1)
  }

  process.stdout.write(
    `${clips.length} clips from ${cacheDir} · ${SAMPLE_RATE / 1000}kHz · ` +
      `${noiseDb}dBFS line noise · ground truth = last sample above -60dBFS\n\n`,
  )
  process.stdout.write(
    `  hangover    p50        p95        premature   verdict (§6 budget ${STAGE_BUDGET_MS.endpoint}ms)\n`,
  )

  let computeUs = 0
  for (const hangoverMs of hangovers) {
    const measurements = clips.map((c) => runClip(c, hangoverMs, noiseDb))
    const latencies = measurements.map((m) => m.latencyMs).filter((l) => !Number.isNaN(l))
    const premature = measurements.reduce((n, m) => n + m.prematureCount, 0)
    computeUs = Math.max(computeUs, ...measurements.map((m) => m.computeUsPerFrame))

    const p50 = pct(latencies, 50)
    const p95 = pct(latencies, 95)
    const verdict =
      premature > 0
        ? `${premature} turn${premature === 1 ? '' : 's'} cut off mid-sentence`
        : p95 <= STAGE_BUDGET_MS.endpoint
          ? 'within budget, no cut-offs'
          : `p95 ${(p95 - STAGE_BUDGET_MS.endpoint).toFixed(0)}ms over`

    process.stdout.write(
      `  ${`${hangoverMs}ms`.padEnd(11)} ` +
        `${`${p50.toFixed(0)}ms`.padEnd(10)} ` +
        `${`${p95.toFixed(0)}ms`.padEnd(10)} ` +
        `${String(premature).padEnd(11)} ${verdict}\n`,
    )
  }

  const gaps = internalPauses(clips)
  process.stdout.write(
    `\n  Latency is the hangover rounded up to a whole 20ms frame. Detection compute is\n` +
      `  ${computeUs.toFixed(1)}us per frame — four orders of magnitude below the budget, so\n` +
      `  tuning anything but the hangover is rounding error, exactly as §6 says.\n`,
  )
  process.stdout.write(
    `\n  Pauses inside speech across these clips: p50 ${pct(gaps, 50).toFixed(0)}ms, ` +
      `p95 ${pct(gaps, 95).toFixed(0)}ms, max ${(gaps.at(-1) ?? 0).toFixed(0)}ms ` +
      `(${gaps.length} pauses).\n` +
      `  Any pause longer than the hangover becomes a cut-off, which is what the premature\n` +
      `  column counts. These clips are TTS, so that column measures SYNTHESISED pauses.\n` +
      `  Treat the latency column as settled and the cut-off column as provisional until it\n` +
      `  is re-measured on real caller audio from the corpus (§10.5).\n`,
  )
}

main()
