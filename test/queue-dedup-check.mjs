
/**
 * 回归检查:插件队列条必须与官方 QueueDock 同源去重。
 *
 * 官方 QueueDock 渲染的是宿主 inbox 投影的 next-turn(`useProjection('inbox')`);插件
 * 只能补它显示不到的行。曾经的实现读 `useSession(s => s.queue)` —— 核心 72f2e71070 删掉
 * 该字段后它恒为 undefined,差集恒为空,于是输入框上方出现两条一样的排队消息(重叠条)。
 *
 * 本脚本用 jsdom 渲染浏览器 half,用替身喂入「宿主侧折叠结果」与「官方投影」,断言:
 *   1. 官方条已显示同一条 → 插件什么都不画;
 *   2. 官方投影缺失该条 → 插件补位;
 *   3. 部分重叠 → 只画官方条没有的那条;
 *   4. 官方帧迟到 → 帧到达后插件条自行消失;
 *   5. 继承项被认领(投影始终为空,只有 running 变化)→ 不留下幽灵行。
 *
 * 用法(需要一份含 node_modules 的 dsh checkout 提供 react/react-dom/jsdom;插件自身零依赖):
 *   node test/queue-dedup-check.mjs [client.js 路径] [dsh checkout 路径]
 * 默认 client.js 为本仓库的 lib/client.js,checkout 取 $DSH_CHECKOUT 或 F:/ACG/Tool/deepseek-harness。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const clientPath = process.argv[2] ?? new URL('../lib/client.js', import.meta.url).pathname.replace(/^\//, '')
const checkout = process.argv[3] ?? process.env.DSH_CHECKOUT ?? 'F:/ACG/Tool/deepseek-harness'
const reqWeb = createRequire(checkout + '/apps/web/package.json')
const reqRoot = createRequire(checkout + '/package.json')

const React = reqWeb('react')
const { createRoot } = reqWeb('react-dom/client')
const { JSDOM } = reqRoot('jsdom')

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Element = dom.window.Element
globalThis.Node = dom.window.Node
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ---- 宿主侧折叠结果(插件读的那份)----
let foldItems = []
const fetchCalls = []
globalThis.fetch = (path, init) => {
  fetchCalls.push({ path, body: JSON.parse(init.body) })
  if (path === '/log-prune/queue') return Promise.resolve({ json: () => Promise.resolve({ ok: true, items: foldItems }) })
  return Promise.resolve({ json: () => Promise.resolve({ ok: true }) })
}

// ---- 官方投影(next-turn)与 SessionSnapshot 的替身,语义同 keyedObservableHook ----
function store(initial) {
  let value = initial
  const listeners = new Set()
  return {
    set(next) { value = next; for (const l of [...listeners]) l() },
    // 同 observableHook / keyedObservableHook:单函数参数或 (key, selector) 都要认
    use(first, second) {
      const selector = typeof first === 'function' ? first : second
      const get = () => (selector ? selector(value) : value)
      return React.useSyncExternalStore(
        (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
        get, get)
    },
  }
}
const projection = store(undefined)
const session = store({ running: false, pendingSubmissions: [] })

// ---- 载入浏览器 half ----
const source = readFileSync(clientPath, 'utf8')
const icons = new Proxy({}, { get: () => () => React.createElement('span', null) })
let captured
new Function('window', source)({ __ModuleLoader__: { load: (def) => { captured = def } } })
if (captured === undefined) throw new Error('client.js did not call __ModuleLoader__.load')
const module_ = captured.factory((name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return icons
  throw new Error('unexpected require: ' + name)
})
let Component
module_.apply({
  slots: {
    inject: (_name, factory) => { factory(); return () => {} },
    register: (_def, component) => { Component = component; return () => {} },
  },
})

const results = []
const act = React.act ?? reqWeb('react-dom/test-utils').act
async function scenario(name, expectVisible, before, body) {
  foldItems = []
  fetchCalls.length = 0
  projection.set(undefined)
  session.set({ running: false, pendingSubmissions: [] })
  if (before !== undefined) await act(async () => { before() })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(React.createElement(Component, {
        sessionId: 's1', useProjection: projection.use, useSession: session.use,
      }))
    })
    if (body !== undefined) await body()
    const rendered = host.querySelector('[data-fork-relink-queue]')
    results.push({
      name, ok: (rendered !== null) === expectVisible,
      detail: rendered === null ? 'no plugin strip' : 'plugin strip: ' + rendered.textContent.slice(0, 50),
    })
  } catch (error) {
    results.push({ name, ok: false, detail: 'threw: ' + (error && error.message) })
  }
  await act(async () => { root.unmount() })
  host.remove()
}

const item = (id, text) => ({ id, text, inherited: false })
const inbox = (...rows) => ({ 'next-turn': rows, 'next-step': [] })

// 1) 官方条已显示同一条 → 插件必须什么都不画(用户报的重叠)
await scenario('overlap: official strip shows the same row', false,
  () => { foldItems = [item('m1', '注意并发会话不易过多')]; projection.set(inbox(item('m1', '注意并发会话不易过多'))) })

// 2) 官方投影缺失(继承项的典型情形)→ 插件补位
await scenario('complement: official projection lacks the row', true,
  () => { foldItems = [item('m1', '继承的排队消息')]; projection.set(inbox()) })

// 3) 部分重叠 → 只画官方条没有的那条
await scenario('partial overlap: only the missing row', true,
  () => { foldItems = [item('m1', '继承的'), item('m2', '官方有的')]; projection.set(inbox(item('m2', '官方有的'))) })

// 4) 官方条迟到的帧:先补位,帧到达后必须自行消失
await scenario('late frame: strip disappears once the projection lands', false,
  () => { foldItems = [item('m1', '继承的排队消息')]; projection.set(inbox()) },
  async () => { await act(async () => { projection.set(inbox(item('m1', '继承的排队消息'))) }) })

// 5) 继承项被认领:投影一直是空(官方条从未显示过),只有 running 变化
await scenario('claimed inherited row: no phantom reminder after the turn starts', false,
  () => { foldItems = [item('m1', '继承的排队消息')]; projection.set(inbox()) },
  async () => {
    foldItems = []
    await act(async () => { session.set({ running: true, pendingSubmissions: [] }) })
  })

let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + '  [' + r.detail + ']')
}
console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)