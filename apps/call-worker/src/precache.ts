/**
 * Pre-warming the §6 audio cache at boot.
 *
 * The set to render is exactly what `voice-flow render` produces: the lines the flow can
 * actually reach, for one lead and language, each with the cache key the worker will look up.
 * Rendering every DECLARED line instead would waste synthesis on dead lines — and on CPU
 * Kokoro, each wasted line costs seconds.
 *
 * Two sources, same shape:
 *   - PRECACHE_FILE, the CLI's JSON. Lets the render happen on a build machine and ship as an
 *     artefact, so a worker boots without paying for synthesis at all.
 *   - the active flow already in memory, via the same analyseReachability the CLI calls.
 *
 * A pre-warm failure is not fatal. The worker starts with a cold or partial cache and the
 * first call pays for it — bad, and worth alerting on, but better than refusing to take calls.
 */

import { readFile } from 'node:fs/promises'

import {
  analyseReachability,
  audioCacheKey,
  type AudioCache,
  type Flow,
  type Lang,
  type LineVars,
  type TTSProvider,
  type Voice,
} from '@voice-agent/shared'

export interface PrecacheLine {
  id: string | null
  text: string
  cacheKey: string
}

/** The shape `voice-flow render` writes. */
export interface RenderFile {
  flowVersion: number
  lang: Lang
  voiceId: string
  lines: PrecacheLine[]
}

export interface PrecacheResult {
  requested: number
  synthesised: number
  alreadyCached: number
  failed: number
  totalMs: number
  /** Lines that could not be rendered. Each one is a live synthesis on a real call. */
  failures: Array<{ id: string | null; error: string }>
}

export async function loadRenderFile(path: string): Promise<RenderFile> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as RenderFile).lines)
  ) {
    throw new Error(`${path} is not a voice-flow render file`)
  }
  return parsed as RenderFile
}

/** The same closed set the CLI would print, computed from the flow already in memory. */
export function linesFromFlow(
  flow: Flow,
  lang: Lang,
  vars: LineVars,
  voiceId: string,
): PrecacheLine[] {
  return analyseReachability(flow, lang, vars, { voiceId }).lines.map((l) => ({
    id: l.id,
    text: l.text,
    cacheKey: l.cacheKey,
  }))
}

export interface PrecacheOptions {
  tts: TTSProvider
  cache: AudioCache
  voice: Voice
  lines: readonly PrecacheLine[]
  sampleRate: number
  bytesPerSample: number
  onProgress?: (done: number, total: number, line: PrecacheLine) => void
}

/**
 * Renders each line and stores it under the key the worker will look up.
 *
 * Deliberately sequential: on CPU the model saturates the cores already, and running renders
 * in parallel at boot would compete with whatever calls the worker is taking.
 */
export async function precache(opts: PrecacheOptions): Promise<PrecacheResult> {
  const startedAt = Date.now()
  const result: PrecacheResult = {
    requested: opts.lines.length,
    synthesised: 0,
    alreadyCached: 0,
    failed: 0,
    totalMs: 0,
    failures: [],
  }

  for (const [i, line] of opts.lines.entries()) {
    // Trust the worker's own key over the file's: if the two ever disagree the file is stale,
    // and writing its key would fill the cache with entries nothing ever looks up.
    const key = audioCacheKey(line.text, opts.voice.id, opts.voice.lang)

    if ((await opts.cache.get(key)) !== undefined) {
      result.alreadyCached++
      opts.onProgress?.(i + 1, opts.lines.length, line)
      continue
    }

    try {
      const chunks: Buffer[] = []
      for await (const chunk of opts.tts.synthesize(line.text, opts.voice)) chunks.push(chunk)
      if (chunks.length === 0) throw new Error('provider produced no audio')

      await opts.cache.set(key, {
        pcm: Buffer.concat(chunks),
        sampleRate: opts.sampleRate,
        bytesPerSample: opts.bytesPerSample,
      })
      result.synthesised++
    } catch (err: unknown) {
      result.failed++
      result.failures.push({ id: line.id, error: err instanceof Error ? err.message : String(err) })
    }

    opts.onProgress?.(i + 1, opts.lines.length, line)
  }

  result.totalMs = Date.now() - startedAt
  return result
}
