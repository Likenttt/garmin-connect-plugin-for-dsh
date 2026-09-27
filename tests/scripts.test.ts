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

describe('maintenance scripts', () => {
  it('publishes a DSH web client with explicit China and Global login actions', async () => {
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
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-client-ui-layout',
      ],
    })

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
    const react = {
      useCallback: (callback: unknown) => callback,
      useEffect: (effect: () => void | (() => void)) => effects.push(effect),
      useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => [initial, () => undefined],
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
    let slotFactory: (() => TestJsxElement) | undefined
    const slots = {
      inject: jest.fn((_name: string, install: () => void) => install()),
      register: jest.fn((
        _definition: unknown,
        render: () => TestJsxElement,
      ) => {
        slotFactory = render
      }),
    }
    let completeFirstAccountRequest: ((value: unknown) => void) | undefined
    const rpcCall = jest.fn().mockImplementation((_channel, method) => {
      if (method !== 'garmin-auth/account') {
        return Promise.resolve({
          ok: true,
          value: { success: false, code: 'unavailable' },
        })
      }
      return new Promise(resolve => {
        completeFirstAccountRequest = resolve
      })
    })
    client.apply({
      connection: { isLoopback: true, rpc: { call: rpcCall } },
      slots,
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
    const overlay = slotFactory!()
    expect(typeof overlay.type).toBe('function')
    const rendered = (overlay.type as (
      props: Record<string, unknown>,
    ) => unknown)(overlay.props)
    const cleanups = effects
      .map(effect => effect())
      .filter((cleanup): cleanup is () => void => typeof cleanup === 'function')
    await Promise.resolve()

    expect(rpcCall).toHaveBeenCalledWith(
      '/api',
      'garmin-auth/account',
      {},
      expect.any(AbortSignal),
    )
    const firstAccountSignal = rpcCall.mock.calls[0][3] as AbortSignal

    // A focus event while the first account request is slow must not create a
    // second request or abort the in-flight one.
    windowListeners.get('focus')?.()
    await Promise.resolve()
    expect(rpcCall).toHaveBeenCalledTimes(1)
    expect(firstAccountSignal.aborted).toBe(false)

    completeFirstAccountRequest!({
      ok: true,
      value: { success: false, authenticated: false },
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 1_000)

    rpcCall.mockClear()
    timeoutCallbacks[0]()
    await Promise.resolve()
    expect(rpcCall).toHaveBeenCalledWith(
      '/api',
      'garmin-auth/account',
      {},
      expect.any(AbortSignal),
    )

    const secondAccountSignal = rpcCall.mock.calls[0][3] as AbortSignal
    rpcCall.mockClear()
    windowListeners.get('focus')?.()
    await Promise.resolve()
    expect(rpcCall).not.toHaveBeenCalled()
    expect(secondAccountSignal.aborted).toBe(false)

    const loginButtons = findButtons(rendered).filter(button => (
      typeof button.props['aria-label'] === 'string'
      && button.props['aria-label'].startsWith('登录 Garmin ')
    ))
    expect(loginButtons.map(button => button.props['aria-label'])).toEqual([
      '登录 Garmin 中国区',
      '登录 Garmin 国际区',
    ])

    ;(loginButtons[0].props.onClick as () => void)()
    await Promise.resolve()
    await Promise.resolve()
    await new Promise(resolve => setImmediate(resolve))
    expect(rpcCall).toHaveBeenCalledWith(
      '/api',
      'garmin-auth/begin',
      { region: 'cn' },
      expect.any(AbortSignal),
    )

    ;(loginButtons[1].props.onClick as () => void)()
    await Promise.resolve()
    await Promise.resolve()
    await new Promise(resolve => setImmediate(resolve))
    expect(rpcCall).toHaveBeenLastCalledWith(
      '/api',
      'garmin-auth/begin',
      { region: 'global' },
      expect.any(AbortSignal),
    )

    cleanups.forEach(cleanup => cleanup())
    expect(clearTimeoutMock).toHaveBeenCalled()
    expect(removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function))
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
