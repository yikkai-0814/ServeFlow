/**
 * The browser's opt-in timings (src/lib/perf.ts).
 *
 * Off by default and silent when off; when on, local only, and limited to a name, a duration and
 * the allowed fields. Nothing here may ever throw into the code it measures.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import {
  perfBegin,
  perfCancel,
  perfEnabled,
  perfEnd,
  perfMeasure,
  perfOutcome,
  perfStart,
  PERF_STORAGE_KEY,
  resetPerf,
  type PerfFields,
} from '@/lib/perf'

function storageWith(value: string | null) {
  return { getItem: (key: string) => (key === PERF_STORAGE_KEY ? value : null) }
}

let info: MockInstance<typeof console.info>
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetPerf()
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetPerf()
})

describe('switched off', () => {
  it('is off when nothing has been set', () => {
    vi.stubGlobal('localStorage', storageWith(null))
    expect(perfEnabled()).toBe(false)
  })

  it('is off when storage cannot be read', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
    })
    expect(perfEnabled()).toBe(false)
  })

  it('is off for any value but "1"', () => {
    vi.stubGlobal('localStorage', storageWith('true'))
    expect(perfEnabled()).toBe(false)
  })

  it('records nothing, and hands back no stop function', () => {
    vi.stubGlobal('localStorage', storageWith(null))
    const measure = vi.spyOn(performance, 'measure')

    expect(perfStart('order.call')).toBeNull()
    perfMeasure('order.call', 0, { outcome: 'ok' })
    perfBegin('order.toPaymentStep')
    perfEnd('order.toPaymentStep')

    expect(info).not.toHaveBeenCalled()
    expect(measure).not.toHaveBeenCalled()
  })

  it('never evaluates the fields at a call site written as stop?.(fields)', () => {
    vi.stubGlobal('localStorage', storageWith(null))
    const fields = vi.fn(() => ({ outcome: 'ok' }))

    perfStart('order.call')?.(fields())

    expect(fields).not.toHaveBeenCalled()
  })
})

describe('switched on', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storageWith('1'))
  })

  it('writes one console line and one performance entry per measurement', () => {
    const measure = vi.spyOn(performance, 'measure')

    const stop = perfStart('order.call')
    stop?.({ outcome: 'ok' })
    stop?.({ outcome: 'ok' })

    expect(info).toHaveBeenCalledTimes(1)
    const [tag, name, duration, detail] = info.mock.calls[0]!
    expect(tag).toBe('[perf]')
    expect(name).toBe('order.call')
    expect(duration).toMatch(/^\d+ ms$/)
    expect(detail).toEqual({ outcome: 'ok' })
    expect(measure).toHaveBeenCalledWith('serveflow:order.call', expect.anything())
  })

  it('sends nothing anywhere', () => {
    perfStart('void.call')?.({ outcome: 'ok' })
    perfMeasure('queue.first', 0, { count: 3 })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ends a measurement begun elsewhere once, with the fields it began with', () => {
    perfBegin('void.toBanner', { route: 'pin' })
    perfEnd('void.toBanner')
    perfEnd('void.toBanner')

    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]![3]).toEqual({ route: 'pin' })
  })

  it('measures nothing for a measurement that was cancelled', () => {
    perfBegin('order.toPaymentStep')
    perfCancel('order.toPaymentStep')
    perfEnd('order.toPaymentStep')

    expect(info).not.toHaveBeenCalled()
  })

  it('passes only the allowed fields, in the allowed forms', () => {
    const smuggled = {
      outcome: 'Customer changed mind',
      collection: 'users',
      route: 'alice@example.com',
      count: 4.6,
      fromCache: true,
      pin: '482913',
      uid: 'till-uid-123',
      total: 2500,
    } as unknown as PerfFields

    perfMeasure('menu.first', 0, smuggled)

    const detail = info.mock.calls[0]![3]
    expect(detail).toEqual({ count: 5, fromCache: true })
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/482913|till-uid|alice|Customer|2500/)
  })

  it('keeps working when the Performance API refuses or is missing', () => {
    vi.spyOn(performance, 'measure').mockImplementation(() => {
      throw new Error('unsupported')
    })
    expect(() => perfMeasure('order.call', 0)).not.toThrow()
    expect(info).toHaveBeenCalledTimes(1)

    vi.stubGlobal('performance', undefined)
    expect(() => perfStart('order.call')?.()).not.toThrow()
  })
})

describe('outcome codes', () => {
  it('prefers the server refusal reason', () => {
    const refusal = { code: 'functions/permission-denied', details: { reason: 'incorrect-pin' } }
    expect(perfOutcome(refusal)).toBe('incorrect-pin')
  })

  it('falls back to the SDK code without its prefix', () => {
    expect(perfOutcome({ code: 'functions/deadline-exceeded' })).toBe('deadline-exceeded')
    expect(perfOutcome({ code: 'auth/invalid-credential' })).toBe('invalid-credential')
  })

  it('is "error" for anything else, and never a message', () => {
    expect(perfOutcome(new Error('alice@example.com is not allowed'))).toBe('error')
    expect(perfOutcome({ details: { reason: 'Not A Code!' } })).toBe('error')
    expect(perfOutcome(null)).toBe('error')
    expect(perfOutcome('boom')).toBe('error')
  })
})
