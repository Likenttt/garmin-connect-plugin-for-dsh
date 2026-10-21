import * as fs from 'fs'
import * as path from 'path'

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
      const config = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'))
      expect(config.mcpServers).toBeDefined()
      expect(config.mcpServers['garmin-connect']).toBeDefined()

      const server = config.mcpServers['garmin-connect']
      expect(server.command).toBe('node')
      expect(server.args).toContain('${pluginDir}/lib/mcp.js')
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
  })

  describe('Antigravity skills and references', () => {
    const skillsDir = path.join(rootDir, 'skills', 'garmin-connect')

    it('contains antigravity-setup.md reference document', () => {
      const setupDoc = path.join(skillsDir, 'references', 'antigravity-setup.md')
      expect(fs.existsSync(setupDoc)).toBe(true)
      const content = fs.readFileSync(setupDoc, 'utf8')
      expect(content).toContain('Antigravity')
      expect(content).toContain('mcp_config.json')
      expect(content).toContain('garmin-connect-auth')
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
