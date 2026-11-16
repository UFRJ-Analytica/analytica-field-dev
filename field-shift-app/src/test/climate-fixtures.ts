import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Tests read the dated fixtures the exporter wrote, so every asserted number is real. */
export function climateFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(resolve(__dirname, '../../backend/fixtures/climate', name), 'utf-8')) as T
}
