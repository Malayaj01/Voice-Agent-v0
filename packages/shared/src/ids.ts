/** Branded identifiers — a CampaignId must never be passed where a LeadId is expected. */

declare const brand: unique symbol

type Brand<T, B extends string> = T & { readonly [brand]: B }

export type CampaignId = Brand<string, 'CampaignId'>
export type LeadId = Brand<string, 'LeadId'>
export type CallId = Brand<string, 'CallId'>
export type TurnId = Brand<string, 'TurnId'>
export type ScriptVersionId = Brand<string, 'ScriptVersionId'>
export type PromptVersionId = Brand<string, 'PromptVersionId'>
export type ConsentRecordId = Brand<string, 'ConsentRecordId'>
export type FaqEntryId = Brand<string, 'FaqEntryId'>

/**
 * A phone number in E.164 form. Per CLAUDE.md, phone numbers are E.164 everywhere —
 * this brand is what stops a raw 10-digit string reaching the dialer.
 */
export type E164 = Brand<string, 'E164'>

const E164_PATTERN = /^\+[1-9]\d{7,14}$/

export function isE164(value: string): value is E164 {
  return E164_PATTERN.test(value)
}

export function toE164(value: string): E164 {
  if (!isE164(value)) {
    throw new TypeError(`not a valid E.164 phone number: ${JSON.stringify(value)}`)
  }
  return value
}
