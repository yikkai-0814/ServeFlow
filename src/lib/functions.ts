import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions'

import { EMULATOR_HOST, FUNCTIONS_EMULATOR_PORT, FUNCTIONS_REGION, useEmulators } from '@/lib/env'
import { app } from '@/lib/firebase'

/**
 * The Cloud Functions client, on the app's own session.
 *
 * Callables send the signed-in user's ID token with every request, and the functions derive
 * everything about the caller from it — which is why this uses the till's own app and never
 * the borrowed manager session in authorizer.ts.
 *
 * Created lazily: only the void dialog and the admin's PIN settings need it.
 */
let functions: Functions | null = null

export function appFunctions(): Functions {
  if (functions) return functions
  functions = getFunctions(app, FUNCTIONS_REGION)
  if (useEmulators) connectFunctionsEmulator(functions, EMULATOR_HOST, FUNCTIONS_EMULATOR_PORT)
  return functions
}
