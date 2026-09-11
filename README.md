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

子 agent 复制部分零依赖、零文件改写:全部走官方 API。任何走官方 fork 的入口(原生分支按钮、其他插件)都被覆盖。

## 安装

```sh
dsh plugin --profile web add "link:<本目录>"
```

重启 `dsh web` 生效。卸载:

```sh
dsh plugin --profile web remove dsh-fork-relink
```

## 测试

真机自测(在真实 web 服务器进程内驱动官方 `sessionController.fork`):fork 子会话的 `session/created` 事件触发、两个子 agent 的副本被创建(事件日志与原件逐行一致,仅多官方 seed 标记;头部 parent/origin/depth 正确)、原件不动;守卫三条(排除子 agent 自身创建/普通会话)与 seed 引用过滤均有离线测试覆盖。

## 继承的排队消息(可见化)

fork 会把原会话未消费的排队消息(`agent/inbox/spliced` 折叠)一并继承下来。这些项在继续对话时会**先于你新发的消息**送达模型,而官方队列条对继承项不显示。本插件在输入框上方把它们显示出来:

- 读取 `POST /log-prune/queue { sessionId }` → `{ ok, items: [{ id, text, inherited }] }`:活体会话读 `Session.snapshotEvents()`,冷会话读 `session.v3.jsonl.zstd`;活体读取失败时自动回退到日志文件,不让整条队列静默消失。
- 删除 `POST /log-prune/queue/remove { sessionId, itemId }`:经官方 `sessionController.updateQueue` 的 `remove` 动作,与官方队列条同一入口。
- 提示条提供逐条「删除」与「全部清除」;`inherited` 标记该项是否来自继承前缀——切点取日志里最后一条 `session/end-seed { inherited: true }`(fork 子会话在继承切点写入的标记),活体会话用精确的 `inheritedEventCount`。

队列本身保持原样:插件只显示与手动删除,不自动清除。

## 已知边界

- 运行中的子 agent 跳过(避免与内存态冲突),记入日志;可等它结束再 fork 一次。
- 副本完整复制子 agent 的历史;若未来官方 fork 支持子树跟随(或提供 children relink/copy API),本插件即可卸载。

## License

[MIT](LICENSE)
