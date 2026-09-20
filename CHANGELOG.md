# 变更记录

本仓库遵循语义化版本:`0.x` 期间次版本号(0.**2**.0)表示能力或行为变化,修订号(0.2.**1**)表示修复与文档。

## 0.2.1 — 2026-09-20

### 修复

- **插件队列条与官方队列条重叠(同一条消息画两遍)**:插件按 `SessionSnapshot.queue`(`placement === 'queued'`)做差集,而核心提交 `72f2e71070`("reconcile durable inbox recovery with master")已删除该字段 —— 权威队列改由宿主 inbox 投影承载,官方 QueueDock 读的是 `useProjection('inbox')['next-turn']`。字段消失后 `snapshot.queue` 恒为 `undefined`、差集恒为空,插件于是把官方条已经显示的行又画了一遍。改为读**与官方条同源**的投影 id 做差集。
- **幽灵行**:宿主侧折叠结果原本只在切换会话时读取一次,被认领或已删除的项会永远留在"官方队列条未显示"里。现在官方队列变化或轮次 `running` 变化时重读 —— 继承项本来就不在投影里,它被认领时只有 `running` 会变。

### 测试

- 新增离线回归检查 `tools/queue-dedup-check.mjs`(jsdom 渲染浏览器 half,喂入宿主折叠与官方投影的替身):修前 5 项里 3 项失败(含用户报的重叠),修后全过。

## 0.2.0 — 2026-09-16

### 新增

- **队列补位条**:只渲染官方队列条显示不到的行 —— 客户端读官方那条队列(`useSession(s => s.queue)` 里 `placement === 'queued'` 的 id),与宿主侧折叠(只折叠 `next-turn`)做差集,差集为空就什么都不画。版式逐项对齐官方队列条(同一套 `--dsh-composer-*` 令牌;实测与官方同宽 696px),编辑交互同官方:铅笔进入 28px 行内输入框,**Enter 保存 / Esc 取消**,文本按全文读取。
- 路由:`/log-prune/queue`(读,活体优先、冷会话读日志)、`/log-prune/queue/edit`、`/log-prune/queue/remove`(后两者经官方 `sessionController.updateQueue`,与官方队列条同一入口)。
- **运行期可寻址性断言**:每个副本创建后复核"写租约可得",结果随 `copied subagent tree` 写入 `$DSH_HOME/dsh-fork-relink.log` 的 `unresumable` 字段;不可寻址不再可能静默通过。

### 变更

- **fork 语义由"搬移"改为"复制"**:监听官方 `session/created`,对 fork 子会话的每个直接子 agent 经官方 `agents.create` 建**副本** —— 新 id、`meta.parentSession` = fork 子会话、`seed` = 原件已完成前缀(截到最后一个 `turn/end`)、`setup` 里追加副本自有 `subagent/descriptor` 并经 `agentPresets.composeFrom` 加入新组合;递归整棵树。**原件一字不动**(旧实现会改写原件的持久化头帧,已删除)。
- 副本落盘后**立即释放活体**,使其成为官方冷恢复路径可寻址的冷会话。

### 修复

- **副本不可寻址(`subagent "…" is unavailable`)**:插件经 `agents.create` 建的活体副本持有该会话的写租约,又不在 continuation manager 的 resident 表里 ⇒ `send_message` 落到冷恢复的 `persistence.open(id,'write')` 时被**自己的租约**拒绝(`SessionAlreadyOwnedError`),表现为"目录里看得见、消息发不进"。改为创建后释放活体。
- **幂等**:重复打开或重复 fork 不再重复复制(目标名下已有子记录即整轮跳过),并在闸门处自愈"缺自有 descriptor"的旧副本。
- 只复制**已完成前缀**,运行中的子代理不再被整体跳过;没有已完成 `turn/end` 的子代理仍跳过并记日志。

## 0.1.0 — 2026-09-10

- 首个版本:监听 `session/created`,把旧会话的直接子 agent 记录**重链**到 fork 出的新会话(搬移实现,已在 0.2.0 被复制语义取代)。
