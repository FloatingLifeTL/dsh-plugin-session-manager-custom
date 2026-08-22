// DSH session-manager-custom Host 插件。
// 提供会话列表、详情、归档/恢复、工作区修复，以及回收站和备份保留区的持久化管理。
// 回收站与备份保留区共享同一套“移动、恢复、彻底删除”生命周期，避免两套实现漂移。
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Cordis 插件标识；Dsh 通过 package 中的 name 加载 Host apply。 */
export const name = 'session-manager-custom'

/** Host 必需依赖。缺少任一服务时 Cordis 会等待服务出现后再应用插件。 */
export const inject = ['webServer', 'workspaceRegistry', 'sessionQuery']

// DSH_HOME 在模块加载时确定，测试通过临时 DSH_HOME 隔离真实 profile。
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
// 清单和会话文件都位于 profiles 下，插件升级或重装不会删除这些数据。
const trashRoot = join(dshHome, 'profiles', '.session-manager-custom-trash')
const trashManifestPath = join(trashRoot, 'trash.json')
const backupRoot = join(dshHome, 'profiles', '.session-manager-custom-backup')
const backupManifestPath = join(backupRoot, 'backup.json')

/**
 * 两类文件保留区的差异配置。
 *
 * trash 和 backup 使用不同目录、清单、状态标记和时间字段，但共用移动、恢复和
 * 列表逻辑。彻底删除只注册给 trash，所以 backup 必须先恢复再经回收站删除。
 */
const STORAGE_AREAS = {
  // 备份区刻意不注册 purge/delete 能力，彻底删除必须经过恢复、归档区、回收站。
  backup: {
    kind: 'backup',
    root: backupRoot,
    manifestPath: backupManifestPath,
    label: '备份保留区',
    countKey: 'backup',
    itemCode: 'backed-up',
    movedAtKey: 'backedUpAt',
    restoreArchived: (entry) => entry.wasArchived !== false
  },
  trash: {
    kind: 'trash',
    root: trashRoot,
    manifestPath: trashManifestPath,
    label: '回收站',
    countKey: 'trash',
    itemCode: 'trashed',
    movedAtKey: 'trashedAt',
    restoreArchived: () => true
  }
}

/** 将任意 throw 值转换为可安全写入 API 响应的字符串。 */
const errText = (error) => (error instanceof Error ? error.message : String(error))

/** 普通会话可见异常码；subagent 的 ungrouped 判定在调用处单独排除。 */
const ISSUE_CODES = ['old-schema', 'no-cwd', 'ungrouped', 'missing-source']
const hasIssueCode = (codes) => codes.some((code) => ISSUE_CODES.includes(code))

/** 将 fs.access 的成功映射为 true；不存在、无权限等访问失败统一映射为 false。 */
const pathExists = async (path) => {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/**
 * 读取一个 JSON 清单。清单不存在、内容损坏或不是数组时按空清单处理，
 * 这样插件首次安装、临时损坏或升级后仍能继续列表和修复。
 */
const readManifest = async (manifestPath) => {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 创建清单目录并写入 UTF-8 JSON；调用方负责失败回滚。 */
const writeManifest = async (manifestPath, entries) => {
  await fs.mkdir(dirname(manifestPath), { recursive: true })
  await fs.writeFile(manifestPath, JSON.stringify(entries, null, 2), 'utf8')
}

/**
 * 从持久化事件块中提取适合只读预览的文本。
 * 不把完整事件对象传给 Client，避免泄露内部对象和产生不可控的序列化内容。
 */
const blockText = (block) => {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'reasoning' && typeof block.text === 'string') return `[思考] ${block.text}`
  if (block.type === 'image') return '[图片]'
  if (block.type === 'tool-call') return `[调用 ${block.name || 'tool'}] ${block.arguments || ''}`
  if (block.type === 'tool-result') return '[工具结果]'
  return ''
}

/** 将内容块数组折叠成预览文本；未知或空块不会参与拼接。 */
const contentText = (blocks) => Array.isArray(blocks) ? blocks.map(blockText).filter(Boolean).join('\n') : ''

/**
 * 把 Surface 事件压缩成 Client 只读预览所需的纯文本字段。
 * 未知事件类型不会失败，只返回最少的 seq/time/type/role/text 数据。
 */
const renderSurfaceEvent = (event) => {
  if (!event || typeof event !== 'object') return null
  const type = String(event.type || '')
  let text = ''
  let meta = ''
  if (type === 'user/message') {
    text = contentText(event.data && event.data.content)
  } else if (type === 'assistant/message') {
    text = contentText(event.data && event.data.message && event.data.message.content)
  } else if (type === 'tool/result') {
    text = contentText(event.data && event.data.message && event.data.message.content) || '工具已返回'
    if (event.data && event.data.error) {
      const failure = event.data.error
      text += `\n[失败 ${failure.name || failure.code || 'UNKNOWN'}]`
    }
  } else if (type === 'tool/call') {
    text = `[调用 ${(event.data && event.data.name) || 'tool'}]\n${(event.data && event.data.arguments) || ''}`
  }
  if (!text && event.data && typeof event.data === 'object') {
    meta = Object.keys(event.data).slice(0, 4).map((key) => `${key}=${typeof event.data[key] === 'string' ? event.data[key] : ''}`).join(' ')
  }
  return {
    seq: Number(event.seq) || 0,
    time: Number(event.time) || 0,
    type,
    role: type === 'user/message' ? 'user' : type === 'assistant/message' ? 'assistant' : type === 'tool/result' || type === 'tool/call' ? 'tool' : 'meta',
    text: text || (`(空消息)` + (meta ? ` ${meta}` : ''))
  }
}

/**
 * 读取 JSON 请求体并限制字节数。按 Buffer 字节累计而不是按字符串长度累计，
 * 避免包含多字节字符的请求体绕过 maxBytes。
 */
function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let totalBytes = 0
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buffer.length
      if (totalBytes > maxBytes) {
        if (typeof req.destroy === 'function') req.destroy()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** 标准 Zstandard frame magic，用于只扫描完整 frame 边界。 */
const ZSTD_MAGIC = 0xfd2fb528
/** 保留区预览仅显示有明确对话语义的事件，过滤权限、chunk 和内部边界记录。 */
const PREVIEW_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])

/**
 * 扫描 `.jsonl.zstd` 中完整 Zstandard frame 的字节范围。
 * 只读取结构元数据，不解压 frame 内容；最后一个不完整 frame 会被忽略，
 * 避免在只读预览时触发或模拟持久化尾部的 crash repair。
 */
const scanZstdFrames = (buffer) => {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return frames
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset++)
    if ((descriptor & 24) !== 0) return frames
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return frames
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return frames
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * 展开 JSONL 中的 chunk 打包行。普通事件原样返回；文本、reasoning 和
 * tool-call chunk 行恢复为等价的 assistant/chunk 事件，用于准确计数和预览。
 */
const expandStoredRecord = (record) => {
  if (!record || typeof record !== 'object') return []
  const tag = record.type
  if (tag !== 'text-chunks' && tag !== 'reasoning-chunks' && tag !== 'tool-call-chunks') return [record]
  const data = record.data
  const members = tag === 'tool-call-chunks' ? data && data.args : data && data.texts
  if (!Array.isArray(members)) return []
  const gaps = Array.isArray(data && data.dt) ? data.dt : []
  const events = []
  let time = Number(record.time0) || 0
  for (let index = 0; index < members.length; index += 1) {
    if (index > 0) time += Number(gaps[index - 1]) || 0
    const base = { index: data.index }
    const chunk = tag === 'tool-call-chunks'
      ? {
          type: 'tool-call-delta',
          ...base,
          id: data.id,
          ...(data.name === undefined ? {} : { name: data.name }),
          argumentsDelta: members[index]
        }
      : {
          type: tag === 'text-chunks' ? 'text-delta' : 'reasoning-delta',
          ...base,
          text: members[index]
        }
    events.push({
      type: 'assistant/chunk',
      seq: Number(record.seq0) + index,
      time,
      data: {
        turn: data.turn,
        step: data.step,
        chunk
      }
    })
  }
  return events
}

/**
 * 读取并解码保留区中的会话持久化文件。支持 DSH 默认的 `.jsonl.zstd`
 * 和未压缩的 `.jsonl`；首行 SessionHeader 作为元数据，后续行为事件日志。
 */
const readStoredSessionArtifact = async (artifactPath) => {
  const source = await fs.readFile(artifactPath)
  const text = basename(artifactPath).toLowerCase().endsWith('.zstd')
    ? scanZstdFrames(source).map(({ start, end }) => zstdDecompressSync(source.subarray(start, end)).toString('utf8')).join('\n')
    : source.toString('utf8')
  let header = null
  const events = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch (_) {
      // 预览忽略最终未写完整的 JSON 行，不因此修改或报错整个会话文件。
      continue
    }
    if (!header && record && record.type === 'session') {
      header = record
      continue
    }
    events.push(...expandStoredRecord(record))
  }
  return { header, events }
}

/**
 * Host 插件入口：注册 HTTP API，并在这里定义所有依赖 ctx 服务的操作。
 * 所有副作用都只通过 ctx.effect 注册，确保插件停止/更新时路由会被撤销。
 */
export function apply(ctx) {
  /** 读取当前工作区归档 id 集合；兼容旧版 registry 未提供数组的情况。 */
  const isArchivedSession = (id) => Array.isArray(ctx.workspaceRegistry.archivedSessionIds)
    ? ctx.workspaceRegistry.archivedSessionIds.includes(id)
    : false

  /**
   * 统一更新工作区归档列表。优先使用 registry.setState；旧版只有 storageDomain
   * handle 时，则回退到直接写 global state 和 registry.state。
   */
  const setArchivedSessionState = async (sessionId, archived) => {
    const reg = ctx.workspaceRegistry
    const domain = ctx.get('storageDomain')
    if (!domain) return false
    const handle = domain.get('workspace')
    if (!handle) return false
    const current = handle.global.get()
    if (!current || !Array.isArray(current.archivedSessionIds)) return false
    const isArchived = current.archivedSessionIds.includes(sessionId)
    if (isArchived === archived) return true
    const next = {
      ...current,
      archivedSessionIds: archived
        ? [...current.archivedSessionIds, sessionId]
        : current.archivedSessionIds.filter((id) => id !== sessionId)
    }
    if (typeof reg.setState === 'function') {
      await reg.setState(next)
    } else {
      await handle.global.set(next)
      reg.state = next
    }
    return true
  }

  /** 将工作区对象裁剪为可安全通过 JSON API 返回的最小视图。 */
  const toWorkspaceView = (workspace) => workspace
    ? { id: workspace.id, title: workspace.title, path: workspace.path }
    : null

  /** 根据会话 id 查找其当前所属工作区。 */
  const workspaceViewForSession = (id) => {
    const workspace = ctx.workspaceRegistry.list().find((ws) => ws.sessionIds.includes(id))
    return toWorkspaceView(workspace)
  }

  /** 从 sessionQuery 的 live-preferred 列表中按 id 查找记录。 */
  const findSessionRecord = async (id) => {
    const records = await ctx.sessionQuery.listSessions()
    return records.find((record) => record.header && record.header.id === id) || null
  }

  /** 调用工作区注册表的归档操作，并把异常转换为统一 API 结果。 */
  const archiveSessionById = async (id) => {
    try {
      await ctx.workspaceRegistry.archiveSession(id)
      return { ok: true, id }
    } catch (error) {
      return { ok: false, error: errText(error) }
    }
  }

  /** 读取一个会话的最新标题；任何标题服务异常都降级为“未命名会话”。 */
  const sessionTitleFor = async (id) => {
    try {
      const titles = await ctx.sessionQuery.readTitleSnapshots([id])
      for (const result of titles) {
        if (result && result.status === 'fulfilled' && result.value && result.value.title && result.value.title.title) {
          return result.value.title.title
        }
      }
    } catch (_) {}
    return '未命名会话'
  }

  /**
   * 定位一个已持久化会话的原始文件。持久化服务缺失、后端不支持、定位失败和
   * 路径缺失都返回带原因的结果，由调用方直接返回给 API。
   */
  const locateSessionFile = async (record) => {
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) return { ok: false, error: '会话持久化服务不可用' }
    if (!persistence.supportsRawArtifacts) return { ok: false, error: '当前持久化后端不支持会话文件' }
    try {
      const location = persistence.locate(record.header)
      if (!location || !location.path) return { ok: false, error: '无法定位会话文件' }
      if (!(await pathExists(location.path))) return { ok: false, error: '会话文件不存在' }
      return { ok: true, location }
    } catch (error) {
      return { ok: false, error: `无法定位会话文件: ${errText(error)}` }
    }
  }

  /**
   * 把归档会话的原始持久化文件移动到备份区或回收站。
   * 移动后先写清单；清单写入失败时把文件移回原路径，避免清单和文件不一致。
   */
  const moveToStorageSession = async (id, area) => {
    const record = await findSessionRecord(id)
    if (!record) return { ok: false, error: '会话不存在' }
    if (!record.persisted) return { ok: false, error: `该会话还没有持久化文件，无法移入${area.label}` }
    if (record.live) return { ok: false, error: `请先结束正在运行的会话，再移入${area.label}` }
    if (!isArchivedSession(id)) return { ok: false, error: `请先归档会话，再移入${area.label}` }

    const located = await locateSessionFile(record)
    if (!located.ok) return located
    const location = located.location

    const entries = await readManifest(area.manifestPath)
    if (entries.some((entry) => entry.id === id)) return { ok: false, error: `该会话已在${area.label}` }

    // 备份区额外拒绝仍存在于回收站的会话，避免两个保留区同时持有同一会话。
    if (area.kind === 'backup') {
      const trashEntries = await readManifest(STORAGE_AREAS.trash.manifestPath)
      if (trashEntries.some((entry) => entry.id === id)) return { ok: false, error: '该会话已在回收站' }
    }

    const title = await sessionTitleFor(id)
    const workspace = workspaceViewForSession(id)
    const wasArchived = isArchivedSession(id)
    const storageDir = join(area.root, id)
    const storagePath = join(storageDir, basename(location.path))
    if (await pathExists(storagePath)) return { ok: false, error: `${area.label}中已有同名会话文件` }

    await fs.mkdir(storageDir, { recursive: true })
    await fs.rename(location.path, storagePath)

    const movedAt = Date.now()
    const entry = {
      id,
      title,
      cwd: record.header.cwd || null,
      workspace,
      createdAt: Number(record.header.createdAt) || 0,
      originalPath: location.path,
      ...(area.kind === 'backup'
        ? { backedUpAt: movedAt, wasArchived }
        : { trashedAt: movedAt })
    }
    entries.push(entry)

    try {
      await writeManifest(area.manifestPath, entries)
    } catch (error) {
      try {
        await fs.rename(storagePath, location.path)
      } catch (_) {}
      throw error
    }

    // 原目录已经搬空，删除失败不阻塞本次操作；会话已由清单完整追踪。
    await fs.rmdir(dirname(location.path)).catch(() => {})
    if (isArchivedSession(id)) {
      try {
        await setArchivedSessionState(id, false)
      } catch (_) {}
    }

    return {
      ok: true,
      id,
      trashed: area.kind === 'trash',
      backedUp: area.kind === 'backup',
      path: storagePath,
      originalPath: location.path
    }
  }

  /** 根据会话记录的 cwd 重新关联工作区，保证恢复文件后仍显示在原来的分组。 */
  const reattachSessionWorkspace = async (id) => {
    const records = await ctx.sessionQuery.listSessions().catch(() => [])
    const record = records.find((item) => item.header && item.header.id === id)
    if (record && record.header.cwd) {
      const workspace = await ctx.workspaceRegistry.resolveByPath(record.header.cwd).catch(() => undefined)
      if (workspace) await workspace.attachSession(id)
    }
  }

  /**
   * 恢复会话时先写剩余清单，再移动文件。文件移动失败会回滚清单，
   * 避免清单误以为会话已经恢复而实际文件仍留在保留区。
   */
  const restoreFromStorageSession = async (id, area) => {
    const entries = await readManifest(area.manifestPath)
    const index = entries.findIndex((entry) => entry.id === id)
    if (index < 0) return { ok: false, error: `${area.label}中没有该会话` }
    const entry = entries[index]
    const source = join(area.root, id, basename(entry.originalPath || ''))
    if (!(await pathExists(source))) return { ok: false, error: `${area.label}会话文件不存在` }

    await fs.mkdir(dirname(entry.originalPath), { recursive: true })
    if (await pathExists(entry.originalPath)) return { ok: false, error: '原路径已有文件，无法恢复' }

    const remainingEntries = entries.filter((candidate) => candidate.id !== id)
    await writeManifest(area.manifestPath, remainingEntries)
    try {
      await fs.rename(source, entry.originalPath)
    } catch (error) {
      await writeManifest(area.manifestPath, entries).catch(() => {})
      throw error
    }

    await fs.rmdir(join(area.root, id)).catch(() => {})
    await reattachSessionWorkspace(id)
    const archived = await setArchivedSessionState(id, area.restoreArchived(entry))
    return { ok: true, id, archived: Boolean(archived), path: entry.originalPath }
  }

  /**
   * 彻底删除一个保留区目录及其清单项。删除目录失败时回滚清单项，
   * 这样下一次列表仍会显示该会话，而不是出现“文件存在但清单已忘掉”的状态。
   */
  const purgeFromStorageSession = async (id, area) => {
    const entries = await readManifest(area.manifestPath)
    if (!entries.some((entry) => entry.id === id)) return { ok: false, error: `${area.label}中没有该会话` }
    const remainingEntries = entries.filter((entry) => entry.id !== id)
    await writeManifest(area.manifestPath, remainingEntries)
    try {
      await fs.rm(join(area.root, id), { recursive: true, force: true })
    } catch (error) {
      await writeManifest(area.manifestPath, entries).catch(() => {})
      throw error
    }
    return { ok: true, id }
  }

  /** 把保留区清单项转换成 API item，并按各自 movedAt 字段排序、按搜索词过滤。 */
  const listStorageSessions = async (args, workspaceViews, entries, sessionCounts, area) => {
    const query = String((args && args.query) || '').trim().toLowerCase()
    const items = entries.map((entry) => ({
      id: entry.id,
      title: entry.title || '未命名会话',
      cwd: entry.cwd || null,
      workspace: entry.workspace || null,
      createdAt: Number(entry.createdAt) || 0,
      trashed: area.kind === 'trash',
      backedUp: area.kind === 'backup',
      archived: false,
      live: false,
      persisted: true,
      running: false,
      codes: [area.itemCode],
      ...(area.kind === 'backup'
        ? { backedUpAt: Number(entry.backedUpAt) || 0 }
        : { trashedAt: Number(entry.trashedAt) || 0 })
    }))
    const filtered = filterItemsByQuery(items, query)
    filtered.sort((a, b) => b[area.movedAtKey] - a[area.movedAtKey] || String(a.id).localeCompare(String(b.id)))
    return {
      ok: true,
      items: filtered,
      counts: { ...sessionCounts, [area.countKey]: entries.length },
      workspaces: workspaceViews
    }
  }

  /** 按统一的可搜索字段过滤；空搜索词返回原数组。 */
  const filterItemsByQuery = (items, query) => query
    ? items.filter((item) => itemHaystack(item).includes(query))
    : items

  /** 构造普通列表与保留区列表共用的纯文本搜索面。 */
  const itemHaystack = (item) => `${item.id} ${item.title} ${item.cwd || ''} ${item.workspace ? item.workspace.title : ''}`.toLowerCase()

  /**
   * 在移动文件前结束会话的 live 状态。这里依赖 DSH 内部 Agent/Session 生命周期对象，
   * 任一关键接口缺失或抛出异常时都拒绝继续移动，避免留下“文件已移走但会话仍运行”的状态。
   */
  const finishLiveSession = async (id) => {
    const sessionsService = ctx.get('sessions')
    const agentsService = ctx.get('agents')
    const agent = agentsService && typeof agentsService.get === 'function' ? agentsService.get(id) : undefined
    try {
      if (agent) {
        if (typeof agent.cancel === 'function') await agent.cancel({ kind: 'disposed' })
        if (typeof agent.whenIdle === 'function') await agent.whenIdle()
        if (!agent.scope || typeof agent.scope.dispose !== 'function') {
          return { ok: false, error: '无法访问会话生命周期接口，不能安全结束 live 状态' }
        }
        await agent.scope.dispose()
      }
      if (sessionsService && sessionsService.store) {
        const entry = sessionsService.store.get(id)
        if (entry && typeof entry.detach === 'function') entry.detach()
      }
      if (agentsService && agentsService.store) agentsService.store.delete(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: `结束 live 状态失败: ${errText(error)}` }
    }
  }

  /** 先安全结束 live 状态，再执行文件移动；移动阶段异常统一转成 API 结果。 */
  const finishLiveAndStoreSession = async (id, area) => {
    const ended = await finishLiveSession(id)
    if (!ended.ok) return ended
    try {
      return await moveToStorageSession(id, area)
    } catch (error) {
      return { ok: false, error: errText(error) }
    }
  }

  /** 把一个未分组会话显式关联到用户选择的工作区。 */
  const moveSession = async (args) => {
    const id = String((args && args.id) || '')
    const workspaceId = String((args && args.workspaceId) || '')
    if (!id) return { ok: false, error: '缺少会话 ID' }
    if (!workspaceId) return { ok: false, error: '请选择工作区' }
    const workspace = ctx.workspaceRegistry.get(workspaceId)
    if (!workspace) return { ok: false, error: '工作区不存在' }
    try {
      await workspace.attachSession(id)
      return { ok: true, id, workspaceId }
    } catch (error) {
      return { ok: false, error: errText(error) }
    }
  }

  /** 将普通会话从归档状态恢复，并重新关联其记录中的工作区。 */
  const restoreSession = async (id) => {
    try {
      const restored = await setArchivedSessionState(id, false)
      if (!restored) return { ok: false, error: '无法访问工作区归档状态' }
      await reattachSessionWorkspace(id)
      return { ok: true, id }
    } catch (error) {
      return { ok: false, error: errText(error) }
    }
  }

  /** 为已持久化但未分组、且 cwd 能解析到工作区的会话补齐工作区关联。 */
  const repairWorkspaceGroups = async () => {
    const records = await ctx.sessionQuery.listSessions()
    const workspaces = ctx.workspaceRegistry.list()
    const repaired = []
    const skipped = []
    for (const record of records) {
      const id = record.header.id
      if (!record.persisted) continue
      const owned = workspaces.some((ws) => ws.sessionIds.includes(id))
      if (owned) continue
      const cwd = record.header.cwd
      if (!cwd) {
        skipped.push({ id, error: 'no-cwd' })
        continue
      }
      const workspace = await ctx.workspaceRegistry.resolveByPath(cwd).catch(() => undefined)
      if (!workspace) {
        skipped.push({ id, error: 'no-workspace' })
        continue
      }
      try {
        await workspace.attachSession(id)
        repaired.push(id)
      } catch (error) {
        skipped.push({ id, error: errText(error) })
      }
    }
    return { ok: true, repaired, skipped }
  }

  /**
   * 构建普通会话列表和类别计数。备份区/回收站只在对应的 view 分支中返回，
   * 因此它们的条目不会混入 all/normal/archived 等常规计数。
   */
  const listSessions = async (args) => {
    const view = String((args && args.view) || 'all')
    const query = String((args && args.query) || '').trim().toLowerCase()
    const records = await ctx.sessionQuery.listSessions()
    const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
    const workspaces = ctx.workspaceRegistry.list()
    const workspaceViews = workspaces.map(toWorkspaceView)
    const wsBySession = new Map()
    for (const ws of workspaces) {
      const wsView = toWorkspaceView(ws)
      for (const sessionId of ws.sessionIds) {
        if (!wsBySession.has(sessionId)) wsBySession.set(sessionId, wsView)
      }
    }
    const agents = ctx.get('agents')
    const titleResults = await ctx.sessionQuery.readTitleSnapshots(records.map((record) => record.header.id)).catch(() => [])
    const titles = new Map()
    for (const result of titleResults) {
      if (result && result.status === 'fulfilled' && result.value && result.value.title) {
        titles.set(result.sessionId, result.value.title.title)
      }
    }
    const trashEntries = await readManifest(STORAGE_AREAS.trash.manifestPath)
    const backupEntries = await readManifest(STORAGE_AREAS.backup.manifestPath)
    const counts = { all: records.length, normal: 0, archived: 0, issues: 0, subagent: 0, backup: backupEntries.length, trash: trashEntries.length }
    const items = []
    for (const record of records) {
      const header = record.header
      const workspace = wsBySession.get(header.id)
      const codes = []
      if (archived.has(header.id)) codes.push('archived')
      if (header.origin === 'subagent') codes.push('subagent')
      if (Number(header.version) !== 0) codes.push('old-schema')
      if (header.cwd === undefined) codes.push('no-cwd')
      // 子代理天然不要求挂到主工作区，ungrouped 只描述普通会话的分组缺失。
      if (record.persisted && !workspace && header.origin !== 'subagent') codes.push('ungrouped')
      if (!record.live && !record.persisted) codes.push('missing-source')
      const agent = agents && typeof agents.get === 'function' ? agents.get(header.id) : undefined
      const running = Boolean(agent && agent.status === 'running')
      if (running) codes.push('running')
      const item = {
        id: header.id,
        title: titles.get(header.id) || '未命名会话',
        cwd: header.cwd || null,
        workspace,
        createdAt: Number(header.createdAt) || 0,
        parentSession: header.parentSession || null,
        origin: header.origin || null,
        agentPreset: header.agentPreset || null,
        version: Number(header.version) || 0,
        archived: archived.has(header.id),
        live: Boolean(record.live),
        persisted: Boolean(record.persisted),
        running,
        codes
      }
      if (!item.archived) counts.normal += 1
      if (item.archived) counts.archived += 1
      if (item.origin === 'subagent') counts.subagent += 1
      if (hasIssueCode(codes)) counts.issues += 1
      let visible = view === 'all'
      if (view === 'backup' || view === 'trash') visible = false
      if (view === 'normal') visible = !item.archived
      if (view === 'archived') visible = item.archived
      if (view === 'subagent') visible = item.origin === 'subagent'
      if (view === 'issues') visible = hasIssueCode(codes)
      if (!visible) continue
      if (query && !itemHaystack(item).includes(query)) continue
      items.push(item)
    }
    if (view === 'backup') return listStorageSessions(args, workspaceViews, backupEntries, counts, STORAGE_AREAS.backup)
    if (view === 'trash') return listStorageSessions(args, workspaceViews, trashEntries, counts, STORAGE_AREAS.trash)
    items.sort((a, b) => b.createdAt - a.createdAt || String(a.id).localeCompare(String(b.id)))
    return { ok: true, items, counts, workspaces: workspaceViews }
  }

  /**
   * 在备份区和回收站清单中查找会话。两类清单都为空或不存在时返回 null。
   */
  const findRetainedSession = async (id) => {
    for (const area of Object.values(STORAGE_AREAS)) {
      const entries = await readManifest(area.manifestPath)
      const entry = entries.find((candidate) => candidate.id === id)
      if (entry) return { area, entry }
    }
    return null
  }

  /**
   * 直接解析保留区文件并构建详情，不依赖 sessionQuery，因为文件已经离开
   * DSH 的普通持久化目录，sessionQuery 无法再按 id 发现它。
   */
  const detailRetainedSession = async (id, area, entry) => {
    const artifactPath = join(area.root, id, basename(entry.originalPath || ''))
    let parsed
    try {
      parsed = await readStoredSessionArtifact(artifactPath)
    } catch (error) {
      return {
        ok: true,
        id,
        eventCount: 0,
        lastActivity: Number(entry.createdAt) || 0,
        createdAt: Number(entry.createdAt) || 0,
        cwd: entry.cwd || null,
        parentSession: null,
        origin: null,
        agentPreset: null,
        preview: [],
        surfaceError: `无法读取${area.label}会话文件: ${errText(error)}`
      }
    }
    const header = parsed.header || {}
    const events = parsed.events || []
    const preview = events
      .filter((event) => PREVIEW_EVENT_TYPES.has(event.type))
      .map(renderSurfaceEvent)
      .filter(Boolean)
    const lastActivity = events.length
      ? events.reduce((max, event) => Math.max(max, Number(event.time) || 0), 0)
      : (header.createdAt || entry.createdAt || 0)
    return {
      ok: true,
      id,
      eventCount: events.length,
      lastActivity: Number(lastActivity) || 0,
      createdAt: Number(header.createdAt || entry.createdAt) || 0,
      cwd: header.cwd || entry.cwd || null,
      parentSession: header.parentSession || null,
      origin: header.origin || null,
      agentPreset: header.agentPreset || null,
      preview,
      surfaceError: null
    }
  }

  /**
   * 读取一个会话的只读预览。备份区/回收站使用独立文件解析器，普通会话使用
   * sessionQuery；Surface 读取失败会保留 surfaceError，而不是让整个详情失败。
   */
  const detailSession = async (args) => {
    const id = String((args && args.id) || '')
    if (!id) return { ok: false, error: '缺少会话 ID' }
    const retained = await findRetainedSession(id)
    if (retained) return detailRetainedSession(id, retained.area, retained.entry)
    const events = await ctx.sessionQuery.listEvents(id).catch(() => [])
    let preview = []
    let surfaceError = null
    let header = null
    try {
      const surface = await ctx.sessionQuery.readSurface(id)
      header = surface.session
      preview = surface.events.map(renderSurfaceEvent).filter(Boolean)
    } catch (error) {
      surfaceError = errText(error)
    }
    const lastActivity = events.length ? events.reduce((max, event) => Math.max(max, Number(event.time) || 0), 0) : (header ? Number(header.createdAt) || 0 : 0)
    return {
      ok: true,
      id,
      eventCount: events.length,
      lastActivity,
      createdAt: header ? Number(header.createdAt) || 0 : 0,
      cwd: header ? header.cwd || null : null,
      parentSession: header ? header.parentSession || null : null,
      origin: header ? header.origin || null : null,
      agentPreset: header ? header.agentPreset || null : null,
      preview,
      surfaceError
    }
  }

  /** 将单个 batch action 映射到对应的业务函数；备份区不注册删除动作。 */
  const runBatchAction = async (action, id) => {
    switch (action) {
      case 'restore': return restoreSession(id)
      case 'trash-restore': return restoreFromStorageSession(id, STORAGE_AREAS.trash)
      case 'trash-delete': return purgeFromStorageSession(id, STORAGE_AREAS.trash)
      case 'backup': return finishLiveAndStoreSession(id, STORAGE_AREAS.backup)
      case 'backup-restore': return restoreFromStorageSession(id, STORAGE_AREAS.backup)
      case 'archive': return archiveSessionById(id)
      case 'delete': return finishLiveAndStoreSession(id, STORAGE_AREAS.trash)
      default: return { ok: false, error: '未知批量操作' }
    }
  }

  /** 顺序执行批量动作，单个失败记录到 skipped，不中断其余会话。 */
  const batchSessions = async (args) => {
    const ids = Array.isArray(args && args.ids) ? args.ids.map((id) => String(id)).filter(Boolean) : []
    const action = String((args && args.action) || '')
    if (!ids.length) return { ok: false, error: '请选择会话' }
    if (!['restore', 'delete', 'trash-restore', 'trash-delete', 'backup', 'backup-restore', 'archive'].includes(action)) return { ok: false, error: '未知批量操作' }
    const archived = []
    const restored = []
    const deleted = []
    const backedUp = []
    const skipped = []
    for (const id of ids) {
      try {
        const result = await runBatchAction(action, id)
        if (result && result.ok) {
          if (action === 'archive') archived.push(id)
          else if (action === 'backup') backedUp.push(id)
          else if (action === 'restore' || action === 'trash-restore' || action === 'backup-restore') restored.push(id)
          else deleted.push(id)
        } else {
          skipped.push({ id, error: (result && result.error) || '操作失败' })
        }
      } catch (error) {
        skipped.push({ id, error: errText(error) })
      }
    }
    return { ok: true, archived, restored, deleted, backedUp, skipped }
  }

  /** 从可选 args 中读取字符串形式的会话 id。 */
  const requireId = (args) => String((args && args.id) || '')

  /**
   * 处理所有只接收 session ID 的 dispatch 分支，统一“缺少 ID”的校验，
   * 避免每个 case 重复写同一段返回。
   */
  const runWithRequiredId = (args, action) => {
    const id = requireId(args)
    return id ? action(id) : { ok: false, error: '缺少会话 ID' }
  }

  /** Host JSON API 的业务方法路由；未知方法返回统一错误，不抛出到 HTTP 层。 */
  const dispatch = async (method, args) => {
    switch (method) {
      case 'list': return listSessions(args)
      case 'detail': return detailSession(args)
      case 'archive': return runWithRequiredId(args, archiveSessionById)
      case 'restore': return runWithRequiredId(args, restoreSession)
      case 'delete': return runWithRequiredId(args, (id) => finishLiveAndStoreSession(id, STORAGE_AREAS.trash))
      case 'move': return moveSession(args)
      case 'repair': return repairWorkspaceGroups()
      case 'backup': return runWithRequiredId(args, (id) => finishLiveAndStoreSession(id, STORAGE_AREAS.backup))
      case 'backupRestore': return runWithRequiredId(args, (id) => restoreFromStorageSession(id, STORAGE_AREAS.backup))
      case 'trashRestore': return runWithRequiredId(args, (id) => restoreFromStorageSession(id, STORAGE_AREAS.trash))
      case 'trashPurge': return runWithRequiredId(args, (id) => purgeFromStorageSession(id, STORAGE_AREAS.trash))
      case 'batch': return batchSessions(args)
      default: return { ok: false, error: '未知操作' }
    }
  }

  /** POST-only JSON API。业务失败返回 HTTP 200 + ok:false，协议/解析失败返回 400。 */
  const route = {
    kind: 'prefix',
    path: '/api/session-manager-custom',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const body = await readJsonBody(req)
        const method = String((body && body.method) || '')
        const result = await dispatch(method, (body && body.args) || {})
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: errText(error) }))
      }
    }
  }

  // register 的返回值由 ctx.effect 管理，插件停止时 WebServer 会移除该 route。
  ctx.effect(() => ctx.webServer.register(route))
}
