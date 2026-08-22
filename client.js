// DSH session-manager-custom Client 插件。
// 负责在侧边栏注册入口、在 shell overlay 中渲染会话管理弹窗，并通过 POST API 调用 Host。
window.__ModuleLoader__.load({
  id: '@dsh-local/session-manager-custom',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const name = 'session-manager-custom'
    const inject = ['slots']

    /**
     * 调用 Host API。Host 返回 JSON；HTTP 错误和业务错误都统一抛出，
     * 调用方不需要再次检查 result.ok。
     */
    const call = async (method, args) => {
      const response = await fetch('/api/session-manager-custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args: args || {} })
      })
      const text = await response.text()
      let result
      try {
        result = JSON.parse(text)
      } catch {
        throw new Error(text || `session-manager-custom ${method} failed`)
      }
      if (!response.ok || (result && result.ok === false)) {
        throw new Error((result && result.error) || `session-manager-custom ${method} failed`)
      }
      return result
    }

    /** 与 Host 保持一致的异常码，仅用于 Client 端 badge 展示。 */
    const ISSUE_CODES = ['old-schema', 'no-cwd', 'ungrouped', 'missing-source']

    /** 把事件时间戳格式化为当前浏览器的本地日期时间。 */
    const timeText = (time) => time ? new Date(Number(time)).toLocaleString() : ''
    /** 为列表和详情提供统一标题回退值。 */
    const titleFor = (item) => (item && item.title) || '未命名会话'
    /** 判断会话是否带有 Host 报告的可见异常码。 */
    const hasIssue = (item) => item && item.codes && item.codes.some((code) => ISSUE_CODES.includes(code))
    /** 所有类别计数的稳定空状态，避免在初始化和列表失败时重复构造对象。 */
    const EMPTY_COUNTS = { all: 0, normal: 0, archived: 0, issues: 0, subagent: 0, backup: 0, trash: 0 }
    /** 面板内交互元素不会触发“点击空白区域取消焦点”。 */
    const isFocusInteractiveTarget = (target) => Boolean(
      target &&
      typeof target.closest === 'function' &&
      target.closest('button,input,select,textarea,tr,.dsh-session-manager-custom-resizer,.dsh-session-manager-custom-confirm,.dsh-session-manager-custom-detail')
    )

    // Tab 配置集中在这里，视图切换按钮只负责绑定同一个 view 值。
    const SESSION_TABS = [
      { view: 'all', className: '', title: '全部会话，不含备份区和回收站', label: (counts) => `全部会话 ${counts.all}` },
      { view: 'normal', className: '', title: '未归档且未移入备份区或回收站的会话', label: (counts) => `未归档 ${counts.normal}` },
      { view: 'archived', className: '', title: '已归档且未移入备份区或回收站的会话', label: (counts) => `归档 ${counts.archived}` },
      { view: 'issues', className: '', title: '存在状态异常的会话，不含备份区和回收站', label: (counts) => `异常 ${counts.issues}` },
      { view: 'subagent', className: '', title: '子代理会话，不含备份区和回收站', label: (counts) => `子代理 ${counts.subagent}` },
      { view: 'backup', className: 'backup-tab', title: '仅备份保留区中的会话，不计入其他类别数量', label: (counts) => `备份区 ${counts.backup}` },
      { view: 'trash', className: 'trash-tab', title: '仅回收站中的会话，不计入其他类别数量', label: (counts) => `回收站 ${counts.trash}` }
    ]

    /** Client 插件入口：注册样式、侧边栏触发按钮和 shell overlay。 */
    function apply(ctx) {
      const el = React.createElement
      // 样式只注册一次；后续 HMR/重载复用同一个 style 标签。
      const css = `

/* Sidebar floating trigger */
.dsh-session-manager-custom-float{position:fixed;z-index:180;bottom:12px;left:224px;height:34px;padding:0 12px;white-space:nowrap;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;pointer-events:auto;box-shadow:0 6px 18px rgba(0,0,0,.14)}

.dsh-session-manager-custom-float.rail{left:52px}

.dsh-session-manager-custom-float:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}

/* Full-screen overlay and centered manager panel */
.dsh-session-manager-custom-root{position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 72%,transparent);backdrop-filter:blur(4px);pointer-events:auto}

.dsh-session-manager-custom-panel{position:relative;width:min(1180px,100%);height:min(760px,92vh);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 24px 80px rgba(0,0,0,.22);display:flex;flex-direction:column;overflow:hidden;pointer-events:auto}

.dsh-session-manager-custom-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 52px 14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}

.dsh-session-manager-custom-title{font-size:16px;font-weight:700;color:var(--dsw-alias-label-primary)}

.dsh-session-manager-custom-id-badge{width:100%;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;opacity:.9}

.dsh-session-manager-custom-close{position:absolute;top:14px;right:16px;width:30px;height:30px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;cursor:pointer}

/* Toolbar, segmented views, search, and shared buttons */
.dsh-session-manager-custom-toolbar{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}

.dsh-session-manager-custom-seg{display:inline-flex;flex-wrap:wrap;gap:4px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}

.dsh-session-manager-custom-seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:5px 10px;border-radius:6px;font-size:12px;cursor:pointer}

.dsh-session-manager-custom-seg button.backup-tab{margin-left:14px;padding-left:14px;border-left:3px solid var(--dsw-alias-brand-primary);border-top-left-radius:0;border-bottom-left-radius:0}

.dsh-session-manager-custom-seg button.trash-tab{margin-left:14px;padding-left:14px;border-left:3px solid var(--dsw-alias-state-warn-primary);border-top-left-radius:0;border-bottom-left-radius:0}

.dsh-session-manager-custom-seg button.active{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-overlay)}

.dsh-session-manager-custom-search{display:flex;align-items:center;gap:6px;margin-left:auto}

.dsh-session-manager-custom-search input{height:30px;min-width:220px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 10px}

.dsh-session-manager-custom-button{height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}

.dsh-session-manager-custom-button:hover{border-color:var(--dsw-alias-brand-primary)}

.dsh-session-manager-custom-button.danger{color:var(--dsw-alias-state-error-primary)}

.dsh-session-manager-custom-batch{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}

.dsh-session-manager-custom-batch span{font-size:12px;color:var(--dsw-alias-label-secondary)}

/* Two-column list/detail layout */
.dsh-session-manager-custom-body{--dsh-sm-detail-width:430px;display:grid;grid-template-columns:minmax(0,1fr) 6px var(--dsh-sm-detail-width,430px);flex:1;min-height:0}

.dsh-session-manager-custom-body.detail-collapsed{grid-template-columns:minmax(0,1fr) 6px 42px}

.dsh-session-manager-custom-list{min-width:0;overflow:auto}

.dsh-session-manager-custom-table{width:100%;border-collapse:collapse;table-layout:fixed}

.dsh-session-manager-custom-table th{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;text-align:left;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}

.dsh-session-manager-custom-table td{padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;font-size:14px}

.dsh-session-manager-custom-table tr.selected td{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}

.dsh-session-manager-custom-title-cell{min-width:0}

.dsh-session-manager-custom-title-main{display:flex;flex-direction:column;gap:2px}

.dsh-session-manager-custom-title-main>div{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.dsh-session-manager-custom-title-main>span{font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.dsh-session-manager-custom-badge{display:inline-flex;padding:3px 9px;border-radius:999px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}

.dsh-session-manager-custom-badge.live{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-label-primary)}

.dsh-session-manager-custom-badge.archived{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-label-primary)}

.dsh-session-manager-custom-badge.issue{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}

.dsh-session-manager-custom-badge.backup{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-label-primary)}

.dsh-session-manager-custom-badge.trash{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-label-primary)}

.dsh-session-manager-custom-badge.subagent{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 12%,transparent);color:var(--dsw-alias-label-primary)}

.dsh-session-manager-custom-row-actions{display:flex;flex-wrap:wrap;gap:6px}

.dsh-session-manager-custom-row-action{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;padding:4px 8px;cursor:pointer}

.dsh-session-manager-custom-row-action:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}

.dsh-session-manager-custom-row-action.danger{color:var(--dsw-alias-state-error-primary)}

.dsh-session-manager-custom-resizer{width:6px;cursor:col-resize;background:var(--dsw-alias-border-l1);flex:none;position:relative;z-index:3}

.dsh-session-manager-custom-resizer:hover{background:var(--dsw-alias-brand-primary)}

/* 拖拽期间添加在 document.body 上的状态类。 */
body.dsh-session-manager-custom-resizing{cursor:col-resize;user-select:none}

/* Read-only right-side detail and preview */
.dsh-session-manager-custom-detail{min-width:0;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}

.dsh-session-manager-custom-detail-head{display:flex;align-items:center;justify-content:space-between;gap:8px;height:38px;padding:0 8px 0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}

.dsh-session-manager-custom-detail-head-title{min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.dsh-session-manager-custom-detail-collapse{width:30px;height:30px;flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-size:18px;font-weight:700;line-height:1;cursor:pointer}

.dsh-session-manager-custom-detail-collapse:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}

.dsh-session-manager-custom-detail-content{flex:1;min-height:0;overflow:auto;padding:14px 16px}

.dsh-session-manager-custom-detail.collapsed{width:42px}

.dsh-session-manager-custom-detail.collapsed
.dsh-session-manager-custom-detail-head{height:42px;padding:6px;flex-direction:column;justify-content:flex-start;border-bottom:0}

.dsh-session-manager-custom-detail-title{font-size:14px;font-weight:700;margin-bottom:10px;color:var(--dsw-alias-label-primary);word-break:break-word}

.dsh-session-manager-custom-detail-meta{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;font-size:11px;color:var(--dsw-alias-label-secondary)}

.dsh-session-manager-custom-detail-meta span{padding:3px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-overlay)}

.dsh-session-manager-custom-move{display:flex;align-items:center;gap:8px;margin-top:12px}

.dsh-session-manager-custom-move select{min-width:160px;height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 8px}

.dsh-session-manager-custom-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}

.dsh-session-manager-custom-preview{display:flex;flex-direction:column;gap:8px;margin-top:12px}

.dsh-session-manager-custom-msg{padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);font-size:12px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}

.dsh-session-manager-custom-msg.user{border-left:3px solid var(--dsw-alias-brand-primary)}

.dsh-session-manager-custom-msg.assistant{border-left:3px solid var(--dsw-alias-state-success-primary)}

.dsh-session-manager-custom-msg.tool{border-left:3px solid var(--dsw-alias-state-warn-primary)}

.dsh-session-manager-custom-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:18px 0;text-align:center}

.dsh-session-manager-custom-error{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:8px 0}

/* Feedback and destructive-action confirmation */
.dsh-session-manager-custom-confirm{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:20px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 64%,transparent);backdrop-filter:blur(2px)}

.dsh-session-manager-custom-confirm-box{max-width:520px;width:100%;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:16px;box-shadow:0 18px 50px rgba(0,0,0,.2)}

.dsh-session-manager-custom-confirm-box p{margin:0 0 12px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}

.dsh-session-manager-custom-confirm-actions{display:flex;justify-content:flex-end;gap:8px}

/* Narrow viewports stack the list above the detail and disable manual resizing. */
@media(max-width:800px){
.dsh-session-manager-custom-body,
.dsh-session-manager-custom-body.detail-collapsed{grid-template-columns:1fr;grid-template-rows:minmax(220px,1fr) minmax(260px,1fr)}

.dsh-session-manager-custom-body.detail-collapsed{grid-template-rows:minmax(220px,1fr) 42px}

.dsh-session-manager-custom-list{border-bottom:1px solid var(--dsw-alias-border-l1)}

.dsh-session-manager-custom-resizer{display:none}

.dsh-session-manager-custom-root{padding:8px}

.dsh-session-manager-custom-search input{min-width:140px}
}

`
      if (typeof document !== 'undefined' && document.querySelector('style[data-plugin="session-manager-custom"]') === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'session-manager-custom'
        tag.textContent = css
        document.head.appendChild(tag)
      }

      // 侧边栏 Trigger 和 overlay 分属不同 React 树，这里用共享订阅状态连接它们。
      const listeners = []
      let open = false
      /** 更新共享 open 状态，并通知所有仍在挂载的订阅组件。 */
      const setManagerOpen = (next) => {
        open = Boolean(next)
        for (const listener of listeners.slice()) listener(open)
      }
      /** 订阅共享 open 状态；组件卸载时从 listeners 中移除自己的 setState。 */
      const useManagerOpen = () => {
        const [value, setValue] = React.useState(open)
        React.useEffect(() => {
          listeners.push(setValue)
          setValue(open)
          return () => {
            const index = listeners.indexOf(setValue)
            if (index >= 0) listeners.splice(index, 1)
          }
        }, [])
        return [value, setManagerOpen]
      }

      /** 侧边栏入口按钮，只负责打开共享的管理器 overlay。 */
      function Trigger(props) {
        const [, setOpen] = useManagerOpen()
        return el('button', {
          className: 'dsh-session-manager-custom-float' + (props.wide ? ' wide' : ' rail'),
          title: '会话管理器',
          onClick: (event) => {
            event.stopPropagation()
            setOpen(true)
          }
        }, '会话管理器')
      }

      /** 会话管理器主组件：持有列表、详情、筛选、批量和确认弹窗状态。 */
      function Overlay() {
        const [value, setOpen] = useManagerOpen()
        const [view, setView] = React.useState('all')
        const [queryInput, setQueryInput] = React.useState('')
        const [query, setQuery] = React.useState('')
        const [items, setItems] = React.useState([])
        const [counts, setCounts] = React.useState(EMPTY_COUNTS)
        const [workspaces, setWorkspaces] = React.useState([])
        const [loading, setLoading] = React.useState(false)
        const [error, setError] = React.useState('')
        const [selected, setSelected] = React.useState(null)
        const [detail, setDetail] = React.useState(null)
        const [confirm, setConfirm] = React.useState(null)
        const [selectedIds, setSelectedIds] = React.useState([])
        const [batchDeleteArmed, setBatchDeleteArmed] = React.useState(false)
        const [moveWorkspaceId, setMoveWorkspaceId] = React.useState('')
        const [notice, setNotice] = React.useState('')
        const [detailCollapsed, setDetailCollapsed] = React.useState(true)
        const [detailWidth, setDetailWidth] = React.useState(430)
        // refs 用于同步读最新宽度、保存鼠标事件清理函数，以及作废过期异步请求。
        const detailWidthRef = React.useRef(detailWidth)
        const resizeCleanupRef = React.useRef(null)
        const detailRequestRef = React.useRef(0)
        const listRequestRef = React.useRef(0)

        // 打开期间监听 Escape；关闭或卸载时移除全局 keydown 监听。
        React.useEffect(() => {
          if (!value) return
          const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false)
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, [value])

        // 每次视图或搜索条件变化时作废未完成的旧列表请求，防止旧响应覆盖新视图。
        const load = React.useCallback(async () => {
          const requestId = ++listRequestRef.current
          setLoading(true)
          setError('')
          try {
            const result = await call('list', { view, query })
            if (listRequestRef.current !== requestId) return []
            const nextItems = result.items || []
            const nextIdSet = new Set(nextItems.map((item) => item.id))
            setItems(nextItems)
            setCounts(result.counts || EMPTY_COUNTS)
            setWorkspaces(result.workspaces || [])
            setSelectedIds((prev) => prev.filter((id) => nextIdSet.has(id)))
            return nextItems
          } catch (loadError) {
            if (listRequestRef.current === requestId) {
              setError(String((loadError && loadError.message) || loadError))
              setItems([])
            }
            return []
          } finally {
            if (listRequestRef.current === requestId) setLoading(false)
          }
        }, [view, query])

        // 打开状态、视图或搜索条件变化时清空旧焦点并重新加载列表。
        React.useEffect(() => {
          listRequestRef.current += 1
          detailRequestRef.current += 1
          setSelectedIds([])
          setBatchDeleteArmed(false)
          setSelected(null)
          setDetail(null)
          setConfirm(null)
          setNotice('')
          setMoveWorkspaceId('')
          if (value) load()
        }, [value, load])

        // 拖拽期间事件处理器读取最新 detailWidth，不依赖闭包中的旧值。
        React.useEffect(() => {
          detailWidthRef.current = detailWidth
        }, [detailWidth])

        // 组件卸载时移除尚未结束的 mousemove/mouseup 监听。
        React.useEffect(() => () => {
          if (resizeCleanupRef.current) resizeCleanupRef.current()
        }, [])

        // 所有用户动作共用同一个通知/加载/异常处理，业务差异仅由 method 和回调表达。
        const runAction = async ({ method, args, loading, successNotice, afterSuccess }) => {
          setNotice('')
          if (loading) setLoading(true)
          try {
            const result = await call(method, args)
            if (successNotice) setNotice(successNotice)
            if (afterSuccess) await afterSuccess(result)
          } catch (actionError) {
            setNotice(String((actionError && actionError.message) || actionError))
          } finally {
            if (loading) setLoading(false)
          }
        }

        // 作废未完成的详情请求并清除当前焦点。右侧预览本身保留，因此这里不清理预览布局状态。
        const clearSelectionFocus = () => {
          detailRequestRef.current += 1
          setSelected(null)
          setDetail(null)
          setConfirm(null)
          setMoveWorkspaceId('')
        }

        /** 选中一行并请求 Host 详情；requestId 保证快速切换时只显示最后结果。 */
        const selectItem = async (item) => {
          const requestId = ++detailRequestRef.current
          setSelected(item)
          setDetail({ loading: true })
          setConfirm(null)
          setMoveWorkspaceId('')
          // 普通、备份区和回收站会话都由 Host 返回只读详情；这里只负责请求竞态。
          try {
            const result = await call('detail', { id: item.id })
            if (detailRequestRef.current !== requestId) return
            setDetail(result)
          } catch (detailError) {
            if (detailRequestRef.current !== requestId) return
            setDetail({ loading: false, error: String((detailError && detailError.message) || detailError) })
          }
        }

        /** 再次点击当前行会取消右侧焦点，否则选中并加载详情。 */
        const toggleSelectionFocus = (item) => {
          if (selected && selected.id === item.id) clearSelectionFocus()
          else selectItem(item)
        }

        /** 在批量选择集合中加入或移除一个会话 id。 */
        const toggleSelected = (id) => {
          setSelectedIds((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id])
        }

        /** 全选或清空当前过滤后的列表。 */
        const toggleAll = () => {
          if (items.length && selectedIds.length === items.length) setSelectedIds([])
          else setSelectedIds(items.map((item) => item.id))
        }

        /** 列表刷新后，用最新 item 重新加载仍被选中的会话详情。 */
        const selectFreshItem = async (nextItems, id) => {
          const fresh = nextItems.find((candidate) => candidate.id === id)
          if (fresh) await selectItem(fresh)
        }

        // 保留当前会话焦点并重新读取列表。用于归档/恢复/移动等状态改变后，
        // 让右侧详情继续使用刷新后的数据，而不是保留旧的 archived/live 状态。
        const reloadAndReselect = async (item) => {
          const nextItems = await load()
          if (selected && selected.id === item.id) await selectFreshItem(nextItems, item.id)
        }

        // 当前会话离开列表或需要关闭确认框时，清掉焦点并重新读取列表。
        const clearSelectionAndReload = async ({ closeConfirm = false } = {}) => {
          detailRequestRef.current += 1
          if (closeConfirm) setConfirm(null)
          setSelected(null)
          setDetail(null)
          setMoveWorkspaceId('')
          await load()
        }

        /** 单条普通会话恢复：刷新列表后保留该会话的右侧焦点。 */
        const runRestore = (item) => runAction({
          method: 'restore',
          args: { id: item.id },
          successNotice: '已恢复',
          afterSuccess: () => reloadAndReselect(item)
        })

        /** 把当前选中会话移动到下拉框指定的工作区。 */
        const runMove = (item) => {
          if (!moveWorkspaceId) return
          return runAction({
            method: 'move',
            args: { id: item.id, workspaceId: moveWorkspaceId },
            successNotice: '已移动到工作区',
            afterSuccess: async () => {
              setMoveWorkspaceId('')
              await reloadAndReselect(item)
            }
          })
        }

        /** 触发 Host 的批量工作区分组修复，并在完成后刷新列表。 */
        const runRepair = () => runAction({
          method: 'repair',
          args: {},
          loading: true,
          afterSuccess: async (result) => {
            const count = (result.repaired || []).length
            setNotice(count ? `已修复 ${count} 个未分组会话` : '没有需要修复的未分组会话')
            await load()
          }
        })

        /** 归档普通会话并保留刷新后的右侧详情焦点。 */
        const runArchive = (item) => runAction({
          method: 'archive',
          args: { id: item.id },
          successNotice: '已归档',
          afterSuccess: () => reloadAndReselect(item)
        })

        /** 把归档会话移入备份区；成功后该会话离开当前普通列表。 */
        const runBackup = (item) => runAction({
          method: 'backup',
          args: { id: item.id },
          successNotice: '已移入备份保留区',
          afterSuccess: () => clearSelectionAndReload()
        })

        /** 备份区/回收站共用的恢复动作，差异仅限 method 和提示文案。 */
        const runStorageRestore = (item, method, areaLabel, unarchivedNotice) => runAction({
          method,
          args: { id: item.id },
          afterSuccess: async (result) => {
            setNotice(result.archived ? `已从${areaLabel}恢复到归档状态` : unarchivedNotice)
            await clearSelectionAndReload()
          }
        })

        /** 备份区恢复为归档状态。 */
        const runBackupRestore = (item) => runStorageRestore(item, 'backupRestore', '备份保留区', '已从备份保留区恢复')
        /** 回收站恢复为归档状态；归档状态更新失败时保留旧提示。 */
        const runTrashRestore = (item) => runStorageRestore(item, 'trashRestore', '回收站', '已从回收站恢复，但未回到归档状态')

        // 备份区没有直接彻底删除入口：必须先恢复、归档区移入回收站，再从回收站彻底删除。
        const runTrashPurge = (item) => runAction({
          method: 'trashPurge',
          args: { id: item.id },
          successNotice: '已彻底删除',
          afterSuccess: () => clearSelectionAndReload({ closeConfirm: true })
        })

        /** 把归档普通会话移入回收站，并关闭确认弹窗。 */
        const runDelete = (item) => runAction({
          method: 'delete',
          args: { id: item.id },
          successNotice: '已移入回收站',
          afterSuccess: () => clearSelectionAndReload({ closeConfirm: true })
        })

        // 行内按钮和右侧详情按钮遵循同一状态机；compact 只改变尺寸样式和“恢复/恢复归档”文案。
        const renderSessionActions = (item, compact) => {
          if (!item) return null
          const baseClass = compact ? 'dsh-session-manager-custom-row-action' : 'dsh-session-manager-custom-button'
          const actions = [
            { when: item.backedUp, label: '恢复', onClick: () => runBackupRestore(item) },
            { when: item.trashed, label: '恢复', onClick: () => runTrashRestore(item) },
            { when: item.trashed, label: '彻底删除', danger: true, onClick: () => setConfirm(item) },
            { when: item.archived, label: compact ? '恢复' : '恢复归档', onClick: () => runRestore(item) },
            { when: !item.trashed && !item.backedUp && item.archived, label: '移入备份', onClick: () => runBackup(item) },
            { when: item.archived, label: '移入回收站', danger: true, onClick: () => setConfirm(item) },
            { when: !item.trashed && !item.backedUp && !item.archived, label: '归档', onClick: () => runArchive(item) }
          ]
          return actions.filter((action) => action.when).map((action) => el('button', {
            key: `${action.label}-${action.danger ? 'danger' : 'normal'}`,
            className: baseClass + (action.danger ? ' danger' : ''),
            onClick: action.onClick
          }, action.label))
        }

        /** 将通用 UI action 归一化为 Host batch action，并汇总成功/跳过数量。 */
        const runBatch = (action) => {
          const normalizedAction = view === 'trash'
            ? (action === 'restore' ? 'trash-restore' : 'trash-delete')
            : view === 'backup'
              ? 'backup-restore'
              : action
          return runAction({
            method: 'batch',
            args: { ids: selectedIds, action: normalizedAction },
            loading: true,
            afterSuccess: async (result) => {
              const parts = []
              if (result.backedUp && result.backedUp.length) parts.push(`备份 ${result.backedUp.length}`)
              if (result.archived && result.archived.length) parts.push(`归档 ${result.archived.length}`)
              if (result.restored && result.restored.length) parts.push(`恢复 ${result.restored.length}`)
              if (result.deleted && result.deleted.length) parts.push(`删除 ${result.deleted.length}`)
              if (result.skipped && result.skipped.length) parts.push(`跳过 ${result.skipped.length}`)
              setNotice(`批量完成：${parts.join('，') || '无操作'}`)
              setBatchDeleteArmed(false)
              setSelectedIds([])
              await clearSelectionAndReload()
            }
          })
        }

        /** 开始右侧详情拖拽；move 更新宽度，up 或卸载时移除全局监听。 */
        const startDetailResize = (event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          if (resizeCleanupRef.current) resizeCleanupRef.current()
          const startX = event.clientX
          const startWidth = detailWidthRef.current
          const maxWidth = Math.max(300, Math.min(680, window.innerWidth - 520))
          let onMove
          let onUp
          const cleanup = () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            if (document.body) document.body.classList.remove('dsh-session-manager-custom-resizing')
          }
          onMove = (moveEvent) => {
            setDetailWidth(Math.max(300, Math.min(maxWidth, startWidth + (startX - moveEvent.clientX))))
          }
          onUp = () => {
            cleanup()
            resizeCleanupRef.current = null
          }
          resizeCleanupRef.current = cleanup
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
          if (document.body) document.body.classList.add('dsh-session-manager-custom-resizing')
        }

        if (!value) return null

        // 每次渲染生成轻量索引，批量按钮判断不需要重复扫描完整 items。
        const selectedIdSet = new Set(selectedIds)
        const itemById = new Map(items.map((item) => [item.id, item]))
        const archivedById = new Map(items.map((item) => [item.id, Boolean(item.archived)]))
        const allSelected = items.length > 0 && selectedIds.length === items.length
        const isStorageView = view === 'trash' || view === 'backup'
        const canBatchDelete = view === 'trash' || (selectedIds.length > 0 && selectedIds.every((id) => archivedById.get(id)))
        const canBatchBackup = !isStorageView && selectedIds.length > 0 && selectedIds.every((id) => {
          const item = itemById.get(id)
          return item && item.archived
        })

        return el('div', { className: 'dsh-session-manager-custom-root', onClick: () => setOpen(false) },
          el('div', {
            className: 'dsh-session-manager-custom-panel',
            onClick: (event) => {
              event.stopPropagation()
              if (!isFocusInteractiveTarget(event.target)) clearSelectionFocus()
            }
          },
            // 顶栏包含标题、关闭按钮和稳定的插件身份标记。
            el('div', { className: 'dsh-session-manager-custom-header' },
              el('div', { className: 'dsh-session-manager-custom-title' }, '会话数据管理'),
              el('button', { className: 'dsh-session-manager-custom-close', title: '关闭', onClick: () => setOpen(false) }, '×'),
              el('div', { className: 'dsh-session-manager-custom-id-badge' }, '「会话管理器_插件ID："session-manager-custom"」')
            ),
            // 工具栏集中渲染视图 Tab、搜索和全局修复/刷新操作。
            el('div', { className: 'dsh-session-manager-custom-toolbar' },
              el('div', { className: 'dsh-session-manager-custom-seg' },
                SESSION_TABS.map((tab) => el('button', {
                  key: tab.view,
                  className: (view === tab.view ? 'active ' : '') + tab.className,
                  title: tab.title,
                  onClick: () => setView(tab.view)
                }, tab.label(counts)))
              ),
              el('div', { className: 'dsh-session-manager-custom-search' },
                el('input', { value: queryInput, placeholder: '搜索 ID、标题、路径', onChange: (event) => setQueryInput(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') setQuery(queryInput) } }),
                el('button', { className: 'dsh-session-manager-custom-button', onClick: () => setQuery(queryInput) }, '搜索')
              ),
              el('button', { className: 'dsh-session-manager-custom-button', onClick: () => runRepair() }, '修复未分组'),
              el('button', { className: 'dsh-session-manager-custom-button', onClick: () => load() }, loading ? '加载中' : '刷新')
            ),
            // 只有选中复选框后才显示批量操作栏。
            selectedIds.length ? el('div', { className: 'dsh-session-manager-custom-batch' },
              el('span', null, `已选 ${selectedIds.length} 项`),
              canBatchBackup ? el('button', { className: 'dsh-session-manager-custom-button', onClick: () => runBatch('backup') }, '批量移入备份') : null,
              !isStorageView ? el('button', { className: 'dsh-session-manager-custom-button', onClick: () => runBatch('archive') }, '批量归档') : null,
              el('button', { className: 'dsh-session-manager-custom-button', onClick: () => runBatch('restore') }, '批量恢复'),
              (view === 'trash' || canBatchDelete) ? el('button', { className: 'dsh-session-manager-custom-button danger', onClick: () => setBatchDeleteArmed(true) }, view === 'trash' ? '彻底删除' : '移入回收站') : null
            ) : null,
            // 主体左侧为会话表格，右侧为可调整宽度的详情预览。
            el('div', { className: 'dsh-session-manager-custom-body' + (detailCollapsed ? ' detail-collapsed' : ''), style: { '--dsh-sm-detail-width': `${Math.round(detailWidth)}px` } },
              el('section', { className: 'dsh-session-manager-custom-list' },
                error ? el('div', { className: 'dsh-session-manager-custom-error' }, error) :
                el('table', { className: 'dsh-session-manager-custom-table' },
                  el('thead', null,
                    el('tr', null,
                      el('th', { style: { width: 34 } }, el('input', { type: 'checkbox', className: 'dsh-session-manager-custom-check', checked: allSelected, onChange: toggleAll })),
                      el('th', { style: { width: '32%' } }, '会话'),
                      el('th', { style: { width: '18%' } }, '状态'),
                      el('th', { style: { width: '16%' } }, '工作区'),
                      el('th', { style: { width: '24%' } }, '操作')
                    )
                  ),
                  el('tbody', null,
                    items.length === 0 ? el('tr', null, el('td', { colSpan: 5 }, el('div', { className: 'dsh-session-manager-custom-empty' }, loading ? '加载中...' : '没有匹配的会话'))) :
                    items.map((item) => el('tr', { key: item.id, className: selected && selected.id === item.id ? 'selected' : '', onClick: () => toggleSelectionFocus(item) },
                      el('td', null, el('input', { type: 'checkbox', className: 'dsh-session-manager-custom-check', checked: selectedIdSet.has(item.id), onChange: () => toggleSelected(item.id), onClick: (event) => event.stopPropagation() })),
                      el('td', null,
                        el('div', { className: 'dsh-session-manager-custom-title-cell' },
                          el('div', { className: 'dsh-session-manager-custom-title-main' },
                            el('div', null, titleFor(item)),
                            el('span', null, item.id)
                          )
                        )
                      ),
                      el('td', null,
                        el('span', { className: 'dsh-session-manager-custom-badge ' + (item.trashed ? 'trash' : item.backedUp ? 'backup' : item.archived ? 'archived' : item.live ? 'live' : hasIssue(item) ? 'issue' : '') }, item.trashed ? 'trash' : item.backedUp ? 'backup' : item.archived ? 'archived' : item.live ? 'live' : hasIssue(item) ? 'issue' : '-'),
                        item.origin === 'subagent' ? el('div', { className: 'dsh-session-manager-custom-badge subagent', style: { marginTop: 4 } }, 'subagent') : null,
                        item.running ? el('div', { className: 'dsh-session-manager-custom-badge live', style: { marginTop: 4 } }, 'running') : null
                      ),
                      el('td', null, item.workspace ? item.workspace.title : '未分组'),
                      el('td', null,
                        el('div', { className: 'dsh-session-manager-custom-row-actions', onClick: (event) => event.stopPropagation() },
                          el('button', { className: 'dsh-session-manager-custom-row-action', onClick: () => selectItem(item) }, '详情'),
                          renderSessionActions(item, true)
                        )
                      )
                    ))
                  )
                )
              ),
              el('div', { className: 'dsh-session-manager-custom-resizer', title: '拖拽调整右侧宽度', onMouseDown: startDetailResize, onDoubleClick: () => setDetailCollapsed(!detailCollapsed) }),
              // 收起时仍保留详情面板挂载，避免宽度和布局状态被重置。
              el('aside', { className: 'dsh-session-manager-custom-detail' + (detailCollapsed ? ' collapsed' : '') },
                el('div', { className: 'dsh-session-manager-custom-detail-head' },
                  !detailCollapsed ? el('div', { className: 'dsh-session-manager-custom-detail-head-title' }, '只读预览') : null,
                  el('button', { className: 'dsh-session-manager-custom-detail-collapse', title: detailCollapsed ? '展开右侧预览' : '收起右侧预览', onClick: () => setDetailCollapsed(!detailCollapsed) }, detailCollapsed ? '«' : '»')
                ),
                !detailCollapsed ? el('div', { className: 'dsh-session-manager-custom-detail-content' },
                !selected ? el('div', { className: 'dsh-session-manager-custom-empty' }, '选择左侧会话查看只读预览') :
                el('div', null,
                  el('div', { className: 'dsh-session-manager-custom-detail-title' }, titleFor(selected)),
                  el('div', { className: 'dsh-session-manager-custom-detail-meta' },
                    el('span', null, selected.id),
                    el('span', null, timeText(selected.createdAt)),
                    selected.workspace ? el('span', null, selected.workspace.title) : null
                  ),
                  detail && detail.loading ? el('div', { className: 'dsh-session-manager-custom-empty' }, '正在读取会话...') :
                  detail && detail.error ? el('div', { className: 'dsh-session-manager-custom-error' }, detail.error) :
                  detail && detail.surfaceError ? el('div', { className: 'dsh-session-manager-custom-error' }, `表面重建失败: ${detail.surfaceError}`) :
                  el('div', { className: 'dsh-session-manager-custom-detail-meta' }, detail ? el('span', null, `${detail.eventCount || 0} 个事件`) : null),
                  el('div', { className: 'dsh-session-manager-custom-move' },
                    el('select', { value: moveWorkspaceId, onChange: (event) => setMoveWorkspaceId(event.target.value), disabled: !selected || selected.trashed || selected.backedUp }, [
                      el('option', { value: '' }, '移动到工作区...'),
                      ...workspaces.map((ws) => el('option', { key: ws.id, value: ws.id }, ws.title))
                    ]),
                    el('button', { className: 'dsh-session-manager-custom-button', disabled: !moveWorkspaceId || !selected || selected.trashed || selected.backedUp, onClick: () => runMove(selected) }, '移动')
                  ),
                  el('div', { className: 'dsh-session-manager-custom-actions' },
                    renderSessionActions(selected, false)
                  ),
                  el('div', { className: 'dsh-session-manager-custom-preview' },
                    detail && detail.preview && detail.preview.length ? detail.preview.map((message) => el('div', { key: `${message.seq}-${message.type}`, className: 'dsh-session-manager-custom-msg ' + message.role }, message.text)) :
                    (!detail || detail.loading) ? null : el('div', { className: 'dsh-session-manager-custom-empty' }, '这个会话没有可预览的消息')
                  )
                )) : null
              )
            ),
            // 操作反馈和单项破坏性操作确认层覆盖在面板主体之上。
            notice ? el('div', { className: 'dsh-session-manager-custom-error', style: { padding: '8px 16px' } }, notice) : null,
            confirm ? el('div', { className: 'dsh-session-manager-custom-confirm' },
              el('div', { className: 'dsh-session-manager-custom-confirm-box' },
                el('p', null, confirm.trashed ? `确认彻底删除回收站会话 ${titleFor(confirm)}？此操作不可恢复。` : `确认将${confirm.archived ? '归档会话' : '会话'} ${titleFor(confirm)}移入回收站？可稍后从回收站恢复。`),
                el('div', { className: 'dsh-session-manager-custom-confirm-actions' },
                  el('button', { className: 'dsh-session-manager-custom-button', onClick: () => setConfirm(null) }, '取消'),
                  confirm.trashed ? el('button', { className: 'dsh-session-manager-custom-button danger', onClick: () => runTrashPurge(confirm) }, '彻底删除') : el('button', { className: 'dsh-session-manager-custom-button danger', onClick: () => runDelete(confirm) }, '移入回收站')
                )
              )
            ) : null,
            // 批量确认使用 selectedIds，和单项确认状态分开维护。
            batchDeleteArmed ? el('div', { className: 'dsh-session-manager-custom-confirm' },
              el('div', { className: 'dsh-session-manager-custom-confirm-box' },
                el('p', null, view === 'trash' ? `确认彻底删除选中的 ${selectedIds.length} 个回收站会话？此操作不可恢复。` : `确认将选中的 ${selectedIds.length} 个会话移入回收站？可稍后从回收站恢复。`),
                el('div', { className: 'dsh-session-manager-custom-confirm-actions' },
                  el('button', { className: 'dsh-session-manager-custom-button', onClick: () => setBatchDeleteArmed(false) }, '取消'),
                  el('button', { className: 'dsh-session-manager-custom-button danger', onClick: () => runBatch('delete') }, view === 'trash' ? '彻底删除' : '移入回收站')
                )
              )
            ) : null
          )
        )
      }

      // 两个 Slot 共享 useManagerOpen 的模块级状态，因此侧边栏按钮可以打开同一个 overlay。
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'dsh-session-manager-custom-trigger', label: 'session-manager-custom' },
        (props) => el(Trigger, { ...props })
      ))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'dsh-session-manager-custom-overlay' },
        () => el(Overlay, null)
      ))
    }

    // ModuleLoader 的 factory 以 CommonJS 形式返回 Cordis Client Plugin 契约。
    module.exports = { name, inject, apply }
    return module.exports
  }
})
