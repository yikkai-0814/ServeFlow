/**
 * The timings placeOrder and voidOrderWithAdminPin attach to their log lines.
 *
 * What matters most is what these can NOT do: change a result, swallow or replace an error, or
 * carry anything but durations, counts and the two facts about the instance. tests/functions runs
 * the real functions with this wired in, and their results are asserted there unchanged.
 */
import { describe, expect, it } from 'vitest'

import {
  createInstanceTiming,
  TIMING_COUNTS,
  TIMING_FLAGS,
  TIMING_STAGES,
  type TimingStage,
} from '../../functions/src/telemetry'

/** A clock the test moves by hand. */
function manualClock(start = 1_000) {
  let now = start
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

const COMMON = [
  'v',
  'totalMs',
  'firstRequestOnInstance',
  'requestOrdinal',
  'instanceAgeMs',
  'moduleLoadMs',
]
const ALLOWED = new Set<string>([...COMMON, ...TIMING_STAGES, ...TIMING_COUNTS, ...TIMING_FLAGS])

describe('the instance', () => {
  it('marks only its first call as the first request, and numbers every call', () => {
    const { clock, advance } = manualClock()
    const instance = createInstanceTiming(clock, 812.4)

    advance(250)
    const first = instance.begin().finish()
    advance(40)
    const second = instance.begin().finish()

    expect(first).toMatchObject({
      firstRequestOnInstance: true,
      requestOrdinal: 1,
      instanceAgeMs: 250,
      moduleLoadMs: 812,
    })
    expect(second).toMatchObject({
      firstRequestOnInstance: false,
      requestOrdinal: 2,
      instanceAgeMs: 290,
    })
  })
})

describe('a call', () => {
  it('times its whole length and each stage, in whole milliseconds', async () => {
    const { clock, advance } = manualClock()
    const call = createInstanceTiming(clock, 0).begin()

    await call.stage('authMs', async () => advance(41.6))
    const ended = call.start('txMs')
    advance(120)
    ended()

    expect(call.finish()).toMatchObject({ v: 1, totalMs: 162, authMs: 42, txMs: 120 })
  })

  it('returns exactly what the work returned', async () => {
    const call = createInstanceTiming(() => 0, 0).begin()
    const value = { id: 'order-1', number: 7 }

    await expect(call.stage('authMs', async () => value)).resolves.toBe(value)
  })

  it('throws exactly what the work threw, and still records how long it took', async () => {
    const { clock, advance } = manualClock()
    const call = createInstanceTiming(clock, 0).begin()
    const refusal = Object.assign(new Error('incorrect-pin'), {
      details: { reason: 'incorrect-pin' },
    })

    const caught = await call
      .stage('pinCheckMs', async () => {
        advance(110)
        throw refusal
      })
      .catch((error: unknown) => error)

    expect(caught).toBe(refusal)
    expect(call.finish().pinCheckMs).toBe(110)
  })

  it('counts transaction attempts, and keeps the stage from the attempt that ran last', async () => {
    const { clock, advance } = manualClock()
    const call = createInstanceTiming(clock, 0).begin()

    // As runTransaction does under contention: the same callback, three times.
    for (const ms of [30, 55, 20]) {
      call.count('txAttempts')
      call.flag('replayed', false)
      await call.stage('catalogueMs', async () => advance(ms))
    }
    call.flag('replayed', true)

    expect(call.finish()).toMatchObject({ txAttempts: 3, catalogueMs: 20, replayed: true })
  })

  it('leaves out a stage it never reached rather than reporting it as zero', () => {
    const record = createInstanceTiming(() => 0, 0)
      .begin()
      .finish()

    expect(record).not.toHaveProperty('voidTxMs')
    expect(record).not.toHaveProperty('txAttempts')
    expect(Object.keys(record).sort()).toEqual([...COMMON].sort())
  })
})

describe('what can reach the log', () => {
  it('is only the listed fields, as numbers and booleans', async () => {
    const call = createInstanceTiming(() => 5, 3).begin()
    for (const stage of TIMING_STAGES) await call.stage(stage, async () => undefined)
    for (const count of TIMING_COUNTS) call.count(count)
    for (const flag of TIMING_FLAGS) call.flag(flag, true)

    const record = call.finish()
    for (const [key, value] of Object.entries(record)) {
      expect(ALLOWED.has(key), key).toBe(true)
      expect(['number', 'boolean']).toContain(typeof value)
    }
  })

  it('drops a name that is not on the lists, whatever is passed at runtime', async () => {
    const call = createInstanceTiming(() => 0, 0).begin()
    // What a careless future edit might try; the types refuse it, and so does finish().
    await call.stage('pin' as TimingStage, async () => undefined)
    call.start('uid' as TimingStage)()

    const record = call.finish()
    expect(record).not.toHaveProperty('pin')
    expect(record).not.toHaveProperty('uid')
  })

  it('never contains what the request carried', async () => {
    // The module is never handed request data. This proves the output stays clean even when the
    // work it times handles the most sensitive values the functions see.
    const call = createInstanceTiming(() => 0, 0).begin()
    const secrets = ['482913', 'till-uid-123', 'alice@example.com', 'Customer changed mind', 'T5']
    await call.stage('pinCheckMs', async () => secrets.join(','))

    const logged = JSON.stringify(call.finish())
    for (const secret of secrets) expect(logged).not.toContain(secret)
  })
})
