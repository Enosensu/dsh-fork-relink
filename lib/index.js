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
 *   - `seed` = 原子 agent 的完整持久日志;`inheritedEventCount` = seed 长度;
 *   - `agentOptions` 取原子 agent descriptor 里的 provider/model;
 *   - `setup` 里经官方 `agentPresets.composeFrom(childCtx, forkChildAgent.ctx)`
 *     加入 fork 子会话的组合(与 spawn 路径同一入口)。
 * 旧会话的子 agent 记录原样保留(不偷走);副本递归复制自己的子 agent。
 *
 * 过滤:运行中的子 agent(内存里活着)跳过;fork 子会话 seed 未引用的子 agent
 * (属于被分支抛弃的路线)不跟随。
 *
 * 零 UI、零路由、零依赖、零文件手术:全部走官方 API。官方若原生实现
 * children relink,卸载本插件即可,无残留。
 */
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528
const LOG_FILE_NAMES = ['session.v3.jsonl.zstd', 'session.jsonl.zstd']

export const name = 'dsh-fork-relink'
export const inject = ['sessions', 'agents', 'sessionQuery', 'agentPresets', 'sessionController']

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
  const buffer = await readFile(childSession.file)
  const frames = scanFrames(buffer)
  const lines = []
  for (const [start, end] of frames) {
    const text = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    lines.push(...text.split('\n').filter(l => l.length > 0))
  }
  const parsed = lines.map(l => JSON.parse(l))
  const lastSeedMarker = parsed.map((e, i) => ({ e, i })).filter(x => x.e.type === 'session/end-seed').pop()
  const ownStart = lastSeedMarker === undefined ? 0 : lastSeedMarker.i + 1
  const hasOwn = parsed.slice(ownStart).some(e => e.type === 'subagent/descriptor')
  if (hasOwn) return
  const inheritedDescriptor = descriptorOf(parsed)
  if (inheritedDescriptor === undefined) return
  const ownEvent = { type: 'subagent/descriptor', seq: parsed[parsed.length - 1].seq + 1, time: Date.now(), data: inheritedDescriptor }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backup = join(dshHome(), 'trash', `${childSession.id}-log.bak-${stamp}`)
  await mkdir(dirname(backup), { recursive: true })
  await copyFile(childSession.file, backup)
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  const eventLine = JSON.stringify(ownEvent) + '\n'
  await writeFile(childSession.file + '.repair', Buffer.concat([buffer, zstdCompressSync(Buffer.from(eventLine, 'utf8'), options)]))
  await rename(childSession.file + '.repair', childSession.file)
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
 * 已填充过,整轮跳过(打开旧 fork 会话的 resume 不会重复复制)。
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
      await ctx.agents.create({
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
      copied.push(copyId)
      // 递归:副本的子 agent = 原子 agent 的子 agent 的副本
      const deeper = await copyChildren(ctx, child.id, ctx.agents.get(copyId))
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
  }
  return { copied, skipped, unrelated }
}

/**
 * 折叠 fork 子会话继承区间内的未消费队列项(agent/inbox/spliced 的 splice 语义:
 * 自 start 起删 removedCount 个再插入 inserted;claimed/discarded 只是通知,
 * 真实状态全在 splice 序列里)。
 */
function inheritedPendingInbox(session) {
  const inheritedCount = session.inheritedEventCount
  const events = session.snapshotEvents(0, inheritedCount)
  const queues = { 'next-turn': [], 'next-step': [] }
  for (const evt of events) {
    if (evt.type !== 'agent/inbox/spliced') continue
    const queue = queues[evt.data.target]
    if (!queue) continue
    queue.splice(evt.data.start ?? 0, evt.data.removedCount ?? 0, ...evt.data.inserted)
  }
  return [...queues['next-turn'], ...queues['next-step']]
}

/**
 * 清除 fork 子会话从父会话继承的遗留队列(经官方 updateQueue remove,
 * 走活体 agent 的收件箱,内存与日志一致)。子会话自己创建后排队的项不受影响。
 */
async function purgeInheritedQueue(controller, session) {
  await new Promise(resolve => setTimeout(resolve, 500))
  const inheritedCount = session.inheritedEventCount
  const inherited = session.snapshotEvents(0, inheritedCount)
  log('purge fold', { sessionId: session.id, inheritedCount, inheritedEvents: inherited.length, spliceCount: inherited.filter(e => e.type === 'agent/inbox/spliced').length })
  const pending = inheritedPendingInbox(session)
  log('purge pending', { pending: pending.map(m => ({ id: m.id, seq: m.seq })) })
  if (pending.length === 0) return []
  const purged = []
  for (const message of pending) {
    try {
      await controller.updateQueue({
        sessionId: session.id,
        itemId: message.id,
        action: { kind: 'remove' },
      })
      purged.push(message.id)
    } catch (error) {
      log('queue purge failed', { sessionId: session.id, itemId: message.id, message: String(error?.message ?? error) })
    }
  }
  return purged
}

export function apply(ctx) {
  // ===== SELFTEST(临时):fork 带积压队列的会话,验证队列清除 + 子代理复制 =====
  setTimeout(async () => {
    try {
      await ctx.agents.resume({ resumeSessionId: 'session-78f1b781-2522-4c9e-83c8-97638c4ffc2b' })
      log('selftest resumed 78f1b781')
    } catch (e) {
      log('selftest failed', { message: String(e?.message ?? e) })
    }
  }, 10000)
  // ===== SELFTEST END =====
  const disposer = ctx.on('session/created', (session) => {
    const header = session.header
    // 只处理 fork 子会话(isSeeded + 有父会话);普通新会话与子 agent 生成不在其列
    if (!header.isSeeded || header.parentSession === undefined) return
    const isSubagentCopy = header.origin === 'subagent'
    void (async () => {
      // 1. 清掉从父会话继承的遗留队列:否则继续对话时先被消费的是队头老消息
      const purged = await purgeInheritedQueue(ctx.sessionController, session)
      // 2. 主对话的 fork:为旧会话的直接子 agent 创建副本(递归整棵树);
      //    子 agent 副本自己的树复制由 copyChildren 的显式递归完成,不在此处
      if (isSubagentCopy) {
        if (purged.length > 0) log('purged inherited queue on subagent copy', { forkChild: session.id, purged })
        return
      }
      const parentAgent = ctx.agents.get(session.id)
      if (parentAgent === undefined) {
        log('fork child has no live agent; skipped', { childId: session.id })
        return
      }
      const result = await copyChildren(ctx, header.parentSession, parentAgent)
      log('copied subagent tree', { forkChild: session.id, ...result, purged })
    })().catch((error) => {
      log('fork follow-up failed', { forkChild: session.id, message: String(error?.message ?? error) })
    })
  })
  return disposer
}
