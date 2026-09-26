/**
 * 离线回归检查:fork 复制整棵子 agent 树(驱动 apply 的 `session/created` 入口)。
 *
 * 覆盖:守卫(fork 子会话才处理)、已完成前缀截断、副本头部(parentSession/origin/isSeeded/
 * delegationDepth)、seed 与 inheritedEventCount 一致、递归整棵树、自家 descriptor 落位、
 * 单副本失败/跳过不拖垮整棵树、副本活体释放,以及复制期间的进度日志
 * (`copying subagent tree` / `copy progress`)——2026-09-26 的误报正是「静默两分钟」造成的。
 *
 * 运行:node test/copy-tree.mjs
 * 夹具落在系统临时目录(不删除,重复运行直接覆盖)。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { apply } from '../lib/index.js'

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
const descriptor = (label) => event('subagent/descriptor', 0, {
  version: 3, mode: 'continuable', provider: 'spawn', label,
  agentProvider: 'provider-a', agentModel: 'model-a',
})
/** 一份「已完成」的子 agent 日志:自有 descriptor + 一个闭合的 turn。 */
const completed = (id, label) => [
  { header: { type: 'session', version: 4, id, createdAt: 1, isSeeded: false, parentSession: 'parent', origin: 'subagent', delegationDepth: 1 }, events: [descriptor(label), event('turn/start', 1, { turn: 1 }), event('turn/end', 2, { turn: 1 })] },
]

const forkChildId = 'session-fork-child'
const parentId = 'parent'
await writeLog(parentId, { type: 'session', version: 4, id: parentId, createdAt: 1, isSeeded: false }, [])
const NORMAL = 11
for (let i = 1; i <= NORMAL; i++) {
  const [fixture] = completed(`child-${String(i).padStart(2, '0')}`, `child ${i}`)
  await writeLog(fixture.header.id, fixture.header, fixture.events)
}
// 没有已完成 turn/end 的子 agent:跳过并记日志。
await writeLog('child-open', { type: 'session', version: 4, id: 'child-open', createdAt: 1, isSeeded: false, parentSession: parentId, origin: 'subagent' }, [descriptor('still running'), event('turn/start', 1, { turn: 1 })])
// 别家父会话的子 agent:不跟随。
await writeLog('child-other', { type: 'session', version: 4, id: 'child-other', createdAt: 1, isSeeded: false, parentSession: 'other', origin: 'subagent' }, [descriptor('other'), event('turn/start', 1, {}), event('turn/end', 2, {})])
// 孙代理:只在复制 child-01 时被递归发现。
await writeLog('grand-01', { type: 'session', version: 4, id: 'grand-01', createdAt: 1, isSeeded: false, parentSession: 'child-01', origin: 'subagent', delegationDepth: 2 }, [descriptor('grandchild'), event('turn/start', 1, {}), event('turn/end', 2, {})])

const creates = []
const disposed = []
const fakeAgent = (options) => ({
  id: options.sessionId,
  ctx: {},
  session: { header: { ...options.meta }, append: () => {} },
})
const ctx = {
  handlers: new Map(),
  on(type, handler) { this.handlers.set(type, handler); return () => this.handlers.delete(type) },
  get: () => undefined,
  agents: {
    get: (id) => (id === forkChildId ? { id, ctx: {}, session: { header: { delegationDepth: 0 } } } : undefined),
    create: async (options) => {
      const agent = fakeAgent(options)
      // setup 必须与工厂一样在返回前跑,副本才有自有 descriptor。
      options.setup?.({ get: () => undefined }, agent)
      creates.push({ options, agent })
      return { agent, dispose: async () => { disposed.push(options.sessionId) } }
    },
  },
  sessionQuery: {
    observeSession: async (id) => {
      const { readFile: read } = await import('node:fs/promises')
      const { scanFrames, findSessionLog } = await import('../lib/index.js')
      const { zstdDecompressSync } = await import('node:zlib')
      const file = await findSessionLog(join(workspaceDir, id))
      const buffer = await read(file)
      const lines = []
      for (const [start, end] of scanFrames(buffer)) lines.push(...zstdDecompressSync(buffer.subarray(start, end)).toString('utf8').split('\n').filter(line => line.length > 0))
      const parsed = lines.map(line => JSON.parse(line))
      const header = parsed[0]
      return { header, events: parsed.slice(1), [Symbol.dispose]: () => {} }
    },
  },
}

const logFile = join(root, 'dsh-fork-relink.log')
const offsetBefore = await stat(logFile).then(info => info.size, () => 0)

apply(ctx)
ctx.handlers.get('session/created')({
  id: forkChildId,
  header: { version: 4, id: forkChildId, createdAt: 1, cwd: 'C:/ws', isSeeded: true, parentSession: parentId, delegationDepth: 0 },
})

async function waitForLog(predicate) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
    const text = await readFile(logFile, 'utf8').catch(() => '')
    const lines = text.slice(offsetBefore).split('\n').filter(line => line.length > 0).map(line => JSON.parse(line))
    if (predicate(lines)) return lines
  }
  return []
}

const failures = []
function expect(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const lines = await waitForLog(entries => entries.some(entry => entry.message === 'copied subagent tree'))
const byMessage = (message) => lines.filter(entry => entry.message === message)
const copyIds = creates.map(entry => entry.options.sessionId)

expect(byMessage('copying subagent tree').length, 2, 'one start line per copied level')
expect(byMessage('copying subagent tree')[0]?.data.children, 12, 'direct children found at the fork level (11 completed + 1 open)')
expect(byMessage('copy progress').map(entry => entry.data.done), [10], 'progress logged every ten children')
expect(byMessage('child copy failed').length, 0, 'no per-child failure')
expect(creates.length, NORMAL + 1, 'one copy per completed child plus the grandchild')
expect(disposed.length, creates.length, 'every copy handle is disposed')
expect(creates.filter(entry => entry.options.meta.parentSession === forkChildId).length, NORMAL, 'every direct copy hangs off the fork child')

const first = creates[0].options
expect(first.meta.isSeeded, true, 'copy is seeded')
expect(first.meta.origin, 'subagent', 'copy is a subagent session')
expect(first.meta.delegationDepth, 1, 'depth is parent depth + 1')
expect(first.meta.cwd, undefined, 'cwd comes from the observed header')
expect(first.inheritedEventCount, first.seed.length, 'inherited count matches the seed')
expect(first.seed.at(-1).type, 'turn/end', 'seed stops at the last completed turn')
expect(first.agentOptions, { provider: 'provider-a', model: 'model-a' }, 'descriptor provider/model become agent options')
expect(first.seed.some(seedEvent => seedEvent.type === 'turn/start') || first.seed.length > 0, true, 'seed carries the completed prefix')
const grand = creates.find(entry => entry.options.meta.parentSession !== forkChildId)
expect(grand?.options.meta.parentSession, copyIds[0], 'grandchild copy hangs off the child copy')
expect(grand?.options.meta.delegationDepth, 2, 'grandchild depth is child depth + 1')
expect(byMessage('copied subagent tree')[0]?.data.copied.length, NORMAL + 1, 'tree result counts the whole subtree')
expect(byMessage('copied subagent tree')[0]?.data.skipped, ['child-open'], 'child without a completed turn is skipped')

if (failures.length > 0) {
  console.error('FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exitCode = 1
} else {
  console.log(`PASS — ${creates.length} copies (incl. 1 grandchild), 1 skipped, progress logged; fixtures at ${workspaceDir}`)
}
