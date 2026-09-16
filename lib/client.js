/**
 * dsh-fork-relink — 浏览器 half。
 *
 * 挂官方 `conversation.input.dock` 槽:在输入框上方显示「继承的排队消息」提示条。
 * fork 会从父会话继承未消费的排队消息(agent/inbox/spliced 折叠),继续对话时
 * 它们先于新消息送达模型,而官方 QueueDock 对这类继承项不显示。
 *
 * 版式与交互对齐官方队列条(ui-conversation 的 QueueDock):同一组布局令牌
 * (--dsh-composer-card-max-width / --dsh-composer-dock-inset / --dsh-composer-side-clearance /
 * --dsh-composer-stack-gap)、36px 行高、12px 顶部圆角、28×28 圆形操作按钮、
 * 28px 输入态编辑器;因此两者宽度与视觉一致,叠放时读作同一块面。
 *
 * 数据来自 /log-prune/queue(活体优先、冷会话读日志);
 * 编辑经 /log-prune/queue/edit、删除经 /log-prune/queue/remove(均为官方 updateQueue)。
 */
window.__ModuleLoader__.load({
  id: 'dsh-fork-relink',
  factory: function (require) {
    var React = require('react')
    var Primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /* 官方 QueueDock.module.css 的同一组取值,保证同宽同高 */
    var FONT = 'Inter, var(--dsw-font-family)'
    var dockStyle = {
      boxSizing: 'border-box', flex: 'none',
      width: 'calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance)'
        + ' - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset))',
      maxWidth: 'calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset)'
        + ' - var(--dsh-composer-dock-inset))',
      margin: '0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px)',
      padding: '0 var(--dsh-composer-dock-inset)',
    }
    var panelStyle = {
      boxSizing: 'border-box', position: 'relative', overflow: 'hidden', width: '100%',
      padding: '2px 0', borderRadius: '12px 12px 0 0',
      background: 'var(--dsw-specific-tip)',
      border: '0.5px solid var(--dsw-alias-border-l1)', borderBottom: 'none',
    }
    var headerStyle = {
      boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 10,
      width: '100%', height: 36, padding: '4px 12px',
      color: 'var(--dsw-alias-label-primary)',
    }
    var countStyle = {
      flex: '1 1 auto', minWidth: 0, fontFamily: FONT, fontSize: 13,
      fontWeight: 500, lineHeight: '24px',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }
    var listStyle = { maxHeight: 180, overflowY: 'auto', margin: 0, padding: 0, listStyle: 'none' }
    var rowStyle = function (first) {
      return {
        boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', height: 36, padding: '4px 5px 4px 12px', borderRadius: 8,
        boxShadow: first ? undefined : 'inset 0 1px 0 var(--dsw-alias-border-l1)',
      }
    }
    var tagStyle = {
      flex: 'none', color: 'var(--dsw-alias-label-tertiary)',
      fontFamily: FONT, fontSize: 13, whiteSpace: 'nowrap',
    }
    var previewStyle = {
      flex: '1 1 auto', minWidth: 0, fontFamily: FONT, fontSize: 13,
      overflow: 'hidden', color: 'var(--dsw-alias-label-primary-dimmed)',
      textOverflow: 'ellipsis', whiteSpace: 'nowrap', wordBreak: 'break-word',
    }
    var editorStyle = {
      boxSizing: 'border-box', flex: '1 1 auto', minWidth: 0, height: 28, padding: '0 8px',
      border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 6, outline: 'none',
      background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
      fontFamily: FONT, fontSize: 13,
    }
    var actionsStyle = { display: 'flex', flex: 'none', alignItems: 'center', gap: 10 }
    var actionStyle = function (disabled) {
      return {
        display: 'grid', placeItems: 'center', flex: 'none', width: 28, height: 28, padding: 0,
        border: 'none', borderRadius: 999, background: 'transparent',
        color: 'var(--dsw-alias-label-tertiary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }
    }

    function postJson(path, body) {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (response) { return response.json() })
    }

    function QueueNotice(props) {
      var sessionId = props.sessionId
      var stateRef = React.useState(null)
      var items = stateRef[0]
      var setItems = stateRef[1]
      var editingRef = React.useState(null)
      var editing = editingRef[0]
      var setEditing = editingRef[1]
      var busyRef = React.useState(null)
      var busyId = busyRef[0]
      var setBusy = busyRef[1]

      React.useEffect(function () {
        setItems(null)
        setEditing(null)
        if (!sessionId) return
        var alive = true
        postJson('/log-prune/queue', { sessionId: sessionId }).then(function (d) {
          if (!alive) return
          if (d && d.ok) { setItems(d.items || []); return }
          // 读取被拒时保持可见的告警:整条队列静默消失曾是本 bug 的表现
          console.warn('[dsh-fork-relink] 队列读取被拒绝:', d)
        }).catch(function (error) { console.warn('[dsh-fork-relink] 队列读取失败:', error) })
        return function () { alive = false }
      }, [sessionId])

      if (!sessionId || items === null || items.length === 0) return null
      var inheritedCount = items.filter(function (it) { return it.inherited }).length

      function saveEdit() {
        if (editing === null || editing.text.trim() === '') return
        var itemId = editing.id
        var text = editing.text
        setBusy(itemId)
        postJson('/log-prune/queue/edit', { sessionId: sessionId, itemId: itemId, text: text })
          .then(function (d) {
            setBusy(null)
            if (d && d.ok) {
              setItems(items.map(function (it) { return it.id === itemId ? { id: it.id, text: text, inherited: it.inherited } : it }))
              setEditing(null)
              return
            }
            console.warn('[dsh-fork-relink] 队列编辑被拒绝:', d)
          })
          .catch(function (error) { setBusy(null); console.warn('[dsh-fork-relink] 队列编辑失败:', error) })
      }

      function remove(itemId) {
        setBusy(itemId)
        postJson('/log-prune/queue/remove', { sessionId: sessionId, itemId: itemId })
          .then(function (d) {
            setBusy(null)
            if (d && d.ok) setItems(items.filter(function (it) { return it.id !== itemId }))
          })
          .catch(function () { setBusy(null) })
      }

      function clearAll() {
        setBusy('__all__')
        setEditing(null)
        var chain = Promise.resolve()
        items.forEach(function (it) {
          chain = chain.then(function () {
            return postJson('/log-prune/queue/remove', { sessionId: sessionId, itemId: it.id }).then(function () { return null })
          })
        })
        chain.then(function () {
          setBusy(null)
          setItems([])
        }).catch(function () { setBusy(null) })
      }

      var headerText = '⚠️ ' + items.length + ' 条排队消息'
        + (inheritedCount === items.length ? '(全部继承自原会话)' : inheritedCount > 0 ? '(其中 ' + inheritedCount + ' 条继承自原会话)' : '')
      var headerHint = '发送时会先于你新发的消息送达模型。可用右侧按钮逐条编辑或删除。'

      return React.createElement('div', { style: dockStyle, 'data-fork-relink-queue': '' },
        React.createElement('div', { style: panelStyle },
          React.createElement('div', { style: headerStyle },
            React.createElement('span', { style: countStyle, title: headerHint }, headerText),
            React.createElement('div', { style: actionsStyle },
              React.createElement('button', {
                type: 'button', style: actionStyle(busyId !== null), title: '全部清除', 'aria-label': '全部清除',
                disabled: busyId !== null, onClick: clearAll,
              }, React.createElement(Primitives.IconTrashOutline16, { size: 14 }))
            )
          ),
          React.createElement('ul', { style: listStyle },
            items.map(function (it, index) {
              var isEditing = editing !== null && editing.id === it.id
              return React.createElement('li', { key: it.id, style: rowStyle(index === 0) },
                React.createElement('span', { style: tagStyle }, it.inherited ? '继承' : '新'),
                isEditing
                  ? React.createElement('input', {
                    autoFocus: true, style: editorStyle, 'aria-label': '编辑排队消息', value: editing.text,
                    onChange: function (event) { setEditing({ id: it.id, text: event.currentTarget.value }) },
                    onKeyDown: function (event) {
                      if (event.key === 'Escape') { setEditing(null); return }
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        saveEdit()
                      }
                    },
                  })
                  : React.createElement('span', { style: previewStyle, title: it.text || '' }, it.text || '(无文本)'),
                React.createElement('div', { style: actionsStyle },
                  isEditing
                    ? [
                      React.createElement('button', {
                        key: 'save', type: 'button', title: '保存', 'aria-label': '保存',
                        style: actionStyle(busyId !== null || editing.text.trim() === ''),
                        disabled: busyId !== null || editing.text.trim() === '',
                        onClick: saveEdit,
                      }, React.createElement(Primitives.IconCheckOutline16, { size: 14 })),
                      React.createElement('button', {
                        key: 'cancel', type: 'button', title: '取消', 'aria-label': '取消',
                        style: actionStyle(busyId !== null), disabled: busyId !== null,
                        onClick: function () { setEditing(null) },
                      }, React.createElement(Primitives.IconCloseOutline16, { size: 14 })),
                    ]
                    : [
                      React.createElement('button', {
                        key: 'edit', type: 'button', title: '编辑', 'aria-label': '编辑',
                        style: actionStyle(busyId !== null), disabled: busyId !== null,
                        onClick: function () { setEditing({ id: it.id, text: it.text || '' }) },
                      }, React.createElement(Primitives.IconEditOutline16, { size: 14 })),
                      React.createElement('button', {
                        key: 'remove', type: 'button', title: '删除', 'aria-label': '删除',
                        style: actionStyle(busyId !== null), disabled: busyId !== null,
                        onClick: function () { remove(it.id) },
                      }, React.createElement(Primitives.IconTrashOutline16, { size: 14 })),
                    ]
                )
              )
            })
          )
        )
      )
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