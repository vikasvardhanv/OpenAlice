import { describe, it, expect } from 'vitest'
import { buildDefaultOrigins, loadConfig } from './config.js'

describe('buildDefaultOrigins', () => {
  it('derives backend origin entries from webPort', () => {
    expect(buildDefaultOrigins(4444)).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:4444',
      'http://127.0.0.1:4444',
    ])
  })

  it('keeps the contributor-dev 5173 entries even when webPort changes', () => {
    // 5173 is the structural contributor-dev convention (Vite default),
    // not derived from webPort. It stays put no matter what backend port
    // is used.
    const a = buildDefaultOrigins(3002)
    const b = buildDefaultOrigins(47331)
    expect(a).toContain('http://localhost:5173')
    expect(b).toContain('http://localhost:5173')
  })
})

describe('loadConfig (workspaces)', () => {
  it('uses buildDefaultOrigins(webPort) when WEB_TERMINAL_ALLOWED_ORIGINS unset', () => {
    const cfg = loadConfig({ webPort: 47331, env: {} })
    expect(cfg.allowedOrigins.has('http://localhost:5173')).toBe(true)
    expect(cfg.allowedOrigins.has('http://127.0.0.1:47331')).toBe(true)
    expect(cfg.allowAnyOrigin).toBe(false)
  })

  it('respects WEB_TERMINAL_ALLOWED_ORIGINS env override', () => {
    const cfg = loadConfig({
      webPort: 4444,
      env: { WEB_TERMINAL_ALLOWED_ORIGINS: 'https://app.openalice.io,http://localhost:9000' },
    })
    expect(cfg.allowedOrigins.has('https://app.openalice.io')).toBe(true)
    expect(cfg.allowedOrigins.has('http://localhost:9000')).toBe(true)
    // Derived defaults are NOT included when env override is set
    expect(cfg.allowedOrigins.has('http://localhost:4444')).toBe(false)
  })

  it('supports * wildcard in env override', () => {
    const cfg = loadConfig({
      webPort: 4444,
      env: { WEB_TERMINAL_ALLOWED_ORIGINS: '*' },
    })
    expect(cfg.allowAnyOrigin).toBe(true)
  })
})
