# dsh-fork-relink

DSH(DeepSeek Harness)官方 fork 的伴随修复插件:**fork(分支)发生后,自动把原会话的直接子 agent 记录重链到新会话**,fork 出的对话完整保留子 agent 面板、代理路由、descriptor、label 等信息。

> 本插件由 Enosensu 与 AI(ZCode 智能体,GLM 模型)结对开发 · Co-developed with AI.

## 背景

DSH 的 fork(会话列表里的分支按钮)用**新会话 id** 承接被继承的历史,而子 agent 会话按 `parentSession` 挂在父会话下。fork 之后,子 agent 记录仍指向旧会话——新对话的子 agent 面板为空,子 agent 的全部工作记录"消失"(实际仍在磁盘上,只是脱离了新对话)。

## 原理

监听官方 `session/created` 事件。fork 子会话(`isSeeded` 且有 `parentSession` 且 `origin !== 'subagent'`)进入 store 时,把旧会话的直接子 agent(`origin === 'subagent'` 的冷会话)的日志头帧 `parentSession` 重链到新会话:

- **只重写头帧**,其余帧字节级原样(头帧独立成帧是 DSH 会话格式的保证);
- 每次重链前把原文件备份到 `$DSH_HOME/trash/`;
- 运行中的子 agent(内存中活着)跳过,避免与内存态互相覆盖;
- 操作记录写入 `$DSH_HOME/dsh-fork-relink.log`。

零 UI、零路由、零依赖:任何走官方 fork 的入口(原生分支按钮、其他插件)都被覆盖。

## 安装

```sh
dsh plugin --profile web add "link:<本目录>"
```

重启 `dsh web` 生效。卸载:

```sh
dsh plugin --profile web remove dsh-fork-relink
```

## 测试

离线测试覆盖:fork 子会话守卫命中、子 agent 自身创建被排除、普通会话被排除、按 origin 过滤枚举、头帧重写后其余帧字节不变、新头合法且首帧恰好一行。

## 已知边界

- 只重链**直接**子 agent;孙代(子 agent 的子 agent)的父链接本就指向子 agent 自己,无需改动。
- 若未来官方 fork 支持子会话重链(或官方提供 children relink API),本插件即可卸载。

## License

[MIT](LICENSE)
