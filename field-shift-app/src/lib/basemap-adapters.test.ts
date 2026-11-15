import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeBasemapAdapter,
  BASEMAP_ADAPTERS,
  DEFAULT_BASEMAP_ADAPTER,
  EOX_ATTRIBUTION_TEXT,
  EOX_SHORT_CREDIT,
  EOX_TILES,
  GOOGLE_SESSION_URL,
  GOOGLE_TILES,
  googleMapsApiKey,
} from './basemap-adapters'

/**
 * AC-34 asks for two things: with `VITE_GOOGLE_MAPS_API_KEY` absent the registry selects the
 * EOX adapter, and the test run records zero requests to a Google host. This file does both
 * and writes the network log the criterion names as its artifact:
 * `artifacts/AC-34-network.txt`.
 */
const requests: string[] = []

function recordTransport() {
  requests.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    requests.push(String(input))
    throw new Error('The basemap registry issues no request')
  }))
}

const GOOGLE_HOST = /(^|\.)googleapis\.com$|(^|\.)google\.com$/i

/** Every non-test module under `src`, so the scan below covers the whole app surface. */
function sourceFiles(): string[] {
  return readdirSync(resolve(process.cwd(), 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.'))
    .map((entry) => relative(process.cwd(), resolve(entry.parentPath, entry.name)))
}

/** The modules of the app that name a Google host at all. */
function googleHostSources(): string[] {
  return sourceFiles().filter((file) => /googleapis\.com|google\.com/i.test(readFileSync(resolve(process.cwd(), file), 'utf8')))
}

function googleRequestsOf(list: readonly string[]): string[] {
  return list.filter((url) => {
    try {
      return GOOGLE_HOST.test(new URL(url).hostname)
    } catch {
      return false
    }
  })
}

beforeEach(() => recordTransport())

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('R-43 the basemap adapter boundary (AC-34)', () => {
  it('selects the EOX Sentinel-2 cloudless 2024 adapter when no Google key is present', async () => {
    const { activeBasemapAdapter: active } = await import('./basemap-adapters')
    for (const environment of [{}, { VITE_GOOGLE_MAPS_API_KEY: undefined }, { VITE_GOOGLE_MAPS_API_KEY: '' }, { VITE_GOOGLE_MAPS_API_KEY: '   ' }]) {
      expect(active(environment).id).toBe('eox-s2cloudless-2024')
    }
    expect(DEFAULT_BASEMAP_ADAPTER.id).toBe('eox-s2cloudless-2024')
    expect(googleMapsApiKey({})).toBeNull()
    // Importing and selecting issued nothing at all.
    expect(requests).toEqual([])
  })

  it('holds the two adapters with the fields, the URL templates and the licence of Table E', () => {
    expect(BASEMAP_ADAPTERS.map((adapter) => adapter.id)).toEqual(['eox-s2cloudless-2024', 'google-satellite'])

    const eox = BASEMAP_ADAPTERS[0]
    expect(eox.tiles).toBe('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg')
    expect(eox.tiles).toBe(EOX_TILES)
    expect(eox.tileSize).toBe(256)
    expect(eox.minzoom).toBe(5)
    expect(eox.maxzoom).toBe(14)
    expect(eox.requiresKey).toBe(false)
    expect(eox.cache).toBe('allowed')
    expect(eox.sessionUrl).toBeNull()
    expect(eox.licence).toBe('CC BY-NC-SA 4.0 for 2018 to 2025')

    const google = BASEMAP_ADAPTERS[1]
    expect(google.tiles).toBe('https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session={session}&key={key}')
    expect(google.tiles).toBe(GOOGLE_TILES)
    expect(google.sessionUrl).toBe('https://tile.googleapis.com/v1/createSession?key={key}')
    expect(google.sessionUrl).toBe(GOOGLE_SESSION_URL)
    expect(google.tileSize).toBe(256)
    expect(google.minzoom).toBe(0)
    expect(google.maxzoom).toBe(18)
    expect(google.requiresKey).toBe(true)
    expect(google.cache).toBe('forbidden')
    expect(google.licence).toBe('Google Maps Platform terms, billing required')
  })

  it('carries the Table F attribution and the two EOX links by character', () => {
    const eox = DEFAULT_BASEMAP_ADAPTER
    expect(eox.attributionText).toBe(
      'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)',
    )
    expect(eox.attributionText).toBe(EOX_ATTRIBUTION_TEXT)
    expect(eox.attributionText).toHaveLength(111)
    expect(eox.shortCredit).toBe('EOxCloudless by EOX IT Services GmbH, CC BY-NC-SA 4.0')
    expect(eox.shortCredit).toBe(EOX_SHORT_CREDIT)
    expect(eox.shortCredit).toHaveLength(53)
    // The licence page links the product and the vendor, and the adapter carries both.
    expect(eox.attribution.map((entry) => entry.url)).toEqual(['https://cloudless.eox.at', 'https://eox.at'])
  })

  it('keeps the Google adapter specified but not selectable without the key', async () => {
    const { activeBasemapAdapter: active } = await import('./basemap-adapters')
    const google = BASEMAP_ADAPTERS[1]
    expect(google.selectable({})).toBe(false)
    expect(google.selectable({ VITE_GOOGLE_MAPS_API_KEY: '' })).toBe(false)
    expect(active({}).id).toBe('eox-s2cloudless-2024')
    // With a key the adapter becomes selectable, which is the only thing the key does here:
    // block 4 renders no basemap (R-43), so still no request leaves this module.
    expect(google.selectable({ VITE_GOOGLE_MAPS_API_KEY: 'test-key' })).toBe(true)
    expect(active({ VITE_GOOGLE_MAPS_API_KEY: 'test-key' }).id).toBe('google-satellite')
    expect(requests).toEqual([])
  })

  it('reads the key from VITE_GOOGLE_MAPS_API_KEY alone and from no other name', async () => {
    const { activeBasemapAdapter: active } = await import('./basemap-adapters')
    const otherNames = {
      GOOGLE_MAPS_API_KEY: 'a',
      VITE_GOOGLE_KEY: 'b',
      VITE_GMAPS_API_KEY: 'c',
      googleMapsApiKey: 'd',
      VITE_GOOGLE_MAPS_API_KEY_EXTRA: 'e',
    }
    expect(active(otherNames).id).toBe('eox-s2cloudless-2024')
    expect(active({ ...otherNames, VITE_GOOGLE_MAPS_API_KEY: 'f' }).id).toBe('google-satellite')
  })

  it('keeps every Google host in the adapter module, and the map surface is the only reader', () => {
    // Block 5 R-30 renders the basemap, so the map surface (MapCanvas), the store's one
    // `basemapId` value and the App's `?basemap=` read of the registry are the only readers of
    // this module. No component names a Google host, and no other module imports the registry.
    expect(googleHostSources()).toEqual(['src/lib/basemap-adapters.ts'])
    const importers = sourceFiles().filter((file) => file !== 'src/lib/basemap-adapters.ts'
      && !file.includes('.test.')
      && /from '.*basemap-adapters'/.test(readFileSync(resolve(process.cwd(), file), 'utf8')))
    // Block 5.5 W7: the boundary editor no longer mounts a map of its own, so it no longer reads
    // the registry. Three readers, and still no component that names a host.
    expect(importers.sort()).toEqual([
      'src/App.tsx',
      'src/components/MapCanvas.tsx',
      'src/lib/map-store.ts',
    ])
  })

  it('records zero requests to a Google host in the test run, and writes the network log', () => {
    // The registry is read for every adapter, which is the whole surface this block adds.
    const active = activeBasemapAdapter({})
    const seen = BASEMAP_ADAPTERS.flatMap((adapter) => [adapter.tiles, adapter.sessionUrl ?? ''])

    expect(googleRequestsOf(requests)).toEqual([])
    expect(googleRequestsOf(seen)).toEqual([
      'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session={session}&key={key}',
      'https://tile.googleapis.com/v1/createSession?key={key}',
    ])
    expect(active.id).toBe('eox-s2cloudless-2024')

    const log = [
      '# AC-34 network log of the test run',
      '# recorded: 2026-11-14',
      '# command: npx vitest run src/lib/basemap-adapters.test.ts',
      'VITE_GOOGLE_MAPS_API_KEY: absent',
      `active adapter: ${active.id}`,
      `active tiles: ${active.tiles}`,
      `attribution (111 characters): ${active.attributionText}`,
      `licence: ${active.licence}`,
      `requests issued by the basemap registry: ${requests.length}`,
      `requests to a Google host: ${googleRequestsOf(requests).length}`,
      `modules under src/ that name a Google host: ${googleHostSources().join(', ')}`,
      '# the two Google URL templates exist in the registry as specified and are never requested:',
      '#   https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session={session}&key={key}',
      '#   https://tile.googleapis.com/v1/createSession?key={key}',
      '',
    ].join('\n')
    writeFileSync(resolve(process.cwd(), 'artifacts/AC-34-network.txt'), log)
    expect(googleRequestsOf(requests).length).toBe(0)
  })
})
