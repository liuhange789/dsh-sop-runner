/**
 * Browser half of dsh-sop-runner.
 *
 * Contributes one real slot of the web shell — `conversation.input.dock` — a
 * compact「SOP 自检」bar above the composer. It reads the current session's
 * workspace from the client session list (`ctx.sessions.list`, the same place
 * the sidebar reads titles/cwd), then talks to the host bridge at
 * `/sop-runner/api`: GET for the checklist and the plain-text report, POST for
 *「通过 / 不通过 / 拍照」. The host writes `.sop/records/<date>.jsonl`; this file
 * never touches the filesystem.
 *
 * @module dsh-sop-runner/client
 */

import React from 'react'

/** Client plugin name shown in diagnostics. */
export const name = 'sop-runner-client'

/** Both the slot registry and the sessions list are needed for the workspace cwd. */
export const inject = ['slots', 'sessions']

/** Host bridge endpoint registered by the host half. */
const BRIDGE = '/sop-runner/api'

/** Largest browser photo accepted by the bridge. */
const MAX_PHOTO_BYTES = 8 * 1024 * 1024

const ACTION_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '3px 8px',
  minHeight: '28px',
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
  borderRadius: '8px',
  color: 'inherit',
  font: 'inherit',
  fontSize: '12px',
  lineHeight: '18px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const SMALL_BUTTON = {
  font: 'inherit',
  fontSize: '12px',
  padding: '4px 10px',
  borderRadius: '7px',
  border: '1px solid var(--dsw-alias-border-l2, #d3d8df)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}

const PASS_BUTTON = {
  ...SMALL_BUTTON,
  border: '1px solid #15803d',
  color: '#15803d',
}

const FAIL_BUTTON = {
  ...SMALL_BUTTON,
  border: '1px solid #b91c1c',
  color: '#b91c1c',
}

const PANEL_STYLE = {
  marginBottom: '8px',
  padding: '12px 14px',
  borderRadius: '12px',
  border: '1px solid var(--dsw-alias-border-l1, #e3e6eb)',
  background: 'var(--dsw-alias-bg-layer-1, #fff)',
  color: 'var(--dsw-alias-label-primary, #1b1f24)',
  fontSize: '13px',
  lineHeight: '1.55',
  maxHeight: 'min(52vh, 560px)',
  overflow: 'auto',
}

const ROW_STYLE = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '10px',
  padding: '7px 0',
  borderTop: '1px solid var(--dsw-alias-border-l1, #f0f2f5)',
}

/**
 * GET the checklist or the plain-text report for one workspace.
 * @param {string} dir - absolute workspace directory.
 * @param {{ report?: boolean }} [options] - report switch.
 * @returns {Promise<object>} bridge payload.
 */
async function loadState(dir, options = {}) {
  const query = new URLSearchParams({ dir })
  if (options.report === true) query.set('report', '1')
  const response = await fetch(`${BRIDGE}?${query.toString()}`, { headers: { accept: 'application/json' } })
  const payload = await response.json()
  if (!response.ok && payload?.error === undefined) throw new Error(`bridge ${response.status}`)
  return payload
}

/**
 * POST one check result (optionally with an archived photo).
 * @param {object} body - `{ dir, item_id, status, note?, photo? }`.
 * @returns {Promise<object>} bridge payload.
 */
async function postCheck(body) {
  const response = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json()
}

/**
 * Read a picked image file as base64 (no data URL prefix).
 * @param {File} file - browser file.
 * @returns {Promise<{ name: string, data: string }>} bridge photo payload.
 */
function readPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve({ name: file.name, data: comma === -1 ? '' : result.slice(comma + 1) })
    }
    reader.onerror = () => reject(new Error('读取照片失败'))
    reader.readAsDataURL(file)
  })
}

/** Whether an item's status chip is pending. */
function statusLabel(item) {
  if (item.status === 'pass') return '通过'
  if (item.status === 'fail') return '不通过'
  return '未查'
}

/** Status chip colors. */
function statusStyle(item) {
  if (item.status === 'pass') return { color: '#15803d', borderColor: '#86efac', background: '#f0fdf4' }
  if (item.status === 'fail') return { color: '#b91c1c', borderColor: '#fecaca', background: '#fef2f2' }
  return { color: '#b45309', borderColor: '#fde68a', background: '#fffbeb' }
}

/**
 * The dock entry. Frameworks pass `sessionId`; `getCwd`/`subscribeSessions`
 * come from apply's closure over `ctx.sessions.list`.
 * @param {object} props - slot props plus the sessions feed.
 * @returns {React.ReactElement | null} the SOP bar.
 */
export function SopDock(props) {
  const { sessionId, getCwd, subscribeSessions } = props
  const dir = React.useSyncExternalStore(
    subscribeSessions,
    () => getCwd(sessionId),
    () => undefined,
  )
  const [open, setOpen] = React.useState(false)
  const [payload, setPayload] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [failFor, setFailFor] = React.useState(null)
  const [note, setNote] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [report, setReport] = React.useState(null)
  const photoInput = React.useRef(null)
  const photoItem = React.useRef(null)

  const refresh = React.useCallback(async () => {
    if (!dir) return
    setLoading(true)
    setError('')
    try {
      setPayload(await loadState(dir))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [dir])

  React.useEffect(() => {
    if (dir) refresh()
    else setPayload(null)
  }, [dir, refresh])

  React.useEffect(() => {
    setOpen(false)
    setReport(null)
    setFailFor(null)
    setNote('')
  }, [dir])

  if (!dir) return null

  const view = payload?.ok === true ? payload : null
  const missing = payload !== null && payload?.ok !== true

  const submit = async body => {
    setBusy(true)
    setError('')
    try {
      const result = await postCheck({ dir, ...body })
      if (result.ok !== true) {
        setError(result.error ?? '记录失败')
        return false
      }
      setPayload(result.view)
      setReport(null)
      setFailFor(null)
      setNote('')
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const pass = async item => {
    if (item.type === 'photo') {
      photoItem.current = item
      photoInput.current?.click()
      return
    }
    await submit({ item_id: item.id, status: 'pass' })
  }

  const onPhotoPicked = async event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    const item = photoItem.current
    photoItem.current = null
    if (!file || !item) return
    if (file.size > MAX_PHOTO_BYTES) {
      setError('照片超过 8MB，请压缩后再上传')
      return
    }
    const photo = await readPhoto(file)
    await submit({ item_id: item.id, status: 'pass', photo })
  }

  const openFail = item => {
    setFailFor(item.id)
    setNote('')
  }

  const submitFail = async item => {
    if (note.trim() === '') return
    await submit({ item_id: item.id, status: 'fail', note: note.trim() })
  }

  const loadReport = async () => {
    setLoading(true)
    setError('')
    try {
      setReport(await loadState(dir, { report: true }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  const summaryText = view === null
    ? (missing ? '未配置' : loading ? '读取中…' : 'SOP 自检')
    : `${view.name} · ${view.checked}/${view.total} 完成${view.failed > 0 ? ` · 异常 ${view.failed}` : ''}`

  return (
    <div>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
          padding: '6px 10px', borderRadius: '10px',
          border: '1px solid var(--dsw-alias-border-l1, #e3e6eb)',
          background: 'var(--dsw-alias-fill-l1, #f8fafc)', fontSize: '12px',
        }}
      >
        <button
          type="button"
          style={{ ...ACTION_STYLE, border: 'none', padding: '2px 4px' }}
          onClick={() => { setOpen(current => !current); if (!open && view === null) refresh() }}
          title="展开 / 收起今日 SOP 清单"
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span>SOP 自检</span>
        </button>
        <span style={{ opacity: 0.78 }}>{summaryText}</span>
        {view !== null && view.failed > 0 ? (
          <span style={{ color: '#b91c1c' }}>异常 {view.failed} 项</span>
        ) : null}
        {view !== null ? (
          <button type="button" style={{ ...SMALL_BUTTON, padding: '2px 8px' }} onClick={refresh} disabled={loading || busy}>
            刷新
          </button>
        ) : null}
      </div>

      {open ? (
        <div style={PANEL_STYLE}>
          {error !== '' ? (
            <div style={{ color: '#b91c1c', marginBottom: '8px' }}>{error}</div>
          ) : null}
          {missing ? (
            <div style={{ opacity: 0.75 }}>
              {payload.error ?? '工作区还没有 SOP'}。让助手调用 <code>sop_init</code> 创建后，这里会出现今日清单。
            </div>
          ) : null}
          {view !== null ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
                <span style={{ fontWeight: 600 }}>{view.store} · {view.date}</span>
                <span style={{ opacity: 0.75 }}>
                  {view.frequency === 'weekly' ? `本周 ${view.windowStart} ~ ${view.windowEnd}` : '按天'} · 完成率 {view.completionRate}%
                </span>
              </div>
              {view.items.map(item => (
                <div key={item.id} style={ROW_STYLE}>
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: item.status === 'pending' && item.required ? 600 : 400 }}>{item.label}</span>
                      {item.type === 'photo' ? (
                        <span style={{ fontSize: '11px', opacity: 0.7 }}>需照片</span>
                      ) : null}
                      {item.required ? null : <span style={{ fontSize: '11px', opacity: 0.7 }}>选做</span>}
                      <span style={{ border: '1px solid', fontSize: '11px', padding: '1px 6px', borderRadius: '999px', ...statusStyle(item) }}>
                        {statusLabel(item)}
                      </span>
                    </div>
                    {item.status === 'fail' && item.note !== '' ? (
                      <div style={{ fontSize: '12px', color: '#b91c1c', marginTop: '2px' }}>{item.note}</div>
                    ) : null}
                    {item.photo !== undefined ? (
                      <div style={{ fontSize: '11px', opacity: 0.65, marginTop: '2px', wordBreak: 'break-all' }}>照片：{item.photo}</div>
                    ) : null}
                    {failFor === item.id ? (
                      <div style={{ marginTop: '6px' }}>
                        <textarea
                          value={note}
                          onChange={event => setNote(event.target.value)}
                          placeholder="必填：哪里没做到（例如台面有残留污渍）"
                          rows={2}
                          style={{
                            width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: '8px',
                            border: '1px solid var(--dsw-alias-border-l2, #d8dce3)', background: 'transparent',
                            color: 'inherit', font: 'inherit', fontSize: '12px', resize: 'vertical',
                          }}
                        />
                        <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                          <button type="button" style={FAIL_BUTTON} disabled={busy || note.trim() === ''} onClick={() => submitFail(item)}>
                            提交不通过
                          </button>
                          <button type="button" style={SMALL_BUTTON} onClick={() => { setFailFor(null); setNote('') }}>
                            取消
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {failFor === item.id ? null : (
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <button type="button" style={PASS_BUTTON} disabled={busy} onClick={() => pass(item)}>
                        {item.type === 'photo' ? '拍照通过' : '通过'}
                      </button>
                      <button type="button" style={FAIL_BUTTON} disabled={busy} onClick={() => openFail(item)}>
                        不通过
                      </button>
                    </div>
                  )}
                </div>
              ))}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px', alignItems: 'center' }}>
                <button type="button" style={SMALL_BUTTON} onClick={loadReport} disabled={loading || busy}>
                  生成今日日报
                </button>
                <span style={{ fontSize: '11px', opacity: 0.6 }}>日报只读已写入的 .sop/records，纯文本，不含图表</span>
              </div>
              {report !== null ? (
                report.ok === true ? (
                  <pre style={{
                    whiteSpace: 'pre-wrap', font: 'inherit', fontSize: '12px', margin: '8px 0 0',
                    padding: '10px', borderRadius: '9px', background: 'var(--dsw-alias-fill-l1, #f8fafc)',
                    border: '1px solid var(--dsw-alias-border-l1, #e3e6eb)',
                  }}>{report.summary}</pre>
                ) : (
                  <div style={{ color: '#b91c1c', fontSize: '12px', marginTop: '6px' }}>{report.error}</div>
                )
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={onPhotoPicked}
      />
    </div>
  )
}

/**
 * Client plugin body: contribute the dock bar and wire the session cwd feed.
 * @param {*} ctx - client plugin context.
 */
export function apply(ctx) {
  const subscribeSessions = listener => ctx.sessions.list.subscribe(listener)
  const getCwd = sessionId => {
    const state = ctx.sessions.list.getSnapshot()
    return state.byId?.[sessionId]?.cwd ?? state.byId?.[state.current]?.cwd
  }
  const Entry = props => (
    <SopDock {...props} getCwd={getCwd} subscribeSessions={subscribeSessions} />
  )
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'sop-runner',
    order: 35,
  }, Entry))
}
