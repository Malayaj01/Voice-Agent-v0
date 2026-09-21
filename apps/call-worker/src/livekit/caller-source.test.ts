/**
 * The seam that keeps the browser harness a faithful rehearsal of a phone call.
 *
 * What is worth testing here is not that a SIP call can be placed — that needs a carrier —
 * but that the browser path adds nothing. If JoiningCallerSource ever grows behaviour, the
 * harness stops exercising the same code a real call will.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Room } from '@livekit/rtc-node'

import { JoiningCallerSource, SipCallerSource, type CallerSource } from './caller-source.js'

const ctx = (log: (line: string) => void = () => undefined) => ({
  room: {} as Room,
  roomName: 'room-1',
  callId: 'call-1',
  log,
})

describe('JoiningCallerSource', () => {
  it('admits by doing nothing — the caller arrives under its own power', async () => {
    const source = new JoiningCallerSource('caller-abc')
    const admitted = await source.admit(ctx())

    assert.equal(admitted.identity, 'caller-abc')
    assert.equal(
      admitted.sipParticipant,
      undefined,
      'a browser caller has no telephony leg, and nothing downstream may expect one',
    )
  })

  it('never touches the room, so it cannot diverge from the SIP path', async () => {
    // An empty object stands in for the Room: any property access would throw, which is the
    // assertion. The source's whole job is to wait.
    const trap = new Proxy(
      {},
      {
        get(_t, prop) {
          throw new Error(`JoiningCallerSource touched room.${String(prop)}`)
        },
      },
    ) as Room

    await new JoiningCallerSource('caller-abc').admit({ ...ctx(), room: trap })
  })

  it('logs what it is waiting for, so a harness that hangs says why', async () => {
    const lines: string[] = []
    await new JoiningCallerSource('caller-xyz').admit(ctx((l) => lines.push(l)))

    assert.equal(lines.length, 1)
    assert.match(lines[0] ?? '', /waiting for caller-xyz/)
  })
})

describe('the seam', () => {
  it('both sources satisfy one interface, so swapping them is the only change', () => {
    const sip: CallerSource = new SipCallerSource(
      { url: 'ws://localhost:7880', apiKey: 'k', apiSecret: 's' },
      { trunkId: 'trunk', to: '+919876543210' as never },
    )
    const joining: CallerSource = new JoiningCallerSource('caller-1')

    assert.equal(sip.name, 'sip')
    assert.equal(joining.name, 'joining')
    for (const source of [sip, joining]) {
      assert.equal(typeof source.admit, 'function')
    }
  })

  /**
   * Constructing the SIP source must not reach the network. runCall publishes the agent track
   * before admitting the caller, and a constructor that dialled would invert that order and
   * lose the opening line.
   */
  it('constructing the SIP source places no call', () => {
    assert.doesNotThrow(
      () =>
        new SipCallerSource(
          { url: 'ws://unreachable.invalid', apiKey: 'k', apiSecret: 's' },
          { trunkId: 'trunk', to: '+919876543210' as never },
        ),
    )
  })
})
