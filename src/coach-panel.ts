import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'
import { defaultAccountSessionPath } from './account-session'
import type { Config, GarminRegion } from './config'
import type { GarminClientLike } from './client'
import { AccountRegistryError, type AccountSource, type MutableAccountRegistry, type RegistryAccountInput } from './account-registry'
import { GarminAuthenticationRequiredError, PublicToolError } from './utils/errors'
import { CoachStorageError, SqliteCoachStore, type CoachPersistence, type CoachNoteInput } from './coach-store'
import { garminAvatarUrl, downloadGarminAvatar } from './account-avatar'

const ENDPOINTS = ['members', 'check', 'timeline', 'notes', 'save-note', 'delete-note',
  'preferences', 'save-preferences', 'save-account', 'remove-account'] as const
type Endpoint = typeof ENDPOINTS[number]
const PREFIX = '/api/garmin-coach'
const ID = /^[a-z][a-z0-9_-]{0,31}$/
type CoachClient = Pick<GarminClientLike, 'getUserProfile' | 'getActivities'
  | 'getAuthenticatedAccount' | 'getAuthenticationRequirement'>
  & Partial<Pick<GarminClientLike, 'getScheduledWorkouts'>>
  & { verifyConnection?: () => Promise<unknown> }

export interface CoachPanelAccount {
  accountId: string
  region: GarminRegion
  alias?: string
  revision?: string
  configured: boolean
  config: Config
  client: CoachClient
}

export interface CoachMember {
  accountId: string
  alias: string
  region: GarminRegion
  provider: 'connect-web' | 'personal'
  configured: boolean
  status: 'unknown' | 'checking' | 'valid' | 'auth_required' | 'unavailable'
  lastCheckedAt?: string
  lastVerifiedAt?: string
  revision?: string
  avatarUrl?: string
}

export interface CoachPanelOptions {
  scopeId?: string
  dataDirectory?: string
  store?: CoachPersistence
  now?: () => Date
}

export type CoachResult = { success: true; [key: string]: unknown }
  | { success: false; code: 'invalid' | 'unavailable' | 'storage_unavailable' | 'conflict' | 'account_not_found' | 'stale_config'; message?: string }

/** Business API shared by native tabs; never returns account credentials or raw SDK data. */
export class CoachPanelService {
  private readonly accounts: Map<string, CoachPanelAccount>
  private readonly source?: AccountSource
  private readonly unsubscribe?: () => void
  private readonly states = new Map<string, CoachMember>()
  private readonly checking = new Map<string, Promise<CoachMember>>()
  private readonly avatars = new Map<string, { account: CoachPanelAccount; source: string; data: string; expiresAt: number }>()
  private avatarBytes = 0
  private readonly store: CoachPersistence
  private readonly now: () => Date
  private closed = false

  constructor(accounts: readonly CoachPanelAccount[] | AccountSource, options: CoachPanelOptions = {}) {
    this.source = 'list' in accounts ? accounts : undefined
    this.accounts = new Map()
    this.now = options.now ?? (() => new Date())
    const unavailable = () => Promise.reject(new CoachStorageError('storage_unavailable'))
    this.store = options.store ?? (options.scopeId
      ? new SqliteCoachStore(options.dataDirectory
        ?? join(dirname(dirname(defaultAccountSessionPath('default'))), 'coach-workspace'), options.scopeId, this.now)
      : { notes: unavailable, save: unavailable, remove: unavailable,
        preferences: unavailable, setPreferences: unavailable, close() {} })
    this.syncAccounts(this.source ? this.source.list() : accounts as readonly CoachPanelAccount[])
    this.unsubscribe = this.source?.subscribe(() => this.syncAccounts(this.source!.list()))
  }

  private syncAccounts(values: readonly CoachPanelAccount[]): void {
    if (this.closed) return
    const next = new Map(values.filter(a => ID.test(a.accountId)).map(a => [a.accountId, a]))
    for (const [id] of this.accounts) {
      if (!next.has(id)) { this.states.delete(id); this.checking.delete(id); this.dropAvatar(id) }
    }
    for (const [index, account] of [...next.values()].entries()) {
      const previous = this.accounts.get(account.accountId)
      const state = previous?.client === account.client && previous.revision === account.revision
        ? this.states.get(account.accountId) : undefined
      if (!state) this.dropAvatar(account.accountId)
      if (!state) this.checking.delete(account.accountId)
      const nextState: CoachMember = {
        accountId: account.accountId,
        alias: safeText(account.alias, 64) || `${account.region === 'cn' ? '大陆' : '国际'}账号 ${index + 1}`,
        region: account.region,
        provider: account.config.provider === 'personal' ? 'personal' : 'connect-web',
        configured: account.configured,
        // An in-memory authenticated identity is historical evidence, not a fresh server check.
        status: state?.status ?? 'unknown',
        ...(state?.lastCheckedAt ? { lastCheckedAt: state.lastCheckedAt } : {}),
        ...(state?.lastVerifiedAt ? { lastVerifiedAt: state.lastVerifiedAt } : {}),
        ...(account.revision ? { revision: account.revision } : {}),
      }
      this.states.set(account.accountId, state ? Object.assign(state, nextState) : nextState)
    }
    this.accounts.clear()
    for (const [id, account] of next) this.accounts.set(id, account)
  }

  async handle(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<CoachResult> {
    if (this.closed || signal?.aborted) return { success: false, code: 'unavailable' }
    const data = record(payload)
    if (!data || !ENDPOINTS.includes(endpoint as Endpoint)) return { success: false, code: 'invalid' }
    try {
      if (this.source) await this.source.ready()
      if (this.closed || signal?.aborted) return { success: false, code: 'unavailable' }
      if (this.source) this.syncAccounts(this.source.list())
      if (endpoint === 'members') {
        if (Object.keys(data).length) return { success: false, code: 'invalid' }
        const members = await Promise.all([...this.accounts.values()].map(async account => {
          const member = this.member(account)
          if (member.status === 'unknown' && account.configured) {
            try {
              if (await account.client.getAuthenticationRequirement()) member.status = 'auth_required'
            } catch { /* Do not mistake a failed local status read for invalid credentials. */ }
          }
          return member
        }))
        return { success: true, members, managed: (this.source as Partial<MutableAccountRegistry> | undefined)?.managed === true }
      }
      if (endpoint === 'save-account') {
        const registry = this.source as Partial<MutableAccountRegistry> | undefined
        if (!registry?.upsert) return { success: false, code: 'storage_unavailable' }
        if (!keys(data, ['accountId', 'alias', 'region', 'provider', 'username', 'personalApiKey', 'expectedRevision'])
          || typeof data.alias !== 'string'
          || (data.region !== 'cn' && data.region !== 'global')
          || (data.provider !== 'connect-web' && data.provider !== 'personal')) return { success: false, code: 'invalid' }
        const saved = await registry.upsert(data as unknown as RegistryAccountInput)
        return { success: true, ...saved }
      }
      if (endpoint === 'remove-account') {
        const registry = this.source as Partial<MutableAccountRegistry> | undefined
        if (!registry?.remove) return { success: false, code: 'storage_unavailable' }
        if (!keys(data, ['accountId', 'expectedRevision']) || typeof data.accountId !== 'string'
          || typeof data.expectedRevision !== 'string' || !/^[0-9a-f]{32}$/.test(data.expectedRevision)) {
          return { success: false, code: 'invalid' }
        }
        await registry.remove(data.accountId, data.expectedRevision)
        return { success: true }
      }
      if (endpoint === 'preferences') {
        if (Object.keys(data).length) return { success: false, code: 'invalid' }
        const preferences = await this.store.preferences()
        return { success: true, selfAccountId: preferences.selfAccountId
          && this.accounts.has(preferences.selfAccountId) ? preferences.selfAccountId : null }
      }
      if (endpoint === 'save-preferences') {
        if (!keys(data, ['selfAccountId']) || (data.selfAccountId !== null
          && (typeof data.selfAccountId !== 'string' || !this.accounts.has(data.selfAccountId)))) {
          return { success: false, code: 'invalid' }
        }
        await this.store.setPreferences(data.selfAccountId as string | null)
        return { success: true, selfAccountId: data.selfAccountId }
      }
      if (typeof data.accountId !== 'string' || !ID.test(data.accountId)) return { success: false, code: 'invalid' }
      const account = this.accounts.get(data.accountId)
      if (!account) return { success: false, code: 'account_not_found' }
      if (data.expectedAccountRevision !== undefined && data.expectedAccountRevision !== account.revision) {
        return { success: false, code: 'stale_config' }
      }
      if (endpoint === 'check') {
        if (!keys(data, ['accountId'])) return { success: false, code: 'invalid' }
        return { success: true, member: await this.check(account) }
      }
      if (endpoint === 'timeline') {
        if (!keys(data, ['accountId', 'days']) || (data.days !== undefined && data.days !== 7 && data.days !== 28)) {
          return { success: false, code: 'invalid' }
        }
        return await this.timeline(account, data.days === 28 ? 28 : 7, signal)
      }
      if (endpoint === 'notes') {
        if (!keys(data, ['accountId'])) return { success: false, code: 'invalid' }
        return { success: true, accountId: account.accountId, notes: await this.store.notes(this.owner(account), account.accountId) }
      }
      if (endpoint === 'save-note') {
        if (!keys(data, ['accountId', 'id', 'title', 'body', 'category', 'expectedRevision', 'expectedAccountRevision'])
          || typeof data.title !== 'string' || !data.title.trim() || data.title.length > 160
          || typeof data.body !== 'string' || !data.body.trim() || data.body.length > 20000
          || (data.category !== undefined && (typeof data.category !== 'string' || data.category.length > 64))
          || (data.id !== undefined && (typeof data.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.id)))
          || (data.id !== undefined && (!Number.isSafeInteger(data.expectedRevision) || Number(data.expectedRevision) < 1))
          || (data.id === undefined && data.expectedRevision !== undefined)) return { success: false, code: 'invalid' }
        const input: CoachNoteInput = {
          title: data.title.trim(), body: data.body.trim(), category: safeText(data.category, 64) || '一般备注',
          ...(typeof data.id === 'string' ? { id: data.id, expectedRevision: Number(data.expectedRevision) } : {}),
        }
        return { success: true, note: await this.store.save(this.owner(account), account.accountId, input) }
      }
      if (endpoint === 'delete-note') {
        if (!keys(data, ['accountId', 'id', 'expectedRevision', 'expectedAccountRevision'])
          || typeof data.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.id)
          || !Number.isSafeInteger(data.expectedRevision) || Number(data.expectedRevision) < 1) {
          return { success: false, code: 'invalid' }
        }
        await this.store.remove(this.owner(account), account.accountId, data.id, Number(data.expectedRevision))
        return { success: true }
      }
      return { success: false, code: 'invalid' }
    } catch (error) {
      const code = error instanceof CoachStorageError ? error.code
        : error instanceof AccountRegistryError && error.code !== 'closed' ? error.code : 'unavailable'
      return { success: false, code,
        ...(code === 'storage_unavailable' ? { message: '本机 SQLite 备注存储暂不可用，请稍后重试或检查运行时支持。' } : {}),
      }
    }
  }

  private owner(account: CoachPanelAccount): string {
    // Protect notes if a stable connection ID is accidentally rebound to a different login identity.
    return createHash('sha256').update(JSON.stringify([
      account.accountId, account.region, account.config.provider === 'personal' ? 'personal' : 'connect-web',
      account.config.provider === 'personal' ? '' : account.config.username.trim().toLowerCase(),
    ])).digest('hex')
  }

  private member(account: CoachPanelAccount): CoachMember {
    const avatar = this.avatars.get(account.accountId)
    return { ...this.states.get(account.accountId)!, ...(avatar?.account === account ? { avatarUrl: avatar.data } : {}) }
  }

  private dropAvatar(accountId: string): void {
    const avatar = this.avatars.get(accountId)
    if (avatar) this.avatarBytes -= avatar.data.length
    this.avatars.delete(accountId)
  }

  private async captureAvatar(account: CoachPanelAccount, profile: unknown): Promise<void> {
    const source = garminAvatarUrl(profile)
    if (!source || this.closed || this.accounts.get(account.accountId) !== account) return
    const previous = this.avatars.get(account.accountId)
    if (previous?.account === account && previous.source === source && previous.expiresAt > Date.now()) return
    const data = await downloadGarminAvatar(source)
    if (!data || this.closed || this.accounts.get(account.accountId) !== account) return
    this.dropAvatar(account.accountId)
    this.avatars.set(account.accountId, { account, source, data, expiresAt: Date.now() + 24 * 60 * 60_000 })
    this.avatarBytes += data.length
    // Account records remain unbounded; portrait memory and list payloads do not.
    while (this.avatarBytes > 4 * 1024 * 1024 || this.avatars.size > 256) this.dropAvatar(this.avatars.keys().next().value!)
  }

  private check(account: CoachPanelAccount): Promise<CoachMember> {
    const pending = this.checking.get(account.accountId)
    if (pending) return pending
    const state = this.states.get(account.accountId)!
    if (!account.configured) return Promise.resolve({ ...state, status: 'unknown' })
    if (!account.client.verifyConnection) return Promise.resolve({ ...state, status: 'unknown' })
    state.status = 'checking'
    let request!: Promise<CoachMember>
    request = (async () => {
      try {
        const profile = await account.client.verifyConnection!()
        if (!this.closed && this.accounts.get(account.accountId) === account) {
          state.status = 'valid'
          state.lastVerifiedAt = this.now().toISOString()
          await this.captureAvatar(account, profile)
        }
      } catch (error) {
        let required = authenticationError(error)
        try { required ||= Boolean(await account.client.getAuthenticationRequirement()) } catch { /* keep classified error */ }
        if (!this.closed && this.accounts.get(account.accountId) === account) state.status = required ? 'auth_required' : 'unavailable'
      } finally {
        if (!this.closed && this.accounts.get(account.accountId) === account) state.lastCheckedAt = this.now().toISOString()
        if (this.checking.get(account.accountId) === request) this.checking.delete(account.accountId)
      }
      return this.accounts.get(account.accountId) === account ? this.member(account) : { ...state }
    })()
    this.checking.set(account.accountId, request)
    return request
  }

  private async timeline(account: CoachPanelAccount, days: number, signal?: AbortSignal): Promise<CoachResult> {
    if (account.configured && account.config.provider !== 'personal' && !this.avatars.has(account.accountId)) {
      try { await this.captureAvatar(account, await account.client.getUserProfile()) } catch { /* Portraits never prevent timeline access. */ }
    }
    const today = localDate(this.now())
    const start = offsetDate(today, 1 - days)
    const end = offsetDate(today, Math.min(days, 30))
    const activities: Record<string, unknown>[] = []
    const plans: Record<string, unknown>[] = []
    let activityError: 'auth_required' | 'unavailable' | undefined
    let planError: 'auth_required' | 'unavailable' | undefined
    let partial = false
    let rawCount = 0
    if (!account.configured) activityError = 'auth_required'
    else {
      try {
        const raw = await account.client.getActivities(0, 100)
        if (!Array.isArray(raw)) throw new Error('invalid response')
        rawCount = raw.length
        for (const item of raw) {
          const data = record(item)
          if (!data) continue
          const date = safeDate(data.startTimeLocal ?? data.startTimeGMT ?? data.startTime)
          if (!date || date < start || date > today) continue
          const type = record(data.activityType)
          activities.push({
            id: safeId(data.activityId ?? data.id), name: safeText(data.activityName ?? data.name, 160) || '运动',
            type: safeText(type?.typeKey ?? data.type, 48) || 'unknown', date,
            durationSeconds: positiveNumber(data.duration ?? data.durationSeconds),
            distanceMeters: positiveNumber(data.distance ?? data.distanceMeters),
          })
        }
        partial = raw.length >= 100
      } catch (error) {
        activityError = authenticationError(error) ? 'auth_required' : 'unavailable'
        try { if (await account.client.getAuthenticationRequirement()) activityError = 'auth_required' } catch { /* retain */ }
        partial = true
      }
      if (!signal?.aborted && account.config.provider !== 'personal' && account.client.getScheduledWorkouts) {
        try {
          const raw = await account.client.getScheduledWorkouts(today, end)
          const list = scheduledList(raw)
          for (const item of list.slice(0, 200)) {
            const data = record(item)
            if (!data) continue
            const date = safeDate(data.calendarDate ?? data.date ?? data.scheduledDate)
            if (!date || date < today || date > end) continue
            const workout = record(data.workout)
            plans.push({ id: safeId(data.scheduleId ?? data.id ?? data.workoutScheduleId),
              name: safeText(data.workoutName ?? data.title ?? workout?.workoutName, 160) || '佳明训练安排', date })
          }
        } catch (error) {
          planError = authenticationError(error) ? 'auth_required' : 'unavailable'
          partial = true
        }
      }
    }
    if (this.closed || signal?.aborted || this.accounts.get(account.accountId) !== account) return { success: false, code: 'unavailable' }
    let notes: unknown[] = []
    let notesError: 'storage_unavailable' | undefined
    try { notes = await this.store.notes(this.owner(account), account.accountId) }
    catch { notesError = 'storage_unavailable' }
    return {
      success: true, accountId: account.accountId, activities, plans, notes,
      updatedAt: this.now().toISOString(), dataSource: 'garmin', partial,
      coverage: { startDate: start, endDate: today, fetchedActivities: rawCount, limit: 100 },
      ...(activityError ? { activityError } : {}), ...(planError ? { planError } : {}),
      ...(notesError ? { notesError } : {}),
      ...(this.member(account).avatarUrl ? { avatarUrl: this.member(account).avatarUrl } : {}),
    }
  }

  close(): void {
    this.closed = true
    this.unsubscribe?.()
    this.store.close()
    this.avatars.clear(); this.avatarBytes = 0
  }
}

interface HostConnection {
  fetch?: { register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => unknown }
  rpc: { handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<{ ok: true; value: CoachResult }>, options: { authority: 'loopback' }): () => unknown }
}

export function registerCoachPanel(ctx: Context, accounts: readonly CoachPanelAccount[] | AccountSource, options: CoachPanelOptions = {}): void {
  ctx.inject(['connection'], child => {
    const service = new CoachPanelService(accounts, options)
    const connection = child.connection as unknown as HostConnection
    const handler = async (endpoint: string, payload: unknown, signal: AbortSignal) => ({
      ok: true as const, value: await service.handle(endpoint, payload, signal),
    })
    const fetch = connection.fetch
    if (fetch?.register) {
      child.on('connection/request', async (request, response, next) => {
        let protectedPath = false
        try { protectedPath = ENDPOINTS.some(endpoint => new URL(request.url ?? '', 'http://dsh.internal').pathname === `${PREFIX}/${endpoint}`) } catch { /* unrelated */ }
        if (!protectedPath || isCoachLoopback(request.socket.remoteAddress)) { await next(); return }
        response.writeHead(403, { 'cache-control': 'no-store' }); response.end()
      })
    }
    const disposers = fetch?.register
      ? ENDPOINTS.map(endpoint => fetch.register({ path: `${PREFIX}/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
        fetch: request => handleCoachFetch(endpoint, request, service),
      }))
      : [connection.rpc.handle('/garmin-coach', handler, { authority: 'loopback' })]
    child.effect(() => async () => {
      try {
        await Promise.allSettled(disposers.reverse().map(dispose => Promise.resolve().then(() => dispose())))
      } finally {
        service.close()
      }
    }, 'garmin-connect: coach panel')
  })
}

export function isCoachLoopback(remote: string | undefined): boolean {
  if (!remote) return false
  if (remote === '::1') return true
  const address = remote.startsWith('::ffff:') ? remote.slice(7) : remote
  return isIP(address) === 4 && address.startsWith('127.')
}

export async function handleCoachFetch(endpoint: Endpoint, request: Request, service: CoachPanelService): Promise<Response> {
  const headers = { 'cache-control': 'no-store' }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers })
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return new Response(null, { status: 415, headers })
  }
  let envelope: Record<string, unknown> | undefined
  try {
    const text = await request.text()
    if (Buffer.byteLength(text) > 96 * 1024) return new Response(null, { status: 413, headers })
    envelope = record(JSON.parse(text))
  } catch { return new Response(null, { status: 400, headers }) }
  if (!envelope || envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string'
    || !envelope.rpcId || envelope.rpcId.length > 128 || envelope.method !== `garmin-coach/${endpoint}`
    || !Object.hasOwn(envelope, 'payload')) return new Response(null, { status: 400, headers })
  return Response.json({ type: 'server-response', rpcId: envelope.rpcId,
    result: { ok: true, value: await service.handle(endpoint, envelope.payload, request.signal) },
  }, { headers })
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null ? value as Record<string, unknown> : undefined
}
function keys(data: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(data).every(key => allowed.includes(key))
}
function safeText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, max) : ''
}
function safeId(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value)
    : typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : ''
}
function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
function safeDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const date = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) ? date : undefined
}
function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function offsetDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
function scheduledList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  const data = record(raw)
  if (!data) throw new Error('invalid calendar')
  for (const key of ['calendarItems', 'workouts', 'scheduledWorkouts', 'items']) {
    if (Array.isArray(data[key])) return data[key] as unknown[]
  }
  throw new Error('invalid calendar')
}

function authenticationError(error: unknown): boolean {
  return error instanceof GarminAuthenticationRequiredError
    || (error instanceof PublicToolError && /\bHTTP (401|403)\b/.test(error.message))
}
