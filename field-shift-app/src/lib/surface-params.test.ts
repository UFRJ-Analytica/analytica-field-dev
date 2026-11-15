import { describe, expect, it } from 'vitest'
import { searchWithSurface, searchWithoutSurface, surfaceOpenFromSearch } from './surface-params'

describe('R-01 and R-06, the two surface parameters (AC-01, AC-05)', () => {
  it('opens a surface and writes only its own key', () => {
    expect(searchWithSurface('?region=br&date=2026-11-12', 'decision')).toBe('?region=br&date=2026-11-12&decision=1')
    expect(searchWithSurface('', 'record')).toBe('?record=1')
  })

  it('removes the other surface and numbers when one opens', () => {
    expect(searchWithSurface('?record=1&date=2026-11-12', 'decision')).toBe('?date=2026-11-12&decision=1')
    expect(searchWithSurface('?decision=1&region=br', 'record')).toBe('?region=br&record=1')
    expect(searchWithSurface('?numbers=1&date=2026-11-12', 'decision')).toBe('?date=2026-11-12&decision=1')
  })

  it('closes a surface by removing only its own key', () => {
    expect(searchWithoutSurface('?decision=1&region=br&date=2026-11-12', 'decision')).toBe('?region=br&date=2026-11-12')
    expect(searchWithoutSurface('?record=1&polygon=trazo:12345', 'record')).toBe('?polygon=trazo%3A12345')
  })

  it('reads only the value 1 as open', () => {
    expect(surfaceOpenFromSearch('?decision=1', 'decision')).toBe(true)
    expect(surfaceOpenFromSearch('?decision=0', 'decision')).toBe(false)
    expect(surfaceOpenFromSearch('', 'record')).toBe(false)
  })
})
