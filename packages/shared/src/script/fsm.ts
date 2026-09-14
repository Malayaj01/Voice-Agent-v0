/**
 * The FSM spine — ARCHITECTURE.md §7.2.
 *
 * Ported from the predecessor's `src/script/stateMachine.ts`, with the transition logic
 * lifted out of TypeScript and into the flow document. The behaviour is the same; what
 * changed is that editing it no longer needs a deploy.
 *
 * The rules this preserves from the original, because they are the product and not
 * incidental:
 *   - `dnc` and `hostile` end the call from ANY state, before any per-state handling
 *   - an off-script intent holds position and re-anchors rather than advancing
 *   - a repeated `not_interested` or `who_gave_number` ends the call
 *   - three distinct objections ends the call
 *   - `no_time` hangs up politely instead of rebutting
 *
 * What this deliberately does NOT do is generate text. `decide()` returns a line selected
 * from the flow's closed set. A classifier that returned something to say, or a model asked
 * to phrase a rebuttal, would break the anti-hallucination guarantee that makes a scripted
 * sales bot legally safe to point at a real phone number.
 */

import type { Lang } from '../lang.js'
import {
  transitionsOf,
  type Flow,
  type FlowDocument,
  type FlowGuard,
  type FlowTransition,
} from './flow.js'
import { resolveLine, type LineVars } from './lines.js'

export interface FsmSnapshot {
  state: string
  ended: boolean
  /** Distinct objection intents raised so far, in order. */
  objectionsRaised: readonly string[]
  /** Consecutive silence nudges issued. */
  nudges: number
  /** Compliance flags accumulated on this call. */
  flags: readonly string[]
}

export interface SpokenLine {
  /** Line id from the flow's table, or null for an inline line. */
  id: string | null
  text: string
}

export interface FsmDecision {
  intent: string
  fromState: string
  nextState: string
  /** The approved line to speak, or null when the flow says nothing for this input. */
  line: SpokenLine | null
  /** The call ends after this line. */
  ended: boolean
  /** Compliance flags added by this transition. */
  flags: readonly string[]
}

export interface FsmInit {
  flow: Flow
  lang: Lang
  /** Substituted into `{{...}}` placeholders — contact name, company, and so on. */
  vars?: LineVars
  /**
   * `script_versions.id` this flow came from. Stamped on the call row so conversion is
   * attributable to a specific script revision (§7.5). Null for a flow loaded off disk.
   */
  scriptVersionId?: string | null
}

/** Builds a machine from a loaded document, carrying the script version through. */
export function fsmFromDocument(doc: FlowDocument, lang: Lang, vars?: LineVars): Fsm {
  return new Fsm({
    flow: doc.flow,
    lang,
    scriptVersionId: doc.scriptVersionId,
    ...(vars === undefined ? {} : { vars }),
  })
}

export class Fsm {
  readonly flow: Flow
  readonly lang: Lang
  /** The script version this machine is running, for §7.5 version stamping. */
  readonly scriptVersionId: string | null

  private readonly vars: Record<string, string>
  private state: string
  private ended = false
  private readonly objections: string[] = []
  private nudges = 0
  private readonly flags: string[] = []

  constructor(init: FsmInit) {
    this.flow = init.flow
    this.lang = init.lang
    this.scriptVersionId = init.scriptVersionId ?? null
    this.vars = { ...init.vars }
    this.state = init.flow.initial
  }

  snapshot(): FsmSnapshot {
    return {
      state: this.state,
      ended: this.ended,
      objectionsRaised: [...this.objections],
      nudges: this.nudges,
      flags: [...this.flags],
    }
  }

  get currentState(): string {
    return this.state
  }

  get isEnded(): boolean {
    return this.ended
  }

  /** Sets a template variable mid-call — the booked slot, for instance. */
  setVar(name: string, value: string): void {
    this.vars[name] = value
  }

  /** The opening line. Spoken before the caller has said anything. */
  start(): FsmDecision {
    const state = this.flow.states[this.state]
    const line =
      state?.say === undefined ? null : resolveLine(this.flow, state.say, this.lang, this.vars)
    return {
      intent: '',
      fromState: this.state,
      nextState: this.state,
      line,
      ended: false,
      flags: [],
    }
  }

  /**
   * Advances the machine. Evaluation order is the original's:
   *   global rules -> per-state `on` -> shared objection routine -> state `default`.
   */
  advance(intent: string): FsmDecision {
    if (this.ended) return this.noop(intent)

    this.nudges = 0

    const globalMatch = this.firstMatch(transitionsOf(this.flow.global[intent]), intent)
    if (globalMatch !== undefined) return this.apply(intent, globalMatch)

    const state = this.flow.states[this.state]
    if (state === undefined) return this.noop(intent)

    const stateMatch = this.firstMatch(transitionsOf(state.on?.[intent]), intent)
    if (stateMatch !== undefined) return this.apply(intent, stateMatch)

    if (this.flow.objections.intents.includes(intent)) {
      // Recorded before the guards run, and `repeated` reflects the state BEFORE this
      // objection was added — matching the original's `already` check.
      const repeated = this.objections.includes(intent)
      if (!repeated) this.objections.push(intent)
      const rule = this.firstMatch(this.flow.objections.rules, intent, repeated)
      if (rule !== undefined) return this.apply(intent, rule)
    }

    if (state.default !== undefined) return this.apply(intent, state.default)
    return this.noop(intent)
  }

  /** The caller said nothing. Nudge, then hang up if they stay silent. */
  onSilence(): FsmDecision {
    if (this.ended) return this.noop('silence')
    this.nudges += 1
    const rule = this.firstMatch(this.flow.onSilence, 'silence')
    if (rule === undefined) return this.noop('silence')
    return this.apply('silence', rule)
  }

  private firstMatch(
    transitions: readonly FlowTransition[],
    intent: string,
    repeated = this.objections.includes(intent),
  ): FlowTransition | undefined {
    return transitions.find((t) => this.guardPasses(t.when, intent, repeated))
  }

  private guardPasses(guard: FlowGuard | undefined, intent: string, repeated: boolean): boolean {
    if (guard === undefined) return true
    if (guard.intentIn !== undefined && !guard.intentIn.includes(intent)) return false
    if (guard.repeated !== undefined && guard.repeated !== repeated) return false
    if (guard.countGte !== undefined && this.objections.length < guard.countGte) return false
    if (guard.nudgesGte !== undefined && this.nudges < guard.nudgesGte) return false
    return true
  }

  private apply(intent: string, t: FlowTransition): FsmDecision {
    const fromState = this.state
    const nextState = t.goto ?? this.state

    const added = t.flag === undefined ? [] : typeof t.flag === 'string' ? [t.flag] : [...t.flag]
    this.flags.push(...added)

    // `{{intent}}` lets the shared objection routine address one rebuttal per objection
    // without needing a rule for each.
    const vars: LineVars = { ...this.vars, intent }

    // A state's own `say` is the entry line, used when a transition moves to it without
    // naming a line of its own.
    const say = t.say ?? (t.goto !== undefined ? this.flow.states[nextState]?.say : undefined)
    const line = say === undefined ? null : resolveLine(this.flow, say, this.lang, vars)

    this.state = nextState
    const terminal = this.flow.states[nextState]?.terminal === true
    if (t.end === true || terminal) this.ended = true

    return { intent, fromState, nextState, line, ended: this.ended, flags: added }
  }

  private noop(intent: string): FsmDecision {
    return {
      intent,
      fromState: this.state,
      nextState: this.state,
      line: null,
      ended: this.ended,
      flags: [],
    }
  }
}
