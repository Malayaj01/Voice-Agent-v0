/**
 * Which lines can this flow actually say?
 *
 * This exists for the §6 pre-cache. Because the FSM selects from a closed set, a lead's audio
 * can be rendered before the call and most turns then cost 0ms of TTS. But "every line in the
 * table" is the wrong set to render: it wastes synthesis on lines the graph cannot reach, and
 * — worse — it hides the fact that they are dead. A line nobody can reach is either a bug in
 * the flow or a leftover from an edit, and both are worth knowing about before a campaign
 * runs on it.
 *
 * The walk mirrors Fsm.advance() exactly: global rules, then per-state `on`, then the shared
 * objection routine, then the state `default`, plus `on_silence` from anywhere. Where they
 * disagree, this analysis is wrong and the cache misses — so they are tested against each
 * other rather than merely written to match.
 */

import type { Lang } from '../lang.js'
import { transitionsOf, type Flow, type FlowTransition, type Say } from './flow.js'
import { lineCacheKey, resolveLine, type LineVars } from './lines.js'

export interface ReachableLine {
  /** Line id, or null when the flow inlined the text. */
  id: string | null
  text: string
  lang: Lang
  /** `hash(text + voice + language)` — the pre-cache key from §6. */
  cacheKey: string
}

export interface ReachabilityReport {
  lines: ReachableLine[]
  reachableStates: string[]
  /** Declared in `lines` but unreachable — dead weight, or a symptom of a flow bug. */
  unreachableLineIds: string[]
  /** Declared in `states` but unreachable from `initial`. */
  unreachableStates: string[]
  /** A `say` that resolves to a line id which does not exist. Always a bug. */
  missingLineIds: string[]
}

/**
 * Which objection rules can fire for a given intent.
 *
 * Rules are evaluated in order and the first passing guard wins, so a rule with no
 * conditional guard shadows everything after it. `no_time` hits an unconditional rule before
 * the generic rebuttal, which is exactly why `rebuttal_no_time` would never be spoken.
 */
function applicableObjectionRules(flow: Flow, intent: string): FlowTransition[] {
  const out: FlowTransition[] = []
  for (const rule of flow.objections.rules) {
    const guard = rule.when
    if (guard?.intentIn !== undefined && !guard.intentIn.includes(intent)) continue

    out.push(rule)

    // repeated / countGte / nudgesGte depend on call state, so the rule may or may not fire
    // and evaluation can fall through. Anything else always fires, ending the chain.
    const conditional =
      guard !== undefined &&
      (guard.repeated !== undefined ||
        guard.countGte !== undefined ||
        guard.nudgesGte !== undefined)
    if (!conditional) break
  }
  return out
}

/** Intents a state can branch on: its own, plus globals, plus the objection set. */
function intentsFor(flow: Flow, stateName: string): string[] {
  const state = flow.states[stateName]
  return [
    ...Object.keys(flow.global),
    ...Object.keys(state?.on ?? {}),
    ...flow.objections.intents,
  ]
}

export interface ReachabilityOptions {
  /** Voice the cache keys are computed for. The §6 key is hash(text + voice + language). */
  voiceId?: string
}

export function analyseReachability(
  flow: Flow,
  lang: Lang,
  vars: LineVars,
  opts: ReachabilityOptions = {},
): ReachabilityReport {
  const voiceId = opts.voiceId ?? ''
  const lines = new Map<string, ReachableLine>()
  const missing = new Set<string>()
  const visited = new Set<string>()
  const queue: string[] = [flow.initial]

  const record = (say: Say | undefined, boundVars: LineVars): void => {
    if (say === undefined) return
    try {
      const resolved = resolveLine(flow, say, lang, boundVars)
      const key = resolved.id ?? `inline:${resolved.text}`
      if (!lines.has(key)) {
        lines.set(key, {
          id: resolved.id,
          text: resolved.text,
          lang,
          cacheKey: lineCacheKey(resolved.text, voiceId, lang),
        })
      }
    } catch {
      // resolveLine throws MissingLineError for an id that does not exist. Templated ids get
      // here when an expansion has no matching line — a real bug, reported not swallowed.
      if (typeof say === 'string') {
        const id = say.replace(/\{\{\s*intent\s*\}\}/g, String(boundVars['intent'] ?? 'intent'))
        missing.add(id)
      }
    }
  }

  /** A transition's line: its own `say`, else the entry line of the state it moves to. */
  const followTransition = (t: FlowTransition, boundVars: LineVars): void => {
    const say = t.say ?? (t.goto === undefined ? undefined : flow.states[t.goto]?.say)
    record(say, boundVars)
    if (t.goto !== undefined && !visited.has(t.goto)) queue.push(t.goto)
  }

  while (queue.length > 0) {
    const name = queue.shift()
    if (name === undefined || visited.has(name)) continue
    visited.add(name)

    const state = flow.states[name]
    if (state === undefined) continue

    // Entry line.
    record(state.say, vars)

    if (state.terminal === true) continue

    // Global rules apply from every state.
    for (const [intent, list] of Object.entries(flow.global)) {
      for (const t of transitionsOf(list)) followTransition(t, { ...vars, intent })
    }

    // Silence handling applies from every state.
    for (const t of flow.onSilence) followTransition(t, { ...vars, intent: 'silence' })

    for (const intent of intentsFor(flow, name)) {
      const bound: LineVars = { ...vars, intent }

      const stateTransitions = transitionsOf(state.on?.[intent])
      if (stateTransitions.length > 0) {
        for (const t of stateTransitions) followTransition(t, bound)
        // A state transition that always fires pre-empts the objection routine for this
        // intent, mirroring Fsm.advance().
        if (stateTransitions.some((t) => t.when === undefined)) continue
      }

      if (flow.objections.intents.includes(intent)) {
        for (const t of applicableObjectionRules(flow, intent)) followTransition(t, bound)
        continue
      }

      if (state.default !== undefined) followTransition(state.default, bound)
    }

    if (state.default !== undefined) followTransition(state.default, vars)
  }

  const reachableIds = new Set([...lines.values()].map((l) => l.id).filter((id) => id !== null))

  return {
    lines: [...lines.values()].sort((a, b) => (a.id ?? '').localeCompare(b.id ?? '')),
    reachableStates: [...visited].sort(),
    unreachableLineIds: Object.keys(flow.lines)
      .filter((id) => !reachableIds.has(id))
      .sort(),
    unreachableStates: Object.keys(flow.states)
      .filter((s) => !visited.has(s))
      .sort(),
    missingLineIds: [...missing].sort(),
  }
}

/** Just the lines, for a pre-cache job that does not care about the diagnostics. */
export function reachableLines(
  flow: Flow,
  lang: Lang,
  vars: LineVars,
  opts: ReachabilityOptions = {},
): ReachableLine[] {
  return analyseReachability(flow, lang, vars, opts).lines
}
