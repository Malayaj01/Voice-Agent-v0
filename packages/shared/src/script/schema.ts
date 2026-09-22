/**
 * Flow validation — ARCHITECTURE.md §7.1.
 *
 * Zod rather than hand-rolled checks, for one reason that matters operationally: this schema
 * is the gate a script edit passes through before it reaches a live campaign, and a rejection
 * has to say WHERE the document is wrong. `states.CLOSE.on.accept_slot.goto: expected string`
 * is actionable; "invalid flow" is not.
 *
 * The document is authored in snake_case, which is what a person editing YAML expects, and
 * consumed in camelCase, which is what the rest of the codebase uses. The transform happens
 * here so neither side compromises.
 */

import { z } from 'zod'

import { LANGS } from '../lang.js'

const LangSchema = z.enum(LANGS)

/** A per-language line body. */
export const LineTextSchema = z.partialRecord(LangSchema, z.string().min(1))

/** A line id (possibly templated, e.g. `rebuttal_{{intent}}`) or an inline body. */
export const SaySchema = z.union([z.string().min(1), LineTextSchema])

/**
 * Guards are declared as explicit interfaces rather than inferred from the schema. With
 * `exactOptionalPropertyTypes`, an inferred `prop?: T | undefined` is not assignable to
 * `prop?: T`, and the snake_case-to-camelCase transform makes the inferred shape unreadable
 * in errors. Declaring them and annotating the transform keeps both sides honest.
 */
export interface FlowGuard {
  repeated?: boolean
  countGte?: number
  nudgesGte?: number
  intentIn?: readonly string[]
}

export interface FlowTransition {
  when?: FlowGuard
  goto?: string
  say?: Say
  end?: boolean
  flag?: string | readonly string[]
}

export const GuardSchema = z
  .object({
    repeated: z.boolean().optional(),
    count_gte: z.number().int().nonnegative().optional(),
    nudges_gte: z.number().int().nonnegative().optional(),
    intent_in: z.array(z.string().min(1)).nonempty().optional(),
  })
  .strict()
  .transform(
    (g): FlowGuard => ({
      ...(g.repeated === undefined ? {} : { repeated: g.repeated }),
      ...(g.count_gte === undefined ? {} : { countGte: g.count_gte }),
      ...(g.nudges_gte === undefined ? {} : { nudgesGte: g.nudges_gte }),
      ...(g.intent_in === undefined ? {} : { intentIn: g.intent_in }),
    }),
  )

const TransitionObjectSchema = z
  .object({
    when: GuardSchema.optional(),
    goto: z.string().min(1).optional(),
    say: SaySchema.optional(),
    end: z.boolean().optional(),
    flag: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  })
  .strict()
  .transform(
    (t): FlowTransition => ({
      ...(t.when === undefined ? {} : { when: t.when }),
      ...(t.goto === undefined ? {} : { goto: t.goto }),
      ...(t.say === undefined ? {} : { say: t.say }),
      ...(t.end === undefined ? {} : { end: t.end }),
      ...(t.flag === undefined ? {} : { flag: t.flag }),
    }),
  )

/** `INTENT: STATE_NAME` is shorthand for `INTENT: { goto: STATE_NAME }`. */
export const TransitionSchema = z.union([
  z
    .string()
    .min(1)
    .transform((goto): FlowTransition => ({ goto })),
  TransitionObjectSchema,
])

/** One transition, or a list evaluated in order with the first passing guard winning. */
export const TransitionListSchema = z
  .union([TransitionSchema, z.array(TransitionSchema).nonempty()])
  .transform((t): readonly FlowTransition[] => (Array.isArray(t) ? t : [t]))

export const StateSchema = z
  .object({
    say: SaySchema.optional(),
    /**
     * The question to repeat when the caller goes off-script in this state.
     *
     * Off-script holds position and re-anchors (§7.2), and the anchor has to be the question
     * this state actually asked. A single static one replays the opening no matter how far
     * the call has got, which is how a caller at PITCH ends up being asked "Got a minute?"
     * again.
     */
    anchor: SaySchema.optional(),
    on: z.record(z.string().min(1), TransitionListSchema).optional(),
    default: TransitionSchema.optional(),
    terminal: z.boolean().optional(),
  })
  .strict()

export type FlowState = z.infer<typeof StateSchema>

export const ObjectionsSchema = z
  .object({
    intents: z.array(z.string().min(1)),
    rules: z.array(TransitionSchema),
  })
  .strict()

export const FlowSchema = z
  .object({
    version: z.number().int().positive(),
    initial: z.string().min(1),
    default_lang: LangSchema.default('en-IN'),
    global: z.record(z.string().min(1), TransitionListSchema).default({}),
    objections: ObjectionsSchema,
    on_silence: TransitionListSchema.optional(),
    lines: z.record(z.string().min(1), LineTextSchema),
    states: z.record(z.string().min(1), StateSchema),
  })
  .strict()
  .transform((d) => ({
    version: d.version,
    initial: d.initial,
    defaultLang: d.default_lang,
    global: d.global,
    objections: d.objections,
    onSilence: d.on_silence ?? [],
    lines: d.lines,
    states: d.states,
  }))

export type Flow = z.infer<typeof FlowSchema>
export type LineText = z.infer<typeof LineTextSchema>
export type Say = z.infer<typeof SaySchema>
export type FlowObjections = z.infer<typeof ObjectionsSchema>
