#!/usr/bin/env node
/**
 * `voice-flow` — the flow authoring tool.
 *
 *   validate <file>   parse, validate, and report dead lines and unreachable states
 *   render   <file>   print every line the flow can actually say, for the §6 TTS pre-cache
 *   publish  <file>   validate, then write to script_versions
 *
 * `render` is the one that earns its keep. Because the FSM speaks from a closed set, a lead's
 * audio can be synthesised before the call and most turns then cost 0ms of TTS. This prints
 * exactly that set — reachable lines only, rendered for one lead and language, each with the
 * cache key the worker will look up.
 */

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import {
  analyseReachability,
  isLang,
  parseFlow,
  safeParseFlow,
  type FlowIssue,
  type Lang,
  type LineVars,
} from '@voice-agent/shared'

const USAGE = `voice-flow — flow authoring tool

  voice-flow validate <file> [--strict]
  voice-flow render   <file> [--lang <lang>] [--lead <file.json>] [--var k=v]... [--voice <id>]
                             [--format json|table]
  voice-flow publish  <file> [--activate] [--author <name>]

Options
  --lang     language to render (default en-IN)
  --lead     JSON file of template variables for one lead
  --var      a single template variable, repeatable: --var contact_first_name=Rahul
  --voice    voice id folded into the cache key (default "")
  --format   render output: json (default, for a pre-cache job) or table
  --strict   validate: treat unreachable lines and states as failures
  --activate publish: make this the version new calls use
  --author   publish: recorded in script_versions.created_by (default $USER)

Environment
  DATABASE_URL   required by publish
`

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function reportIssues(issues: readonly FlowIssue[]): void {
  for (const issue of issues) process.stderr.write(`  ${issue.path}: ${issue.message}\n`)
}

function collectVars(leadJson: string | undefined, pairs: readonly string[]): LineVars {
  const vars: Record<string, string> = {}
  if (leadJson !== undefined) {
    const parsed: unknown = JSON.parse(leadJson)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail('--lead must be a JSON object of variable names to strings')
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      vars[k] = String(v)
    }
  }
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0) fail(`--var expects k=v, got "${pair}"`)
    vars[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return vars
}

function resolveLang(value: string | undefined): Lang {
  const lang = value ?? 'en-IN'
  if (!isLang(lang)) fail(`unknown language "${lang}"`)
  return lang
}

async function cmdValidate(file: string, strict: boolean): Promise<number> {
  const result = safeParseFlow(await readFile(file, 'utf8'))
  if (!result.ok) {
    process.stderr.write(`invalid: ${file}\n`)
    reportIssues(result.issues)
    return 1
  }

  const flow = result.flow
  const report = analyseReachability(flow, flow.defaultLang, {})

  process.stdout.write(`valid: ${file}\n`)
  process.stdout.write(`  version         ${flow.version}\n`)
  process.stdout.write(
    `  states          ${report.reachableStates.length} reachable / ${Object.keys(flow.states).length} declared\n`,
  )
  process.stdout.write(
    `  lines           ${report.lines.length} reachable / ${Object.keys(flow.lines).length} declared\n`,
  )

  let problems = 0

  // A say that resolves to nothing is always a bug: the call reaching it would throw
  // mid-conversation.
  if (report.missingLineIds.length > 0) {
    process.stderr.write(`  MISSING LINES   ${report.missingLineIds.join(', ')}\n`)
    problems += report.missingLineIds.length
  }
  if (report.unreachableStates.length > 0) {
    process.stderr.write(`  unreachable states  ${report.unreachableStates.join(', ')}\n`)
    if (strict) problems += report.unreachableStates.length
  }
  if (report.unreachableLineIds.length > 0) {
    process.stderr.write(`  unreachable lines   ${report.unreachableLineIds.join(', ')}\n`)
    if (strict) problems += report.unreachableLineIds.length
  }

  return problems > 0 ? 1 : 0
}

async function cmdRender(
  file: string,
  opts: { lang: Lang; vars: LineVars; voiceId: string; format: string },
): Promise<number> {
  const flow = parseFlow(await readFile(file, 'utf8'))
  const report = analyseReachability(flow, opts.lang, opts.vars, { voiceId: opts.voiceId })

  const unrendered = report.lines.filter((l) => l.text.includes('{{'))

  if (opts.format === 'table') {
    for (const line of report.lines) {
      process.stdout.write(`${(line.id ?? '(inline)').padEnd(28)} ${line.cacheKey.slice(0, 12)}\n`)
      process.stdout.write(`  ${line.text}\n`)
    }
  } else {
    process.stdout.write(
      `${JSON.stringify(
        {
          flowVersion: flow.version,
          lang: opts.lang,
          voiceId: opts.voiceId,
          lines: report.lines,
        },
        null,
        2,
      )}\n`,
    )
  }

  process.stderr.write(`${report.lines.length} reachable lines for ${opts.lang}\n`)
  if (report.missingLineIds.length > 0) {
    process.stderr.write(`MISSING LINES: ${report.missingLineIds.join(', ')}\n`)
    return 1
  }
  // A leftover placeholder cannot be cached — the text differs per lead at call time, so the
  // key would never be hit. Worth failing on, since the symptom otherwise is a silent 0%
  // cache rate.
  if (unrendered.length > 0) {
    process.stderr.write(
      `unrendered placeholders in: ${unrendered.map((l) => l.id ?? '(inline)').join(', ')}\n` +
        `pass the missing variables with --var or --lead, or these lines cannot be pre-cached\n`,
    )
    return 1
  }
  return 0
}

async function cmdPublish(
  file: string,
  opts: { activate: boolean; author: string },
): Promise<number> {
  const databaseUrl = process.env['DATABASE_URL']
  if (databaseUrl === undefined) fail('DATABASE_URL is not set')

  const yaml = await readFile(file, 'utf8')

  // Imported lazily so validate and render need neither a driver nor a database.
  const { default: pg } = await import('pg')
  const { publishFlow, FlowPublishError } = await import('./flow-store.js')

  const pool = new pg.Pool({ connectionString: databaseUrl })
  try {
    const result = await publishFlow(pool, {
      yaml,
      createdBy: opts.author,
      activate: opts.activate,
    })
    process.stdout.write(
      `published version ${result.version} as ${result.scriptVersionId}` +
        `${result.active ? ' (active)' : ' (inactive)'}\n`,
    )
    return 0
  } catch (err: unknown) {
    if (err instanceof FlowPublishError) {
      process.stderr.write(`${err.message}\n`)
      reportIssues(err.issues)
      return 1
    }
    throw err
  } finally {
    await pool.end()
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      lang: { type: 'string' },
      lead: { type: 'string' },
      var: { type: 'string', multiple: true },
      voice: { type: 'string' },
      format: { type: 'string', default: 'json' },
      strict: { type: 'boolean', default: false },
      activate: { type: 'boolean', default: false },
      author: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  })

  const [command, file] = positionals
  if (values.help === true || command === undefined) {
    process.stdout.write(USAGE)
    return command === undefined ? 1 : 0
  }
  if (file === undefined) fail(`${command}: expected a flow file\n\n${USAGE}`)

  switch (command) {
    case 'validate':
      return cmdValidate(file, values.strict === true)

    case 'render': {
      const leadJson =
        values.lead === undefined ? undefined : await readFile(values.lead, 'utf8')
      return cmdRender(file, {
        lang: resolveLang(values.lang),
        vars: collectVars(leadJson, values.var ?? []),
        voiceId: values.voice ?? '',
        format: values.format ?? 'json',
      })
    }

    case 'publish':
      return cmdPublish(file, {
        activate: values.activate === true,
        author: values.author ?? process.env['USER'] ?? process.env['USERNAME'] ?? 'unknown',
      })

    default:
      fail(`unknown command "${command}"\n\n${USAGE}`)
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
