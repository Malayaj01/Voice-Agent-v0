/** Typed environment reading. No dependencies — this is all the config parsing we need. */

export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new Error(`missing required environment variable: ${name}`)
  }
  return value
}

export function optionalEnv(
  name: string,
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name]
  return value === undefined || value === '' ? fallback : value
}

export function numberEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new Error(`environment variable ${name} must be a number, got ${JSON.stringify(raw)}`)
  }
  return parsed
}
