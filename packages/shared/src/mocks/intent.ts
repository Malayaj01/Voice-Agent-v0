/**
 * Mock intent classifier — keyword rules, no model.
 *
 * §7.2: the classifier's only job is utterance -> intent. It never returns a line to speak;
 * the FSM picks that from the approved set. Keep that boundary in any real implementation
 * that replaces this.
 *
 * The rules are ported from the predecessor's src/script/intent.ts so that the mock speaks
 * the same 19-label vocabulary the flow document branches on — a classifier emitting labels
 * the FSM has never heard of would send every turn down the off-script path.
 *
 * Those 19 labels are NOT the taxonomy. §10 is explicit that the real one comes from
 * clustering the call corpus and that the current labels were guessed; they are here to
 * build against until that work happens.
 */

import type { CallCtx, Intent, IntentClassifier } from '../providers.js'
import { realSleep, type SleepFn } from './sleep.js'

export interface MockIntentRule {
  readonly intent: string
  readonly match: RegExp
  readonly confidence?: number
}

/**
 * Evaluated in order — first match wins, so the consequential intents come first. `dnc`
 * outranks everything: "yes, but stop calling me" is a DNC request, not an acknowledgement.
 * `accept_slot` outranks `acknowledge` so "theek hai, Monday 11" books a slot rather than
 * merely agreeing. The ordering is the original's, deliberately.
 */
export const DEFAULT_INTENT_RULES: readonly MockIntentRule[] = [
  {
    intent: 'dnc',
    match:
      /\b(do not call|don'?t call|dnc|remove (me|my number)|opt[- ]?out|stop calling|mat call|dobara (nahi|mat) call)\b/i,
  },
  {
    intent: 'hostile',
    match: /\b(scam|fraud|idiot|stupid|shut up|harass|complaint|lawyer|police)\b/i,
  },
  { intent: 'voicemail', match: /\b(voicemail|leave a message|after the (beep|tone))\b/i },
  {
    intent: 'gatekeeper',
    match:
      /\b(who is (this|calling)|not available|in a meeting|i('ll| will) take a message|assistant to)\b/i,
  },
  {
    intent: 'wrong_person',
    match: /\b(wrong (number|person)|no one (by|named)|galat (number|aadmi))\b/i,
  },
  {
    intent: 'is_this_ai',
    match: /\b(are you (an? )?(ai|bot|robot)|is this (an? )?(ai|bot|recording)|kya (yeh )?ai)\b/i,
  },
  { intent: 'who_gave_number', match: /\b(who gave|where did you get|number kahan|kaise mila)\b/i },
  {
    intent: 'already_use_competitor',
    match: /\b(already (have|use)|pehle se|we use \w+|competitor)\b/i,
  },
  { intent: 'how_much', match: /\b(how much|pricing|price|cost|expensive|kitna)\b/i },
  { intent: 'send_email', match: /\b(send (me )?(an? )?email|email me|email bhej|whatsapp)\b/i },
  { intent: 'call_later', match: /\b(call (me )?(later|back)|baad mein|next week|kal call)\b/i },
  {
    intent: 'no_time',
    match: /\b(no time|can'?t talk|bad time|time nahi|abhi nahi|abhi busy|busy)\b/i,
  },
  {
    intent: 'not_interested',
    match: /\b(not interested|no thanks|don'?t (need|want)|zaroorat nahi|nahi chahiye)\b/i,
  },
  {
    intent: 'accept_slot',
    match:
      /\b(first|second|gyarah|teen|eleven|three|book it|book kar|lock (it|kar)|that one|pehla|doosra|monday|tuesday|11|3 baje)\b/i,
  },
  {
    intent: 'decline_slots',
    match: /\b(none (of )?(those|them)|no slot|doesn'?t work|dono nahi)\b/i,
  },
  {
    intent: 'give_availability',
    match: /\b(i'?m free|i am free|available|thursday|friday|wednesday)\b/i,
  },
  {
    intent: 'acknowledge',
    match:
      /\b(okay|ok|haan|han|hmm|ji|yes|yeah|yep|sure|theek|achha|accha|boliye|go on|tell me|continue)\b/i,
  },
  { intent: 'interested', match: /\b(interested|sounds good|let'?s do|karte hain|chalo)\b/i },
]

export const FALLBACK_INTENT = 'unclear'

export interface MockIntentConfig {
  rules?: readonly MockIntentRule[]
  /** Classification delay — §6 budget is 150ms, and 0 on the regex fast path. Default 0. */
  latencyMs?: number
  /** Confidence for a rule that does not set its own. Default 0.9. */
  defaultConfidence?: number
  /** Confidence reported with FALLBACK_INTENT. Default 0.2. */
  fallbackConfidence?: number
  sleep?: SleepFn
}

export interface ClassificationRecord {
  utterance: string
  state: string
  intent: Intent
}

export class MockIntentClassifier implements IntentClassifier {
  readonly name = 'mock-intent'

  /** One record per classify() call, in order. */
  readonly classified: ClassificationRecord[] = []

  private readonly rules: readonly MockIntentRule[]
  private readonly latencyMs: number
  private readonly defaultConfidence: number
  private readonly fallbackConfidence: number
  private readonly sleep: SleepFn

  constructor(cfg: MockIntentConfig = {}) {
    this.rules = cfg.rules ?? DEFAULT_INTENT_RULES
    this.latencyMs = cfg.latencyMs ?? 0
    this.defaultConfidence = cfg.defaultConfidence ?? 0.9
    this.fallbackConfidence = cfg.fallbackConfidence ?? 0.2
    this.sleep = cfg.sleep ?? realSleep
  }

  async classify(ctx: CallCtx, utterance: string): Promise<Intent> {
    await this.sleep(this.latencyMs)

    let result: Intent = { label: FALLBACK_INTENT, confidence: this.fallbackConfidence }
    for (const rule of this.rules) {
      if (rule.match.test(utterance)) {
        result = { label: rule.intent, confidence: rule.confidence ?? this.defaultConfidence }
        break
      }
    }

    this.classified.push({ utterance, state: ctx.state, intent: result })
    return result
  }
}

/** Always returns the same intent. For driving an FSM down a specific branch. */
export class FixedIntentClassifier implements IntentClassifier {
  readonly name = 'fixed-intent'

  constructor(
    private readonly label: string,
    private readonly confidence = 1,
  ) {}

  classify(): Promise<Intent> {
    return Promise.resolve({ label: this.label, confidence: this.confidence })
  }
}
