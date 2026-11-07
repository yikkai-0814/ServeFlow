import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

interface HeaderRule {
  source: string
  headers: { key: string; value: string }[]
}

const config = JSON.parse(readFileSync(resolve(process.cwd(), 'firebase.json'), 'utf8')) as {
  hosting: {
    public: string
    headers: HeaderRule[]
    rewrites: { source: string; destination: string }[]
  }
}

const cacheControlOf = (rule: HeaderRule | undefined) =>
  rule?.headers.find((header) => header.key === 'Cache-Control')?.value

/**
 * A till that keeps an old index.html keeps asking for the old bundle after a deploy. The rule
 * has to reach every route, not only the path `/index.html`: Hosting matches headers against the
 * request path, before rewrites, and the app is loaded at `/`, `/pos`, `/orders/...`.
 *
 * **The order is the whole mechanism.** Firebase applies matching rules in the order they are
 * defined, so `/assets/**` has to come after `**` to have the last word. The other way round,
 * every asset loses its long cache and nothing fails.
 */
describe('Hosting cache headers', () => {
  const [everything, assets, ...others] = config.hosting.headers

  it('asks the browser to revalidate everything first', () => {
    expect(everything?.source).toBe('**')
    expect(cacheControlOf(everything)).toBe('no-cache')
  })

  it('then keeps hashed assets cached for a year, having the last word', () => {
    expect(assets?.source).toBe('/assets/**')
    expect(cacheControlOf(assets)).toBe('public, max-age=31536000, immutable')
  })

  it('has no other rule that could disturb them', () => {
    expect(others).toEqual([])
  })

  it('leaves the rewrite and the public directory as they were', () => {
    expect(config.hosting.rewrites).toEqual([{ source: '**', destination: '/index.html' }])
    expect(config.hosting.public).toBe('dist')
  })
})
