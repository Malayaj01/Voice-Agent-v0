#!/usr/bin/env node
/**
 * Measures time-to-first-byte cached vs uncached, against the §6 budget.
 *
 *   node dist/bench-tts.js [--flow <file>] [--lang en-IN] [--voice af_heart] [--lines 6]
 *
 * First byte is what the budget is about: the caller hears the start of the line, not the end
 * of it. So this measures the gap between asking for a line and the first frame arriving, on a
 * cold cache and then a warm one.
 */

import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import {
  CachingTTSProvider,
  MemoryAudioCache,
  parseFlow,
  STAGE_BUDGET_MS,
  type Lang,
  type TTSProvider,
  type Voice,
} from '@voice-agent/shared'

import {
  KOKORO_BYTES_PER_SAMPLE,
  KOKORO_SAMPLE_RATE,
  KokoroTTSProvider,
} from './kokoro-tts.js'
import { linesFromFlow } from './precache.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const VARS = {
  contact_first_name: 'Rahul',
  company: 'Lipi',
  company_name: 'Acme Clinics',
  industry: 'healthcare',
  slot_pair: 'Monday 11 or Tuesday 3',
  slot_first: 'Monday 11',
  slot_booked: 'Monday 11',
  anchor_question: 'Got a minute?',
}

/** Time until the first frame arrives, plus total time to drain the utterance. */
async function measure(
  tts: TTSProvider,
  text: string,
  voice: Voice,
): Promise<{ firstByteMs: number; totalMs: number; bytes: number }> {
  const startedAt = performance.now()
  let firstByteMs = Number.NaN
  let bytes = 0

  for await (const chunk of tts.synthesize(text, voice)) {
    if (Number.isNaN(firstByteMs)) firstByteMs = performance.now() - startedAt
    bytes += chunk.byteLength
  }
  return { firstByteMs, totalMs: performance.now() - startedAt, bytes }
}

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx] ?? Number.NaN
}

function row(label: string, values: number[]): string {
  const budget = STAGE_BUDGET_MS.tts_first_byte
  const p95 = pct(values, 95)
  const verdict = p95 <= budget ? 'within budget' : `${(p95 / budget).toFixed(0)}x OVER budget`
  return (
    `  ${label.padEnd(22)} ` +
    `min ${pct(values, 0).toFixed(1).padStart(9)}ms  ` +
    `median ${pct(values, 50).toFixed(1).padStart(9)}ms  ` +
    `p95 ${p95.toFixed(1).padStart(9)}ms   ${verdict}\n`
  )
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      flow: { type: 'string' },
      lang: { type: 'string', default: 'en-IN' },
      voice: { type: 'string', default: 'af_heart' },
      lines: { type: 'string', default: '6' },
    },
  })

  const flowPath = values.flow ?? join(REPO_ROOT, 'db', 'seed', 'flow-v1.yaml')
  const lang = (values.lang ?? 'en-IN') as Lang
  const voice: Voice = { id: values.voice ?? 'af_heart', lang }
  const limit = Number(values.lines ?? '6')

  const flow = parseFlow(await readFile(flowPath, 'utf8'))
  const lines = linesFromFlow(flow, lang, VARS, voice.id).slice(0, limit)

  const kokoro = new KokoroTTSProvider({ dtype: 'q8', device: 'cpu' })
  const cache = new MemoryAudioCache()
  const cached = new CachingTTSProvider(kokoro, cache, {
    sampleRate: KOKORO_SAMPLE_RATE,
    bytesPerSample: KOKORO_BYTES_PER_SAMPLE,
  })

  process.stdout.write(`flow v${flow.version} · ${lines.length} lines · voice ${voice.id}\n\n`)

  // Model load is a boot cost, not a per-line cost, so it is reported separately rather than
  // smeared across the first measurement.
  const loadStart = performance.now()
  await kokoro.warmup()
  process.stdout.write(`model load (once, at boot)  ${(performance.now() - loadStart).toFixed(0)}ms\n\n`)

  const cold: number[] = []
  const warm: number[] = []
  /**
   * Total synthesis time, tracked separately from first byte. Pre-rendering needs the WHOLE
   * line, and on Kokoro the tail costs several times the head — summing first-byte times would
   * understate the cost of a pre-warm by about 3x.
   */
  const coldTotal: number[] = []
  let audioMs = 0

  for (const line of lines) {
    const miss = await measure(cached, line.text, voice)
    cold.push(miss.firstByteMs)
    coldTotal.push(miss.totalMs)
    audioMs += (miss.bytes / KOKORO_BYTES_PER_SAMPLE / KOKORO_SAMPLE_RATE) * 1000

    const hit = await measure(cached, line.text, voice)
    warm.push(hit.firstByteMs)

    process.stdout.write(
      `  ${(line.id ?? 'inline').padEnd(22)} cold ${miss.firstByteMs.toFixed(0).padStart(7)}ms   ` +
        `warm ${hit.firstByteMs.toFixed(1).padStart(6)}ms   ` +
        `(${(miss.bytes / KOKORO_BYTES_PER_SAMPLE / KOKORO_SAMPLE_RATE).toFixed(1)}s audio)\n`,
    )
  }

  const synthMs = coldTotal.reduce((a, b) => a + b, 0)
  process.stdout.write(`\ntime to first byte (budget ${STAGE_BUDGET_MS.tts_first_byte}ms, §6)\n`)
  process.stdout.write(row('uncached (cache miss)', cold))
  process.stdout.write(row('cached (pre-warmed)', warm))

  const speedup = pct(cold, 50) / Math.max(pct(warm, 50), 0.001)
  process.stdout.write(`\n  speedup at the median      ${speedup.toFixed(0)}x\n`)
  process.stdout.write(
    `  full render per line      median ${(pct(coldTotal, 50) / 1000).toFixed(1)}s ` +
      `— this, not first byte, is what a pre-warm pays per line\n`,
  )
  process.stdout.write(
    `  realtime factor           ${(synthMs / audioMs).toFixed(2)}x ` +
      `(${(synthMs / 1000).toFixed(1)}s of compute for ${(audioMs / 1000).toFixed(1)}s of audio)\n`,
  )
  process.stdout.write(`  cache                     ${JSON.stringify(cache.stats())}\n`)
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
