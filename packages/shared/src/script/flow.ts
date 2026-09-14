/**
 * Flow schema — ARCHITECTURE.md §7.1.
 *
 * The conversation flow is DATA: YAML, versioned in Postgres, hot-reloadable. The
 * predecessor defined its lines as TypeScript functions (`lines.ts`, `objections.ts`), which
 * meant no line could be A/B tested or corrected without a deploy. That is the thing being
 * killed here.
 *
 * Two consequences of lines living in a table rather than in code:
 *   - the set of things the bot can say is closed and enumerable, which is what makes the
 *     §6 TTS pre-cache possible (`hash(text + voice + language)`), and
 *   - the anti-hallucination guarantee is checkable by reading one YAML document.
 */

import { parse as parseYaml } from 'yaml'

import type { Lang } from '../lang.js'

/** A per-language line body. Missing languages fall back to the flow's default language. */
export type LineText = Partial<Record<Lang, string>>

export interface FlowGuard {
  /** This objection has already been raised on this call. */
  repeated?: boolean
  /** Total distinct objections raised so far is at least N. */
  countGte?: number
  /** Restrict the rule to a subset of intents. */
  intentIn?: readonly string[]
  /** Silence nudges issued so far is at least N. */
  nudgesGte?: number
}

export interface FlowTransition {
  /** Guard; when absent the transition always applies. */
  when?: FlowGuard
  /** Target state. Omit to stay in the current state. */
  goto?: string
  /** Line id from `lines`, or an inline per-language body. Omit to say nothing. */
  say?: string | LineText
  /** Terminate the call after speaking. */
  end?: boolean
  /** Compliance flags to record on the call. */
  flag?: string | readonly string[]
}

export interface FlowState {
  /** Line spoken on entry to this state, when it is entered from `goto`. */
  say?: string | LineText
  /** intent -> transition(s). A list is evaluated in order, first matching guard wins. */
  on?: Record<string, string | FlowTransition | readonly FlowTransition[]>
  /** Applied when no `on` entry and no objection rule matches. */
  default?: FlowTransition
  /** Terminal state: the call ends on entry. */
  terminal?: boolean
}

export interface FlowObjections {
  /** Intents treated as objections. */
  intents: readonly string[]
  /** Evaluated in order; first matching guard wins. */
  rules: readonly FlowTransition[]
}

export interface Flow {
  version: number
  initial: string
  defaultLang: Lang
  /** Evaluated before any per-state transition — dnc, hostile, off-script, wrong person. */
  global: Record<string, string | FlowTransition | readonly FlowTransition[]>
  /** Shared objection routine, applied when no per-state transition matches. */
  objections: FlowObjections
  /** The closed set of lines. Enumerable, therefore pre-cacheable. */
  lines: Record<string, LineText>
  states: Record<string, FlowState>
  /** Applied when the caller says nothing. */
  onSilence: readonly FlowTransition[]
}

export class FlowParseError extends Error {
  override readonly name = 'FlowParseError'
}

function fail(path: string, msg: string): never {
  throw new FlowParseError(`${path}: ${msg}`)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseGuard(raw: unknown, path: string): FlowGuard {
  if (!isRecord(raw)) fail(path, 'must be a mapping')
  const guard: FlowGuard = {}
  if ('repeated' in raw) {
    if (typeof raw['repeated'] !== 'boolean') fail(`${path}.repeated`, 'must be a boolean')
    guard.repeated = raw['repeated']
  }
  if ('count_gte' in raw) {
    if (typeof raw['count_gte'] !== 'number') fail(`${path}.count_gte`, 'must be a number')
    guard.countGte = raw['count_gte']
  }
  if ('nudges_gte' in raw) {
    if (typeof raw['nudges_gte'] !== 'number') fail(`${path}.nudges_gte`, 'must be a number')
    guard.nudgesGte = raw['nudges_gte']
  }
  if ('intent_in' in raw) {
    const list = raw['intent_in']
    if (!Array.isArray(list) || list.some((i) => typeof i !== 'string')) {
      fail(`${path}.intent_in`, 'must be a list of intent names')
    }
    guard.intentIn = list as string[]
  }
  return guard
}

function parseSay(raw: unknown, path: string): string | LineText {
  if (typeof raw === 'string') return raw
  if (!isRecord(raw)) fail(path, 'must be a line id or a per-language mapping')
  const out: LineText = {}
  for (const [lang, text] of Object.entries(raw)) {
    if (typeof text !== 'string') fail(`${path}.${lang}`, 'must be a string')
    out[lang as Lang] = text
  }
  return out
}

function parseTransition(raw: unknown, path: string): FlowTransition {
  if (typeof raw === 'string') return { goto: raw }
  if (!isRecord(raw)) fail(path, 'must be a state name or a transition mapping')

  const t: FlowTransition = {}
  if ('when' in raw) t.when = parseGuard(raw['when'], `${path}.when`)
  if ('goto' in raw) {
    if (typeof raw['goto'] !== 'string') fail(`${path}.goto`, 'must be a state name')
    t.goto = raw['goto']
  }
  if ('say' in raw) t.say = parseSay(raw['say'], `${path}.say`)
  if ('end' in raw) {
    if (typeof raw['end'] !== 'boolean') fail(`${path}.end`, 'must be a boolean')
    t.end = raw['end']
  }
  if ('flag' in raw) {
    const flag = raw['flag']
    if (typeof flag === 'string') t.flag = flag
    else if (Array.isArray(flag) && flag.every((f) => typeof f === 'string')) t.flag = flag
    else fail(`${path}.flag`, 'must be a string or list of strings')
  }
  return t
}

function parseTransitionList(raw: unknown, path: string): FlowTransition[] {
  if (Array.isArray(raw)) return raw.map((r, i) => parseTransition(r, `${path}[${i}]`))
  return [parseTransition(raw, path)]
}

function parseTransitionMap(
  raw: unknown,
  path: string,
): Record<string, string | FlowTransition | readonly FlowTransition[]> {
  if (raw === undefined) return {}
  if (!isRecord(raw)) fail(path, 'must be a mapping of intent to transition')
  const out: Record<string, FlowTransition[]> = {}
  for (const [intent, value] of Object.entries(raw)) {
    out[intent] = parseTransitionList(value, `${path}.${intent}`)
  }
  return out
}

/**
 * Parses and validates a flow document. Every state referenced by a `goto` and every line id
 * referenced by a `say` must exist — an unreachable target is a script bug that would
 * otherwise surface mid-call, on a real number, at a cost of Rs 1,000-10,000 per call.
 */
export function parseFlow(yaml: string): Flow {
  const doc: unknown = parseYaml(yaml)
  if (!isRecord(doc)) throw new FlowParseError('flow: document must be a mapping')

  const version = doc['version']
  if (typeof version !== 'number') fail('version', 'must be a number')

  const initial = doc['initial']
  if (typeof initial !== 'string') fail('initial', 'must be a state name')

  const defaultLang = (doc['default_lang'] ?? 'en-IN') as Lang

  const linesRaw = doc['lines']
  if (!isRecord(linesRaw)) fail('lines', 'must be a mapping of line id to per-language text')
  const lines: Record<string, LineText> = {}
  for (const [id, body] of Object.entries(linesRaw)) {
    const parsed = parseSay(body, `lines.${id}`)
    if (typeof parsed === 'string') fail(`lines.${id}`, 'must be a per-language mapping')
    lines[id] = parsed
  }

  const statesRaw = doc['states']
  if (!isRecord(statesRaw)) fail('states', 'must be a mapping of state name to definition')
  const states: Record<string, FlowState> = {}
  for (const [name, raw] of Object.entries(statesRaw)) {
    if (!isRecord(raw)) fail(`states.${name}`, 'must be a mapping')
    const state: FlowState = {}
    if ('say' in raw) state.say = parseSay(raw['say'], `states.${name}.say`)
    if ('on' in raw) state.on = parseTransitionMap(raw['on'], `states.${name}.on`)
    if ('default' in raw) {
      state.default = parseTransition(raw['default'], `states.${name}.default`)
    }
    if ('terminal' in raw) {
      if (typeof raw['terminal'] !== 'boolean') fail(`states.${name}.terminal`, 'must be a boolean')
      state.terminal = raw['terminal']
    }
    states[name] = state
  }

  const objectionsRaw = doc['objections']
  if (!isRecord(objectionsRaw)) fail('objections', 'must be a mapping')
  const objIntents = objectionsRaw['intents']
  if (!Array.isArray(objIntents) || objIntents.some((i) => typeof i !== 'string')) {
    fail('objections.intents', 'must be a list of intent names')
  }
  const objRulesRaw = objectionsRaw['rules']
  if (!Array.isArray(objRulesRaw)) fail('objections.rules', 'must be a list')
  const objections: FlowObjections = {
    intents: objIntents as string[],
    rules: objRulesRaw.map((r, i) => parseTransition(r, `objections.rules[${i}]`)),
  }

  const flow: Flow = {
    version,
    initial,
    defaultLang,
    global: parseTransitionMap(doc['global'], 'global'),
    objections,
    lines,
    states,
    onSilence:
      doc['on_silence'] === undefined ? [] : parseTransitionList(doc['on_silence'], 'on_silence'),
  }

  validateReferences(flow)
  return flow
}

function validateReferences(flow: Flow): void {
  const stateNames = new Set(Object.keys(flow.states))
  const lineIds = new Set(Object.keys(flow.lines))

  const checkTransition = (t: FlowTransition, path: string): void => {
    if (t.goto !== undefined && !stateNames.has(t.goto)) {
      fail(path, `goto references unknown state "${t.goto}"`)
    }
    if (typeof t.say === 'string' && !lineIds.has(t.say) && !t.say.includes('{{')) {
      fail(path, `say references unknown line "${t.say}"`)
    }
  }

  if (!stateNames.has(flow.initial)) fail('initial', `unknown state "${flow.initial}"`)

  for (const [intent, value] of Object.entries(flow.global)) {
    for (const [i, t] of parseTransitionList(value, `global.${intent}`).entries()) {
      checkTransition(t, `global.${intent}[${i}]`)
    }
  }
  for (const [i, rule] of flow.objections.rules.entries()) {
    checkTransition(rule, `objections.rules[${i}]`)
  }
  for (const [i, rule] of flow.onSilence.entries()) {
    checkTransition(rule, `on_silence[${i}]`)
  }
  for (const [name, state] of Object.entries(flow.states)) {
    if (typeof state.say === 'string' && !lineIds.has(state.say)) {
      fail(`states.${name}.say`, `references unknown line "${state.say}"`)
    }
    for (const [intent, value] of Object.entries(state.on ?? {})) {
      for (const [i, t] of parseTransitionList(value, `states.${name}.on.${intent}`).entries()) {
        checkTransition(t, `states.${name}.on.${intent}[${i}]`)
      }
    }
    if (state.default !== undefined) checkTransition(state.default, `states.${name}.default`)
  }
}

/** Normalises a transition entry to a list, for evaluation. */
export function transitionsOf(
  value: string | FlowTransition | readonly FlowTransition[] | undefined,
): readonly FlowTransition[] {
  if (value === undefined) return []
  if (typeof value === 'string') return [{ goto: value }]
  return Array.isArray(value) ? value : [value as FlowTransition]
}
