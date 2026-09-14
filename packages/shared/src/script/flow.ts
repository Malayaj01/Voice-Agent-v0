/**
 * Flow parsing — ARCHITECTURE.md §7.1.
 *
 * Two layers, because they catch different classes of mistake:
 *
 *   1. The Zod schema (schema.ts) rejects a malformed document — wrong types, unknown keys,
 *      a transition that is neither a state name nor a mapping.
 *   2. Cross-reference validation rejects a well-formed document that does not hang together
 *      — a `goto` to a state that does not exist, a `say` naming a line that was renamed.
 *
 * The second layer is the one that matters in production. A dangling `goto` is syntactically
 * perfect YAML and fails only when a live call happens to take that branch, which at 2,000
 * calls/day means it fails on a real number, mid-conversation, at Rs 1,000-10,000 a call if
 * the fallback misbehaves. It has to be impossible to publish.
 */

import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

import {
  FlowSchema,
  type Flow,
  type FlowTransition,
  type LineText,
  type Say,
} from './schema.js'

export type {
  Flow,
  FlowGuard,
  FlowObjections,
  FlowState,
  FlowTransition,
  LineText,
  Say,
} from './schema.js'
export { FlowSchema, LineTextSchema, TransitionSchema } from './schema.js'

export interface FlowIssue {
  /** Dotted path into the document, e.g. `states.CLOSE.on.accept_slot.goto`. */
  path: string
  message: string
}

export class FlowParseError extends Error {
  override readonly name = 'FlowParseError'
  readonly issues: readonly FlowIssue[]

  constructor(issues: readonly FlowIssue[]) {
    super(
      issues.length === 1 && issues[0] !== undefined
        ? `${issues[0].path}: ${issues[0].message}`
        : `flow has ${issues.length} problems:\n` +
            issues.map((i) => `  ${i.path}: ${i.message}`).join('\n'),
    )
    this.issues = issues
  }
}

export type FlowParseResult =
  | { ok: true; flow: Flow }
  | { ok: false; issues: readonly FlowIssue[] }

function issuesFromZod(error: z.ZodError): FlowIssue[] {
  return error.issues.map((i) => ({
    path: i.path.length === 0 ? 'flow' : i.path.join('.'),
    message: i.message,
  }))
}

/** Normalises a transition entry to a list. */
export function transitionsOf(
  value: FlowTransition | readonly FlowTransition[] | undefined,
): readonly FlowTransition[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value as FlowTransition]
}

/** A line id is templated when it interpolates a variable, e.g. `rebuttal_{{intent}}`. */
export function isTemplatedLineId(say: Say): say is string {
  return typeof say === 'string' && say.includes('{{')
}

/**
 * Checks that every `goto` and every non-templated `say` resolves. Templated ids are left to
 * reachability analysis, which knows what the variable can be bound to.
 */
export function crossReferenceIssues(flow: Flow): FlowIssue[] {
  const issues: FlowIssue[] = []
  const states = new Set(Object.keys(flow.states))
  const lines = new Set(Object.keys(flow.lines))

  const check = (t: FlowTransition, path: string): void => {
    if (t.goto !== undefined && !states.has(t.goto)) {
      issues.push({ path: `${path}.goto`, message: `unknown state "${t.goto}"` })
    }
    if (t.say !== undefined && typeof t.say === 'string' && !isTemplatedLineId(t.say)) {
      if (!lines.has(t.say)) {
        issues.push({ path: `${path}.say`, message: `unknown line "${t.say}"` })
      }
    }
  }

  if (!states.has(flow.initial)) {
    issues.push({ path: 'initial', message: `unknown state "${flow.initial}"` })
  }

  for (const [intent, list] of Object.entries(flow.global)) {
    transitionsOf(list).forEach((t, i) => check(t, `global.${intent}[${i}]`))
  }
  flow.objections.rules.forEach((t, i) => check(t, `objections.rules[${i}]`))
  flow.onSilence.forEach((t, i) => check(t, `on_silence[${i}]`))

  for (const [name, state] of Object.entries(flow.states)) {
    if (state.say !== undefined && typeof state.say === 'string' && !lines.has(state.say)) {
      issues.push({ path: `states.${name}.say`, message: `unknown line "${state.say}"` })
    }
    for (const [intent, list] of Object.entries(state.on ?? {})) {
      transitionsOf(list).forEach((t, i) => check(t, `states.${name}.on.${intent}[${i}]`))
    }
    if (state.default !== undefined) check(state.default, `states.${name}.default`)
  }

  return issues
}

/** Parses and fully validates. Never throws — for a CLI or an API that reports problems. */
export function safeParseFlow(yamlText: string): FlowParseResult {
  let doc: unknown
  try {
    doc = parseYaml(yamlText)
  } catch (err: unknown) {
    return {
      ok: false,
      issues: [{ path: 'flow', message: `YAML is not parseable: ${String(err)}` }],
    }
  }

  const parsed = FlowSchema.safeParse(doc)
  if (!parsed.success) return { ok: false, issues: issuesFromZod(parsed.error) }

  const issues = crossReferenceIssues(parsed.data)
  if (issues.length > 0) return { ok: false, issues }

  return { ok: true, flow: parsed.data }
}

/** Parses and fully validates, throwing FlowParseError. */
export function parseFlow(yamlText: string): Flow {
  const result = safeParseFlow(yamlText)
  if (!result.ok) throw new FlowParseError(result.issues)
  return result.flow
}

/** A parsed flow together with where it came from — §7.5 stamps this on every call. */
export interface FlowDocument {
  /** `script_versions.id`, or null for a flow loaded straight off disk. */
  scriptVersionId: string | null
  version: number
  flow: Flow
  yaml: string
  loadedAt: Date
}

export function documentFromYaml(yamlText: string, scriptVersionId: string | null): FlowDocument {
  const flow = parseFlow(yamlText)
  return { scriptVersionId, version: flow.version, flow, yaml: yamlText, loadedAt: new Date() }
}
