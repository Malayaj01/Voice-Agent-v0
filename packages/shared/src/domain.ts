/**
 * Row types for the schema in ARCHITECTURE.md §8. These mirror db/migrations/ — change
 * one and change the other in the same commit.
 *
 * Timestamps are Date; bigint-free by design (all ids are uuid text).
 */

import type { Lang } from './lang.js'
import type {
  CallId,
  CampaignId,
  ConsentRecordId,
  E164,
  FaqEntryId,
  LeadId,
  PromptVersionId,
  ScriptVersionId,
  TurnId,
} from './ids.js'

/** Conversation flow, stored as YAML data and versioned — never as TypeScript. §7.1 */
export interface ScriptVersion {
  id: ScriptVersionId
  version: number
  yaml: string
  createdBy: string
  createdAt: Date
  active: boolean
}

export interface Campaign {
  id: CampaignId
  name: string
  scriptVersionId: ScriptVersionId
  /** Dialer pacing parameters. Shape owned by the dialer; opaque here. */
  pacing: Readonly<Record<string, unknown>>
  /** TRAI-legal calling window. Enforced in the dialer, in code — never assumed. */
  activeHours: Readonly<Record<string, unknown>>
  createdAt: Date
}

export type PriorityTier = 1 | 2 | 3

export interface Lead {
  id: LeadId
  campaignId: CampaignId
  name: string
  phoneE164: E164
  language: Lang
  priorityTier: PriorityTier
  meta: Readonly<Record<string, unknown>>
}

/** DLT-registered consent. A first-class table, not an afterthought. §2 */
export interface ConsentRecord {
  id: ConsentRecordId
  phoneE164: E164
  dltConsentId: string
  source: string
  grantedAt: Date
  expiresAt: Date | null
  revokedAt: Date | null
}

export type DncSource = 'own' | 'DND_registry'

export interface DncEntry {
  phoneE164: E164
  reason: string
  source: DncSource
  addedAt: Date
}

export type Disposition =
  | 'connected'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'voicemail'
  | 'dnc_requested'
  | 'hangup'

/** The fact table for all reporting. §8 */
export interface Call {
  id: CallId
  campaignId: CampaignId
  leadId: LeadId
  /** Version stamping is what makes conversion attributable to a script revision. §7.5 */
  scriptVersionId: ScriptVersionId
  promptVersionId: PromptVersionId | null
  providerCallId: string | null
  startedAt: Date
  endedAt: Date | null
  durationS: number | null
  connected: boolean
  disposition: Disposition | null
  leadScore: number | null
  nextAction: string | null
  recordingUri: string | null
}

export type TurnRole = 'caller' | 'agent'

/**
 * One conversational turn. The t_*_ms columns are the production telemetry that matters —
 * total-latency-only tells you that you are slow, never where. §6
 */
export interface Turn {
  id: TurnId
  callId: CallId
  seq: number
  role: TurnRole
  text: string
  intent: string | null
  state: string | null
  tEndpointMs: number | null
  tSttMs: number | null
  tIntentMs: number | null
  tTtsFirstByteMs: number | null
}

/** Approved answers, retrieved and spoken verbatim. Never generated. §7.3 */
export interface FaqEntry {
  id: FaqEntryId
  question: string
  approvedAnswer: string
  embedding: readonly number[]
  language: Lang
  active: boolean
}
