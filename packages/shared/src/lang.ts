/**
 * Languages the agent speaks. Provider selection is keyed on (stage, language) — see
 * providers.ts — so adding a language means registering providers for it, not editing
 * a switch statement.
 */
export const LANGS = ['en-IN', 'hi-IN', 'hi-IN-hinglish'] as const

export type Lang = (typeof LANGS)[number]

export function isLang(value: string): value is Lang {
  return (LANGS as readonly string[]).includes(value)
}
