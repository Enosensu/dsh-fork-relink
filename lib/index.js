/**
 * dsh-fork-relink — 官方 fork 的伴随修复。
 *
 * dsh 的 fork(会话列表里的分支按钮)用新会话 id 承接被继承的历史,而子 agent
 * 会话按 parentSession 挂在父会话下——fork 后子 agent 记录因此留在旧会话上,
 * 新对话的子 agent 面板为空。
 *
 * 本插件监听官方 `session/created` 事件:fork 子会话(isSeeded 且 parentSession
 * 存在且 origin 非 subagent)进入 store 时,把旧会话的直接子 agent 记录
 * (origin === 'subagent' 的冷会话)的头帧 parentSession 重链到新会话。
 * 只重写头帧,其余帧字节原样;每次重链前备份到 $DSH_HOME/trash。
 *
 * 零 UI、零路由:原生分支按钮、easyrewrite 等任何走官方 fork 的入口都被覆盖。
 */
import { copyFile, mkdir, readdir, readFile, rename, stat, appendFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528
const LOG_FILE_NAMES = ['session.v3.jsonl.zstd', 'session.jsonl.zstd']

export const name = 'dsh-fork-relink'
export const inject = ['sessions']

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

/** 只替换头帧:新头帧重新压缩,其余帧字节原样保留(头帧独立成帧是格式保证)。 */
export function rewriteHeaderFrame(buffer, headerLine) {
  const frames = scanFrames(buffer)
  if (frames.length === 0) throw new Error('empty log')
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  const headFrame = zstdCompressSync(Buffer.from(headerLine + '\n', 'utf8'), options)
  return Buffer.concat([headFrame, buffer.subarray(frames[0][1])])
}

/** 定位一个会话所在的工作区目录(sessions 根下的 <工作区>/,会话目录的父级)。 */
async function findSessionWorkspace(sessionId) {
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
          out.push({ id: head.id, file, header: head, buffer })
        }
      } catch { /* 损坏文件不拦列表 */ }
      break
    }
  }
  return out
}

/**
 * 把 parentId 的直接子 agent 冷会话重链到 childId。
 * 只重链 fork 子会话 seed 中引用到的子 agent——spawn 事件在被丢弃尾部里的
 * 子 agent 属于被分支抛弃的路线,不跟随。
 * 运行中的子 agent(内存里活着)头帧会被内存态覆盖,跳过并记录。
 */
async function relinkChildren(ctx, parentId, childId, seedEvents) {
  if (parentId === childId) return { relinked: [], skipped: [], unrelated: [] }
  const workspaceDir = await findSessionWorkspace(parentId)
  if (workspaceDir === undefined) return { relinked: [], skipped: [], unrelated: [] }
  const seedText = seedEvents.map(evt => JSON.stringify(evt)).join('\n')
  const relinked = []
  const skipped = []
  const unrelated = []
  for (const childSession of await findChildSessions(workspaceDir, parentId)) {
    if (ctx.sessions.get(childSession.id) !== undefined) { skipped.push(childSession.id); continue }
    if (!seedText.includes(childSession.id)) { unrelated.push(childSession.id); continue }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const backup = join(dshHome(), 'trash', `${childSession.id}-header.bak-${stamp}`)
    await mkdir(dirname(backup), { recursive: true })
    await copyFile(childSession.file, backup)
    const nextHead = { ...childSession.header, parentSession: childId }
    await writeFile(childSession.file + '.relink', rewriteHeaderFrame(childSession.buffer, JSON.stringify(nextHead)))
    await rename(childSession.file + '.relink', childSession.file)
    relinked.push(childSession.id)
  }
  return { relinked, skipped, unrelated }
}

/** 静默包含:一次重链失败不影响事件分发与其余 fork。 */
function relinkContained(ctx, parentId, childId, seedEvents) {
  void relinkChildren(ctx, parentId, childId, seedEvents)
    .then((result) => {
      log('relink result', { parentId, childId, ...result })
      return result
    })
    .catch((error) => {
      log('relink failed', { parentId, childId, message: String(error?.message ?? error) })
    })
}

export function apply(ctx) {
  const disposer = ctx.on('session/created', (session) => {
    const header = session.header
    // 只处理 fork 子会话:isSeeded 且有父会话,且不是子 agent 自身的创建
    // (子 agent 生成也带 parentSession,若不排除会把主会话已有子 agent 错误吸走)
    if (!header.isSeeded || header.parentSession === undefined || header.origin === 'subagent') return
    relinkContained(ctx, header.parentSession, session.id, session.snapshotEvents())
  })
  return disposer
}
