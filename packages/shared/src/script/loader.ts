/**
 * Flow loading and hot reload — ARCHITECTURE.md §7.1.
 *
 * Two rules govern this, and both are about not breaking live calls:
 *
 * 1. A BAD FLOW MUST NEVER REPLACE A GOOD ONE. Reload parses and validates before swapping.
 *    If the new document is invalid the loader keeps serving the last good flow and reports
 *    the error. The alternative — swap first, discover the typo when a call reaches that
 *    branch — turns a YAML mistake into dead air on a real number.
 *
 * 2. A CALL KEEPS THE FLOW IT STARTED WITH. Sessions bind a FlowDocument at creation and hold
 *    it to the end. Swapping mid-call would move a caller between script versions in the
 *    middle of a sentence and make the version stamped on the call row (§7.5) a lie, which
 *    destroys the attribution the whole optimisation loop depends on.
 *
 * Polling rather than fs.watch or LISTEN/NOTIFY: a flow changes a few times a day at most,
 * the fingerprint check is cheap, and polling behaves identically for a file and for a
 * Postgres row. There is no latency argument for anything cleverer here.
 */

import { readFile, stat } from 'node:fs/promises'

import { documentFromYaml, safeParseFlow, type FlowDocument, type FlowIssue } from './flow.js'

export interface LoadedFlowSource {
  scriptVersionId: string | null
  yaml: string
}

export interface FlowSource {
  readonly name: string
  /**
   * Cheap change token — an mtime, a row id, a hash. Compared between polls so an unchanged
   * flow costs one stat or one indexed lookup rather than a parse.
   */
  fingerprint(): Promise<string>
  load(): Promise<LoadedFlowSource>
}

/** Reads a flow from disk. For local development and the CLI. */
export class FileFlowSource implements FlowSource {
  readonly name: string

  constructor(private readonly path: string) {
    this.name = `file:${path}`
  }

  async fingerprint(): Promise<string> {
    const s = await stat(this.path)
    return `${s.mtimeMs}:${s.size}`
  }

  async load(): Promise<LoadedFlowSource> {
    return { scriptVersionId: null, yaml: await readFile(this.path, 'utf8') }
  }
}

export interface FlowLoaderOptions {
  /** Poll interval. 0 disables polling; call reload() manually. */
  pollMs?: number
  /** Invoked when a reload swaps in a new document. */
  onChange?: (doc: FlowDocument, previous: FlowDocument) => void
  /**
   * Invoked when a reload fails. The previous document stays active — this is a signal to
   * page someone, not a reason to stop taking calls.
   */
  onError?: (issues: readonly FlowIssue[], source: string) => void
  /** Injectable for tests. */
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

export class FlowLoader {
  private doc: FlowDocument
  private token: string
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly opts: FlowLoaderOptions

  private constructor(
    private readonly source: FlowSource,
    doc: FlowDocument,
    token: string,
    opts: FlowLoaderOptions,
  ) {
    this.doc = doc
    this.token = token
    this.opts = opts
  }

  /** Loads once. Throws if the initial flow is invalid — starting on a broken script is not
   * a degraded mode, it is a failure to start. */
  static async create(source: FlowSource, opts: FlowLoaderOptions = {}): Promise<FlowLoader> {
    const token = await source.fingerprint()
    const { scriptVersionId, yaml } = await source.load()
    const doc = documentFromYaml(yaml, scriptVersionId)
    const loader = new FlowLoader(source, doc, token, opts)
    if ((opts.pollMs ?? 0) > 0) loader.start()
    return loader
  }

  /** The flow new calls should use. In-flight calls keep the document they started with. */
  get current(): FlowDocument {
    return this.doc
  }

  start(): void {
    if (this.timer !== undefined) return
    const interval = this.opts.setInterval ?? setInterval
    const pollMs = this.opts.pollMs ?? 0
    if (pollMs <= 0) return
    this.timer = interval(() => {
      void this.reload()
    }, pollMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer === undefined) return
    const clear = this.opts.clearInterval ?? clearInterval
    clear(this.timer)
    this.timer = undefined
  }

  /**
   * Checks the source and swaps if it changed and validates. Returns whether the active
   * document changed. Never throws: a reload failure is reported and the good flow stays.
   */
  async reload(): Promise<boolean> {
    let token: string
    let loaded: LoadedFlowSource
    try {
      token = await this.source.fingerprint()
      if (token === this.token) return false
      loaded = await this.source.load()
    } catch (err: unknown) {
      this.opts.onError?.(
        [{ path: 'source', message: `could not read flow: ${String(err)}` }],
        this.source.name,
      )
      return false
    }

    const result = safeParseFlow(loaded.yaml)
    if (!result.ok) {
      // Deliberately does NOT advance the token: the next poll retries, so fixing the file
      // recovers without a restart.
      this.opts.onError?.(result.issues, this.source.name)
      return false
    }

    const previous = this.doc
    this.doc = {
      scriptVersionId: loaded.scriptVersionId,
      version: result.flow.version,
      flow: result.flow,
      yaml: loaded.yaml,
      loadedAt: new Date(),
    }
    this.token = token
    this.opts.onChange?.(this.doc, previous)
    return true
  }
}
