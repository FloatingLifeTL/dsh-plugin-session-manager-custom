// Host 插件单元测试。测试不依赖真实 DSH runtime，通过最小 mock 上下文驱动 HTTP route。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { access as accessPromise } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

// 测试使用独立 DSH_HOME，避免读取或写入用户 profile 中真实的 trash/backup 清单。
// 由于 index.js 在模块加载时读取 DSH_HOME，因此必须先设置环境变量再动态导入。
const testHome = mkdtempSync(join(tmpdir(), 'session-manager-custom-test-'))
process.env.DSH_HOME = testHome
const { apply, version } = await import('../index.js')

after(() => {
  rmSync(testHome, { recursive: true, force: true })
})

/** 创建最小 DSH Host 上下文，并立即应用插件以捕获注册的 HTTP route。 */
function createContext() {
  const routes = []
  const ctx = {
    workspaceRegistry: {
      list: () => [],
      archivedSessionIds: [],
      archiveSession: async () => {},
      resolveByPath: async () => undefined,
      get: () => undefined,
      setState: async () => {}
    },
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      listEvents: async () => [],
      readSurface: async () => ({ session: { createdAt: 1 }, events: [] })
    },
    webServer: {
      register: (route) => routes.push(route)
    },
    effect: (fn) => fn(),
    get: () => undefined
  }
  apply(ctx)
  return { ctx, route: routes[0] }
}

/** 构造带 workspace/session_projcache 两个领域的最小 storageDomain mock。 */
function createFakeStorageDomain({ workspaceRecords = {}, cacheIds = [], archived = [] } = {}) {
  const cacheKeys = new Set(cacheIds)
  const workspaceState = { archivedSessionIds: archived }
  const workspaceTable = {
    entries: () => Object.entries(workspaceRecords),
    get: (id) => workspaceRecords[id],
    update: async (id, fn) => {
      const next = fn(workspaceRecords[id])
      workspaceRecords[id] = next
      return next
    }
  }
  const cacheTable = {
    keys: () => cacheKeys[Symbol.iterator](),
    get: (id) => cacheKeys.has(id) ? {} : undefined,
    delete: async (id) => cacheKeys.delete(id)
  }
  return {
    workspaceTable,
    cacheTable,
    workspaceState,
    cacheIds: cacheKeys,
    get: (name) => name === 'workspace'
      ? { table: () => workspaceTable, global: { get: () => workspaceState, set: async (value) => { workspaceState.archivedSessionIds = value.archivedSessionIds } } }
      : name === 'session_projcache'
        ? { table: () => cacheTable }
        : undefined
  }
}

/** 用 EventEmitter 模拟请求，触发 route 并返回最终 HTTP 状态和 JSON。 */
async function invoke(route, body) {
  const req = new EventEmitter()
  req.method = 'POST'
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code
      return this
    },
    end(value) {
      this.body = value
    }
  }
  const promise = route.handler(req, res)
  req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  await promise
  return { status: res.statusCode, json: JSON.parse(res.body) }
}

test('list returns an empty session list', async () => {
  const { route } = createContext()
  const result = await invoke(route, { method: 'list', args: { view: 'all', query: '' } })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.deepEqual(result.json.items, [])
  assert.equal(result.json.counts.all, 0)
})

test('version comes from the plugin package.json declaration', async () => {
  const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
  const packageVersion = JSON.parse(readFileSync(packagePath, 'utf8')).version
  const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))
  const clientSource = readFileSync(clientPath, 'utf8')
  const { route } = createContext()

  const result = await invoke(route, { method: 'version', args: {} })

  assert.equal(version, packageVersion)
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.version, packageVersion)
  assert.equal(clientSource.includes(`v${packageVersion}`), false)
})

test('request body limit is measured in bytes', async () => {
  const { route } = createContext()
  const req = new EventEmitter()
  req.method = 'POST'
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code
      return this
    },
    end(value) {
      this.body = value
    }
  }
  const promise = route.handler(req, res)
  req.emit('data', Buffer.alloc(1_000_001, 0x61))
  req.emit('end')
  await promise

  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body).error, /request body too large/)
})

test('batch rejects unknown actions', async () => {
  const { route } = createContext()
  const result = await invoke(route, { method: 'batch', args: { ids: ['session-1'], action: 'unknown' } })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, false)
  assert.match(result.json.error, /未知批量操作/)
})

test('single delete rejects missing session id', async () => {
  const { route } = createContext()
  const result = await invoke(route, { method: 'delete', args: {} })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, false)
  assert.match(result.json.error, /缺少会话 ID/)
})

test('backup area does not expose direct purge operations', async () => {
  const { route } = createContext()
  const single = await invoke(route, { method: 'backupPurge', args: { id: 'session-1' } })
  const batch = await invoke(route, { method: 'batch', args: { ids: ['session-1'], action: 'backup-delete' } })

  assert.equal(single.status, 200)
  assert.equal(single.json.ok, false)
  assert.match(single.json.error, /未知操作/)
  assert.equal(batch.status, 200)
  assert.equal(batch.json.ok, false)
  assert.match(batch.json.error, /未知批量操作/)
})

test('subagent sessions are not marked as ungrouped issues', async () => {
  const { ctx, route } = createContext()
  ctx.sessionQuery.listSessions = async () => [
    {
      header: { id: 'subagent-session', createdAt: 1, version: 0, cwd: '/workspace', origin: 'subagent' },
      live: false,
      persisted: true
    }
  ]
  ctx.workspaceRegistry.list = () => []
  ctx.workspaceRegistry.archivedSessionIds = []

  const subagent = await invoke(route, { method: 'list', args: { view: 'subagent', query: '' } })
  const issues = await invoke(route, { method: 'list', args: { view: 'issues', query: '' } })

  assert.deepEqual(subagent.json.items.map((item) => item.id), ['subagent-session'])
  assert.deepEqual(subagent.json.items[0].codes, ['subagent'])
  assert.equal(subagent.json.counts.issues, 0)
  assert.deepEqual(issues.json.items, [])
})

test('retained backup files produce a read-only preview', async () => {
  const { route } = createContext()
  const id = 'session-retained'
  const areaRoot = join(testHome, 'profiles', '.session-manager-custom-backup')
  const fileDir = join(areaRoot, id)
  mkdirSync(fileDir, { recursive: true })
  const header = {
    type: 'session',
    version: 0,
    id,
    createdAt: 10,
    cwd: '/workspace',
    delegationDepth: 0
  }
  const events = [
    { type: 'user/message', seq: 0, time: 11, data: { content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant/message', seq: 1, time: 12, data: { message: { content: [{ type: 'text', text: 'hi' }] } } }
  ]
  const lines = [header, ...events].map((value) => `${JSON.stringify(value)}\n`)
  const frames = lines.map((line) => zstdCompressSync(Buffer.from(line)))
  const artifactPath = join(fileDir, 'session.jsonl.zstd')
  writeFileSync(artifactPath, Buffer.concat(frames))
  const originalPath = join(testHome, 'sessions', id, 'session.jsonl.zstd')
  writeFileSync(join(areaRoot, 'backup.json'), JSON.stringify([
    { id, title: 'Retained', cwd: '/workspace', createdAt: 10, backedUpAt: 20, wasArchived: true, originalPath }
  ], null, 2))

  const result = await invoke(route, { method: 'detail', args: { id } })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.eventCount, 2)
  assert.equal(result.json.createdAt, 10)
  assert.deepEqual(result.json.preview.map((item) => item.role), ['user', 'assistant'])
  assert.equal(result.json.surfaceError, null)
})

test('retained trash files produce a preview from uncompressed jsonl', async () => {
  const { route } = createContext()
  const id = 'session-trashed-preview'
  const areaRoot = join(testHome, 'profiles', '.session-manager-custom-trash')
  const fileDir = join(areaRoot, id)
  mkdirSync(fileDir, { recursive: true })
  const header = { type: 'session', version: 0, id, createdAt: 30, cwd: '/workspace', delegationDepth: 0 }
  const event = { type: 'user/message', seq: 0, time: 31, data: { content: [{ type: 'text', text: 'trash preview' }] } }
  writeFileSync(join(fileDir, 'session.jsonl'), `${JSON.stringify(header)}\n${JSON.stringify(event)}\n`)
  const originalPath = join(testHome, 'sessions', id, 'session.jsonl')
  writeFileSync(join(areaRoot, 'trash.json'), JSON.stringify([
    { id, title: 'Trashed', cwd: '/workspace', createdAt: 30, trashedAt: 40, originalPath }
  ], null, 2))

  const result = await invoke(route, { method: 'detail', args: { id } })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.eventCount, 1)
  assert.equal(result.json.createdAt, 30)
  assert.equal(result.json.preview[0].role, 'user')
  assert.equal(result.json.surfaceError, null)
})

test('normal view excludes archived sessions', async () => {
  const { ctx, route } = createContext()
  const records = [
    {
      header: { id: 'normal-session', createdAt: 2, version: 0, cwd: '/workspace', origin: 'default' },
      live: true,
      persisted: true
    },
    {
      header: { id: 'archived-session', createdAt: 1, version: 0, cwd: '/workspace', origin: 'default' },
      live: true,
      persisted: true
    }
  ]
  ctx.sessionQuery.listSessions = async () => records
  ctx.sessionQuery.readTitleSnapshots = async () => []
  ctx.workspaceRegistry.archivedSessionIds = ['archived-session']
  ctx.workspaceRegistry.list = () => [
    { id: 'workspace', title: 'Workspace', path: '/workspace', sessionIds: ['normal-session'] }
  ]

  const result = await invoke(route, { method: 'list', args: { view: 'normal', query: '' } })

  assert.equal(result.status, 200)
  assert.deepEqual(result.json.items.map((item) => item.id), ['normal-session'])
  assert.equal(result.json.counts.all, 2)
  assert.equal(result.json.counts.normal, 1)
  assert.equal(result.json.counts.archived, 1)
})

test('all session count excludes trash manifest entries', async () => {
  const { ctx, route } = createContext()
  const records = [
    {
      header: { id: 'session-a', createdAt: 1, version: 0, cwd: '/workspace', origin: 'default' },
      live: true,
      persisted: true
    }
  ]
  ctx.sessionQuery.listSessions = async () => records
  ctx.sessionQuery.readTitleSnapshots = async () => []

  const result = await invoke(route, { method: 'list', args: { view: 'all', query: '' } })
  const trash = await invoke(route, { method: 'list', args: { view: 'trash', query: '' } })

  assert.equal(result.status, 200)
  assert.equal(result.json.counts.all, 1)
  assert.deepEqual(result.json.items.map((item) => item.id), ['session-a'])
  assert.ok(result.json.counts.trash >= 0)
  assert.equal(trash.json.counts.all, 1)
  assert.equal(trash.json.counts.normal, 1)
})

test('backup view preserves normal session counts', async () => {
  const { ctx, route } = createContext()
  const records = [
    {
      header: { id: 'session-a', createdAt: 1, version: 0, cwd: '/workspace', origin: 'default' },
      live: false,
      persisted: true
    }
  ]
  ctx.sessionQuery.listSessions = async () => records
  ctx.sessionQuery.readTitleSnapshots = async () => []

  const result = await invoke(route, { method: 'list', args: { view: 'all', query: '' } })
  const backup = await invoke(route, { method: 'list', args: { view: 'backup', query: '' } })

  assert.equal(result.status, 200)
  assert.equal(result.json.counts.all, 1)
  assert.deepEqual(result.json.items.map((item) => item.id), ['session-a'])
  assert.ok(result.json.counts.backup >= 0)
  assert.ok(Array.isArray(backup.json.items))
  assert.equal(backup.json.counts.backup, backup.json.items.length)
  assert.ok(backup.json.items.every((item) => item.backedUp === true))
  assert.equal(backup.json.counts.all, 1)
  assert.equal(backup.json.counts.normal, 1)
})

test('backup rejects sessions that have not been archived', async () => {
  const { ctx, route } = createContext()
  ctx.sessionQuery.listSessions = async () => [
    {
      header: { id: 'session-a', createdAt: 1, version: 0, cwd: '/workspace', origin: 'default' },
      live: false,
      persisted: true
    }
  ]
  ctx.workspaceRegistry.archivedSessionIds = []

  const result = await invoke(route, { method: 'backup', args: { id: 'session-a' } })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, false)
  assert.match(result.json.error, /请先归档会话/)
})

test('backup safely ends a live archived session before file validation', async () => {
  const { ctx, route } = createContext()
  let disposed = false
  let detached = false
  let deleted = false
  const record = {
    header: { id: 'session-a', createdAt: 1, version: 0, cwd: '/workspace', origin: 'default' },
    live: true,
    persisted: true
  }
  ctx.get = (name) => {
    if (name === 'agents') {
      return {
        get: (id) => ({
          cancel: async () => {},
          whenIdle: async () => {},
          scope: {
            dispose: async () => {
              disposed = true
              record.live = false
            }
          }
        }),
        store: {
          delete: () => {
            deleted = true
          }
        }
      }
    }
    if (name === 'sessions') {
      return {
        store: {
          get: () => ({
            detach: () => {
              detached = true
            }
          })
        }
      }
    }
    return undefined
  }
  ctx.sessionQuery.listSessions = async () => [record]
  ctx.workspaceRegistry.archivedSessionIds = ['session-a']

  const result = await invoke(route, { method: 'backup', args: { id: 'session-a' } })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, false)
  assert.match(result.json.error, /会话持久化服务不可用/)
  assert.equal(disposed, true)
  assert.equal(detached, true)
  assert.equal(deleted, true)
})

test('cleanup removes stale cache rows, workspace references and archive IDs', async () => {
  const { ctx, route } = createContext()
  const workspaceRecords = {
    ws: { id: 'ws', path: '/workspace', sessionIds: ['session-live', 'session-stale'] }
  }
  const detached = []
  const workspace = {
    id: 'ws',
    sessionIds: workspaceRecords.ws.sessionIds,
    detachSession: async (id) => {
      detached.push(id)
      workspaceRecords.ws.sessionIds = workspaceRecords.ws.sessionIds.filter((item) => item !== id)
      workspace.sessionIds = workspaceRecords.ws.sessionIds
    }
  }
  const storage = createFakeStorageDomain({
    workspaceRecords,
    cacheIds: ['session-live', 'session-stale'],
    archived: ['session-stale']
  })
  const originalGet = ctx.get
  ctx.get = (name) => name === 'storageDomain' ? storage : originalGet(name)
  ctx.sessionQuery.listSessions = async () => [
    { header: { id: 'session-live' }, live: false, persisted: true }
  ]
  ctx.workspaceRegistry.list = () => []
  ctx.workspaceRegistry.get = () => workspace
  ctx.workspaceRegistry.archivedSessionIds = ['session-stale']
  ctx.workspaceRegistry.setState = async (state) => { ctx.workspaceRegistry.archivedSessionIds = state.archivedSessionIds }

  const result = await invoke(route, { method: 'cleanup', args: {} })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.deepEqual(result.json.removedCacheIds, ['session-stale'])
  assert.deepEqual(result.json.removedWorkspace, [{ workspaceId: 'ws', sessionId: 'session-stale' }])
  assert.deepEqual(result.json.removedArchiveIds, ['session-stale'])
  assert.deepEqual(detached, ['session-stale'])
  assert.deepEqual(workspaceRecords.ws.sessionIds, ['session-live'])
})

test('moving a session to trash detaches workspace, archive marker and projection cache', async () => {
  const { ctx, route } = createContext()
  const id = 'session-move'
  const sessionDir = join(testHome, 'sessions', id)
  const sourcePath = join(sessionDir, 'session.jsonl')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(sourcePath, `${JSON.stringify({ type: 'session', version: 0, id, createdAt: 1, cwd: '/workspace', delegationDepth: 0 })}\n`)
  const workspaceRecords = { ws: { id: 'ws', path: '/workspace', sessionIds: [id] } }
  const detached = []
  const workspace = {
    id: 'ws',
    title: 'Workspace',
    path: '/workspace',
    sessionIds: [id],
    detachSession: async (sessionId) => {
      detached.push(sessionId)
      workspaceRecords.ws.sessionIds = workspaceRecords.ws.sessionIds.filter((item) => item !== sessionId)
      workspace.sessionIds = workspaceRecords.ws.sessionIds
    }
  }
  const storage = createFakeStorageDomain({ workspaceRecords, cacheIds: [id], archived: [id] })
  const originalGet = ctx.get
  ctx.get = (name) => {
    if (name === 'sessionPersistence') return { supportsRawArtifacts: true, locate: () => ({ kind: 'jsonl', path: sourcePath }) }
    if (name === 'storageDomain') return storage
    return originalGet(name)
  }
  ctx.sessionQuery.listSessions = async () => [
    { header: { id, createdAt: 1, version: 0, cwd: '/workspace', origin: 'default' }, live: false, persisted: true }
  ]
  ctx.sessionQuery.readTitleSnapshots = async () => [
    { sessionId: id, status: 'fulfilled', value: { title: { title: 'Moved' } } }
  ]
  ctx.workspaceRegistry.list = () => [workspace]
  ctx.workspaceRegistry.get = () => workspace
  ctx.workspaceRegistry.archivedSessionIds = [id]
  ctx.workspaceRegistry.setState = async (state) => {
    ctx.workspaceRegistry.archivedSessionIds = state.archivedSessionIds
    storage.workspaceState.archivedSessionIds = [...state.archivedSessionIds]
  }

  const result = await invoke(route, { method: 'delete', args: { id } })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.cleanup.ok, true)
  assert.equal(await accessPromise(sourcePath).then(() => true, () => false), false)
  assert.deepEqual(detached, [id])
  assert.deepEqual(workspaceRecords.ws.sessionIds, [])
  assert.equal(storage.cacheIds.has(id), false)
  assert.deepEqual(storage.workspaceState.archivedSessionIds, [])
  const trash = JSON.parse(readFileSync(join(testHome, 'profiles', '.session-manager-custom-trash', 'trash.json'), 'utf8'))
  assert.ok(trash.some((item) => item.id === id))
})

test('moving a session to backup detaches workspace, archive marker and projection cache', async () => {
  const { ctx, route } = createContext()
  const id = 'session-backup-move'
  const sessionDir = join(testHome, 'sessions', id)
  const sourcePath = join(sessionDir, 'session.jsonl')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(sourcePath, `${JSON.stringify({ type: 'session', version: 0, id, createdAt: 1, cwd: '/workspace', delegationDepth: 0 })}\n`)
  const workspaceRecords = { ws: { id: 'ws', path: '/workspace', sessionIds: [id] } }
  const workspace = {
    id: 'ws',
    title: 'Workspace',
    path: '/workspace',
    sessionIds: [id],
    detachSession: async (sessionId) => {
      workspaceRecords.ws.sessionIds = workspaceRecords.ws.sessionIds.filter((item) => item !== sessionId)
      workspace.sessionIds = workspaceRecords.ws.sessionIds
    }
  }
  const storage = createFakeStorageDomain({ workspaceRecords, cacheIds: [id], archived: [id] })
  const originalGet = ctx.get
  ctx.get = (name) => {
    if (name === 'sessionPersistence') return { supportsRawArtifacts: true, locate: () => ({ kind: 'jsonl', path: sourcePath }) }
    if (name === 'storageDomain') return storage
    return originalGet(name)
  }
  ctx.sessionQuery.listSessions = async () => [
    { header: { id, createdAt: 1, version: 0, cwd: '/workspace', origin: 'default' }, live: false, persisted: true }
  ]
  ctx.sessionQuery.readTitleSnapshots = async () => []
  ctx.workspaceRegistry.list = () => [workspace]
  ctx.workspaceRegistry.get = () => workspace
  ctx.workspaceRegistry.archivedSessionIds = [id]
  ctx.workspaceRegistry.setState = async (state) => {
    ctx.workspaceRegistry.archivedSessionIds = state.archivedSessionIds
    storage.workspaceState.archivedSessionIds = [...state.archivedSessionIds]
  }

  const result = await invoke(route, { method: 'backup', args: { id } })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.cleanup.ok, true)
  assert.deepEqual(workspaceRecords.ws.sessionIds, [])
  assert.equal(storage.cacheIds.has(id), false)
  assert.deepEqual(storage.workspaceState.archivedSessionIds, [])
  const backup = JSON.parse(readFileSync(join(testHome, 'profiles', '.session-manager-custom-backup', 'backup.json'), 'utf8'))
  assert.ok(backup.some((item) => item.id === id))
})

test('purging a trash session removes its manifest, workspace reference and projection cache', async () => {
  const { ctx, route } = createContext()
  const id = 'session-purge'
  const areaRoot = join(testHome, 'profiles', '.session-manager-custom-trash')
  const storageDir = join(areaRoot, id)
  const originalPath = join(testHome, 'sessions', id, 'session.jsonl')
  mkdirSync(storageDir, { recursive: true })
  writeFileSync(join(storageDir, 'session.jsonl'), '{}')
  writeFileSync(join(areaRoot, 'trash.json'), JSON.stringify([
    { id, title: 'Purge', cwd: '/workspace', createdAt: 1, trashedAt: 2, originalPath }
  ], null, 2))
  const workspaceRecords = { ws: { id: 'ws', path: '/workspace', sessionIds: [id] } }
  const detached = []
  const workspace = {
    id: 'ws',
    sessionIds: [id],
    detachSession: async (sessionId) => {
      detached.push(sessionId)
      workspaceRecords.ws.sessionIds = workspaceRecords.ws.sessionIds.filter((item) => item !== sessionId)
      workspace.sessionIds = workspaceRecords.ws.sessionIds
    }
  }
  const storage = createFakeStorageDomain({ workspaceRecords, cacheIds: [id], archived: [id] })
  const originalGet = ctx.get
  ctx.get = (name) => name === 'storageDomain' ? storage : originalGet(name)
  ctx.workspaceRegistry.list = () => []
  ctx.workspaceRegistry.get = () => workspace
  ctx.workspaceRegistry.archivedSessionIds = [id]
  ctx.workspaceRegistry.setState = async (state) => {
    ctx.workspaceRegistry.archivedSessionIds = state.archivedSessionIds
    storage.workspaceState.archivedSessionIds = [...state.archivedSessionIds]
  }

  const result = await invoke(route, { method: 'trashPurge', args: { id } })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.cleanup.ok, true)
  assert.equal(await accessPromise(join(storageDir, 'session.jsonl')).then(() => true, () => false), false)
  assert.deepEqual(detached, [id])
  assert.deepEqual(workspaceRecords.ws.sessionIds, [])
  assert.equal(storage.cacheIds.has(id), false)
  assert.deepEqual(storage.workspaceState.archivedSessionIds, [])
  assert.deepEqual(JSON.parse(readFileSync(join(areaRoot, 'trash.json'), 'utf8')), [])
})

test('restoring a backup session reattaches workspace, archive state and projection cache', async () => {
  const { ctx, route } = createContext()
  const id = 'session-restore'
  const areaRoot = join(testHome, 'profiles', '.session-manager-custom-backup')
  const storageDir = join(areaRoot, id)
  const originalPath = join(testHome, 'sessions', id, 'session.jsonl')
  mkdirSync(storageDir, { recursive: true })
  writeFileSync(join(storageDir, 'session.jsonl'), `${JSON.stringify({ type: 'session', version: 0, id, createdAt: 1, cwd: '/workspace', delegationDepth: 0 })}\n`)
  writeFileSync(join(areaRoot, 'backup.json'), JSON.stringify([
    { id, title: 'Restore', cwd: '/workspace', workspace: { id: 'ws', title: 'Workspace', path: '/workspace' }, createdAt: 1, backedUpAt: 2, wasArchived: true, originalPath }
  ], null, 2))
  let attached = false
  const workspace = {
    id: 'ws',
    sessionIds: [],
    attachSession: async (sessionId) => {
      attached = true
      workspace.sessionIds = [sessionId]
    }
  }
  const storage = createFakeStorageDomain({ cacheIds: [id], archived: [] })
  const cacheService = {
    coldSnapshot: async (sessionId) => {
      storage.cacheIds.add(sessionId)
    }
  }
  const originalGet = ctx.get
  ctx.get = (name) => {
    if (name === 'sessionProjectionCache') return cacheService
    if (name === 'storageDomain') return storage
    return originalGet(name)
  }
  ctx.sessionQuery.listSessions = async () => [
    { header: { id, createdAt: 1, cwd: '/workspace', origin: 'default' }, live: false, persisted: true }
  ]
  ctx.workspaceRegistry.get = () => workspace
  ctx.workspaceRegistry.resolveByPath = async () => workspace
  ctx.workspaceRegistry.archivedSessionIds = []
  ctx.workspaceRegistry.setState = async (state) => {
    ctx.workspaceRegistry.archivedSessionIds = state.archivedSessionIds
    storage.workspaceState.archivedSessionIds = [...state.archivedSessionIds]
  }

  const result = await invoke(route, { method: 'backupRestore', args: { id } })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(attached, true)
  assert.equal(result.json.archived, true)
  assert.deepEqual(workspace.sessionIds, [id])
  assert.equal(storage.cacheIds.has(id), true)
  assert.equal(result.json.cacheRefresh.action, 'refreshed')
  assert.deepEqual(storage.workspaceState.archivedSessionIds, [id])
  assert.deepEqual(JSON.parse(readFileSync(join(areaRoot, 'backup.json'), 'utf8')), [])
})

test('restoring a trash session reattaches workspace, archive state and projection cache', async () => {
  const { ctx, route } = createContext()
  const id = 'session-trash-restore'
  const areaRoot = join(testHome, 'profiles', '.session-manager-custom-trash')
  const storageDir = join(areaRoot, id)
  const originalPath = join(testHome, 'sessions', id, 'session.jsonl')
  mkdirSync(storageDir, { recursive: true })
  writeFileSync(join(storageDir, 'session.jsonl'), `${JSON.stringify({ type: 'session', version: 0, id, createdAt: 1, cwd: '/workspace', delegationDepth: 0 })}\n`)
  writeFileSync(join(areaRoot, 'trash.json'), JSON.stringify([
    { id, title: 'Restore trash', cwd: '/workspace', workspace: { id: 'ws', title: 'Workspace', path: '/workspace' }, createdAt: 1, trashedAt: 2, originalPath }
  ], null, 2))
  let attached = false
  const workspace = {
    id: 'ws',
    sessionIds: [],
    attachSession: async (sessionId) => {
      attached = true
      workspace.sessionIds = [sessionId]
    }
  }
  const storage = createFakeStorageDomain({ cacheIds: [id], archived: [] })
  const cacheService = {
    coldSnapshot: async (sessionId) => {
      storage.cacheIds.add(sessionId)
    }
  }
  const originalGet = ctx.get
  ctx.get = (name) => {
    if (name === 'sessionProjectionCache') return cacheService
    if (name === 'storageDomain') return storage
    return originalGet(name)
  }
  ctx.sessionQuery.listSessions = async () => [
    { header: { id, createdAt: 1, cwd: '/workspace', origin: 'default' }, live: false, persisted: true }
  ]
  ctx.workspaceRegistry.get = () => workspace
  ctx.workspaceRegistry.resolveByPath = async () => workspace
  ctx.workspaceRegistry.archivedSessionIds = []
  ctx.workspaceRegistry.setState = async (state) => {
    ctx.workspaceRegistry.archivedSessionIds = state.archivedSessionIds
    storage.workspaceState.archivedSessionIds = [...state.archivedSessionIds]
  }

  const result = await invoke(route, { method: 'trashRestore', args: { id } })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(attached, true)
  assert.equal(result.json.archived, true)
  assert.deepEqual(workspace.sessionIds, [id])
  assert.equal(storage.cacheIds.has(id), true)
  assert.equal(result.json.cacheRefresh.action, 'refreshed')
  assert.deepEqual(storage.workspaceState.archivedSessionIds, [id])
  assert.deepEqual(JSON.parse(readFileSync(join(areaRoot, 'trash.json'), 'utf8')), [])
})

test('moving a normal session clears old workspace references before attaching the target', async () => {
  const { ctx, route } = createContext()
  const id = 'session-workspace-move'
  const workspaceRecords = {
    old: { id: 'old', path: '/old', sessionIds: [id] },
    target: { id: 'target', path: '/target', sessionIds: [] }
  }
  const workspaces = {
    old: {
      id: 'old',
      path: '/old',
      sessionIds: [id],
      detachSession: async (sessionId) => {
        workspaceRecords.old.sessionIds = workspaceRecords.old.sessionIds.filter((item) => item !== sessionId)
        workspaces.old.sessionIds = workspaceRecords.old.sessionIds
      }
    },
    target: {
      id: 'target',
      path: '/target',
      sessionIds: [],
      attachSession: async (sessionId) => {
        workspaceRecords.target.sessionIds = [sessionId]
        workspaces.target.sessionIds = workspaceRecords.target.sessionIds
      }
    }
  }
  const storage = createFakeStorageDomain({ workspaceRecords })
  const originalGet = ctx.get
  ctx.get = (name) => name === 'storageDomain' ? storage : originalGet(name)
  ctx.workspaceRegistry.list = () => Object.values(workspaces)
  ctx.workspaceRegistry.get = (id) => workspaces[id]

  const result = await invoke(route, { method: 'move', args: { id, workspaceId: 'target' } })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.deepEqual(result.json.detach.detached, ['old'])
  assert.deepEqual(workspaceRecords.old.sessionIds, [])
  assert.deepEqual(workspaceRecords.target.sessionIds, [id])
})

test('restoring a normal session reattaches workspace and clears archive marker', async () => {
  const { ctx, route } = createContext()
  const id = 'session-normal-restore'
  const workspaceRecords = { ws: { id: 'ws', path: '/workspace', sessionIds: [] } }
  const workspace = {
    id: 'ws',
    path: '/workspace',
    sessionIds: [],
    attachSession: async (sessionId) => {
      workspaceRecords.ws.sessionIds = [sessionId]
      workspace.sessionIds = workspaceRecords.ws.sessionIds
    }
  }
  const storage = createFakeStorageDomain({ workspaceRecords, archived: [id] })
  const originalGet = ctx.get
  ctx.get = (name) => name === 'storageDomain' ? storage : originalGet(name)
  ctx.sessionQuery.listSessions = async () => [
    { header: { id, createdAt: 1, cwd: '/workspace', origin: 'default' }, live: false, persisted: true }
  ]
  ctx.workspaceRegistry.list = () => [workspace]
  ctx.workspaceRegistry.get = () => workspace
  ctx.workspaceRegistry.resolveByPath = async () => workspace
  ctx.workspaceRegistry.archivedSessionIds = [id]
  ctx.workspaceRegistry.setState = async (state) => {
    ctx.workspaceRegistry.archivedSessionIds = state.archivedSessionIds
    storage.workspaceState.archivedSessionIds = [...state.archivedSessionIds]
  }

  const result = await invoke(route, { method: 'restore', args: { id } })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.deepEqual(workspaceRecords.ws.sessionIds, [id])
  assert.deepEqual(storage.workspaceState.archivedSessionIds, [])
})

test('restore rolls back to storage when workspace reattachment fails', async () => {
  const { ctx, route } = createContext()
  const id = 'session-restore-rollback'
  const areaRoot = join(testHome, 'profiles', '.session-manager-custom-backup')
  const storageDir = join(areaRoot, id)
  const originalPath = join(testHome, 'sessions', id, 'session.jsonl')
  mkdirSync(storageDir, { recursive: true })
  writeFileSync(join(storageDir, 'session.jsonl'), `${JSON.stringify({ type: 'session', version: 0, id, createdAt: 1, cwd: '/missing', delegationDepth: 0 })}\n`)
  writeFileSync(join(areaRoot, 'backup.json'), JSON.stringify([
    { id, title: 'Rollback', cwd: '/missing', createdAt: 1, backedUpAt: 2, wasArchived: true, originalPath }
  ], null, 2))
  const storage = createFakeStorageDomain({ cacheIds: [id], archived: [id] })
  const originalGet = ctx.get
  ctx.get = (name) => name === 'storageDomain' ? storage : originalGet(name)
  ctx.sessionQuery.listSessions = async () => [
    { header: { id, createdAt: 1, cwd: '/missing', origin: 'default' }, live: false, persisted: true }
  ]
  ctx.workspaceRegistry.resolveByPath = async () => undefined
  ctx.workspaceRegistry.get = () => undefined
  ctx.workspaceRegistry.archivedSessionIds = [id]
  ctx.workspaceRegistry.setState = async (state) => {
    ctx.workspaceRegistry.archivedSessionIds = state.archivedSessionIds
    storage.workspaceState.archivedSessionIds = [...state.archivedSessionIds]
  }

  const result = await invoke(route, { method: 'backupRestore', args: { id } })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.rollback.ok, true)
  assert.equal(await accessPromise(originalPath).then(() => true, () => false), false)
  assert.equal(await accessPromise(join(storageDir, 'session.jsonl')).then(() => true, () => false), true)
  assert.ok(JSON.parse(readFileSync(join(areaRoot, 'backup.json'), 'utf8')).some((item) => item.id === id))
  assert.equal(storage.cacheIds.has(id), false)
  assert.deepEqual(storage.workspaceState.archivedSessionIds, [])
})
