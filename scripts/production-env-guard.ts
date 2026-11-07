/**
 * Stops a production build from being made with development configuration.
 *
 * **Why this exists.** Vite reads `.env.local` in every mode, so `.env.production.local` only
 * overrides what it names. A variable missing from the production file is therefore not missing
 * at all: it silently takes its development value. Remove `VITE_USE_EMULATORS` from the
 * production file and the build comes out pointing at 127.0.0.1, with every till in the café
 * trying to reach an emulator that is not there.
 *
 * So each variable has to be stated for production specifically, in a production env file or in
 * the environment of the build itself. Reports name variables and never their values.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Plugin } from 'vite'

/** Mirrors REQUIRED_KEYS in src/lib/env.ts. */
const FIREBASE_KEYS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const

const EMULATOR_FLAG = 'VITE_USE_EMULATORS'

/** The files Vite reads in production mode that `.env.local` cannot be mistaken for. */
const PRODUCTION_ENV_FILES = ['.env.production', '.env.production.local']

type Env = Readonly<Record<string, string | undefined>>

export interface ProductionEnvInput {
  /** What the build will actually inline, after Vite has merged every env file. */
  env: Env
  /** Names stated for production specifically. */
  statedForProduction: ReadonlySet<string>
  /** The default project in .firebaserc, which is what `firebase deploy` will target. */
  deployProjectId: string | null
}

/** Everything wrong with this configuration, in words safe to print. Empty means it is fine. */
export function productionEnvProblems({
  env,
  statedForProduction,
  deployProjectId,
}: ProductionEnvInput): string[] {
  const problems: string[] = []

  if (env[EMULATOR_FLAG] === 'true') {
    problems.push(`${EMULATOR_FLAG} is true, so this build would connect to the emulators.`)
  }

  for (const key of [...FIREBASE_KEYS, EMULATOR_FLAG]) {
    if (!statedForProduction.has(key)) {
      problems.push(`${key} is not set for production, so it would come from .env.local or .env.`)
    }
  }

  for (const key of FIREBASE_KEYS) {
    const value = env[key]
    if (value === undefined || value.trim() === '') {
      problems.push(`${key} is empty.`)
    } else if (/demo-|localhost|127\.0\.0\.1/i.test(value)) {
      problems.push(`${key} holds a development value.`)
    }
  }

  const projectId = env.VITE_FIREBASE_PROJECT_ID
  if (deployProjectId !== null && projectId && projectId !== deployProjectId) {
    problems.push('VITE_FIREBASE_PROJECT_ID does not match the default project in .firebaserc.')
  }

  return problems
}

/** The variable names a file assigns. Names only: the values are never read into anything. */
export function namesAssignedIn(text: string): string[] {
  return [...text.matchAll(/^\s*(?:export\s+)?(VITE_[A-Z0-9_]+)\s*=/gm)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  )
}

function statedForProductionIn(envDir: string): Set<string> {
  const names = new Set(Object.keys(process.env).filter((name) => name.startsWith('VITE_')))
  for (const file of PRODUCTION_ENV_FILES) {
    const path = join(envDir, file)
    if (existsSync(path)) {
      for (const name of namesAssignedIn(readFileSync(path, 'utf8'))) names.add(name)
    }
  }
  return names
}

function deployProjectIn(root: string): string | null {
  const path = join(root, '.firebaserc')
  if (!existsSync(path)) return null
  const config = JSON.parse(readFileSync(path, 'utf8')) as { projects?: { default?: unknown } }
  const project = config.projects?.default
  return typeof project === 'string' ? project : null
}

/** Fails `vite build` in production mode. Development and `vite preview` are left alone. */
export function productionEnvGuard(): Plugin {
  return {
    name: 'serveflow:production-env-guard',
    apply: 'build',
    configResolved(config) {
      if (config.mode !== 'production') return

      const envDir = typeof config.envDir === 'string' ? config.envDir : config.root
      const problems = productionEnvProblems({
        env: config.env,
        statedForProduction: statedForProductionIn(envDir),
        deployProjectId: deployProjectIn(config.root),
      })
      if (problems.length === 0) return

      throw new Error(
        [
          'Refusing to build for production:',
          ...problems.map((problem) => `  - ${problem}`),
          '',
          'Set these in .env.production.local. See .env.example for the full list.',
        ].join('\n'),
      )
    },
  }
}
