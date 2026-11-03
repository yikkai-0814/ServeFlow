/**
 * The checks a PIN-authorised void must pass before it is written. Pure, like pin.ts.
 *
 * The function writes `orderVoids/{orderId}` with the Admin SDK, which firestore.rules do not
 * judge, so every condition `validVoid` puts on that document is restated here. Each one names
 * the rule it mirrors; tests/functions also feeds the written record back through the real
 * rules as an admin write, so the two cannot drift apart unnoticed.
 */

/** Mirrors VOID_REASON_MAX in src/features/pos/voids.ts and `d.reason.size() <= 200`. */
export const VOID_REASON_MAX = 200
/** Mirrors `initiatedByStaffName.size() <= 60` in validVoid. */
export const STAFF_NAME_MAX = 60

/** Mirrors validateVoidReason in src/features/pos/voids.ts: trimmed, required, bounded. */
export function validateReason(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed === '' || trimmed.length > VOID_REASON_MAX) return null
  return trimmed
}

/** A Firestore document id: a non-empty string with no path separator. */
export function isDocumentId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 1500 && !value.includes('/')
  )
}

/** What a void records about who asked for it. */
export interface Initiator {
  staffId: string
  staffName: string
}

/** The fields of a profile or roster document this needs, exactly as stored. */
export interface PersonRecord {
  exists: boolean
  active?: unknown
  name?: unknown
}

function usableName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= STAFF_NAME_MAX
}

/**
 * Who requested the void, decided entirely from server-side records.
 *
 * The requester is always the signed-in account (`callerUid`, from the verified token). The
 * till may say which roster member is operating it — as an id only. Then:
 *
 *  - no operator, or the operator IS the account → the account, under its profile's
 *    `displayName` (validVoid's account-operator form, `isAccountOperator`);
 *  - a roster id → that `staffMembers` document must exist and be active, and its CURRENT
 *    name is recorded (`isNamedOperator`). Nothing the till sends becomes a name.
 *
 * Null means the requester cannot be recorded truthfully, and the void is refused.
 */
export function resolveInitiator(
  callerUid: string,
  callerProfile: PersonRecord,
  operatorId: string | null,
  operator: PersonRecord | null,
): Initiator | null {
  if (operatorId === null || operatorId === callerUid) {
    if (!callerProfile.exists || callerProfile.active !== true) return null
    return usableName(callerProfile.name)
      ? { staffId: callerUid, staffName: callerProfile.name }
      : null
  }

  if (!operator || !operator.exists || operator.active !== true) return null
  return usableName(operator.name) ? { staffId: operatorId, staffName: operator.name } : null
}

/** The order total a void reverses: validVoid requires `amount == order.total`, an int >= 0. */
export function orderTotalOf(total: unknown): number | null {
  return Number.isInteger(total) && (total as number) >= 0 ? (total as number) : null
}
