/**
 * Opt-in timings for the counter's slow paths, kept on the device that measured them.
 *
 * **Off unless asked for.** On a device where somebody has run
 * `localStorage.setItem('serveflow.perf', '1')` and reloaded, each measurement becomes a
 * `performance.measure` entry (the DevTools Performance panel) and one `console.info` line. Read
 * once per page load, so turning it on or off takes a reload. Anywhere else — and wherever storage
 * cannot be read — every function here returns at once and records nothing.
 *
 * **Nothing leaves the page.** No request, no Firestore write and no storage write is made here.
 *
 * **Durations, never data.** A measurement is a fixed name, a number of milliseconds and the few
 * fields `PerfFields` allows, each checked before it is recorded: no id, name, price, table,
 * reason, PIN or email can be passed through.
 *
 * Call sites use `perfStart` as `stop?.(fields)`: when this is off, `stop` is null and the fields
 * are never even evaluated, so measuring costs a disabled page nothing.
 */

export const PERF_STORAGE_KEY = 'serveflow.perf'

export type PerfName =
  | 'session.auth'
  | 'session.profile'
  | 'login.signIn'
  | 'menu.first'
  | 'order.warmup'
  | 'order.prepare'
  | 'order.call'
  | 'order.toPaymentStep'
  | 'void.pinStatus'
  | 'void.call'
  | 'void.toBanner'
  | 'queue.first'
  | 'queue.newOrder'

/** Everything a measurement may say besides its duration. */
export interface PerfFields {
  /** `ok`, a server refusal code such as `incorrect-pin`, or an SDK error code. */
  outcome?: string
  /** The first snapshot came from the local cache rather than the server. */
  fromCache?: boolean
  /** Whether the restored session had a signed-in user. */
  signedIn?: boolean
  /** Which menu collection a `menu.first` measured. */
  collection?: MenuCollection
  /** How a void was authorised. */
  route?: VoidRoute
  /** How many documents arrived. */
  count?: number
  /** This device's clock minus the order's server time: approximate, as the clocks may differ. */
  approxSinceCreatedMs?: number
}

export type MenuCollection = 'categories' | 'menuItems' | 'modifierGroups'
export type VoidRoute = 'admin' | 'pin' | 'manager'

export type PerfStop = (fields?: PerfFields) => void

const MENU_COLLECTIONS = new Set<string>(['categories', 'menuItems', 'modifierGroups'])
const VOID_ROUTES = new Set<string>(['admin', 'pin', 'manager'])
/** Codes are short lowercase words with hyphens; anything else is not passed through. */
const CODE = /^[a-z][a-z0-9-]{0,39}$/

let enabled: boolean | undefined

export function perfEnabled(): boolean {
  if (enabled === undefined) {
    try {
      enabled = globalThis.localStorage?.getItem(PERF_STORAGE_KEY) === '1'
    } catch {
      enabled = false
    }
  }
  return enabled
}

/** Forgets the flag and any measurement in progress. For tests, which change the flag. */
export function resetPerf(): void {
  enabled = undefined
  pending.clear()
}

function now(): number {
  try {
    return globalThis.performance?.now() ?? 0
  } catch {
    return 0
  }
}

/** Now, on the clock measurements use. Zero when this is off. */
export function perfNow(): number {
  return perfEnabled() ? now() : 0
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

function allowed(fields: PerfFields | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (!fields) return out
  if (typeof fields.outcome === 'string' && CODE.test(fields.outcome)) out.outcome = fields.outcome
  if (typeof fields.fromCache === 'boolean') out.fromCache = fields.fromCache
  if (typeof fields.signedIn === 'boolean') out.signedIn = fields.signedIn
  if (typeof fields.collection === 'string' && MENU_COLLECTIONS.has(fields.collection)) {
    out.collection = fields.collection
  }
  if (typeof fields.route === 'string' && VOID_ROUTES.has(fields.route)) out.route = fields.route
  if (isCount(fields.count)) out.count = Math.round(fields.count)
  if (isCount(fields.approxSinceCreatedMs)) {
    out.approxSinceCreatedMs = Math.round(fields.approxSinceCreatedMs)
  }
  return out
}

/** Records one measurement from `startedAt` (on `perfNow`'s clock) to now. Never throws. */
export function perfMeasure(name: PerfName, startedAt: number, fields?: PerfFields): void {
  if (!perfEnabled()) return
  const end = now()
  const detail = allowed(fields)
  try {
    globalThis.performance?.measure?.(`serveflow:${name}`, { start: startedAt, end, detail })
  } catch {
    // An engine without measure options still gets the console line below.
  }
  try {
    console.info('[perf]', name, `${Math.round(end - startedAt)} ms`, detail)
  } catch {
    // A measurement must never disturb the counter.
  }
}

/** Starts a measurement; the returned function ends it, once. Null when this is off. */
export function perfStart(name: PerfName): PerfStop | null {
  if (!perfEnabled()) return null
  const startedAt = now()
  let stopped = false
  return (fields) => {
    if (stopped) return
    stopped = true
    perfMeasure(name, startedAt, fields)
  }
}

/** Measurements begun in one place and ended in another, such as a click and the next screen. */
const pending = new Map<PerfName, { startedAt: number; fields?: PerfFields }>()

export function perfBegin(name: PerfName, fields?: PerfFields): void {
  if (perfEnabled()) pending.set(name, { startedAt: now(), fields })
}

/** Ends a measurement `perfBegin` started. Nothing happens if none is in progress. */
export function perfEnd(name: PerfName): void {
  const started = pending.get(name)
  if (!started) return
  pending.delete(name)
  perfMeasure(name, started.startedAt, started.fields)
}

/** Abandons a measurement `perfBegin` started, as when the thing it was timing failed. */
export function perfCancel(name: PerfName): void {
  pending.delete(name)
}

/**
 * What a failure was, as a code: the server's refusal reason when it gave one, otherwise the
 * SDK's error code without its `functions/` or `auth/` prefix, otherwise `error`. Never a message.
 */
export function perfOutcome(caught: unknown): string {
  if (typeof caught !== 'object' || caught === null) return 'error'
  const { details, code } = caught as { details?: unknown; code?: unknown }
  const reason =
    typeof details === 'object' && details !== null
      ? (details as { reason?: unknown }).reason
      : undefined
  if (typeof reason === 'string' && CODE.test(reason)) return reason
  if (typeof code === 'string') {
    const bare = code.slice(code.indexOf('/') + 1)
    if (CODE.test(bare)) return bare
  }
  return 'error'
}
