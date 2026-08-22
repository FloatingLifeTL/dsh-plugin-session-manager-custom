// Host 插件单元测试。测试不依赖真实 DSH runtime，通过最小 mock 上下文驱动 HTTP route。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

// 测试使用独立 DSH_HOME，避免读取或写入用户 profile 中真实的 trash/backup 清单。
// 由于 index.js 在模块加载时读取 DSH_HOME，因此必须先设置环境变量再动态导入。
const testHome = mkdtempSync(join(tmpdir(), 'session-manager-custom-test-'))
process.env.DSH_HOME = testHome
const { apply } = await import('../index.js')

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
