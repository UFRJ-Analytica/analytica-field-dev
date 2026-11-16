/**
 * Ship the polygon tiers the app fetches from its own origin.
 *
 * `regions.ts` points the United States adapter at `data/polygons/us-38017-*.pmtiles` and at
 * `data/polygons/us-38017.manifest.json`, and `polygon-source.ts` fetches the manifest and mounts
 * the tiers with `pmtiles:///data/polygons/...`. Those URLs resolve in development because Vite
 * serves the project root, but `data/` is outside `public/`, so `vite build` alone leaves them out
 * of `dist/` and a deployment would 404 every tier.
 *
 * This copies exactly the three files the running app asks for, after the bundle is written, and
 * fails loudly if one is missing. The class tables are imported by `polygon-class-tables.ts`, so
 * they are already inside the bundle and are not copied.
 */
import { copyFile, mkdir, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const source = join(appRoot, 'data', 'polygons')
const target = join(appRoot, 'dist', 'data', 'polygons')

const FILES = [
  'us-38017-detail.pmtiles',
  'us-38017-overview.pmtiles',
  'us-38017.manifest.json',
]

await mkdir(target, { recursive: true })
for (const file of FILES) {
  const from = join(source, file)
  try {
    await access(from)
  } catch {
    throw new Error(`missing build input ${from}: the United States tiers cannot ship without it`)
  }
  await copyFile(from, join(target, file))
  console.log(`copied ${file} to dist/data/polygons/`)
}
