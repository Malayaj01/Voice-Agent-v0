/**
 * Injectable delay, so artificial latency is configurable AND testable.
 *
 * Tests pass `recordingSleep()` and assert on the durations that were requested, rather
 * than actually waiting — a suite that sleeps for its own fixtures gets deleted eventually.
 */

export type SleepFn = (ms: number) => Promise<void>

export const realSleep: SleepFn = (ms) =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))

/** Resolves immediately but records what it was asked to wait for. */
export function recordingSleep(): { sleep: SleepFn; calls: number[]; totalMs: () => number } {
  const calls: number[] = []
  return {
    calls,
    sleep: (ms: number) => {
      calls.push(ms)
      return Promise.resolve()
    },
    totalMs: () => calls.reduce((a, b) => a + b, 0),
  }
}
