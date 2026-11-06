import { readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'
import type { WindowsPrivateAcl } from '../src/windows-private-acl'
import type { WorkspaceDescriptor, WorkspaceLease } from '../src/workspace-runtime'

const roots: string[] = []
const leases: WorkspaceLease[] = []
const nativePlatform = process.platform
const fileIdentity = (info: { dev: number; ino: number }) => `${info.dev}:${info.ino}`

/** Model protected DACLs by inode, so atomic file rename preserves protection. */
function windowsAcl(options: { failDirectory?(path: string): boolean; failFile?(path: string): boolean } = {}) {
  const directories = new Set<string>()
  const files = new Set<string>()
  let pending: Promise<unknown> = Promise.resolve()
  const atomic = <T>(action: () => Promise<T>): Promise<T> => {
    const request = pending.then(action, action)
    pending = request.catch(() => undefined)
    return request
  }
  const acl = {
    prepareDirectory: jest.fn((path: string) => atomic(async () => {
      let info
      try { info = await lstat(path) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await mkdir(path, { recursive: true, mode: 0o700 })
        info = await lstat(path)
        directories.add(fileIdentity(info))
      }
      if (!info.isDirectory() || info.isSymbolicLink() || !directories.has(fileIdentity(info))) {
        throw new Error('Existing directory has inherited, unprotected Windows ACLs')
      }
    })),
    secureDirectory: jest.fn((path: string) => atomic(async () => {
      if (options.failDirectory?.(path)) throw new Error('Directory ACL preparation failed')
      const parent = await lstat(dirname(path)), target = await lstat(path)
      if (!directories.has(fileIdentity(parent)) || !target.isDirectory() || target.isSymbolicLink()
        || target.uid !== parent.uid || (await readdir(path)).length) throw new Error('New empty owned directory required')
      directories.add(fileIdentity(target))
    })),
    secureFile: jest.fn((path: string) => atomic(async () => {
      if (options.failFile?.(path)) throw new Error('File ACL preparation failed')
      const parent = await lstat(dirname(path)), file = await lstat(path)
      if (!directories.has(fileIdentity(parent)) || !file.isFile() || file.isSymbolicLink()) throw new Error('Private file parent required')
      files.add(fileIdentity(file))
    })),
    verifyFile: jest.fn((path: string) => atomic(async () => {
      if (!files.has(fileIdentity(await lstat(path)))) throw new Error('File ACL is not protected')
    })),
  } satisfies WindowsPrivateAcl
  return acl
}

/** Override process only for this module; the real Node filesystem stays native. */
function loadWindowsRuntime(acl: WindowsPrivateAcl): typeof import('../src/workspace-runtime') {
  const filename = resolve(__dirname, '../src/workspace-runtime.ts')
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const module = { exports: {} }
  const facade = Object.create(process) as NodeJS.Process
  Object.defineProperty(facade, 'platform', { value: 'win32' })
  const localRequire = (specifier: string) => specifier === './windows-private-acl'
    ? { createWindowsPrivateAcl: async () => acl }
    : require(specifier.startsWith('.') ? resolve(dirname(filename), specifier) : specifier)
  const execute = runInThisContext(`(function(exports, require, module, __filename, __dirname, process) {\n${output}\n})`, { filename })
  execute(module.exports, localRequire, module, filename, dirname(filename), facade)
  return module.exports as typeof import('../src/workspace-runtime')
}

async function fixture(options: Parameters<typeof windowsAcl>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'garmin-windows-runtime-test-'))
  roots.push(root)
  const descriptor: WorkspaceDescriptor = { scopeId: 'synthetic-windows-workspace', dataDirectory: join(root, 'private') }
  const acl = windowsAcl(options)
  const runtime = loadWindowsRuntime(acl)
  return { descriptor, acl, runtime,
    lock: join(descriptor.dataDirectory, `runtime-${runtime.workspaceDigest(descriptor.scopeId)}.lock`),
    reclaim: join(descriptor.dataDirectory, `runtime-${runtime.workspaceDigest(descriptor.scopeId)}.reclaim`),
  }
}
async function acquire(f: Awaited<ReturnType<typeof fixture>>) {
  const owner = await f.runtime.acquireWorkspaceLease(f.descriptor)
  expect(owner).toBeDefined()
  leases.push(owner!)
  return owner!
}
afterEach(async () => {
  expect(process.platform).toBe(nativePlatform)
  for (const lease of leases.splice(0)) await lease.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('secures the exclusive new Windows lock before verifying its private ACL', async () => {
  const f = await fixture()
  const owner = await acquire(f)
  expect(f.acl.secureDirectory).toHaveBeenCalledWith(f.lock)
  await owner.publish({ origin: 'http://127.0.0.1:8811', accessToken: 'a'.repeat(48) })
  expect(await f.runtime.readWorkspaceEndpoint(f.descriptor)).toMatchObject({ instanceId: owner.instanceId, pid: process.pid })
})

it('secures its reclaim gate without rewriting the existing live owner directory', async () => {
  const f = await fixture()
  const owner = await acquire(f)
  await expect(f.runtime.acquireWorkspaceLease(f.descriptor)).resolves.toBeUndefined()
  expect(f.acl.secureDirectory.mock.calls.filter(([path]) => path === f.lock)).toHaveLength(1)
  expect(f.acl.secureDirectory).toHaveBeenCalledWith(f.reclaim)
  expect((await readdir(f.descriptor.dataDirectory)).some(name => name.endsWith('.reclaim'))).toBe(false)
  expect(JSON.parse(await readFile(join(f.lock, 'owner.json'), 'utf8')).instanceId).toBe(owner.instanceId)
})

it('keeps two concurrent Windows contenders to one owner', async () => {
  const f = await fixture()
  const result = await Promise.all([f.runtime.acquireWorkspaceLease(f.descriptor), f.runtime.acquireWorkspaceLease(f.descriptor)])
  const owners = result.filter((value): value is WorkspaceLease => value !== undefined)
  leases.push(...owners)
  expect(owners).toHaveLength(1)
  expect(f.acl.secureDirectory.mock.calls.filter(([path]) => path === f.lock)).toHaveLength(1)
})

it('does not secure or remove a foreign existing lock', async () => {
  const f = await fixture()
  await f.runtime.registerWorkspace(f.descriptor)
  await mkdir(f.lock)
  await writeFile(join(f.lock, 'foreign-owner-marker'), 'keep')
  await expect(f.runtime.acquireWorkspaceLease(f.descriptor)).resolves.toBeUndefined()
  expect(f.acl.secureDirectory).not.toHaveBeenCalledWith(f.lock)
  expect(await readFile(join(f.lock, 'foreign-owner-marker'), 'utf8')).toBe('keep')
})

it('removes its newly created empty gate when directory ACL setup fails', async () => {
  const f = await fixture({ failDirectory: path => path.endsWith('.reclaim') })
  await acquire(f)
  await expect(f.runtime.acquireWorkspaceLease(f.descriptor)).resolves.toBeUndefined()
  await expect(lstat(f.reclaim)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readdir(f.lock))).toEqual(['owner.json'])
})

it('cleans its temporary JSON file and gate when securing the gate owner file fails', async () => {
  const f = await fixture({ failFile: path => path.includes('.reclaim') })
  await acquire(f)
  await expect(f.runtime.acquireWorkspaceLease(f.descriptor)).resolves.toBeUndefined()
  await expect(lstat(f.reclaim)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readdir(f.descriptor.dataDirectory)).some(name => name.includes('.reclaim'))).toBe(false)
  expect((await readdir(f.lock))).toEqual(['owner.json'])
})

it('removes a failed new lock without leaving an unowned startup barrier', async () => {
  const f = await fixture({ failFile: path => path.includes('.lock') })
  await expect(f.runtime.acquireWorkspaceLease(f.descriptor)).rejects.toThrow('File ACL preparation failed')
  await expect(lstat(f.lock)).rejects.toMatchObject({ code: 'ENOENT' })
})
