import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Script } from 'node:vm'

interface TestJsxElement {
  props: Record<string, unknown>
  type: unknown
}

interface ClientBundleModule {
  apply(context: unknown): void
}

interface ClientBundleDefinition {
  factory(load: (id: string) => unknown): ClientBundleModule
  id: string
}

function findButtons(value: unknown): TestJsxElement[] {
  if (Array.isArray(value)) return value.flatMap(findButtons)
  if (typeof value !== 'object' || value === null) return []
  const element = value as Partial<TestJsxElement>
  if (typeof element.type === 'function') {
    return findButtons((element.type as (
      props: Record<string, unknown>,
    ) => unknown)(element.props ?? {}))
  }
  return [
    ...(element.type === 'button' ? [element as TestJsxElement] : []),
    ...findButtons(element.props?.children),
  ]
}

function findInputs(value: unknown): TestJsxElement[] {
  if (Array.isArray(value)) return value.flatMap(findInputs)
  if (typeof value !== 'object' || value === null) return []
  const element = value as Partial<TestJsxElement>
  if (typeof element.type === 'function') {
    return findInputs((element.type as (
      props: Record<string, unknown>,
    ) => unknown)(element.props ?? {}))
  }
  return [
    ...(element.type === 'input' ? [element as TestJsxElement] : []),
    ...findInputs(element.props?.children),
  ]
}

function textChildren(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textChildren).join('')
  if (typeof value === 'object' && value !== null) {
    return textChildren((value as TestJsxElement).props?.children)
  }
  return ''
}

describe('maintenance scripts', () => {
  it('publishes a DSH web client with login only in dynamic account settings cards', async () => {
    const projectRoot = path.resolve(__dirname, '..')
    const build = spawnSync(
      process.execPath,
      [path.join(projectRoot, 'scripts/build-client.mjs')],
      { cwd: projectRoot, encoding: 'utf8' },
    )
    expect(build.status).toBe(0)
    expect(build.stderr).toBe('')

    const manifest = JSON.parse(readFileSync(
      path.resolve(__dirname, '../package.json'),
      'utf8',
    )) as {
      exports?: Record<string, string | { types?: string; default?: string }>
      dsh?: { client?: { platform?: string; inject?: string[] } }
      peerDependencies?: Record<string, string>
    }

    expect(manifest.exports?.['./client']).toEqual({
      types: './lib/types/client/index.d.ts',
      default: './lib/dsh-client.js',
    })
    // DSH resolves this subpath while discovering dsh.client declarations.
    expect(manifest.exports?.['./package.json']).toBe('./package.json')
    expect(manifest.dsh?.client).toEqual({
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-client-ui-layout',
      ],
    })
    expect(manifest.peerDependencies).not.toHaveProperty(
      '@deepseek-ai/dsh-client-runtime',
    )

    const bundle = readFileSync(
      path.resolve(__dirname, '../lib/dsh-client.js'),
      'utf8',
    )
    expect(bundle).toContain('require("react/jsx-runtime")')
    expect(bundle).not.toContain('React.createElement')

    let definition: ClientBundleDefinition | undefined
    const timeoutCallbacks: Array<() => void> = []
    const windowListeners = new Map<string, () => void>()
    const clearTimeoutMock = jest.fn()
    const setTimeoutMock = jest.fn((callback: () => void, _delay: number) => {
      timeoutCallbacks.push(callback)
      return timeoutCallbacks.length
    })
    const addEventListener = jest.fn((event: string, callback: () => void) => {
      windowListeners.set(event, callback)
    })
    const removeEventListener = jest.fn((event: string) => {
      windowListeners.delete(event)
    })
    new Script(bundle).runInNewContext({
      AbortController,
      clearTimeout: clearTimeoutMock,
      setTimeout: setTimeoutMock,
      window: {
        __ModuleLoader__: {
          load(value: ClientBundleDefinition) {
            definition = value
          },
        },
        addEventListener,
        removeEventListener,
      },
    })
    expect(definition?.id).toBe('dsh-plugin-garmin-connect')

    const createElement = (
      type: unknown,
      props: Record<string, unknown>,
    ): TestJsxElement => ({ type, props })
    const effects: Array<() => void | (() => void)> = []
    let nextStateOverride: unknown
    const react = {
      useCallback: (callback: unknown) => callback,
      useEffect: (effect: () => void | (() => void)) => effects.push(effect),
      useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => {
        if (nextStateOverride !== undefined) {
          const value = nextStateOverride
          nextStateOverride = undefined
          return [value, () => undefined]
        }
        return [initial, () => undefined]
      },
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    }
    const client = definition!.factory((id) => {
      if (id === 'react') return react
      if (id === 'react/jsx-runtime') {
        return {
          Fragment: Symbol('Fragment'),
          jsx: createElement,
          jsxs: createElement,
        }
      }
      throw new Error(`unexpected client dependency: ${id}`)
    })
    let overlayFactory: (() => TestJsxElement) | undefined
    let settingsFactory: (() => TestJsxElement) | undefined
    const slots = {
      inject: jest.fn((_name: string, install: () => void) => install()),
      register: jest.fn((
        definition: { name: string },
        render: () => TestJsxElement,
      ) => {
        if (definition.name === 'shell.overlay') overlayFactory = render
        if (definition.name === 'plugins.bundle.config') settingsFactory = render
      }),
    }
    const rpcCall = jest.fn().mockResolvedValue({
      ok: true,
      value: { success: false, code: 'configuration' },
    })
    const form = {
      getSnapshot: () => ({
        status: 'ready',
        value: {
          accountsConfigured: true,
          accounts: [
            { id: 'legacy-cn', region: 'cn', alias: '', slot: 1, revision: '1'.repeat(32) },
            { id: 'legacy-global', region: 'global', alias: '', slot: 2 },
          ],
        },
        base: {}, user: {}, revision: 2, writable: true, mode: 'host',
      }),
      subscribe: () => () => undefined,
      mutate: jest.fn().mockResolvedValue(true),
    }
    const connection = { isLoopback: true, rpc: { call: rpcCall } }
    const configForms = {
      get: () => form,
      describe: () => ({ load: async () => undefined }),
    }
    client.apply({
      connection,
      slots,
      inject: (_dependencies: string[], callback: (ctx: unknown) => void) => {
        callback({ connection, slots, configForms })
      },
    })

    expect(slots.inject).toHaveBeenCalledWith(
      'shell.overlay',
      expect.any(Function),
    )
    expect(slots.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'garmin-connect-auth',
        name: 'shell.overlay',
      }),
      expect.any(Function),
    )
    expect(settingsFactory).toBeDefined()
    const overlay = overlayFactory!()
    expect(typeof overlay.type).toBe('function')
    const renderedOverlay = (overlay.type as (
      props: Record<string, unknown>,
    ) => unknown)(overlay.props)
    const cleanups = effects
      .map(effect => effect())
      .filter((cleanup): cleanup is () => void => typeof cleanup === 'function')
    const settings = settingsFactory!()
    const renderedSettings = (settings.type as (
      props: Record<string, unknown>,
    ) => unknown)(settings.props)
    const loginButtons = findButtons(renderedSettings).filter(button => (
      textChildren(button.props.children) === '在 Harness 内登录'
    ))
    expect(findButtons(renderedOverlay)).toEqual([])
    expect(rpcCall).not.toHaveBeenCalled()
    expect(loginButtons).toHaveLength(2)
    expect(loginButtons.every(button => button.props.disabled === true)).toBe(true)

    ;(loginButtons[0].props.onClick as () => void)()
    await new Promise(resolve => setImmediate(resolve))
    expect(rpcCall).toHaveBeenCalledWith(
      '/api',
      'garmin-auth/begin',
      { accountId: 'legacy-cn' },
      expect.any(AbortSignal),
    )

    ;(loginButtons[1].props.onClick as () => void)()
    await new Promise(resolve => setImmediate(resolve))
    expect(rpcCall).toHaveBeenCalledWith(
      '/api',
      'garmin-auth/begin',
      { accountId: 'legacy-global' },
      expect.any(AbortSignal),
    )

    nextStateOverride = [{
      accountId: 'legacy-cn', slot: 1, region: 'cn', configured: true,
      authenticated: false, maskedEmail: 'chu****@88.com',
    }]
    const maskedSettings = (settings.type as (
      props: Record<string, unknown>,
    ) => unknown)(settings.props)
    const emailInputs = findInputs(maskedSettings)
      .filter(input => input.props.inputMode === 'email')
    expect(emailInputs[0].props.value).toBe('chu****@88.com')
    expect(emailInputs[0].props.type).toBe('text')

    cleanups.forEach(cleanup => cleanup())
  })

  it('ships both test-report pages in the published package', () => {
    const manifest = JSON.parse(readFileSync(
      path.resolve(__dirname, '../package.json'),
      'utf8',
    )) as { files?: string[] }

    expect(manifest.files).toEqual(expect.arrayContaining([
      'TEST_REPORT.md',
      'TEST_REPORT.zh-CN.md',
    ]))
  })

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
        timeout: 15_000,
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
