import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { defaultAccountSessionPath } from '../src/account-session'

describe('Antigravity Plugin & Visualization Compatibility', () => {
  const rootDir = path.resolve(__dirname, '..')

  describe('plugin.json manifest', () => {
    const pluginJsonPath = path.join(rootDir, 'plugin.json')

    it('exists and is valid JSON', () => {
      expect(fs.existsSync(pluginJsonPath)).toBe(true)
      const content = fs.readFileSync(pluginJsonPath, 'utf8')
      const manifest = JSON.parse(content)
      expect(manifest.name).toBe('garmin-connect')
      expect(typeof manifest.displayName).toBe('string')
      expect(typeof manifest.version).toBe('string')
      expect(typeof manifest.description).toBe('string')
      expect(Array.isArray(manifest.suggestedPrompts)).toBe(true)
      expect(manifest.suggestedPrompts.length).toBeGreaterThan(0)
    })
  })

  describe('mcp_config.json configuration', () => {
    const mcpConfigPath = path.join(rootDir, 'mcp_config.json')

    it('exists and correctly configures the garmin-connect Stdio MCP server', () => {
      expect(fs.existsSync(mcpConfigPath)).toBe(true)
      const content = fs.readFileSync(mcpConfigPath, 'utf8')
      const config = JSON.parse(content)
      expect(config.mcpServers).toBeDefined()
      expect(config.mcpServers['garmin-connect']).toBeDefined()

      const server = config.mcpServers['garmin-connect']
      expect(server.command).toBe('node')
      expect(server.args).toEqual(['${pluginDir}/lib/mcp.js'])
    })

    it('does not contain hardcoded personal credentials or fixed region', () => {
      const content = fs.readFileSync(mcpConfigPath, 'utf8')
      expect(content).not.toContain('@')
      expect(content).not.toContain('liaoyunyu')
      const config = JSON.parse(content)
      const server = config.mcpServers['garmin-connect']
      expect(server.env?.GARMIN_USERNAME).toBeUndefined()
      expect(server.env?.GARMIN_REGION).toBeUndefined()
    })
  })

  describe('package.json metadata and packaging', () => {
    const pkgPath = path.join(rootDir, 'package.json')

    it('includes Antigravity plugin files in files array', () => {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      expect(pkg.files).toContain('plugin.json')
      expect(pkg.files).toContain('mcp_config.json')
      expect(pkg.keywords).toContain('antigravity')
    })

    it('defines expected bin executables with existing build targets', () => {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      expect(pkg.bin).toBeDefined()
      expect(pkg.bin['garmin-connect-mcp']).toBe('lib/mcp.js')
      expect(pkg.bin['garmin-connect-auth']).toBe('lib/auth-cli.js')

      const mcpTarget = path.join(rootDir, pkg.bin['garmin-connect-mcp'])
      const authTarget = path.join(rootDir, pkg.bin['garmin-connect-auth'])
      expect(fs.existsSync(mcpTarget)).toBe(true)
      expect(fs.existsSync(authTarget)).toBe(true)

      const mcpContent = fs.readFileSync(mcpTarget, 'utf8')
      const authContent = fs.readFileSync(authTarget, 'utf8')
      expect(mcpContent.startsWith('#!/usr/bin/env node')).toBe(true)
      expect(authContent.startsWith('#!/usr/bin/env node')).toBe(true)
    })
  })

  describe('native MCP server stdio process connection', () => {
    it('successfully connects via stdio and lists 26 garmin tools with user-configured env', async () => {
      const mcpEntry = path.join(rootDir, 'lib', 'mcp.js')
      const transport = new StdioClientTransport({
        command: 'node',
        args: [mcpEntry],
        env: {
          ...process.env,
          GARMIN_USERNAME: 'antigravity-test@example.com',
          GARMIN_REGION: 'cn',
        },
      })
      const client = new Client({ name: 'antigravity-verifier', version: '1.0.0' })
      await client.connect(transport)
      try {
        const result = await client.listTools()
        expect(result.tools.length).toBe(26)
        const toolNames = result.tools.map(t => t.name)
        expect(toolNames).toContain('get_garmin_profile')
        expect(toolNames).toContain('get_garmin_activities')
        expect(toolNames).toContain('get_garmin_sleep')
      } finally {
        await client.close()
      }
    })
  })

  describe('auth-cli executable parameter verification (no credentials required)', () => {
    const authCliPath = path.join(rootDir, 'lib', 'auth-cli.js')

    it('fails with clear error when serve is invoked without --account', () => {
      const result = spawnSync('node', [authCliPath, 'serve', '--open'], {
        encoding: 'utf8',
      })
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain(
        'Serve account is required; use --account <alias>',
      )
    })

    it('fails with clear error when serve is invoked without --region, ignoring GARMIN_REGION env', () => {
      const result = spawnSync(
        'node',
        [authCliPath, 'serve', '--open', '--account', 'default'],
        {
          encoding: 'utf8',
          env: { ...process.env, GARMIN_REGION: 'cn' },
        },
      )
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain(
        'Serve region is required; use global or cn',
      )
    })

    it('fails with clear error when canary is invoked without --region', () => {
      const result = spawnSync('node', [authCliPath, 'canary'], {
        encoding: 'utf8',
      })
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain(
        'Canary region is required; use global or cn',
      )
    })

    it('fails with clear error when canary is invoked with invalid region', () => {
      const result = spawnSync(
        'node',
        [authCliPath, 'canary', '--region', 'invalid-region'],
        {
          encoding: 'utf8',
        },
      )
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain(
        'Invalid canary region; expected global or cn',
      )
    })
  })

  describe('Antigravity skills and references documentation consistency', () => {
    const skillsDir = path.join(rootDir, 'skills', 'garmin-connect')
    const setupDoc = path.join(skillsDir, 'references', 'antigravity-setup.md')

    it('contains antigravity-setup.md reference document with accurate instructions', () => {
      expect(fs.existsSync(setupDoc)).toBe(true)
      const content = fs.readFileSync(setupDoc, 'utf8')
      expect(content).toContain('Antigravity')
      expect(content).toContain('mcp_config.json')
      expect(content).toContain('garmin-connect-auth')

      // Verify npx arguments specify --package=dsh-plugin-garmin-connect
      expect(content).toContain('--package=dsh-plugin-garmin-connect')
      expect(content).toContain('garmin-connect-mcp')

      // Verify serve examples include --account default and --region
      expect(content).toContain('--account default --region cn --open')
      expect(content).toContain('--account default --region global --open')

      // Verify session default path points to XDG / default.session.json
      expect(content).not.toContain('~/.garmin-connect/session.json')
      expect(content).toContain('.config/dsh-plugin-garmin-connect/accounts/default.session.json')

      // Verify security description does not claim encryption
      expect(content).not.toContain('加密保存')
      expect(content).toContain('未经加密')

      // Verify canary explanation clarifies it is non-persisting probe
      expect(content).toContain('隔离的浏览器端到端登录诊断探针')
      expect(content).toContain('不会读取或保存')
    })

    it('resolves default session token path in accordance with documentation', () => {
      const sessionPath = defaultAccountSessionPath('default', {
        HOME: '/mock/home',
        XDG_CONFIG_HOME: '/mock/home/.config',
      })
      expect(sessionPath).toBe(
        path.resolve(
          '/mock/home/.config/dsh-plugin-garmin-connect/accounts/default.session.json',
        ),
      )
    })

    it('contains visualization-guide.md following Generative UI guidelines', () => {
      const visDoc = path.join(skillsDir, 'references', 'visualization-guide.md')
      expect(fs.existsSync(visDoc)).toBe(true)
      const content = fs.readFileSync(visDoc, 'utf8')
      expect(content).toContain('Generative UI')
      expect(content).toContain('https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js')
      expect(content).toContain('--card')
      expect(content).toContain('--foreground')
    })

    it('links to antigravity and visualization guides in SKILL.md', () => {
      const skillFile = path.join(skillsDir, 'SKILL.md')
      const content = fs.readFileSync(skillFile, 'utf8')
      expect(content).toContain('antigravity-setup.md')
      expect(content).toContain('visualization-guide.md')
    })
  })
})
