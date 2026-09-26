/**
 * 离线回归检查:fork 复制整棵子 agent 树,并把它登记进父会话的目录事件。
 *
 * 覆盖:守卫(fork 子会话才处理)、已完成前缀截断、副本头部(parentSession/origin/isSeeded/
 * delegationDepth)、seed 与 inheritedEventCount 一致、递归整棵树、自有 descriptor、
 * 跳过没有 turn/end 的子 agent、副本活体释放、复制进度日志,以及
 * **父会话自有的 \`subagent/catalog\` 登记** —— v4 起子代理面板只折叠父会话自有区间的
 * 目录事件,不扫磁盘;只写副本的 parentSession 会让副本「磁盘上有、面板里没有」
 * (2026-09-26 用户报的正是这个)。另含旧副本的自愈补登记与幂等。
 *
 * 运行:node test/copy-tree.mjs
 * 夹具落在系统临时目录(不删除,重复运行直接覆盖)。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { apply, findSessionLog, scanFrames } from '../lib/index.js'

const root = join(tmpdir(), 'dsh-fork-relink-copy')
const workspace = '--ws--'
const workspaceDir = join(root, 'sessions', workspace)
process.env.DSH_HOME = root

function frame(lines) {
  return zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

async function writeLog(id, header, events) {
  const dir = join(workspaceDir, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([
    frame([JSON.stringify(header)]),
    ...(events.length > 0 ? [frame(events.map(event => JSON.stringify(event)))] : []),
  ]))
}

const event = (type, seq, data) => ({ type, seq, time: 1000 + seq, data })
const descriptorData = (label) => ({ version: 3, mode: 'continuable', provider: 'spawn', label, agentProvider: 'provider-a', agentModel: 'model-a' })
const descriptor = (label) => event('subagent/descriptor', 0, descriptorData(label))
const childHeader = (id, parent, createdAt = 1) => ({ type: 'session', version: 4, id, createdAt, isSeeded: false, cwd: 'C:/ws', parentSession: parent, origin: 'subagent', delegationDepth: 1 })
const completedChild = (id, parent, label) => [descriptor(label), event('turn/start', 1, { turn: 1 }), event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } })]

const forkA = 'session-fork-a'
const forkB = 'session-fork-b'
const A = 'parent-a'
const B = 'parent-b'
const A_CHILDREN = 11

await writeLog(A, { type: 'session', version: 4, id: A, createdAt: 1, isSeeded: false }, [])
await writeLog(B, { type: 'session', version: 4, id: B, createdAt: 1, isSeeded: false }, [])
const aChildIds = []
for (let i = 1; i <= A_CHILDREN; i++) {
  const id = `a-child-${String(i).padStart(2, '0')}`
  aChildIds.push(id)
  await writeLog(id, childHeader(id, A), completedChild(id, A, `child ${i}`))
}
// 没有已完成 turn/end:跳过并记日志。
await writeLog('a-open', childHeader('a-open', A), [descriptor('still running'), event('turn/start', 1, { turn: 1 })])
// 别家父会话的子 agent:不跟随。
await writeLog('z-other', childHeader('z-other', 'other'), completedChild('z-other', 'other', 'other'))
// 孙代理:只在复制 a-child-01 时被递归发现。
await writeLog('a-grand', childHeader('a-grand', aChildIds[0], 2), completedChild('a-grand', aChildIds[0], 'grandchild'))
// 场景 2:两份「0.3.2 之前造出来的」副本 —— 头部 parentSession 指向 forkB,但父会话里没有目录事件。
await writeLog('b-child-01', childHeader('b-child-01', B), completedChild('b-child-01', B, 'B one'))
await writeLog('b-child-02', childHeader('b-child-02', B), completedChild('b-child-02', B, 'B two'))
const legacyCopies = [
  { id: 'copy-b-01', parentId: forkB, source: 'b-child-01', createdAt: 7 },
  { id: 'copy-b-02', parentId: forkB, source: 'b-child-02', createdAt: 8 },
]
for (const copy of legacyCopies) {
  await writeLog(copy.id, { ...childHeader(copy.id, copy.parentId), createdAt: copy.createdAt, isSeeded: true }, completedChild(copy.id, copy.parentId, `copy ${copy.id}`))
}

function makeSession(header, createdAt) {
  const appended = []
  return {
    header: { ...header, createdAt },
    appended,
    ownEvents: () => appended,
    append: (type, data) => { appended.push({ type, seq: appended.length, data }); return appended.length - 1 },
  }
}

const creates = []
const disposed = []
let nextCreatedAt = 100
const parentAgents = new Map([
  [forkA, { id: forkA, ctx: {}, session: makeSession({ delegationDepth: 0 }, 1) }],
  [forkB, { id: forkB, ctx: {}, session: makeSession({ delegationDepth: 0 }, 2) }],
])
const ctx = {
  handlers: new Map(),
  on(type, handler) { this.handlers.set(type, handler); return () => this.handlers.delete(type) },
  get: () => undefined,
  agents: {
    get: (id) => parentAgents.get(id),
    create: async (options) => {
      const agent = { id: options.sessionId, ctx: {}, session: makeSession(options.meta, nextCreatedAt++) }
      options.setup?.({ get: () => undefined }, agent)
      creates.push({ options, agent })
      return { agent, dispose: async () => { disposed.push(options.sessionId) } }
    },
  },
  sessionQuery: {
    observeSession: async (id) => {
      const { readFile: read } = await import('node:fs/promises')
      const { zstdDecompressSync } = await import('node:zlib')
      const file = await findSessionLog(join(workspaceDir, id))
      const buffer = await read(file)
      const lines = []
      for (const [start, end] of scanFrames(buffer)) lines.push(...zstdDecompressSync(buffer.subarray(start, end)).toString('utf8').split('\n').filter(line => line.length > 0))
      const parsed = lines.map(line => JSON.parse(line))
      return { header: parsed[0], events: parsed.slice(1), [Symbol.dispose]: () => {} }
    },
  },
}

const logFile = join(root, 'dsh-fork-relink.log')
const offsetBefore = await stat(logFile).then(info => info.size, () => 0)
async function newLogLines() {
  const text = await readFile(logFile, 'utf8').catch(() => '')
  return text.slice(offsetBefore).split('\n').filter(line => line.length > 0).map(line => JSON.parse(line))
}

const forkSession = (id, parent) => ({ id, header: { version: 4, id, createdAt: 1, cwd: 'C:/ws', isSeeded: true, parentSession: parent, delegationDepth: 0 } })
apply(ctx)
ctx.handlers.get('session/created')(forkSession(forkA, A))
ctx.handlers.get('session/created')(forkSession(forkB, B))

const deadline = Date.now() + 15000
let lines = []
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 25))
  lines = await newLogLines()
  if (lines.filter(entry => entry.message === 'copied subagent tree').length >= 2) break
}

const failures = []
function expect(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const byMessage = (message) => lines.filter(entry => entry.message === message)
const forFork = (entries, id) => entries.filter(entry => entry.data.forkChild === id)
const catalogs = (session) => session.appended.filter(entry => entry.type === 'subagent/catalog').map(entry => entry.data)
const copyIds = creates.map(entry => entry.options.sessionId)

// —— 复制语义 ——
expect(forFork(byMessage('copying subagent tree'), forkA)[0]?.data.children, A_CHILDREN + 1, 'direct children found at the fork level')
expect(forFork(byMessage('copy progress'), forkA).map(entry => entry.data.done), [10], 'progress logged every ten children')
expect(byMessage('child copy failed').length, 0, 'no per-child failure')
expect(creates.length, A_CHILDREN + 1, 'one copy per completed child plus the grandchild')
expect(disposed.length, creates.length, 'every copy handle is disposed')
expect(creates.filter(entry => entry.options.meta.parentSession === forkA).length, A_CHILDREN, 'every direct copy hangs off the fork child')
const first = creates[0].options
expect(first.meta.isSeeded, true, 'copy is seeded')
expect(first.meta.origin, 'subagent', 'copy is a subagent session')
expect(first.meta.delegationDepth, 1, 'depth is parent depth + 1')
expect(first.inheritedEventCount, first.seed.length, 'inherited count matches the seed')
expect(first.seed.at(-1).type, 'turn/end', 'seed stops at the last completed turn')
expect(first.agentOptions, { provider: 'provider-a', model: 'model-a' }, 'descriptor provider/model become agent options')
const grand = creates.find(entry => entry.options.meta.parentSession !== forkA)
expect(grand?.options.meta.parentSession, copyIds[0], 'grandchild copy hangs off the child copy')
expect(grand?.options.meta.delegationDepth, 2, 'grandchild depth is child depth + 1')
expect(forFork(byMessage('copied subagent tree'), forkA)[0]?.data.copied.length, A_CHILDREN + 1, 'tree result counts the whole subtree')
expect(forFork(byMessage('copied subagent tree'), forkA)[0]?.data.skipped, ['a-open'], 'child without a completed turn is skipped')

// —— 父会话目录登记(面板真正读的东西)——
const forkACatalog = catalogs(parentAgents.get(forkA).session)
expect(forkACatalog.length, A_CHILDREN, 'one catalog event per direct copy')
expect(forkACatalog.map(entry => entry.childId), copyIds.filter(id => creates.find(entry => entry.options.sessionId === id)?.options.meta.parentSession === forkA), 'catalog names the direct copies in order')
expect(forkACatalog.every(entry => entry.version === 0 && entry.mode === 'continuable'), true, 'catalog entries carry version 0 and the descriptor mode')
expect(forkACatalog.map(entry => entry.label), Array.from({ length: A_CHILDREN }, (_, index) => `child ${index + 1}`), 'catalog labels come from the descriptor')
expect(forkACatalog[0]?.childCreatedAt, creates[0].agent.session.header.createdAt, 'catalog records the copy createdAt')
// 孙代理的目录条目挂在「a-child-01 的副本」名下,而不是 fork 会话。
const childCopy = creates.find(entry => entry.options.meta.parentSession === forkA)
expect(catalogs(childCopy.agent.session).map(entry => entry.childId), [grand.options.sessionId], 'grandchild is catalogued on its own parent copy')
expect(forkACatalog.some(entry => entry.childId === 'a-grand'), false, 'grandchild is not catalogued on the fork child')

// —— 旧副本自愈 + 幂等 ——
expect(forFork(byMessage('copied subagent tree'), forkB)[0]?.data.copied, [], 'self-heal creates no new session')
expect(forFork(byMessage('copied subagent tree'), forkB)[0]?.data.alreadyPopulated, true, 'self-heal reports an already populated fork')
const forkBCatalog = catalogs(parentAgents.get(forkB).session)
expect(forkBCatalog.map(entry => entry.childId), legacyCopies.map(copy => copy.id), 'existing copies are catalogued')
expect(forkBCatalog.map(entry => entry.childCreatedAt), legacyCopies.map(copy => copy.createdAt), 'existing copies keep their own createdAt')
expect(forFork(byMessage('catalogued existing copies'), forkB)[0]?.data.catalogued, legacyCopies.length, 'self-heal logs what it catalogued')
const appendedAfterHeal = parentAgents.get(forkB).session.appended.length
ctx.handlers.get('session/created')(forkSession(forkB, B))
await new Promise(resolve => setTimeout(resolve, 300))
expect(parentAgents.get(forkB).session.appended.length, appendedAfterHeal, 'reopening the healed fork appends nothing more')

if (failures.length > 0) {
  console.error('FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exitCode = 1
} else {
  console.log(`PASS — ${creates.length} copies catalogued, ${legacyCopies.length} legacy copies healed, progress logged; fixtures at ${workspaceDir}`)
}
