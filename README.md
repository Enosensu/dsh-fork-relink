# dsh-fork-relink

DSH(DeepSeek Harness)官方 fork 的伴随插件:**fork(分支)发生后,自动为原会话的直接子 agent 创建完整副本挂到新会话下**——fork 出的对话完整保留子 agent 面板、代理路由、descriptor、label 等信息;原会话的子 agent 记录原样保留(复制而非转移,两个分支互不干扰)。

> 本插件由 Enosensu 与 AI(ZCode 智能体,GLM 模型)结对开发 · Co-developed with AI.

## 背景

DSH 的 fork(会话列表里的分支按钮)用**新会话 id** 承接被继承的历史,而子 agent 会话按 `parentSession` 挂在父会话下。fork 之后,子 agent 记录仍指向旧会话——新对话的子 agent 面板为空,子 agent 的全部工作记录"消失"(实际仍在磁盘上,只是脱离了新对话)。

## 原理

监听官方 `session/created` 事件。fork 子会话(`isSeeded` 且有 `parentSession` 且 `origin !== 'subagent'`)进入 store 时,为旧会话的每个直接子 agent 调用官方 `agents.create` 创建**完整副本**:

- `meta.parentSession` 在创建那一刻就指向 fork 子会话(无文件改写、无归属抢夺);
- `meta.origin: 'subagent'`、`delegationDepth` = 父 +1;
- `seed` = 原子 agent 的完整持久日志(逐行一致),`inheritedEventCount` = seed 长度;
- `agentOptions` 取原子 agent descriptor 里的 provider/model;
- `setup` 经官方 `agentPresets.composeFrom(childCtx, forkChildAgent.ctx)` 加入 fork 子会话的组合(与 spawn 路径同一入口);
- **递归**:副本的子 agent 同样被复制,整棵子 agent 树跟随;
- **副本是冷会话**:副本落盘后立即释放活体。留活的副本会持有该会话的写租约,而插件经 `agents.create` 创建的活体不在 subagent continuation manager 的 resident 表里 ⇒ `send_message` 不走活体投递、改走冷恢复,而冷恢复第一步 `persistence.open(id, 'write')` 会被副本自己的写租约拒绝(`SessionAlreadyOwnedError`),对外表现为 `subagent "…" is unavailable` —— **目录里看得见、消息发不进**。释放后副本留在磁盘上,成为官方 resume 路径可寻址的冷会话,首次发消息由官方冷恢复按 descriptor 唤醒;
- **过滤**:运行中的子 agent 跳过(记入日志);fork 子会话 seed 未引用的子 agent(属于被分支抛弃的路线)不跟随;
- 操作记录写入 `$DSH_HOME/dsh-fork-relink.log`,含每个副本的可寻址性复核结果(`unresumable` 为空即全部可寻址)。

## 可达性(明示)

| 对象 | fork 前旧父 | fork 后新父 |
|---|---|---|
| 原子 agent(原件) | 仍然可达(记录与 id 均未改动) | 不可达(`UNAUTHORIZED: belongs to another parent session`) |
| 副本(新 id) | 不可达(它不是旧父的子) | 可达:`list_agents` 的 id 与 `send_message` 接受的 id **完全一致**,首次发送冷恢复唤醒 |

语义是**复制而非转移**:旧分支照常使用原子 agent,新分支使用副本,两个分支互不干扰。错误码沿用核心词汇(`NOT_RESUMABLE` / `UNAUTHORIZED` / `PARENT_UNAVAILABLE`),插件不新增也不改写。

**运维后果(必须知道的唯一一条)**:fork 之后,任何「续跑同一子会话」的协议都要**改用副本 id**——原 id 仍归旧分支,对新父必然返回 `UNAUTHORIZED: belongs to another parent session`。以 `list_agents` 给出的 id 为准,它与你应当发送的 id 是同一个。

子 agent 复制部分零依赖、零文件改写:全部走官方 API。任何走官方 fork 的入口(原生分支按钮、其他插件)都被覆盖。

## 安装

从 GitHub 安装(使用者走这条;装到的是本仓库 `main` 的当前代码,本插件是纯 ESM、无构建步骤,所以 git 安装不需要 `allowBuilds` 授权):

```sh
dsh plugin --profile web add github:Enosensu/dsh-fork-relink
```

本地开发时直接指向工作目录:

```sh
dsh plugin --profile web add "link:<本目录>"
```

重启 `dsh web` 生效。卸载:

```sh
dsh plugin --profile web remove dsh-fork-relink
```

## 测试

真机自测(在真实 web 服务器进程内驱动官方 `sessionController.fork`):fork 子会话的 `session/created` 事件触发、两个子 agent 的副本被创建(事件日志与原件逐行一致,仅多官方 seed 标记;头部 parent/origin/depth 正确)、原件不动;守卫三条(排除子 agent 自身创建/普通会话)与 seed 引用过滤均有离线测试覆盖。

## 排队消息(自 0.3.0 起不再由本插件补位)

fork 会把原会话未消费的排队轮次(`agent/inbox/spliced` → `next-turn` 折叠)一并继承下来,这些项在继续对话时会**先于你新发的消息**送达模型。0.2.x 为此提供过一个「补位条」,只画官方队列条显示不到的行 —— 前提是官方 QueueDock 看不到继承项。

2026-09-20 在真实 GUI(Playwright 驱动本机 Chrome + 隔离实例)上实测:**当前 core 的 inbox 投影由日志尾页播种、本就带上继承项,官方条自己就把它们列全了**,补位条的差集恒为空、常驻空转。它历史上还因去重源失效(`SessionSnapshot.queue`,已被核心 `72f2e71070` 删除)把官方条已有的行又画一遍 —— 输入框上方两条一样的排队消息(0.2.1 修过)。

因此 0.3.0 删掉了整个补位条:浏览器 half、`/log-prune/queue`(读)、`/log-prune/queue/edit`、`/log-prune/queue/remove` 三个路由,以及只服务它们的注入(`webServer` / `sessions` / `sessionController`)。**子 agent 复制不受影响**;若未来某个 core 又显示不了继承项,回退到 0.2.1 即可。

## 已知边界

- 运行中的子 agent 跳过(避免与内存态冲突),记入日志;可等它结束再 fork 一次。
- 继承的排队消息不再由本插件呈现:官方队列条会显示它们(0.3.0 实测);插件只负责复制子 agent 树。
- 副本完整复制子 agent 的历史;若未来官方 fork 支持子树跟随(或提供 children relink/copy API),本插件即可卸载。

## License

[MIT](LICENSE)
