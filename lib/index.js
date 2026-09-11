/**
 * dsh-fork-relink — 官方 fork 的伴随复制插件。
 *
 * 问题:官方 fork(会话列表的分支按钮)用新会话 id 承接被继承的历史,而子 agent
 * 会话按头部的 `parentSession` 挂在父会话下——fork 之后子 agent 记录留在旧会话上,
 * 新对话的子 agent 面板为空。
 *
 * 方案(复制,而非转移):监听官方 `session/created` 事件;fork 子会话进入 store
 * 时,为旧会话的每个直接子 agent(`origin === 'subagent'` 的冷会话)调用官方
 * `agents.create` 创建**完整副本**:
 *   - `meta.parentSession` 指向 fork 子会话(创建时即正确,无文件改写);
 *   - `meta.origin: 'subagent'`、`delegationDepth` = 父 +1;
 *   - `seed` = 原子 agent 的持久日志的「已完成前缀」(截到最后一个 turn/end);
 *   - `agentOptions` 取原子 agent descriptor 里的 provider/model;
 *   - `setup` 里经官方 `agentPresets.composeFrom(childCtx, forkChildAgent.ctx)`
 *     加入 fork 子会话的组合(与 spawn 路径同一入口),并追加副本自己的
 *     descriptor(身份投影 last-wins + isOwnSeq 判定需要自有事件);
 *   - 副本创建后**立即释放活体**(见 {@link releaseCopies}):留活的副本会持写租约
 *     又不在 continuation manager 的 resident 表里,`send_message` 会被自己的租约
 *     顶掉、报 "is unavailable";副本留在磁盘上成为官方冷恢复可寻址的冷会话。
 * 旧会话的子 agent 记录原样保留(复制而非转移);副本递归复制自己的子 agent。
 *
 * 队列可见化:fork 会继承父会话的未消费排队消息(agent/inbox/spliced 折叠),
 * 它们会在继续对话时先于新消息送达模型,而官方 QueueDock 对这类继承项不显示。
 * 本插件提供 /log-prune/queue(读取,活体优先、冷会话读文件)与
 * /log-prune/queue/remove(经官方 updateQueue remove 删除),客户端在输入框
 * 上方的 dock 里显示这些排队项并提供逐条删除/全部清除。
 *
 * 幂等:目标名下已有子 agent 记录时整轮跳过(打开旧 fork 的 resume 不会重复
 * 复制);闸门同时自愈缺自有 descriptor 的旧副本。单副本失败不拖垮整棵树。
 *
 * 零依赖:除上述外全部走官方 API。官方若原生实现子代理同步 fork,卸载即可。
 */
import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528
const LOG_FILE_NAMES = ['session.v3.jsonl.zstd', 'session.jsonl.zstd']

export const name = 'dsh-fork-relink'
export const inject = ['webServer', 'sessions', 'agents', 'sessionQuery', 'agentPresets', 'sessionController']

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

let logQueue = Promise.resolve()
function log(message, data) {
  const line = JSON.stringify({ t: new Date().toISOString(), message, data: data ?? null }) + '\n'
  logQueue = logQueue.then(async () => {
    try {
      const file = join(dshHome(), 'dsh-fork-relink.log')
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, line, 'utf8')
    } catch { /* 日志失败不抛 */ }
  })
  return logQueue
}

/**
 * 结构化扫描拼接 zstd 帧的边界(不依赖 magic 盲扫,避免压缩载荷中的伪 magic)。
 * 与 dsh 自己的 scanZstdFrames 同规则:校验 magic、帧头描述符保留位、
 * 逐 block 头推进、可选校验和尾。返回完整帧的字节区间 [start, end]。
 */
export function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error('trailing bytes below frame magic')
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) throw new Error('frame ends after magic')
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) throw new Error('truncated frame header')
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error('truncated block header')
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) throw new Error('truncated block payload')
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error('truncated checksum')
      offset += 4
    }
    frames.push([start, offset])
  }
  return frames
}

/** 读取一个会话日志文件的全部事件行(多帧拼接)。 */
function readLogLines(buffer) {
  const frames = scanFrames(buffer)
  let text = ''
  for (const [start, end] of frames) {
    text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
  }
  return text.split('\n').filter(l => l.length > 0)
}

/** 在一个工作区目录里枚举「父会话 = parentId」的子 agent 会话(读头帧)。 */
export async function findChildSessions(workspaceDir, parentId) {
  const out = []
  let entries
  try {
    entries = await readdir(workspaceDir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === parentId) continue
    const dir = join(workspaceDir, name)
    const info = await stat(dir).catch(() => undefined)
    if (!info?.isDirectory()) continue
    for (const logName of LOG_FILE_NAMES) {
      const file = join(dir, logName)
      if (!existsSync(file)) continue
      try {
        const buffer = await readFile(file)
        const frames = scanFrames(buffer)
        const firstFrameText = zstdDecompressSync(buffer.subarray(frames[0][0], frames[0][1])).toString('utf8')
        const head = JSON.parse(firstFrameText)
        if (head.type !== 'session') break
        if (head.parentSession === parentId && head.origin === 'subagent') {
          out.push({ id: head.id, file, header: head })
        }
      } catch { /* 损坏文件不拦列表 */ }
      break
    }
  }
  return out
}

/**
 * 自愈:给「唯一 descriptor 在继承区间内」的副本补上自有 descriptor。
 * 活会话走 session.append(内存+日志一致);冷会话按帧格式追加一帧(先备份)。
 */
export async function repairOwnDescriptor(ctx, childSession) {
  const live = ctx.agents.get(childSession.id)
  if (live !== undefined) {
    const inheritedCount = live.session.inheritedEventCount
    const hasOwn = live.session.ownEvents().some(e => e.type === 'subagent/descriptor')
    if (hasOwn) return
    const inheritedDescriptor = descriptorOf(live.session.snapshotEvents(0, inheritedCount))
    if (inheritedDescriptor === undefined) return
    live.session.append('subagent/descriptor', inheritedDescriptor)
    log('repaired own descriptor (live)', { childId: childSession.id })
    return
  }
  const file = childSession.file ?? await findSessionLogFile(childSession.id)
  if (file === undefined) return
  const buffer = await readFile(file)
  const frames = scanFrames(buffer)
  const lines = []
  for (const [start, end] of frames) {
    const text = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    lines.push(...text.split('\n').filter(l => l.length > 0))
  }
  const parsed = parseLogLines(lines)
  const ownStart = inheritedCutOf(parsed)
  const hasOwn = parsed.slice(ownStart).some(e => e.type === 'subagent/descriptor')
  if (hasOwn) return
  const inheritedDescriptor = descriptorOf(parsed)
  if (inheritedDescriptor === undefined) return
  const ownEvent = { type: 'subagent/descriptor', seq: parsed[parsed.length - 1].seq + 1, time: Date.now(), data: inheritedDescriptor }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backup = join(dshHome(), 'trash', `${childSession.id}-log.bak-${stamp}`)
  await mkdir(dirname(backup), { recursive: true })
  await copyFile(file, backup)
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  const eventLine = JSON.stringify(ownEvent) + '\n'
  await writeFile(file + '.repair', Buffer.concat([buffer, zstdCompressSync(Buffer.from(eventLine, 'utf8'), options)]))
  await rename(file + '.repair', file)
  log('repaired own descriptor (cold)', { childId: childSession.id, seq: ownEvent.seq })
}

/** 定位一个会话所在的工作区目录(sessions 根下的 <工作区>/)。 */
export async function findSessionWorkspace(sessionId) {
  const root = join(dshHome(), 'sessions')
  let workspaces
  try {
    workspaces = await readdir(root)
  } catch {
    return undefined
  }
  for (const workspace of workspaces) {
    const dir = join(root, workspace, sessionId)
    if (!existsSync(dir)) continue
    const info = await stat(dir).catch(() => undefined)
    if (info?.isDirectory()) return join(root, workspace)
  }
  return undefined
}

async function findSessionLogFile(sessionId) {
  const workspace = await findSessionWorkspace(sessionId)
  if (workspace === undefined) return undefined
  for (const logName of LOG_FILE_NAMES) {
    const file = join(workspace, sessionId, logName)
    if (existsSync(file)) return file
  }
  return undefined
}

/** 从子 agent 的持久事件里取最后一条 descriptor(spawn 时的 provider/model/mode/label)。 */
function descriptorOf(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'subagent/descriptor') return events[i].data
  }
  return undefined
}

/**
 * 为 sourceId 的每个直接子 agent 创建副本,挂到 newParent(一个 Agent)下,
 * 并递归复制子树的更深层。幂等:newParent 名下已有子 agent 记录时视为
 * 已填充过,整轮跳过(打开旧 fork 会话的 resume 不会重复复制);
 * 闸门同时自愈缺自有 descriptor 的旧副本。
 */
const inflight = new Set()

async function copyChildren(ctx, sourceId, newParentAgent) {
  const copied = []
  const skipped = []
  const unrelated = []
  const workspaceDir = await findSessionWorkspace(sourceId)
  if (workspaceDir === undefined) return { copied, skipped, unrelated }
  // 幂等 + 自愈:newParent 名下已有子 agent 记录 = 已填充过,不再复制;但其中
  // 缺「自有 descriptor」的旧副本(修复前生成的)当场补上,否则目录永远省略它们。
  const existing = await findChildSessions(workspaceDir, newParentAgent.id)
  if (existing.length > 0) {
    for (const existingChild of existing) {
      try {
        await repairOwnDescriptor(ctx, existingChild)
      } catch (error) {
        log('descriptor repair failed', { childId: existingChild.id, message: String(error?.message ?? error) })
      }
    }
    skipped.push(...existing.map(c => c.id))
    return { copied, skipped, unrelated, alreadyPopulated: true }
  }
  if (inflight.has(newParentAgent.id)) return { copied, skipped, unrelated, alreadyPopulated: true }
  inflight.add(newParentAgent.id)
  const created = []
  try {
    for (const child of await findChildSessions(workspaceDir, sourceId)) {
      try {
        // 只复制「已完成前缀」:截到最后一个 turn/end。运行中的子 agent 只带已完成
        // 部分(与官方 fork 语义一致);空闲注册的副本照常全量复制。
        const observed = await ctx.sessionQuery.observeSession(child.id)
        let lastClosed = -1
        for (let i = observed.events.length - 1; i >= 0; i--) {
          if (observed.events[i].type === 'turn/end') { lastClosed = i; break }
        }
        if (lastClosed === -1) { skipped.push(child.id); continue }
        const seed = observed.events.slice(0, lastClosed + 1)
        const descriptor = descriptorOf(seed)
        const copyId = `session-${randomUUID()}`
        const handle = await ctx.agents.create({
          sessionId: copyId,
          parentAgent: newParentAgent,
          meta: {
            ...(observed.header.cwd !== undefined ? { cwd: observed.header.cwd } : {}),
            ...(observed.header.agentPreset !== undefined ? { agentPreset: observed.header.agentPreset } : {}),
            parentSession: newParentAgent.id,
            isSeeded: true,
            origin: 'subagent',
            delegationDepth: (newParentAgent.session.header.delegationDepth ?? 0) + 1,
          },
          seed,
          inheritedEventCount: seed.length,
          ...(descriptor?.agentProvider !== undefined && descriptor?.agentModel !== undefined
            ? { agentOptions: { provider: descriptor.agentProvider, model: descriptor.agentModel } }
            : {}),
          setup: (childCtx, child) => {
            // 与 spawn 路径同一入口:副本加入 fork 子会话的组合
            childCtx.get('agentPresets')?.composeFrom(childCtx, newParentAgent.ctx)
            // 追加副本自己的 descriptor(seed 里继承的是祖先的,identity 投影按
            // last-wins + isOwnSeq 判定——没有自己的 descriptor,目录会永远省略该行)
            if (descriptor !== undefined) child.session.append('subagent/descriptor', descriptor)
          },
        })
        created.push({ copyId, handle })
        copied.push(copyId)
        // 递归:副本的子 agent = 原子 agent 的子 agent 的副本
        const deeper = await copyChildren(ctx, child.id, handle.agent)
        copied.push(...deeper.copied)
        skipped.push(...deeper.skipped)
        unrelated.push(...deeper.unrelated)
      } catch (error) {
        // 单个子副本失败不拖垮整棵树
        log('child copy failed', { childId: child.id, message: String(error?.message ?? error) })
        skipped.push(child.id)
      }
    }
  } finally {
    inflight.delete(newParentAgent.id)
    await releaseCopies(ctx, created)
  }
  return { copied, skipped, unrelated }
}

/**
 * 释放副本的活体,把副本留在磁盘上成为冷会话。
 *
 * 这不是省资源,而是可寻址性的前提:插件经 `agents.create` 创建的活体会持有该
 * 会话的写租约,而它又不在 continuation manager 的 resident 表里 —— 于是
 * `send_message` 既不会走活体投递,也会在冷恢复第一步
 * `persistence.open(id, 'write')` 上被自己的写租约拒绝
 * (`SessionAlreadyOwnedError`),对外表现为 `subagent "…" is unavailable`:
 * 目录里看得见、消息发不进。释放活体后副本成为官方 resume 路径可寻址的冷会话,
 * 首次发消息由官方冷恢复按 descriptor 唤醒。
 */
async function releaseCopies(ctx, created) {
  for (const { copyId, handle } of [...created].reverse()) {
    try {
      await handle.dispose()
      log('released copy (cold)', { copyId })
    } catch (error) {
      log('copy release failed', { copyId, message: String(error?.message ?? error) })
    }
  }
}

/**
 * 复核副本确实能被官方恢复路径寻址:写租约可得 = `send_message` 的冷恢复走得通。
 * 不可寻址时记日志,不静默(这正是本次故障缺席的断言)。
 */
async function verifyCopyResumable(ctx, copyId) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return true
  try {
    const handle = await persistence.open(copyId, 'write')
    await handle.close()
    return true
  } catch (error) {
    log('copy is not resumable', { copyId, message: String(error?.message ?? error) })
    return false
  }
}

/** 折叠 splice 序列为未消费队列(agent/inbox/spliced 的 splice 语义)。 */
function foldInbox(events) {
  const queues = { 'next-turn': [], 'next-step': [] }
  for (const evt of events) {
    if (evt.type !== 'agent/inbox/spliced') continue
    const queue = queues[evt.data.target]
    if (!queue) continue
    queue.splice(evt.data.start ?? 0, evt.data.removedCount ?? 0, ...evt.data.inserted)
  }
  return [...queues['next-turn'], ...queues['next-step']]
}

/** 日志行 = 首行会话头部 + 事件行;去掉头部后事件下标与 seq 一致。 */
function parseLogLines(lines) {
  const parsed = lines.map(l => JSON.parse(l))
  return parsed[0]?.type === 'session' ? parsed.slice(1) : parsed
}

/**
 * 继承前缀在事件序列里的长度:被 fork 的子会话在继承切点处追加一条
 * `session/end-seed { inherited: true }`(seq = 前缀长度),取最后一条即本会话的切点。
 * 无该标记(非 fork 会话)时为 0。
 */
function inheritedCutOf(events) {
  let cut = 0
  for (const evt of events) {
    if (evt.type === 'session/end-seed' && evt.data?.inherited === true) cut = evt.seq
  }
  return cut
}

function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join(' ')
    .slice(0, 160)
}

/** 折叠出当前队列,并标出「由继承前缀引入」的项(文案与判定共用同一前缀切点)。 */
function describeQueue(events, inheritedCut) {
  const inheritedIds = new Set(foldInbox(events.slice(0, inheritedCut)).map(m => m.id))
  return foldInbox(events).map(m => ({
    id: m.id,
    text: messageText(m),
    inherited: inheritedIds.has(m.id),
  }))
}

/** 读取一个会话的未消费队列项(活体优先;活体读取失败或冷会话读日志文件)。 */
export async function readQueueItems(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) {
    try {
      return describeQueue(live.snapshotEvents(), live.inheritedEventCount)
    } catch (error) {
      // 活体读取出错不得让队列整条消失:退回持久日志再折一次
      log('live queue read failed; reading the log file instead', {
        sessionId, message: String(error?.message ?? error),
      })
    }
  }
  const file = await findSessionLogFile(sessionId)
  if (file === undefined) return []
  const events = parseLogLines(readLogLines(await readFile(file)))
  return describeQueue(events, inheritedCutOf(events))
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** 同源校验(浏览器侧 CSRF 围栏;本地进程本就能读这些文件)。 */
function requestFromSameOrigin(req) {
  try {
    const origin = req.headers?.origin || req.headers?.referer
    if (!origin) return true
    if (origin === 'null') return false
    const host = req.headers?.host
    if (!host) return false
    return new URL(origin).host === host
  } catch { return false }
}

async function readJsonBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { req.removeAllListeners('data'); req.resume(); reject(new Error('body-too-large')); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

export function apply(ctx) {
  const disposers = []
  // 队列可见化:读取(活体优先,冷会话读文件)
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/log-prune/queue',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        if (!requestFromSameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        const body = await readJsonBody(req)
        const { sessionId } = body
        if (typeof sessionId !== 'string' || !/^[A-Za-z0-9-]+$/.test(sessionId) || sessionId.length > 128) {
          sendJson(res, 400, { ok: false, error: 'invalid-session-id' }); return
        }
        const items = await readQueueItems(ctx, sessionId)
        sendJson(res, 200, { ok: true, items })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: 'internal', message: String(error?.message ?? error) })
      }
    },
  }))
  // 队列项删除:经官方 updateQueue remove(要求会话在当前服务器内处于打开状态)
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/log-prune/queue/remove',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
        if (!requestFromSameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        const body = await readJsonBody(req)
        const { sessionId, itemId } = body
        if (typeof sessionId !== 'string' || !/^[A-Za-z0-9-]+$/.test(sessionId) || sessionId.length > 128
          || typeof itemId !== 'string' || itemId.length === 0 || itemId.length > 128) {
          sendJson(res, 400, { ok: false, error: 'invalid-request' }); return
        }
        await ctx.sessionController.updateQueue({ sessionId, itemId, action: { kind: 'remove' } })
        log('queue item removed', { sessionId, itemId })
        sendJson(res, 200, { ok: true })
      } catch (error) {
        log('queue remove failed', { message: String(error?.message ?? error) })
        sendJson(res, 400, { ok: false, error: 'remove-refused', message: String(error?.message ?? error) })
      }
    },
  }))
  const disposer = ctx.on('session/created', (session) => {
    const header = session.header
    // 只处理 fork 子会话(isSeeded + 有父会话);普通新会话与子 agent 生成不在其列
    if (!header.isSeeded || header.parentSession === undefined) return
    const isSubagentCopy = header.origin === 'subagent'
    if (isSubagentCopy) return
    // 主对话的 fork:为旧会话的直接子 agent 创建副本(递归整棵树);
    // 子 agent 副本自己的树复制由 copyChildren 的显式递归完成,不在此处。
    // 继承的排队消息保持原样(不清除);可见化与手动删除走 /log-prune/queue。
    void (async () => {
      const parentAgent = ctx.agents.get(session.id)
      if (parentAgent === undefined) {
        log('fork child has no live agent; skipped', { childId: session.id })
        return
      }
      const result = await copyChildren(ctx, header.parentSession, parentAgent)
      // 可寻址性断言:每个副本都必须能被官方恢复路径拿到写租约,否则
      // send_message 会以 "is unavailable" 收场(目录里看得见、消息发不进)。
      const unresumable = []
      for (const copyId of result.copied) {
        if (!await verifyCopyResumable(ctx, copyId)) unresumable.push(copyId)
      }
      log('copied subagent tree', { forkChild: session.id, ...result, unresumable })
    })().catch((error) => {
      log('fork follow-up failed', { forkChild: session.id, message: String(error?.message ?? error) })
    })
  })
  disposers.push(disposer)
  return () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } }
}
