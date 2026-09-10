/**
 * dsh-fork-relink — browser half。
 *
 * 挂官方 `conversation.input.dock` 槽:在输入框上方显示「继承的排队消息」提示条。
 * fork 会从父会话继承未消费的排队消息(agent/inbox/spliced 折叠),继续对话时
 * 它们先于新消息送达模型,而官方 QueueDock 对这类继承项不显示。
 * 数据来自本插件的 /log-prune/queue(活体优先、冷会话读日志);删除经
 * /log-prune/queue/remove(官方 updateQueue remove)。清空后提示条消失。
 */
window.__ModuleLoader__.load({
  id: 'dsh-fork-relink',
  factory: function (require) {
    var React = require('react')
    var Primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    function QueueNotice(props) {
      var sessionId = props.sessionId
      var stateRef = React.useState(null)
      var items = stateRef[0]
      var setItems = stateRef[1]
      var busyIdRef = React.useState(null)
      var busyId = busyIdRef[0]
      var setBusy = busyIdRef[1]

      React.useEffect(function () {
        setItems(null)
        if (!sessionId) return
        var alive = true
        fetch('/log-prune/queue', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId }),
        }).then(function (r) { return r.json() }).then(function (d) {
          if (!alive) return
          if (d && d.ok) { setItems(d.items || []); return }
          // 读取被拒时保持可见的告警:整条队列静默消失曾是本 bug 的表现
          console.warn('[dsh-fork-relink] 队列读取被拒绝:', d)
        }).catch(function (error) { console.warn('[dsh-fork-relink] 队列读取失败:', error) })
        return function () { alive = false }
      }, [sessionId])

      if (!sessionId || items === null || items.length === 0) return null
      var inheritedCount = items.filter(function (it) { return it.inherited }).length

      function remove(itemId) {
        setBusy(itemId)
        fetch('/log-prune/queue/remove', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, itemId: itemId }),
        }).then(function (r) { return r.json() }).then(function (d) {
          setBusy(null)
          if (d && d.ok) setItems(items.filter(function (it) { return it.id !== itemId }))
        }).catch(function () { setBusy(null) })
      }

      function clearAll() {
        setBusy('__all__')
        var chain = Promise.resolve()
        items.forEach(function (it) {
          chain = chain.then(function () {
            return fetch('/log-prune/queue/remove', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: sessionId, itemId: it.id }),
            }).then(function () { return null })
          })
        })
        chain.then(function () {
          setBusy(null)
          setItems([])
        }).catch(function () { setBusy(null) })
      }

      var boxStyle = {
        margin: '4px 0', padding: '6px 10px', borderRadius: 8, fontSize: 12,
        border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08))',
        color: 'var(--dsw-alias-text-secondary, rgba(128,128,128,1))',
        display: 'flex', flexDirection: 'column', gap: 4,
      }
      var rowStyle = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
      var textStyle = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

      return React.createElement('div', { style: boxStyle },
        React.createElement('div', { style: rowStyle },
          React.createElement('span', null, items.length === inheritedCount
            ? '⚠️ 此对话从原会话继承了 ' + items.length + ' 条排队消息,发送时会先于新消息送达模型:'
            : '⚠️ 此对话有 ' + items.length + ' 条排队消息(其中 ' + inheritedCount
              + ' 条继承自原会话),发送时会先于新消息送达模型:'),
          React.createElement(Primitives.Button, {
            variant: 'ghost', size: 'sm', disabled: busyId !== null,
            icon: React.createElement(Primitives.IconTrashOutline16, null),
            onClick: clearAll,
          }, '全部清除')),
        items.map(function (it) {
          return React.createElement('div', { key: it.id, style: rowStyle },
            React.createElement('span', { style: textStyle }, (it.inherited ? '[继承] ' : '[新] ') + (it.text || '(无文本)')),
            React.createElement(Primitives.Button, {
              variant: 'ghost', size: 'sm', disabled: busyId !== null,
              icon: React.createElement(Primitives.IconCloseOutline16, null),
              onClick: function () { remove(it.id) },
            }, '删除'))
        }))
    }

    function apply(ctx) {
      var disposers = []
      var d1 = ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-fork-relink-queue-notice',
          order: -20,
          inject: function (sessionId) {
            return { sessionId: sessionId }
          },
        }, QueueNotice)
      })
      if (typeof d1 === 'function') disposers.push(d1)
      return function () {
        for (var i = 0; i < disposers.length; i++) disposers[i]()
      }
    }

    return { name: 'dsh-fork-relink', inject: ['slots'], apply: apply }
  },
})
