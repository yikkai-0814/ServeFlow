import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadEnv, type ResolvedConfig } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  namesAssignedIn,
  productionEnvGuard,
  productionEnvProblems,
} from '../../scripts/production-env-guard'

const PROJECT = 'real-project'

const COMPLETE = {
  VITE_FIREBASE_API_KEY: 'key-value',
  VITE_FIREBASE_AUTH_DOMAIN: `${PROJECT}.firebaseapp.com`,
  VITE_FIREBASE_PROJECT_ID: PROJECT,
  VITE_FIREBASE_STORAGE_BUCKET: `${PROJECT}.firebasestorage.app`,
  VITE_FIREBASE_MESSAGING_SENDER_ID: '123',
  VITE_FIREBASE_APP_ID: '1:123:web:abc',
  VITE_USE_EMULATORS: 'false',
}

const asFile = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

function problemsWith(env: Record<string, string | undefined>, stated = Object.keys(COMPLETE)) {
  return productionEnvProblems({
    env,
    statedForProduction: new Set(stated),
    deployProjectId: PROJECT,
  })
}

describe('productionEnvProblems', () => {
  it('passes a complete production configuration', () => {
    expect(problemsWith(COMPLETE)).toEqual([])
  })

  it('refuses the emulators', () => {
    expect(problemsWith({ ...COMPLETE, VITE_USE_EMULATORS: 'true' }).join()).toContain(
      'connect to the emulators',
    )
  })

  it('refuses a demo project, and the mismatch with what firebase deploy targets', () => {
    const problems = problemsWith({ ...COMPLETE, VITE_FIREBASE_PROJECT_ID: 'demo-serveflow' })
    expect(problems.join()).toContain('VITE_FIREBASE_PROJECT_ID holds a development value')
    expect(problems.join()).toContain('does not match the default project')
  })

  it('refuses a real project that is not the one being deployed to', () => {
    expect(problemsWith({ ...COMPLETE, VITE_FIREBASE_PROJECT_ID: 'other' }).join()).toContain(
      'does not match the default project',
    )
  })

  it.each(['localhost:9099', 'http://127.0.0.1:8080'])('refuses a local address: %s', (value) => {
    expect(problemsWith({ ...COMPLETE, VITE_FIREBASE_AUTH_DOMAIN: value }).join()).toContain(
      'VITE_FIREBASE_AUTH_DOMAIN holds a development value',
    )
  })

  it('refuses a variable that is empty', () => {
    expect(problemsWith({ ...COMPLETE, VITE_FIREBASE_API_KEY: ' ' }).join()).toContain(
      'VITE_FIREBASE_API_KEY is empty',
    )
  })

  it('refuses a value that only arrived from a development file', () => {
    const stated = Object.keys(COMPLETE).filter((key) => key !== 'VITE_FIREBASE_APP_ID')
    expect(problemsWith(COMPLETE, stated).join()).toContain(
      'VITE_FIREBASE_APP_ID is not set for production',
    )
  })

  it('names variables and never prints what they hold', () => {
    const secret = 'do-not-print-this-demo-value'
    const problems = problemsWith({ ...COMPLETE, VITE_FIREBASE_API_KEY: secret }, [])
    expect(problems.join()).not.toContain(secret)
    expect(problems.join()).toContain('VITE_FIREBASE_API_KEY')
  })
})

describe('namesAssignedIn', () => {
  it('reads names however the line is written, skipping comments', () => {
    const text = [
      '# VITE_COMMENTED=1',
      'VITE_PLAIN=1',
      'VITE_SPACED = 2',
      'VITE_QUOTED= "three"',
      'export VITE_EXPORTED=4',
      'OTHER=5',
    ].join('\r\n')
    expect(namesAssignedIn(text)).toEqual([
      'VITE_PLAIN',
      'VITE_SPACED',
      'VITE_QUOTED',
      'VITE_EXPORTED',
    ])
  })
})

/**
 * The guard against real files, merged by Vite's own loader. This is the audit's scenario: every
 * test here has a `.env.local` turning the emulators on, as a development machine does.
 */
describe('a production build on a machine set up for development', () => {
  const dirs: string[] = []
  /** vitest.config.ts sets VITE_ variables, and a build's own environment outranks its files. */
  const inherited = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const name of Object.keys(process.env).filter((key) => key.startsWith('VITE_'))) {
      inherited.set(name, process.env[name])
      delete process.env[name]
    }
  })

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    for (const [name, value] of inherited) process.env[name] = value
    inherited.clear()
  })

  const DEVELOPMENT = {
    ...COMPLETE,
    VITE_FIREBASE_PROJECT_ID: 'demo-x',
    VITE_USE_EMULATORS: 'true',
  }

  function runGuard(production: Record<string, string> | null, mode = 'production') {
    const root = mkdtempSync(join(tmpdir(), 'serveflow-guard-'))
    dirs.push(root)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '.env.local'), asFile(DEVELOPMENT))
    writeFileSync(join(root, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT } }))
    if (production) writeFileSync(join(root, '.env.production.local'), asFile(production))

    const config = { mode, root, envDir: root, env: loadEnv(mode, root, 'VITE_') }
    const hook = productionEnvGuard().configResolved as (config: ResolvedConfig) => void
    return () => hook(config as unknown as ResolvedConfig)
  }

  it('builds when production states everything', () => {
    expect(runGuard(COMPLETE)).not.toThrow()
  })

  it('fails when the production file loses its emulator flag and inherits true', () => {
    const { VITE_USE_EMULATORS: _removed, ...withoutFlag } = COMPLETE
    expect(runGuard(withoutFlag)).toThrow(/VITE_USE_EMULATORS is true/)
  })

  it('fails when there is no production file at all', () => {
    expect(runGuard(null)).toThrow(/Refusing to build for production/)
  })

  it('fails when a production value is merely inherited, even a harmless-looking one', () => {
    const { VITE_FIREBASE_API_KEY: _removed, ...withoutKey } = COMPLETE
    expect(runGuard(withoutKey)).toThrow(/VITE_FIREBASE_API_KEY is not set for production/)
  })

  it('leaves other build modes alone', () => {
    expect(runGuard(null, 'development')).not.toThrow()
  })

  it('is only ever part of a build', () => {
    expect(productionEnvGuard().apply).toBe('build')
  })
})
