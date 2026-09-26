/**
 * 离线回归检查:跨会话格式代际读取子 agent。
 *
 * 背景:核心把会话日志按格式代际命名(`session.vN.jsonl` / `.jsonl.zstd`,N = SESSION_FORMAT_VERSION),
 * 升级格式时**保留旧代际文件、只在旁边另写新代际**(本机实测:目录里同时有 `session.v3.jsonl.zstd`
 * 与 `session.v4.jsonl.zstd`)。插件一旦写死代际号,核心升级后就会静默把「有子 agent 的会话」读成
 * 「没有子 agent」——fork 后新对话的子代理面板为空,日志里 `copied` 是空数组。本检查造出含
 * v0/v3/v4 与一个未来代际(v9)的 DSH_HOME,断言最高代际被选中、非规范名被忽略。
 *
 * 运行:node tools/check-log-generation.mjs
 * 夹具落在系统临时目录(不删除,重复运行直接覆盖)。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { findChildSessions, findSessionLog, findSessionWorkspace } from '../lib/index.js'

const root = join(tmpdir(), 'dsh-fork-relink-check')
const workspace = '--ws--'
const workspaceDir = join(root, 'sessions', workspace)
process.env.DSH_HOME = root

/** 一帧 = 一行 JSON(核心同样分批分帧写,这里顺带覆盖多帧边界推进)。 */
function frame(lines) {
  return zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

async function writeLog(dir, name, header, events = []) {
  await mkdir(dir, { recursive: true })
  const frames = [frame([JSON.stringify(header)])]
  if (events.length > 0) frames.push(frame(events.map(event => JSON.stringify(event))))
  await writeFile(join(dir, name), Buffer.concat(frames))
}

const session = (id, extra = {}) => ({ type: 'session', version: 4, id, createdAt: 1, isSeeded: false, ...extra })
const child = (id, extra = {}) => session(id, { parentSession: 'parent', origin: 'subagent', ...extra })

// 被测会话自己(不参与列表)、一个未来代际、一个第 0 代、一个已迁移(双代际)会话。
await writeLog(join(workspaceDir, 'parent'), 'session.v4.jsonl.zstd', session('parent'))
await writeLog(join(workspaceDir, 'child-a'), 'session.v4.jsonl.zstd', child('child-a'))
await writeLog(join(workspaceDir, 'child-b'), 'session.v3.jsonl.zstd', child('child-b'))
await writeLog(join(workspaceDir, 'child-f'), 'session.v9.jsonl.zstd', child('child-f'))
await writeLog(join(workspaceDir, 'child-g'), 'session.jsonl.zstd', child('child-g'))
await writeLog(join(workspaceDir, 'child-d'), 'session.v3.jsonl.zstd', child('child-d', { generation: 'v3' }))
await writeLog(join(workspaceDir, 'child-d'), 'session.v4.jsonl.zstd', child('child-d', { generation: 'v4' }))
// 干扰项:别家父会话的子 agent、非规范文件名、普通文件。
await writeLog(join(workspaceDir, 'child-c'), 'session.v4.jsonl.zstd', session('child-c', { parentSession: 'other', origin: 'subagent' }))
await writeLog(join(workspaceDir, 'child-e'), 'session.v4.jsonl.txt', child('child-e'))
await writeFile(join(workspaceDir, 'loose-file'), 'not a session dir')

const failures = []
function expect(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (!same) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const found = await findChildSessions(workspaceDir, 'parent')
expect(found.map(entry => entry.id).sort(), ['child-a', 'child-b', 'child-d', 'child-f', 'child-g'], 'direct children')
expect(found.find(entry => entry.id === 'child-d')?.header.generation, 'v4', 'migrated session reads its highest generation')
expect(basename(await findSessionLog(join(workspaceDir, 'child-d'))), 'session.v4.jsonl.zstd', 'findSessionLog picks the highest generation')
expect(await findSessionLog(join(workspaceDir, 'child-e')), undefined, 'non-canonical name is not a log')
expect(await findSessionWorkspace('parent'), workspaceDir, 'workspace lookup by session id')

if (failures.length > 0) {
  console.error('FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exitCode = 1
} else {
  console.log('PASS — 5 checks, fixtures at ' + workspaceDir)
}
