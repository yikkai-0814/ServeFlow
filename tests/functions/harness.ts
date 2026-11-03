/**
 * Drives the real Cloud Functions in the Functions emulator, as the app would.
 *
 * Every address comes from the environment `firebase emulators:exec` sets — the Firestore and
 * Auth hosts, and the hub that says where the Functions emulator is — so the suite runs on
 * whichever ports the emulators were started on and never assumes the defaults. That is what
 * lets it run beside a developer's own emulators on different ports.
 *
 * Seeding and inspection go through @firebase/rules-unit-testing with rules disabled — the
 * stand-in for "the server looked at the database". Everything the tests ASSERT about
 * behaviour goes through the callables, signed in as a real Auth emulator account.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { deleteApp, FirebaseError, initializeApp, type FirebaseApp } from 'firebase/app'
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
} from 'firebase/auth'
import { collection, doc, getDoc, getDocs, setDoc, type Firestore } from 'firebase/firestore'
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
  type Functions,
} from 'firebase/functions'

/** Fixed by vitest.config.ts for every suite; `test:functions` starts the emulators with it. */
export const PROJECT_ID = process.env.VITE_FIREBASE_PROJECT_ID ?? 'demo-ordering-system'
export const REGION = 'asia-southeast1'
export const PASSWORD = 'emulator-password'

function requireHost(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set — run this suite with npm run test:functions.`)
  return value
}

interface Emulators {
  authHost: string
  functionsOrigin: string
}

let testEnv: RulesTestEnvironment | null = null
let app: FirebaseApp | null = null
let auth: Auth | null = null
let functions: Functions | null = null
let emulators: Emulators | null = null

export async function startHarness(): Promise<void> {
  const hub = requireHost('FIREBASE_EMULATOR_HUB')
  const listing = (await (await fetch(`http://${hub}/emulators`)).json()) as Record<
    string,
    { host: string; port: number }
  >
  const fn = listing.functions
  if (!fn) throw new Error('The Functions emulator is not running.')
  emulators = {
    authHost: requireHost('FIREBASE_AUTH_EMULATOR_HOST'),
    functionsOrigin: `http://${fn.host}:${fn.port}`,
  }

  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8') },
  })

  app = initializeApp(
    { projectId: PROJECT_ID, apiKey: 'fake-api-key', authDomain: `${PROJECT_ID}.firebaseapp.com` },
    `functions-tests-${Date.now()}`,
  )
  auth = getAuth(app)
  connectAuthEmulator(auth, `http://${emulators.authHost}`, { disableWarnings: true })
  functions = getFunctions(app, REGION)
  connectFunctionsEmulator(functions, fn.host, fn.port)
}

export async function stopHarness(): Promise<void> {
  if (auth) await signOut(auth).catch(() => undefined)
  if (app) await deleteApp(app)
  await testEnv?.cleanup()
  app = auth = functions = testEnv = null
}

function env(): RulesTestEnvironment {
  if (!testEnv) throw new Error('startHarness() has not run.')
  return testEnv
}

/** Clears Firestore and every Auth account in this throwaway test project. */
export async function resetEmulators(): Promise<void> {
  if (auth) await signOut(auth).catch(() => undefined)
  await env().clearFirestore()
  await fetch(`http://${emulators!.authHost}/emulator/v1/projects/${PROJECT_ID}/accounts`, {
    method: 'DELETE',
  })
}

// ---- Seeding and inspection (rules disabled) ------------------------------------------------

export async function asServer<T>(work: (db: Firestore) => Promise<T>): Promise<T> {
  let result: T
  await env().withSecurityRulesDisabled(async (context) => {
    result = await work(context.firestore() as unknown as Firestore)
  })
  return result!
}

export async function read(path: string): Promise<Record<string, unknown> | null> {
  return asServer(async (db) => {
    const snapshot = await getDoc(doc(db, path))
    return snapshot.exists() ? snapshot.data() : null
  })
}

export async function write(path: string, data: Record<string, unknown>): Promise<void> {
  await asServer((db) => setDoc(doc(db, path), data))
}

export async function count(collectionPath: string): Promise<number> {
  return asServer(async (db) => (await getDocs(collection(db, collectionPath))).size)
}

/** The rules' own view, signed in as `uid` — for the parity check against validVoid. */
export function asRulesUser(uid: string): Firestore {
  return env().authenticatedContext(uid).firestore() as unknown as Firestore
}

// ---- Accounts --------------------------------------------------------------------------------

export interface Account {
  uid: string
  email: string
  displayName: string
}

let counter = 0

/** A real Auth emulator account with a `users/{uid}` profile, as an admin would create it. */
export async function createAccount(
  displayName: string,
  role: 'admin' | 'staff',
  active = true,
): Promise<Account> {
  const email = `${role}-${counter++}-${Date.now()}@example.test`
  const credential = await createUserWithEmailAndPassword(auth!, email, PASSWORD)
  const uid = credential.user.uid
  await write(`users/${uid}`, { uid, email, displayName, role, active, createdAt: new Date() })
  await signOut(auth!)
  return { uid, email, displayName }
}

export async function signInAs(account: Account): Promise<void> {
  await signInWithEmailAndPassword(auth!, account.email, PASSWORD)
}

export async function signOutAll(): Promise<void> {
  await signOut(auth!)
}

// ---- Calling the functions -------------------------------------------------------------------

export async function call<T = unknown>(name: string, data?: unknown): Promise<T> {
  const callable = httpsCallable<unknown, T>(functions!, name)
  return (await callable(data)).data
}

/** The `details.reason` a call was refused with. Fails the test if the call succeeded. */
export async function refusal(name: string, data?: unknown): Promise<string> {
  try {
    await call(name, data)
  } catch (caught) {
    const details = (caught as FirebaseError & { details?: { reason?: string } }).details
    if (details?.reason) return details.reason
    throw caught
  }
  throw new Error(`${name} was expected to be refused, but succeeded`)
}

/**
 * Calls a function with a hand-made ID token, to control its claims — used to prove that
 * `setAdminPin` judges `auth_time`. The Functions emulator does not verify token signatures,
 * so an unsigned token with the right project is accepted exactly as a real one would be.
 */
export async function callWithToken(
  name: string,
  data: unknown,
  claims: { uid: string; authTimeSeconds: number },
): Promise<{ ok: boolean; reason: string | null }> {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const token = [
    encode({ alg: 'none', typ: 'JWT' }),
    encode({
      iss: `https://securetoken.google.com/${PROJECT_ID}`,
      aud: PROJECT_ID,
      sub: claims.uid,
      user_id: claims.uid,
      auth_time: claims.authTimeSeconds,
      iat: now - 5,
      exp: now + 3600,
      firebase: { sign_in_provider: 'password', identities: {} },
    }),
    '',
  ].join('.')

  const response = await fetch(`${emulators!.functionsOrigin}/${PROJECT_ID}/${REGION}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
  })
  const body = (await response.json()) as { error?: { details?: { reason?: string } } }
  return { ok: response.ok, reason: body.error?.details?.reason ?? null }
}
