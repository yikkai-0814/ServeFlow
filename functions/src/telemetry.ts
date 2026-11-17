/**
 * How long a call took, and where the time went: attached as one `perf` object to the line a
 * function already logs when it succeeds ("Order placed", "Order voided with admin PIN").
 *
 * Pure apart from the clock it is handed, like pin.ts, so it is tested without an emulator.
 *
 * **Only durations, counts and two facts about the instance — never anything about the sale.**
 * Nothing here is given the request, a document or an error. What it can record is fixed by the
 * three lists below, and `finish` copies nothing else, so no uid, name, order, price, table,
 * reason, PIN or payment detail can reach the log through it.
 *
 * **What it cannot see.** The time the platform spends before the handler runs — starting a
 * container, checking the caller's token — is outside it. Cloud Run's own logs carry that, and
 * every line logged here already carries Cloud Run's `instanceId` label and trace, which is what
 * joins the two.
 */

/** Durations, in whole milliseconds. */
export const TIMING_STAGES = [
  'authMs',
  'catalogueMs',
  'txMs',
  'adminLookupMs',
  'attemptSpendMs',
  'pinCheckMs',
  'attemptResetMs',
  'voidTxMs',
] as const

/** How many times something happened during the call. */
export const TIMING_COUNTS = [
  'txAttempts',
  'attemptSpendAttempts',
  'pinChecks',
  'voidTxAttempts',
] as const

/** Yes-or-no facts about the call. */
export const TIMING_FLAGS = ['replayed'] as const

export type TimingStage = (typeof TIMING_STAGES)[number]
export type TimingCount = (typeof TIMING_COUNTS)[number]
export type TimingFlag = (typeof TIMING_FLAGS)[number]

/** What is logged, under `perf`. A stage that was never reached is absent, not zero. */
export type TimingRecord = {
  /** Bumped if a field changes meaning, so a log query can tell the two apart. */
  v: 1
  /** From the handler starting to this record being made. */
  totalMs: number
  /** The first call this instance has handled: it paid for setting up its connections. */
  firstRequestOnInstance: boolean
  /** Which call this is on the instance, counting from 1. */
  requestOrdinal: number
  /** How long the instance had been loaded when this call started. */
  instanceAgeMs: number
  /** How long the process took to load the function's code, before any call. */
  moduleLoadMs: number
} & Partial<Record<TimingStage | TimingCount, number>> &
  Partial<Record<TimingFlag, boolean>>

/** Milliseconds from any fixed point; only differences are used. */
export type Clock = () => number

export interface CallTiming {
  /** Times `work` and returns exactly what it returns, or throws exactly what it throws. */
  stage<T>(name: TimingStage, work: () => Promise<T>): Promise<T>
  /** Starts timing a stage too long to wrap; call what this returns when it ends. */
  start(name: TimingStage): () => void
  count(name: TimingCount): void
  flag(name: TimingFlag, value: boolean): void
  finish(): TimingRecord
}

export interface InstanceTiming {
  /** One per call, at the very start of the handler. */
  begin(): CallTiming
}

const STAGES = new Set<string>(TIMING_STAGES)
const COUNTS = new Set<string>(TIMING_COUNTS)
const FLAGS = new Set<string>(TIMING_FLAGS)

/**
 * The instance's clock and call counter. Created once, when the function's code loads, so
 * `moduleLoadMs` is measured by the caller at that moment (the process's uptime).
 *
 * Each deployed function runs in its own instances, so "first request on instance" is per
 * function in production. The emulator may serve several functions from one process, where it is
 * only approximate.
 */
export function createInstanceTiming(clock: Clock, moduleLoadMs: number): InstanceTiming {
  const loadedAt = clock()
  let served = 0

  return {
    begin() {
      served += 1
      const startedAt = clock()
      return createCallTiming(clock, startedAt, {
        firstRequestOnInstance: served === 1,
        requestOrdinal: served,
        instanceAgeMs: Math.round(startedAt - loadedAt),
        moduleLoadMs: Math.round(moduleLoadMs),
      })
    },
  }
}

function createCallTiming(
  clock: Clock,
  startedAt: number,
  instance: Pick<
    TimingRecord,
    'firstRequestOnInstance' | 'requestOrdinal' | 'instanceAgeMs' | 'moduleLoadMs'
  >,
): CallTiming {
  // The last measurement of a stage wins: inside a transaction that is the attempt that committed.
  const stages = new Map<string, number>()
  const counts = new Map<string, number>()
  const flags = new Map<string, boolean>()

  function start(name: TimingStage) {
    const began = clock()
    return () => {
      stages.set(name, clock() - began)
    }
  }

  return {
    async stage(name, work) {
      const end = start(name)
      try {
        return await work()
      } finally {
        end()
      }
    },
    start,
    count(name) {
      counts.set(name, (counts.get(name) ?? 0) + 1)
    },
    flag(name, value) {
      flags.set(name, value)
    },
    finish() {
      const record: Record<string, number | boolean> = {
        v: 1,
        totalMs: Math.round(clock() - startedAt),
        ...instance,
      }
      // Copied through the lists rather than trusted, so nothing else can ride along.
      for (const [name, ms] of stages) if (STAGES.has(name)) record[name] = Math.round(ms)
      for (const [name, n] of counts) if (COUNTS.has(name)) record[name] = n
      for (const [name, value] of flags) if (FLAGS.has(name)) record[name] = value
      return record as TimingRecord
    },
  }
}
