/**
 * The TTS stack the worker runs: a provider, the §6 cache in front of it, and a pre-warm of
 * the flow's closed set at boot.
 *
 * Order matters at boot. Load the model, then pre-warm, then start serving — because with
 * CPU Kokoro a cache miss costs seconds (measured: ~3.9s median to first byte against a 250ms
 * budget), so a worker that accepted calls with a cold cache would simply fail them slowly.
 */

import { readFile } from 'node:fs/promises'

import {
  CachingTTSProvider,
  FileAudioCache,
  optionalEnv,
  type Flow,
  type HealthStatus,
  type Lang,
  type LineVars,
  type TTSProvider,
  type Voice,
} from '@voice-agent/shared'
import { MockTTSProvider } from '@voice-agent/shared/mocks'

import {
  KOKORO_BYTES_PER_SAMPLE,
  KOKORO_SAMPLE_RATE,
  KokoroTTSProvider,
} from './kokoro-tts.js'
import { linesFromFlow, loadRenderFile, precache, type PrecacheResult } from './precache.js'

export interface TtsRuntime {
  tts: TTSProvider
  cache: FileAudioCache
  voice: Voice
  /** Degraded when any line failed to pre-render — those lines will be seconds late. */
  check: () => Promise<HealthStatus>
  result: PrecacheResult | undefined
}

export interface TtsRuntimeEnv {
  provider?: string
  cacheDir?: string
  /** `voice-flow render` output. Lets the render happen on a build machine. */
  precacheFile?: string
  /** JSON file of template variables, when deriving the line set from the flow in-process. */
  leadFile?: string
  voiceId?: string
  lang?: Lang
  enabled?: boolean
}

export function envToTtsRuntimeEnv(): TtsRuntimeEnv {
  return {
    provider: optionalEnv('TTS_PROVIDER', 'kokoro'),
    cacheDir: optionalEnv('AUDIO_CACHE_DIR', '.cache/audio'),
    precacheFile: optionalEnv('PRECACHE_FILE', ''),
    leadFile: optionalEnv('PRECACHE_LEAD', ''),
    voiceId: optionalEnv('TTS_VOICE', 'af_heart'),
    lang: optionalEnv('TTS_LANG', 'en-IN') as Lang,
    enabled: optionalEnv('PRECACHE', '1') !== '0',
  }
}

function buildProvider(name: string): TTSProvider {
  // The mock keeps a dev worker from downloading 80MB of weights to test unrelated wiring.
  if (name === 'mock') return new MockTTSProvider({ msPerChar: 20, chunkMs: 20 })
  return new KokoroTTSProvider({ dtype: 'q8', device: 'cpu' })
}

export async function startTtsRuntime(
  env: TtsRuntimeEnv,
  flow: Flow,
  log: (line: string) => void = (line) => console.log(line),
): Promise<TtsRuntime> {
  const lang = env.lang ?? 'en-IN'
  const voice: Voice = { id: env.voiceId ?? 'af_heart', lang }

  const inner = buildProvider(env.provider ?? 'kokoro')
  const cache = new FileAudioCache(env.cacheDir ?? '.cache/audio')
  const preloaded = await cache.preload()
  log(`[tts] provider ${inner.name}; ${preloaded} cached lines on disk`)

  const tts = new CachingTTSProvider(inner, cache, {
    sampleRate: KOKORO_SAMPLE_RATE,
    bytesPerSample: KOKORO_BYTES_PER_SAMPLE,
  })

  if (env.enabled === false) {
    log('[tts] pre-warm disabled (PRECACHE=0) — every line will synthesise live')
    return { tts, cache, voice, check: () => Promise.resolve('ok'), result: undefined }
  }

  if (inner instanceof KokoroTTSProvider) {
    const at = Date.now()
    await inner.warmup()
    log(`[tts] model loaded in ${Date.now() - at}ms`)
  }

  const lines =
    env.precacheFile !== undefined && env.precacheFile !== ''
      ? (await loadRenderFile(env.precacheFile)).lines
      : linesFromFlow(flow, lang, await readVars(env.leadFile), voice.id)

  log(`[tts] pre-warming ${lines.length} reachable lines...`)
  const result = await precache({
    tts: inner,
    cache,
    voice,
    lines,
    sampleRate: KOKORO_SAMPLE_RATE,
    bytesPerSample: KOKORO_BYTES_PER_SAMPLE,
  })

  log(
    `[tts] pre-warm done in ${(result.totalMs / 1000).toFixed(1)}s: ` +
      `${result.synthesised} rendered, ${result.alreadyCached} already cached, ${result.failed} failed`,
  )
  for (const failure of result.failures) {
    log(`[tts]   FAILED ${failure.id ?? '(inline)'}: ${failure.error}`)
  }

  return {
    tts,
    cache,
    voice,
    check: () => Promise.resolve(result.failed > 0 ? 'degraded' : 'ok'),
    result,
  }
}

async function readVars(leadFile: string | undefined): Promise<LineVars> {
  if (leadFile === undefined || leadFile === '') return {}
  const parsed: unknown = JSON.parse(await readFile(leadFile, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) return {}
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) vars[k] = String(v)
  return vars
}
