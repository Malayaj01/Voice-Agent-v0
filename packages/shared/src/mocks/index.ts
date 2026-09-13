/**
 * Mock providers — ARCHITECTURE.md §5.
 *
 * What Phase 1 builds against, so that the media loop, the FSM and the latency
 * instrumentation can all be exercised before any vendor account exists. Imported from
 * `@voice-agent/shared/mocks`, deliberately not from the package root: these must never be
 * reachable by accident from production code.
 *
 * All three take configurable artificial latency, defaulting to 0 so suites stay fast. The
 * MOCK_*_REALISTIC presets reproduce the §6 budget when you want the real timing.
 */

export * from './audio.js'
export * from './intent.js'
export * from './sleep.js'
export * from './stt.js'
export * from './tts.js'
