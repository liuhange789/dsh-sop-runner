/**
 * Host half of dsh-sop-runner.
 *
 * Two real surfaces:
 * - four tools (`sop_init` / `sop_today` / `sop_check` / `sop_report`) that read
 *   and write `.sop/` in the calling session's workspace;
 * - an optional HTTP bridge at `/sop-runner/api` (only when the web composition
 *   mounts `webServer`) that the browser card uses to show the checklist and
 *   post results/photos without going through the model.
 *
 * The workspace comes from `exec.agent.session.header.cwd` — the same source
 * `dsh-tool-fs` uses — with `process.cwd()` as the non-agent fallback.
 *
 * @module dsh-sop-runner
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  FREQUENCIES,
  ITEM_TYPES,
  PHOTO_EXTENSIONS,
  STATUSES,
  checkItem,
  defaultStore,
  localDate,
  normalizeDefinition,
  readDefinition,
  reportFor,
  sopPaths,
  todayView,
  writeDefinition,
} from '../core/sop.js'

/** Plugin id used by the loader entry and diagnostics. */
export const name = 'sop-runner'

/** Only the tool registry is a hard dependency; the web bridge is optional. */
export const inject = ['tools']

/** Composition-entry configuration. The plugin has no tunable policy yet. */
export const Config = z.object({
  /** Store label for workspaces whose SOP JSON does not name one; empty = folder name. */
  store: z.string().default(''),
})

/** Bridge path served by the web composition. */
export const BRIDGE_PATH = '/sop-runner/api'

/** Largest accepted browser photo, decoded. */
const MAX_PHOTO_BYTES = 8 * 1024 * 1024

/** Largest accepted bridge request body (base64 makes the payload ~1.37x). */
const MAX_BODY_BYTES = 12 * 1024 * 1024

/** The item shape every tool result carries. */
const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    type: { type: 'string', enum: ITEM_TYPES },
    required: { type: 'boolean' },
    status: { type: 'string', enum: ['pending', ...STATUSES] },
    note: { type: 'string' },
    photo: { type: 'string' },
    at: { type: 'string' },
  },
}

/** Checklist/result projection shared by `sop_today` and `sop_check`. */
const VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    frequency: { type: 'string', enum: FREQUENCIES },
    store: { type: 'string' },
    date: { type: 'string' },
    windowStart: { type: 'string' },
    windowEnd: { type: 'string' },
    totalItems: { type: 'integer' },
    total: { type: 'integer', description: '按必做条目计数的完成率分母' },
    checked: { type: 'integer' },
    passed: { type: 'integer' },
    failed: { type: 'integer' },
    completionRate: { type: 'integer' },
    items: { type: 'array', items: ITEM_SCHEMA },
    pendingIds: { type: 'array', items: { type: 'string' } },
    pendingRequiredIds: { type: 'array', items: { type: 'string' } },
    failedIds: { type: 'array', items: { type: 'string' } },
    recordsRead: { type: 'integer' },
    invalidLines: { type: 'integer' },
  },
}
/**
 * The calling session's workspace directory.
 * @param {*} exec - tool execution context.
 * @returns {string} absolute workspace path.
 */
function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') return cwd
  return process.cwd()
}

/** Throw a tool failure from a `{ ok:false, error }` core result. */
function unwrap(result) {
  if (!result.ok) throw new Error(result.error)
  return result
}

/** Remove the core's `ok` discriminant, which the output schema does not declare. */
function publicView(view) {
  const { ok: _ok, ...rest } = view
  return rest
}

/** Render a checklist view as text. */
function renderView(value) {
  const lines = [
    `SOP：${value.name}（${value.frequency}）· 门店：${value.store} · ${value.date}`,
    `完成率 ${value.checked}/${value.total}（${value.completionRate}%）· 异常 ${value.failed} 项`,
  ]
  const pending = value.items.filter(item => item.status === 'pending')
  lines.push(pending.length === 0 ? '未完成：无' : `未完成：${pending.map(item => `${item.label}${item.required ? '' : '（选做）'}`).join('、')}`)
  const failed = value.items.filter(item => item.status === 'fail')
  if (failed.length > 0) {
    lines.push(`异常项：${failed.map(item => `${item.label}${item.note === '' ? '' : ` — ${item.note}`}`).join('；')}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Read a JSON body with a hard size cap. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体超过 12MB'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** Write JSON to one response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

/**
 * Archive one browser photo under `.sop/photos/<date>/`.
 * @param {string} workspaceDir - absolute workspace directory.
 * @param {string} date - record date.
 * @param {string} itemId - item the photo evidences.
 * @param {{ name?: string, data?: string }} photo - browser upload.
 * @returns {Promise<string>} workspace-relative photo path.
 */
async function savePhoto(workspaceDir, date, itemId, photo) {
  if (typeof photo?.data !== 'string' || photo.data === '') throw new Error('photo.data 为空')
  const extension = path.extname(String(photo.name ?? '')).slice(1).toLowerCase()
  if (!PHOTO_EXTENSIONS.includes(extension)) throw new Error(`照片扩展名只能是 ${PHOTO_EXTENSIONS.join(' / ')}`)
  const decoded = Buffer.from(photo.data, 'base64')
  if (decoded.length === 0) throw new Error('照片内容为空')
  if (decoded.length > MAX_PHOTO_BYTES) throw new Error('照片超过 8MB')
  const targetDir = path.join(sopPaths(workspaceDir).photos, date)
  await mkdir(targetDir, { recursive: true })
  const safeId = itemId.replace(/[^A-Za-z0-9_-]/g, '_')
  const file = path.join(targetDir, `${safeId}-${Date.now()}.${extension}`)
  await writeFile(file, decoded)
  return path.relative(workspaceDir, file).split(path.sep).join('/')
}

/**
 * Reject an obviously invalid bridge submission before a photo is archived,
 * so a failed request never leaves an orphan image behind. `checkItem` still
 * runs the full validation afterwards.
 * @param {object} definition - loaded SOP definition.
 * @param {object} body - bridge request body.
 */
function preflightBridgeCheck(definition, body) {
  const itemId = typeof body.item_id === 'string' ? body.item_id.trim() : ''
  if (!definition.items.some(item => item.id === itemId)) throw new Error(`未知 item_id：${itemId || '(空)'}`)
  if (!STATUSES.includes(body.status)) throw new Error(`status 只能是 ${STATUSES.join(' / ')}`)
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw new Error('note 必须是字符串')
  if (body.status === 'fail' && (typeof body.note !== 'string' || body.note.trim() === '')) {
    throw new Error('标记不通过时必须填写 note（哪里没做到）')
  }
}

/**
 * Resolve and validate the workspace a bridge request names.
 * @param {unknown} dir - query/body directory.
 * @returns {Promise<string>} absolute existing directory.
 */
async function resolveBridgeDir(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new Error('缺少 dir（当前会话工作区）')
  const value = dir.trim()
  if (!path.isAbsolute(value)) throw new Error('dir 必须是绝对路径')
  const info = await stat(value)
  if (!info.isDirectory()) throw new Error('dir 不是目录')
  return value
}

/**
 * Build the HTTP handler the web composition mounts. Exported so a test can
 * drive it with a real `http.createServer` without a full DSH boot.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler.
 */
export function createBridgeHandler() {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== BRIDGE_PATH) {
        sendJson(res, 404, { ok: false, error: '未知路径' })
        return
      }
      if (req.method === 'GET') {
        const workspaceDir = await resolveBridgeDir(url.searchParams.get('dir'))
        const date = url.searchParams.get('date') ?? localDate()
        const storeParam = url.searchParams.get('store')
        const store = storeParam === null || storeParam === '' ? undefined : storeParam
        if (url.searchParams.get('report') === '1') {
          sendJson(res, 200, await reportFor(workspaceDir, { date, ...(store === undefined ? {} : { store }) }))
          return
        }
        sendJson(res, 200, await todayView(workspaceDir, { date, ...(store === undefined ? {} : { store }) }))
        return
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const workspaceDir = await resolveBridgeDir(body.dir)
        const loaded = await readDefinition(workspaceDir)
        if (!loaded.ok) throw new Error(loaded.error)
        const date = body.date ?? localDate()
        const storeParam = typeof body.store === 'string' && body.store.trim() !== '' ? body.store.trim() : undefined
        const store = storeParam ?? defaultStore(workspaceDir, loaded.definition)
        preflightBridgeCheck(loaded.definition, body)
        let photo
        if (body.photo !== undefined && body.photo !== null) {
          photo = await savePhoto(workspaceDir, date, String(body.item_id ?? ''), body.photo)
        }
        const result = await checkItem(workspaceDir, {
          item_id: body.item_id,
          status: body.status,
          note: body.note,
          store,
          date,
          ...(photo === undefined ? {} : { photo }),
        })
        if (!result.ok) {
          sendJson(res, 400, { ok: false, error: result.error })
          return
        }
        sendJson(res, 200, { ok: true, view: result.view, saved: { recordPath: result.recordPath, itemId: result.itemId, status: result.status, ...(result.photo === undefined ? {} : { photo: result.photo }) } })
        return
      }
      sendJson(res, 405, { ok: false, error: '只接受 GET / POST' })
    } catch (cause) {
      sendJson(res, 400, { ok: false, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }
}

/**
 * Register the host plugin.
 * @param {*} ctx - host plugin context.
 * @param {*} config - validated composition config.
 */
export function apply(ctx, config) {
  const configuredStore = typeof config?.store === 'string' ? config.store.trim() : ''

  ctx.tools.register(defineTool({
    name: 'sop_init',
    description: [
      'Create or replace the workspace SOP definition in .sop/sop.json: a named checklist of confirm/photo items with a daily or weekly cadence.',
      'Refuses to replace an existing SOP unless overwrite: true. Item ids must be unique and stable (they are the keys recorded in the JSONL history).',
      'Use this once per store workspace; afterwards call sop_today to see what is left for today.',
    ].join(' '),
    parameters: {
      name: { type: 'string', required: true, description: 'SOP 名称，例如「开档前自检」' },
      frequency: { type: 'string', enum: FREQUENCIES, description: 'daily（按天）或 weekly（按周一到周日汇总），默认 daily' },
      store: { type: 'string', description: '门店名；留空则用工作区目录名。记录与日报按门店区分' },
      items: {
        type: 'array',
        required: true,
        description: '检查条目，1-50 条。photo 类型条目标记通过时必须带照片',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '稳定唯一 id，字母数字/下划线/连字符，≤40 字' },
            label: { type: 'string', required: true, description: '员工看到的中文检查项，≤120 字' },
            type: { type: 'string', enum: ITEM_TYPES, description: 'confirm（口头确认）或 photo（需照片留证）' },
            required: { type: 'boolean', description: '是否计入完成率，默认 true' },
          },
        },
      },
      overwrite: { type: 'boolean', description: '已有 .sop/sop.json 时是否替换，默认 false' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          created: { type: 'boolean' },
          overwritten: { type: 'boolean' },
          definitionPath: { type: 'string' },
          name: { type: 'string' },
          frequency: { type: 'string', enum: FREQUENCIES },
          store: { type: 'string' },
          itemCount: { type: 'integer' },
        },
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: `已${value.overwritten ? '替换' : '创建'} SOP：${value.name}（${value.frequency}）· 门店：${value.store} · ${value.itemCount} 项\n定义文件：${value.definitionPath}`,
        }]
      },
    },
    presentCall(args) {
      return { card: 'generic', title: 'SOP init', kind: 'other', rawInput: { name: args.name, items: Array.isArray(args.items) ? args.items.length : 0 } }
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspaceDir = workspaceOf(exec)
      const store = typeof args.store === 'string' && args.store.trim() !== ''
        ? args.store.trim()
        : configuredStore !== '' ? configuredStore : defaultStore(workspaceDir, {})
      const normalized = normalizeDefinition({
        name: args.name,
        frequency: args.frequency ?? 'daily',
        ...(store === '' ? {} : { store }),
        items: args.items,
      })
      if (!normalized.ok) throw new Error(normalized.error)
      const written = await writeDefinition(workspaceDir, normalized.definition, { overwrite: args.overwrite === true })
      if (!written.ok) throw new Error(written.error)
      return {
        created: written.created,
        overwritten: written.overwritten,
        definitionPath: written.definitionPath,
        name: written.definition.name,
        frequency: written.definition.frequency,
        store: defaultStore(workspaceDir, written.definition),
        itemCount: written.definition.items.length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sop_today',
    description: [
      'Show today\'s SOP checklist from .sop/sop.json with the last recorded result for every item, the completion rate over required items, and the ids still pending or failed.',
      'Reads the .sop/records/<date>.jsonl history; the newest submission for the same store and item wins. Does not write anything.',
      'Call this before marking items so the model knows exactly what is missing ("今天该查什么、查了没有").',
    ].join(' '),
    parameters: {
      date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
      store: { type: 'string', description: '门店名，默认取 SOP 的 store 字段或工作区目录名' },
    },
    output: { schema: VIEW_SCHEMA, render: (_args, value) => renderView(value) },
    presentCall(args) {
      return { card: 'generic', title: 'SOP today', kind: 'other', rawInput: { store: args.store, date: args.date } }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const workspaceDir = workspaceOf(exec)
      const store = args.store ?? (configuredStore !== '' ? configuredStore : undefined)
      return publicView(unwrap(await todayView(workspaceDir, {
        ...(args.date === undefined ? {} : { date: args.date }),
        ...(store === undefined ? {} : { store }),
      })))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sop_check',
    description: [
      'Record one SOP item result and append it to .sop/records/<date>.jsonl.',
      'status fail requires a non-empty note (what was not done); a photo-type item marked pass requires a photo path inside the workspace. Unknown item ids and future dates are rejected before anything is written.',
      'Returns the refreshed checklist so the next item to check is obvious.',
    ].join(' '),
    parameters: {
      item_id: { type: 'string', required: true, description: 'sop_today 返回的条目 id' },
      status: { type: 'string', required: true, enum: STATUSES, description: 'pass 通过 / fail 不通过（必须写备注）' },
      note: { type: 'string', description: '备注；fail 时必填，说明哪里没做到；≤500 字' },
      photo: { type: 'string', description: '工作区内的照片相对路径（photo 类型条目标记通过时必填）' },
      store: { type: 'string', description: '门店名，默认取 SOP 的 store 字段或工作区目录名' },
      date: { type: 'string', description: 'YYYY-MM-DD，默认今天；补记只能用过去日期' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          itemId: { type: 'string' },
          label: { type: 'string' },
          status: { type: 'string', enum: STATUSES },
          note: { type: 'string' },
          photo: { type: 'string' },
          recordPath: { type: 'string' },
          view: VIEW_SCHEMA,
        },
      },
      render(_args, value) {
        const next = value.view.items.find(item => item.status === 'pending')
        return [{
          type: 'text',
          text: [
            `已记录：${value.label} → ${value.status === 'pass' ? '通过' : '不通过'}${value.note === '' ? '' : `（${value.note}）`}${value.photo === undefined ? '' : ` · 照片 ${value.photo}`}`,
            `今日完成率 ${value.view.checked}/${value.view.total}（${value.view.completionRate}%）· 异常 ${value.view.failed} 项`,
            next === undefined ? '所有条目已检查。' : `下一条未完成：${next.label}（${next.id}）`,
          ].join('\n'),
        }]
      },
    },
    presentCall(args) {
      return { card: 'generic', title: 'SOP check', kind: 'other', rawInput: { item_id: args.item_id, status: args.status } }
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const workspaceDir = workspaceOf(exec)
      const result = unwrap(await checkItem(workspaceDir, {
        item_id: args.item_id,
        status: args.status,
        ...(args.note === undefined ? {} : { note: args.note }),
        ...(args.photo === undefined ? {} : { photo: args.photo }),
        ...(args.store === undefined ? {} : { store: args.store }),
        ...(args.date === undefined ? {} : { date: args.date }),
      }))
      return {
        itemId: result.itemId,
        label: result.label,
        status: result.status,
        note: result.note,
        ...(result.photo === undefined ? {} : { photo: result.photo }),
        recordPath: result.recordPath,
        view: publicView(result.view),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sop_report',
    description: [
      'Generate the plain-text daily SOP report for one store: completion rate, the exception items with their notes, the pending items, and the trend against the previous period (yesterday for a daily SOP, last week for a weekly one).',
      'Reads .sop/records only and never charts or calls an LLM. Use it to answer "查了没有、哪里没做到" with the recorded facts.',
    ].join(' '),
    parameters: {
      date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
      store: { type: 'string', description: '门店名，默认取 SOP 的 store 字段或工作区目录名' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          frequency: { type: 'string', enum: FREQUENCIES },
          store: { type: 'string' },
          date: { type: 'string' },
          period: { type: 'string' },
          total: { type: 'integer' },
          checked: { type: 'integer' },
          passed: { type: 'integer' },
          failed: { type: 'integer' },
          completionRate: { type: 'integer' },
          pendingIds: { type: 'array', items: { type: 'string' } },
          failedIds: { type: 'array', items: { type: 'string' } },
          failedItems: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                note: { type: 'string' },
                photo: { type: 'string' },
              },
            },
          },
          previousPeriod: {
            type: 'object',
            additionalProperties: false,
            properties: {
              start: { type: 'string' },
              end: { type: 'string' },
              completionRate: { type: 'integer' },
              failed: { type: 'integer' },
              records: { type: 'integer' },
            },
          },
          trend: {
            type: 'object',
            additionalProperties: false,
            properties: {
              baseline: { type: 'string' },
              available: { type: 'boolean' },
              deltaPoints: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              exceptionDelta: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              direction: { type: 'string', enum: ['up', 'down', 'flat', 'no-baseline'] },
            },
          },
          summary: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.summary }]
      },
    },
    presentCall(args) {
      return { card: 'generic', title: 'SOP report', kind: 'other', rawInput: { store: args.store, date: args.date } }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const workspaceDir = workspaceOf(exec)
      const store = args.store ?? (configuredStore !== '' ? configuredStore : undefined)
      return publicView(unwrap(await reportFor(workspaceDir, {
        ...(args.date === undefined ? {} : { date: args.date }),
        ...(store === undefined ? {} : { store }),
      })))
    },
  }))

  // Optional browser bridge: only exists when the web composition mounts webServer.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], webCtx => {
      const handler = createBridgeHandler()
      webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: BRIDGE_PATH, handler }))
    })
  }
}
