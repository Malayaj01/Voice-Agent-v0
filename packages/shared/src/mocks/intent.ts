/**
 * Mock intent classifier — keyword rules, no model.
 *
 * §7.2: the classifier's only job is utterance -> intent. It never returns a line to speak;
 * the FSM picks that from the approved set. Keep that boundary in any real implementation
 * that replaces this.
 *
 * The labels below are a starting set matching the §7.1 flow example. They are NOT the
 * taxonomy — §10 says the real one comes from clustering the call corpus, and the current
 * hand-written labels were guessed. Treat these as placeholders to build against.
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
 */
export const DEFAULT_INTENT_RULES: readonly MockIntentRule[] = [
  { intent: 'dnc', match: /\b(do not call|don'?t call|stop calling|remove me|unsubscribe|dnd)\b/i },
  { intent: 'not_interested', match: /\b(not interested|no thanks|nahi chahiye|mat karo)\b/i },
  { intent: 'no_time', match: /\b(busy|not now|no time|later|baad mein|abhi nahi|meeting)\b/i },
  { intent: 'callback_later', match: /\b(call back|callback|call me|kal|tomorrow)\b/i },
  { intent: 'price_question', match: /\b(price|cost|charges|rate|kitna|how much)\b/i },
  { intent: 'human_request', match: /\b(real person|human|agent|manager|someone else)\b/i },
  { intent: 'acknowledge', match: /\b(yes|yeah|yep|sure|ok|okay|haan|han|theek|go ahead|tell me)\b/i },
  { intent: 'negative', match: /\b(no|nope|nahi|na)\b/i },
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
