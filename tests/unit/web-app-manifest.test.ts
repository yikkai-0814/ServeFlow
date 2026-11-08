/**
 * What Chrome needs to install ServeFlow as an app rather than as a shortcut.
 *
 * Without a linked manifest, "Add to Home screen" on Android makes a plain shortcut, and a
 * shortcut always opens in a normal Chrome tab. With one that names the app, starts at `/`,
 * asks for `standalone` and offers a 192 and a 512 icon, Chrome installs it and launches it
 * in its own window. These are static files served as-is by Hosting, so the files themselves
 * are what is asserted here.
 *
 * Deliberately NOT here: a service worker. Current Chrome installs without one, and adding
 * one is an offline-support decision this project has not made — see the last block.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

interface ManifestIcon {
  src: string
  sizes: string
  type: string
  purpose: string
}

interface ManifestScreenshot {
  src: string
  sizes: string
  type: string
  form_factor: string
  label: string
}

const manifest = JSON.parse(read('public/manifest.webmanifest')) as Record<string, unknown> & {
  icons: ManifestIcon[]
  screenshots: ManifestScreenshot[]
}
const html = read('index.html')

/** The ribbon's own colour blend, blue at one end and orange at the other. */
const RIBBON = /stop-color="#1d5ee0"[\s\S]*stop-color="#e9582b"/

/** A PNG's own width and height, from its IHDR chunk — no image library needed for two ints. */
function pngSize(publicPath: string): { width: number; height: number } {
  const bytes = readFileSync(join(root, 'public', publicPath))
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** The IHDR colour type: 2 is plain RGB, 6 is RGB with an alpha channel. */
function pngColourType(publicPath: string): number {
  return readFileSync(join(root, 'public', publicPath))[25]!
}

describe('the manifest', () => {
  it('names the app ServeFlow, in full and on the home screen', () => {
    expect(manifest.name).toBe('ServeFlow')
    expect(manifest.short_name).toBe('ServeFlow')
  })

  it('launches standalone at the root, and keeps every route inside the app', () => {
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.id).toBe('/')
  })

  it('leaves orientation to the device, so a tablet can rotate', () => {
    expect(manifest).not.toHaveProperty('orientation')
  })

  it('carries the colours the page itself declares', () => {
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/)
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/)
    // The status bar should not change colour between the splash and the loaded page.
    expect(html).toContain(`<meta name="theme-color" content="${String(manifest.theme_color)}" />`)
  })

  it.each([
    ['192x192', 'any', 192],
    ['512x512', 'any', 512],
    ['512x512', 'maskable', 512],
  ])('offers a %s %s PNG that exists at that size', (sizes, purpose, pixels) => {
    const icon = manifest.icons.find((each) => each.sizes === sizes && each.purpose === purpose)
    expect(icon?.type).toBe('image/png')
    expect(icon?.src.startsWith('/')).toBe(true)

    // Hosting serves public/ at the root, so an icon's path is its file under public/.
    expect(pngSize(icon!.src.slice(1))).toEqual({ width: pixels, height: pixels })
  })

  it('describes the app in what Chrome shows in full, and says it needs a connection', () => {
    expect(typeof manifest.description).toBe('string')
    const description = String(manifest.description)

    // Chrome truncates an install-dialog description past 300 characters.
    expect(description.length).toBeGreaterThan(0)
    expect(description.length).toBeLessThanOrEqual(300)
    expect(description).toMatch(/internet connection/)
  })
})

/**
 * The install dialog's screenshots: Chrome shows the richer dialog only with at least one for the
 * device's form factor. Desktop shows only "wide" ones and Android ignores them, so each needs
 * its own. They are of the empty sign-in page and nothing else — no order, name or price.
 */
describe('the install screenshots', () => {
  it('offers exactly one wide and one narrow screenshot', () => {
    expect(manifest.screenshots.map((shot) => shot.form_factor).sort()).toEqual(['narrow', 'wide'])
  })

  it.each(['wide', 'narrow'])('the %s one is a PNG that matches its stated size', (factor) => {
    const shot = manifest.screenshots.find((each) => each.form_factor === factor)!
    expect(shot.type).toBe('image/png')
    expect(shot.src).toMatch(/^\/screenshots\/sign-in-[a-z]+\.png$/)
    expect(shot.label.length).toBeGreaterThan(0)

    const { width, height } = pngSize(shot.src.slice(1))
    expect(shot.sizes).toBe(`${width}x${height}`)

    // Chrome's limits: each side 320–3840 px, the long side at most 2.3 times the short one.
    for (const side of [width, height]) {
      expect(side).toBeGreaterThanOrEqual(320)
      expect(side).toBeLessThanOrEqual(3840)
    }
    expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(2.3)

    // Wide is landscape and narrow is portrait, or the form factor is a lie.
    expect(width > height).toBe(factor === 'wide')
  })
})

describe('index.html', () => {
  it('links the manifest from a path Hosting serves as a file, not through the SPA rewrite', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    expect(existsSync(resolve(root, 'public/manifest.webmanifest'))).toBe(true)
  })

  it('gives iOS an existing icon with no transparent corners to fill', () => {
    const link = /<link rel="apple-touch-icon" href="\/([^"]+)" \/>/.exec(html)
    expect(link).not.toBeNull()

    // Reuses the full-bleed maskable icon rather than shipping another file: it is opaque
    // (no alpha channel) and large enough for iOS to scale down.
    const icon = link![1]!
    expect(icon).toBe('icons/icon-maskable-512.png')
    expect(pngSize(icon)).toEqual({ width: 512, height: 512 })
    expect(pngColourType(icon)).toBe(2)
  })

  it('gives the browser tab the ServeFlow ribbon rather than the Vite logo', () => {
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/icons/favicon.svg" />')

    const favicon = read('public/icons/favicon.svg')
    expect(favicon).toMatch(RIBBON)
    expect(favicon).not.toMatch(/<text|<image/)
    expect(existsSync(resolve(root, 'public/favicon.svg'))).toBe(false)
  })
})

/**
 * The logo files, generated from one geometry: the ribbon, blue through teal to orange.
 *
 * Everything is vector and self-contained — no live text, so the wordmark cannot fall back to
 * another typeface on a machine without Geist, and no embedded raster. The reference image the
 * design was drawn from is kept outside `public/`, because everything in there is deployed.
 */
describe('the ServeFlow logo files', () => {
  it('keeps the master logo as the ribbon', () => {
    const logo = read('public/icons/logo.svg')

    expect(logo).toMatch(RIBBON)
    expect(logo).not.toMatch(/<text|<image/)
  })

  it('draws the wordmark as outlines beside the same ribbon', () => {
    const wordmark = read('public/icons/wordmark.svg')

    expect(wordmark).toMatch(RIBBON)
    // "Serve" and "Flow" are shapes, in the logo's text colour — not text in a font.
    expect(wordmark).not.toMatch(/<text|<image|font-family/)
    expect(wordmark.match(/fill="#334155"/g)).toHaveLength(2)
    expect(wordmark).toContain('<title>ServeFlow</title>')
  })

  it('does not ship the reference image with the app', () => {
    const shipped = readdirSync(resolve(root, 'public'), { recursive: true }).map(String)

    expect(shipped.filter((name) => /\.(jpe?g)$/i.test(name))).toEqual([])
  })
})

/**
 * No service worker, and so no offline mode.
 *
 * A caching worker would keep serving an old build after a deploy, and taking orders offline
 * needs Firestore's persistent cache first or they are lost when the app closes. Neither is
 * wanted yet; this fails loudly if a worker arrives without that decision being made.
 */
describe('offline support, deliberately absent', () => {
  it('registers no service worker anywhere in the app', () => {
    const sources: string[] = []
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(entry.name)) sources.push(readFileSync(path, 'utf8'))
      }
    }
    walk(resolve(root, 'src'))

    expect(sources.some((source) => source.includes('serviceWorker'))).toBe(false)
    expect(html).not.toContain('serviceWorker')
  })

  it('ships no worker script', () => {
    const files = readdirSync(resolve(root, 'public'))
    expect(files.filter((name) => /(^sw|worker)\.js$/i.test(name))).toEqual([])
  })
})
