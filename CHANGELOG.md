# 变更记录

本仓库遵循语义化版本:`0.x` 期间次版本号(0.**2**.0)表示能力或行为变化,修订号(0.2.**1**)表示修复与文档。

## 0.3.3 — 2026-09-26

### 修复

- **副本「磁盘上有、面板里没有」**:0.3.1 让复制重新跑起来之后,子代理面板依然是空的 —— 面板不扫磁盘。v4 起官方目录投影只折叠**父会话自有区间**的 `subagent/catalog` 事件(继承前缀里的条目一律忽略),这条事件由官方 `establishCatalogChild` 在 spawn 时写入。插件只把副本头部的 `parentSession` 指过去,从没写过目录事件;而 fork 的 seed 又把源会话的 35 条目录事件一并继承过来,它们全在继承前缀里、还指向源会话的孩子 ⇒ 投影为空、面板为空。实测 fork `session-35e438ef…`:继承切点 seq 2880,继承的目录事件最后一条 seq 2701(被忽略),自有区间 0 条;源会话 `session-02438649…` 则有 35 条。
- 现在每个副本创建后即向父会话追加一条 `subagent/catalog`(version 0 + descriptor 的 mode/label + 副本自己的 createdAt,与官方同一事件形状);递归时挂在该副本自己名下。
- **自愈**:0.3.2 及之前造出的副本没有这些条目。重开这类 fork 会话时按「目录里缺谁补谁」登记回父会话 —— 不必重新 fork,也不会重复建副本。

### 测试

- `test/copy-tree.mjs` 增加目录登记与自愈两个场景(新建副本必须写目录事件;旧副本重开必须补登记,且再重开不追加)。对 0.3.2 跑,8 条目录断言全部失败。

## 0.3.2 — 2026-09-26

### 新增

- **复制期间的进度日志**:建副本是「每个子 agent 一次官方 `agents.create`」,本机实测每次约 3.5 s —— 35 个子 agent 要跑约 2 分钟,数百个要十几分钟。此前整段过程一行日志都没有,与「什么都没发生」无法区分(2026-09-26 的误报:fork 实际复制了 35 个子 agent,`copied: 35, unresumable: 0`,但因为当时仍在途中而被判为失效)。现在开始复制时记一条 `copying subagent tree`(含 fork 子会话、源会话、直接子 agent 数),每 10 个记一条 `copy progress`。
- 离线检查 `test/copy-tree.mjs`(`npm test` 一并运行):用替身 ctx 驱动 `apply` 的 `session/created` 入口,覆盖守卫、已完成前缀截断、副本头部(parentSession / origin / isSeeded / delegationDepth)、`inheritedEventCount` 与 seed 一致、递归整棵树、自有 descriptor、跳过没有 `turn/end` 的子 agent、副本活体释放与进度日志。

## 0.3.1 — 2026-09-26

### 修复

- **fork 后不再复制子 agent(日志里 `copied` 恒为空)**:插件把日志文件名写死成 `session.v3.jsonl.zstd` / `session.jsonl.zstd`,而核心已把会话格式升到 **v4**,磁盘上是 `session.v4.jsonl.zstd`。于是 `findChildSessions` 一个会话都读不到,`copyChildren` 把「读不到」和「没有子 agent」算成同一件事 —— fork 后新对话的子代理面板为空,`$DSH_HOME/dsh-fork-relink.log` 里只有一条 `copied: []`(没有 `skipped`、没有 `alreadyPopulated`),从 2026-09-24 起每次 fork 都如此。改为**扫目录取最高代际**(正则解析 `session[.vN].jsonl[.zstd]`,同代际优先压缩文件),代际号不再写死,核心下次升级格式不会再让插件失效。真实数据复核:2026-09-24 那次 fork 的父会话 `session-575ccef0…` 有 223 个直接子 agent,修复前插件读到 0 个、修复后 223 个。
- **观察日志的租约未释放**:每个子 agent 经 `sessionQuery.observeSession` 读取后没有释放(`SessionObservation` 是 Disposable)。一次 fork 复制数百个子 agent 就留下数百条租约,把冷读取常驻在观察缓存里。现在每轮复制结束即释放。

### 测试

- 新增离线检查 `test/check-log-generation.mjs`(`npm test`):造出含 v0 / v3 / v4 与一个未来代际(v9)的会话目录,断言最高代际被选中、非规范文件名被忽略。修改前该检查读到 0 个子 agent 而失败。

## 0.3.0 — 2026-09-20

### 移除

- **队列补位条整体删除**:浏览器 half(`lib/client.js`)、`/log-prune/queue`(读)、`/log-prune/queue/edit`、`/log-prune/queue/remove` 三个路由,以及只服务它们的注入(`webServer` / `sessions` / `sessionController`)。理由:该功能的前提是官方 QueueDock 显示不了 fork 继承的排队消息,而当前 core 的 inbox 投影由日志尾页播种、本就带上继承项 —— 2026-09-20 用 Playwright 驱动真实 GUI 实测,官方条自己就把 3 条继承项列全了,补位条的差集恒为空、**常驻空转**。它此前还因去重源(`SessionSnapshot.queue`,核心 `72f2e71070` 已删除该字段)失效,把官方条已有的行又画一遍(输入框上方两条一样的排队消息,0.2.1 修过)。删掉失效的一半后插件回归单一职责。
- 随之删除 `test/queue-dedup-check.mjs`(它只测被删掉的补位条),`package.json` 去掉 `./client` 导出与 `dsh.client` 声明。

### 保留

- 子 agent 复制语义不变(见 0.2.0);若未来官方 fork 原生跟随子树,本插件即可卸载。

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
