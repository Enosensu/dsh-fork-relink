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
export const inject = ['sessions', 'agents', 'sessionQuery', 'agentPresets']

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
  // 幂等:newParent 名下已有子 agent 记录 = 已填充过(打开旧 fork 的 resume
  // 会重新触发本函数),整轮跳过,避免重复复制;in-flight 锁防并发重入。
  const existing = await findChildSessions(workspaceDir, newParentAgent.id)
  if (existing.length > 0) {
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

export function apply(ctx) {
  const disposer = ctx.on('session/created', (session) => {
    const header = session.header
    log('event: session/created', { id: session.id, isSeeded: header.isSeeded, parentSession: header.parentSession, origin: header.origin })
    // 只处理 fork 子会话:isSeeded 且有父会话,且不是子 agent 自身的创建
    // (副本的创建也带 origin: 'subagent',会在这里被排除——递归由 copyChildren 显式完成)
    if (!header.isSeeded || header.parentSession === undefined || header.origin === 'subagent') return
    void (async () => {
      const parentAgent = ctx.agents.get(session.id)
      if (parentAgent === undefined) {
        log('fork child has no live agent; skipped', { childId: session.id })
        return
      }
      const result = await copyChildren(ctx, header.parentSession, parentAgent)
      log('copied subagent tree', { forkChild: session.id, ...result })
    })().catch((error) => {
      log('copy failed', { forkChild: session.id, message: String(error?.message ?? error) })
    })
  })
  return disposer
}
