import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('maintenance scripts', () => {
  it('keeps weekly workout creation in dry-run mode unless explicitly confirmed', () => {
    const script = path.resolve(__dirname, '../scripts/create-week-workouts.cjs')
    const cwd = mkdtempSync(path.join(tmpdir(), 'garmin-script-test-'))
    let result: ReturnType<typeof spawnSync>
    try {
      result = spawnSync(process.execPath, [script], {
        cwd,
        env: {
          ...process.env,
          GARMIN_USERNAME: '',
          GARMIN_PASSWORD: '',
          GARMIN_SESSION_TOKEN: '',
        },
        encoding: 'utf8',
        timeout: 5_000,
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DRY RUN')
    expect(result.stdout).toContain('--confirm-create')
    expect(result.stderr).toBe('')
  })

  it('keeps MCP stdio stdout protocol-only during early dotenv warnings', () => {
    const entrypoint = path.resolve(__dirname, '../src/mcp.ts')
    const tsxLoader = require.resolve('tsx')
    const cwd = mkdtempSync(path.join(tmpdir(), 'garmin-mcp-test-'))
    let result: ReturnType<typeof spawnSync>
    try {
      result = spawnSync(process.execPath, ['--import', tsxLoader, entrypoint], {
        cwd,
        env: {
          ...process.env,
          GARMIN_USERNAME: 'fixture@example.test',
          GARMIN_PASSWORD: 'fixture-password',
          GARMIN_SESSION_TOKEN: '',
          DOTENV_KEY:
            'dotenv://:MCP_STDIO_SECRET@dotenvx.com/vault/.env.vault?environment=development',
        },
        input: '',
        encoding: 'utf8',
        timeout: 5_000,
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).not.toContain('fixture@example.test')
    expect(result.stderr).not.toContain('fixture-password')
    expect(result.stderr).not.toContain('MCP_STDIO_SECRET')
  })
})
