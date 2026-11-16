/**
 * Core of dsh-sop-runner: the SOP definition, the daily check window, the
 * append-only JSONL record store, and the plain-text daily report.
 *
 * Everything here is plain fs + string handling so the same code runs in the
 * host (tools + HTTP bridge) and in the browser bundle (client card), and the
 * unit tests can drive it against a real temporary workspace.
 *
 * @module dsh-sop-runner/core
 */

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Accepted SOP cadences. `weekly` rolls the current Monday–Sunday week up. */
export const FREQUENCIES = Object.freeze(['daily', 'weekly'])

/** Accepted check outcomes. `fail` is an exception and requires a note. */
export const STATUSES = Object.freeze(['pass', 'fail'])

/** Accepted item evidence kinds. `photo` needs an archived photo to pass. */
export const ITEM_TYPES = Object.freeze(['confirm', 'photo'])

/** A human-readable note longer than this is rejected instead of truncated. */
export const MAX_NOTE_LENGTH = 500

/** Longest accepted archived photo path, in characters. */
const MAX_PHOTO_PATH_LENGTH = 240

/** Photo extensions the bridge accepts for browser uploads. */
export const PHOTO_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif'])

const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The fixed layout under the workspace root.
 * @param {string} workspaceDir - absolute workspace directory.
 * @returns {{ root: string, definition: string, records: string, photos: string }} layout.
 */
export function sopPaths(workspaceDir) {
  const root = path.join(workspaceDir, '.sop')
  return {
    root,
    definition: path.join(root, 'sop.json'),
    records: path.join(root, 'records'),
    photos: path.join(root, 'photos'),
  }
}

/**
 * The local calendar date of `now` (never UTC — a store checks on its own day).
 * @param {Date} [now] - clock to read.
 * @returns {string} `YYYY-MM-DD`.
 */
export function localDate(now = new Date()) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Whether a string is a real calendar date.
 * @param {unknown} value - candidate.
 * @returns {boolean} true only for `YYYY-MM-DD` that round-trips.
 */
export function isDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(year, month - 1, day)
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
}

/**
 * Shift a `YYYY-MM-DD` date by whole days in local time.
 * @param {string} date - valid date string.
 * @param {number} days - signed day offset.
 * @returns {string} shifted date string.
 */
export function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number)
  return localDate(new Date(year, month - 1, day + days))
}

/** Monday-first day offset inside the week. */
function mondayOffset(date) {
  const [year, month, day] = date.split('-').map(Number)
  return (new Date(year, month - 1, day).getDay() + 6) % 7
}

/**
 * The dates one SOP period covers, plus the previous period for the trend.
 * `daily` covers just the date; `weekly` covers that date's Monday through
 * Sunday (the current period stops at the checked date so nothing future is counted).
 * @param {'daily'|'weekly'} frequency - SOP cadence.
 * @param {string} date - date being viewed/checked.
 * @returns {{ start: string, end: string, dates: string[], previous: { start: string, end: string, dates: string[] } }} window.
 */
export function periodWindow(frequency, date) {
  if (frequency === 'weekly') {
    const start = addDays(date, -mondayOffset(date))
    const end = addDays(start, 6)
    const previousStart = addDays(start, -7)
    return {
      start,
      end,
      dates: datesBetween(start, date),
      previous: { start: previousStart, end: addDays(previousStart, 6), dates: datesBetween(previousStart, addDays(previousStart, 6)) },
    }
  }
  return {
    start: date,
    end: date,
    dates: [date],
    previous: { start: addDays(date, -1), end: addDays(date, -1), dates: [addDays(date, -1)] },
  }
}

/**
 * Inclusive date run, ascending.
 * @param {string} start - first date.
 * @param {string} end - last date, or anything earlier (returns []).
 * @returns {string[]} dates from start to end.
 */
function datesBetween(start, end) {
  const result = []
  let cursor = start
  while (cursor <= end) {
    result.push(cursor)
    cursor = addDays(cursor, 1)
  }
  return result
}

/**
 * Derive the store name a workspace reports under: the definition's explicit
 * `store`, else the workspace folder name, else `default`.
 * @param {string} workspaceDir - absolute workspace directory.
 * @param {{ store?: string }} definition - loaded definition.
 * @returns {string} store label used in records and reports.
 */
export function defaultStore(workspaceDir, definition) {
  if (typeof definition?.store === 'string' && definition.store.trim() !== '') return definition.store.trim()
  const base = path.basename(workspaceDir.replace(/[/\\]+$/, ''))
  return base === '' ? 'default' : base
}

/**
 * Validate and normalize a definition supplied by a tool call.
 * Unknown fields are dropped; defaults are filled; every failure names the field.
 * @param {unknown} input - `{ name, frequency?, store?, items }`.
 * @returns {{ ok: true, definition: object } | { ok: false, error: string }} result.
 */
export function normalizeDefinition(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'SOP 定义必须是对象：{name, frequency, items}' }
  }
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name === '') return { ok: false, error: 'name 不能为空' }
  if (name.length > 80) return { ok: false, error: 'name 超过 80 字' }

  const frequency = input.frequency === undefined ? 'daily' : String(input.frequency)
  if (!FREQUENCIES.includes(frequency)) {
    return { ok: false, error: `frequency 只能是 ${FREQUENCIES.join(' / ')}` }
  }

  let store
  if (input.store !== undefined && input.store !== null) {
    if (typeof input.store !== 'string') return { ok: false, error: 'store 必须是字符串' }
    store = input.store.trim()
    if (store.length > 60) return { ok: false, error: 'store 超过 60 字' }
    if (store !== '') { /* kept */ } else store = undefined
  }

  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { ok: false, error: 'items 必须是非空数组' }
  }
  if (input.items.length > 50) return { ok: false, error: 'items 超过 50 条' }

  const items = []
  const seen = new Set()
  for (let index = 0; index < input.items.length; index += 1) {
    const raw = input.items[index]
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: `items[${index}] 必须是对象` }
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!ITEM_ID_RE.test(id)) {
      return { ok: false, error: `items[${index}].id 必须匹配 ${ITEM_ID_RE}（字母或数字开头，仅字母数字下划线连字符）` }
    }
    if (seen.has(id)) return { ok: false, error: `item id 重复：${id}` }
    seen.add(id)
    const label = typeof raw.label === 'string' ? raw.label.trim() : ''
    if (label === '') return { ok: false, error: `items[${index}].label 不能为空` }
    if (label.length > 120) return { ok: false, error: `items[${index}].label 超过 120 字` }
    const type = raw.type === undefined ? 'confirm' : String(raw.type)
    if (!ITEM_TYPES.includes(type)) {
      return { ok: false, error: `items[${index}].type 只能是 ${ITEM_TYPES.join(' / ')}` }
    }
    const required = raw.required === undefined ? true : raw.required
    if (typeof required !== 'boolean') return { ok: false, error: `items[${index}].required 必须是布尔值` }
    items.push({ id, label, type, required })
  }

  return {
    ok: true,
    definition: {
      name,
      frequency,
      ...(store === undefined ? {} : { store }),
      items,
    },
  }
}

/**
 * Read `.sop/sop.json` from a workspace.
 * @param {string} workspaceDir - absolute workspace directory.
 * @returns {Promise<{ ok: true, definition: object } | { ok: false, error: string, missing: boolean }>} result.
 */
export async function readDefinition(workspaceDir) {
  const { definition: definitionPath } = sopPaths(workspaceDir)
  let text
  try {
    text = await readFile(definitionPath, 'utf8')
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      return { ok: false, missing: true, error: '工作区还没有 SOP，请先调用 sop_init 创建（写入 .sop/sop.json）' }
    }
    return { ok: false, missing: false, error: `读取 .sop/sop.json 失败：${cause?.message ?? String(cause)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, missing: false, error: '.sop/sop.json 不是合法 JSON' }
  }
  return normalizeDefinition(parsed)
}

/**
 * Persist a definition, refusing to clobber an existing file unless asked.
 * @param {string} workspaceDir - absolute workspace directory.
 * @param {object} definition - normalized definition.
 * @param {{ overwrite?: boolean }} [options] - overwrite switch.
 * @returns {Promise<{ ok: true, created: boolean, overwritten: boolean, definition: object, definitionPath: string } | { ok: false, error: string }>} result.
 */
export async function writeDefinition(workspaceDir, definition, options = {}) {
  const paths = sopPaths(workspaceDir)
  await mkdir(paths.root, { recursive: true })
  const existed = await fileExists(paths.definition)
  if (existed && options.overwrite !== true) {
    return { ok: false, error: '.sop/sop.json 已存在；如需替换请传 overwrite: true' }
  }
  const stored = {}
  for (const key of ['name', 'frequency', 'store', 'items']) {
    if (definition[key] !== undefined) stored[key] = definition[key]
  }
  stored.items = definition.items.map(item => ({ ...item }))
  await writeFile(paths.definition, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
  return {
    ok: true,
    created: !existed,
    overwritten: existed,
    definition: stored,
    definitionPath: paths.definition,
  }
}

/** Whether a path exists. */
async function fileExists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Read the JSONL record files for a set of dates.
 * Malformed lines are counted and skipped — one bad append never hides the day.
 * @param {string} workspaceDir - absolute workspace directory.
 * @param {string[]} dates - date files to read, in chronological order.
 * @returns {Promise<{ records: object[], invalidLines: number, filesRead: string[] }>} read result.
 */
export async function readRecords(workspaceDir, dates) {
  const { records: recordsDir } = sopPaths(workspaceDir)
  const records = []
  const filesRead = []
  let invalidLines = 0
  for (const date of dates) {
    const file = path.join(recordsDir, `${date}.jsonl`)
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (cause) {
      if (cause?.code === 'ENOENT') continue
      throw cause
    }
    filesRead.push(file)
    text.split('\n').forEach(line => {
      const trimmed = line.trim()
      if (trimmed === '') return
      let parsed
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        invalidLines += 1
        return
      }
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.results)) {
        invalidLines += 1
        return
      }
      records.push(parsed)
    })
  }
  return { records, invalidLines, filesRead }
}

/**
 * Fold records into the last status per item (later lines win — the same store
 * and day keeps only the newest submission for each item).
 * @param {object[]} records - parsed JSONL rows.
 * @param {string} store - store filter; exact match.
 * @returns {Map<string, { status: string, note: string, photo?: string, at?: string, date: string }>} last status per item id.
 */
export function foldStatuses(records, store) {
  const statuses = new Map()
  for (const record of records) {
    if (record.store !== store) continue
    for (const result of record.results) {
      if (typeof result?.item_id !== 'string') continue
      if (!STATUSES.includes(result.status)) continue
      statuses.set(result.item_id, {
        status: result.status,
        note: typeof result.note === 'string' ? result.note : '',
        ...(typeof result.photo === 'string' ? { photo: result.photo } : {}),
        ...(typeof record.at === 'string' ? { at: record.at } : {}),
        date: typeof record.date === 'string' ? record.date : '',
      })
    }
  }
  return statuses
}

/**
 * Completion is measured over required items; a definition with no required
 * item is measured over every item. A checked item is pass OR fail — "查了没有"
 * is about whether someone looked, and exceptions are reported separately.
 * @param {object} definition - normalized definition.
 * @param {Map<string, object>} statuses - folded statuses.
 * @returns {{ total: number, checked: number, passed: number, failed: number, completionRate: number, items: object[] }} progress.
 */
export function computeProgress(definition, statuses) {
  const requiredItems = definition.items.filter(item => item.required)
  const basis = requiredItems.length > 0 ? requiredItems : definition.items
  const items = definition.items.map(item => {
    const status = statuses.get(item.id)
    return {
      id: item.id,
      label: item.label,
      type: item.type,
      required: item.required,
      status: status?.status ?? 'pending',
      note: status?.note ?? '',
      ...(status?.photo === undefined ? {} : { photo: status.photo }),
      ...(status?.at === undefined ? {} : { at: status.at }),
    }
  })
  const checked = basis.filter(item => statuses.has(item.id)).length
  // Exceptions are reported over every item: an optional item that failed is
  // still an exception worth reading, even though it does not move completion.
  const passed = definition.items.filter(item => statuses.get(item.id)?.status === 'pass').length
  const failed = definition.items.filter(item => statuses.get(item.id)?.status === 'fail').length
  return {
    total: basis.length,
    checked,
    passed,
    failed,
    completionRate: basis.length === 0 ? 100 : Math.round(checked * 100 / basis.length),
    items,
  }
}

/**
 * Today's checklist payload (also what the client bridge serves).
 * @param {string} workspaceDir - absolute workspace directory.
 * @param {{ date?: string, store?: string, now?: Date }} [options] - view options.
 * @returns {Promise<object>} view payload, `ok:false` when no SOP exists.
 */
export async function todayView(workspaceDir, options = {}) {
  const date = options.date ?? localDate(options.now)
  if (!isDateString(date)) return { ok: false, error: 'date 必须是 YYYY-MM-DD' }
  const loaded = await readDefinition(workspaceDir)
  if (!loaded.ok) return { ok: false, missing: loaded.missing === true, error: loaded.error }
  const definition = loaded.definition
  const store = options.store ?? defaultStore(workspaceDir, definition)
  const window = periodWindow(definition.frequency, date)
  const read = await readRecords(workspaceDir, window.dates)
  const statuses = foldStatuses(read.records, store)
  const progress = computeProgress(definition, statuses)
  const pending = progress.items.filter(item => item.status === 'pending')
  const failed = progress.items.filter(item => item.status === 'fail')
  return {
    ok: true,
    name: definition.name,
    frequency: definition.frequency,
    store,
    date,
    windowStart: window.start,
    windowEnd: window.end,
    totalItems: definition.items.length,
    total: progress.total,
    checked: progress.checked,
    passed: progress.passed,
    failed: progress.failed,
    completionRate: progress.completionRate,
    items: progress.items,
    pendingIds: pending.map(item => item.id),
    pendingRequiredIds: pending.filter(item => item.required).map(item => item.id),
    failedIds: failed.map(item => item.id),
    recordsRead: read.records.length,
    invalidLines: read.invalidLines,
  }
}

/**
 * Validate a model-supplied relative photo path against the workspace.
 * @param {string} workspaceDir - absolute workspace directory.
 * @param {unknown} photo - candidate path.
 * @returns {Promise<{ ok: true, photo: string } | { ok: false, error: string }>} result.
 */
export async function validatePhotoPath(workspaceDir, photo) {
  if (typeof photo !== 'string' || photo.trim() === '') return { ok: false, error: 'photo 必须是非空相对路径' }
  const value = photo.trim()
  if (value.length > MAX_PHOTO_PATH_LENGTH) return { ok: false, error: 'photo 路径过长' }
  if (value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    return { ok: false, error: 'photo 必须是工作区内的相对路径，不能是绝对路径' }
  }
  if (value.split(/[\\/]/).some(segment => segment === '..')) {
    return { ok: false, error: 'photo 路径不能跳出工作区（不允许 ..）' }
  }
  const resolved = path.resolve(workspaceDir, value)
  if (!resolved.startsWith(path.resolve(workspaceDir))) {
    return { ok: false, error: 'photo 路径必须位于工作区内' }
  }
  const exists = await fileExists(resolved)
  if (!exists) return { ok: false, error: `photo 文件不存在：${value}` }
  const extension = path.extname(value).slice(1).toLowerCase()
  if (extension !== '' && !PHOTO_EXTENSIONS.includes(extension)) {
    return { ok: false, error: `photo 扩展名只能是 ${PHOTO_EXTENSIONS.join(' / ')}` }
  }
  return { ok: true, photo: value.split(path.sep).join('/') }
}

/**
 * Validate one check submission before anything is written.
 * @param {object} definition - loaded definition.
 * @param {{ item_id: unknown, status: unknown, note: unknown, photo: unknown }} input - model args.
 * @param {string} workspaceDir - absolute workspace directory (photo resolution).
 * @returns {Promise<{ ok: true, item: object, status: string, note: string, photo?: string } | { ok: false, error: string }>} result.
 */
export async function validateCheck(definition, input, workspaceDir) {
  const itemId = typeof input.item_id === 'string' ? input.item_id.trim() : ''
  const item = definition.items.find(candidate => candidate.id === itemId)
  if (item === undefined) {
    return { ok: false, error: `未知 item_id：${itemId || '(空)'}；可用：${definition.items.map(candidate => candidate.id).join(', ')}` }
  }
  const status = String(input.status)
  if (!STATUSES.includes(status)) return { ok: false, error: `status 只能是 ${STATUSES.join(' / ')}` }
  let note = input.note === undefined ? '' : input.note
  if (typeof note !== 'string') return { ok: false, error: 'note 必须是字符串' }
  note = note.trim()
  if (note.length > MAX_NOTE_LENGTH) return { ok: false, error: `note 超过 ${MAX_NOTE_LENGTH} 字` }
  if (status === 'fail' && note === '') return { ok: false, error: '标记不通过时必须填写 note（哪里没做到）' }
  let photo
  if (input.photo !== undefined && input.photo !== null && input.photo !== '') {
    const checked = await validatePhotoPath(workspaceDir, input.photo)
    if (!checked.ok) return checked
    photo = checked.photo
  }
  if (item.type === 'photo' && status === 'pass' && photo === undefined) {
    return { ok: false, error: `「${item.label}」需要照片留证：请上传照片或传 photo 相对路径后再标记通过` }
  }
  return { ok: true, item, status, note, ...(photo === undefined ? {} : { photo }) }
}

/**
 * Append one check result to the day's JSONL file (creating directories on first use).
 * @param {string} workspaceDir - absolute workspace directory.
 * @param {{ date: string, store: string, item: object, status: string, note: string, photo?: string, at?: string }} entry - validated entry.
 * @returns {Promise<{ recordPath: string, record: object }>} written record.
 */
export async function appendRecord(workspaceDir, entry) {
  const paths = sopPaths(workspaceDir)
  await mkdir(paths.records, { recursive: true })
  const results = [{ item_id: entry.item.id, status: entry.status, note: entry.note }]
  if (entry.photo !== undefined) results[0].photo = entry.photo
  const record = {
    date: entry.date,
    store: entry.store,
    results,
    ...(entry.at === undefined ? {} : { at: entry.at }),
  }
  const recordPath = path.join(paths.records, `${entry.date}.jsonl`)
  await appendFile(recordPath, `${JSON.stringify(record)}\n`, 'utf8')
  return { recordPath, record }
}

/**
 * Record one item and report the refreshed checklist. Nothing is written when
 * validation fails, so a rejected call never leaves a half-checked day.
 * @param {string} workspaceDir - absolute workspace directory.
 * @param {object} input - `{ item_id, status, note?, photo?, store?, date? }`.
 * @param {Date} [now] - clock for the default date and `at` stamp.
 * @returns {Promise<object>} `{ ok:false, error }` or the refreshed view plus the saved entry.
 */
export async function checkItem(workspaceDir, input, now = new Date()) {
  const date = input.date ?? localDate(now)
  if (!isDateString(date)) return { ok: false, error: 'date 必须是 YYYY-MM-DD' }
  if (date > localDate(now)) return { ok: false, error: '不能给未来日期做检查记录' }
  const loaded = await readDefinition(workspaceDir)
  if (!loaded.ok) return { ok: false, missing: loaded.missing === true, error: loaded.error }
  const definition = loaded.definition
  const store = input.store === undefined ? defaultStore(workspaceDir, definition) : String(input.store).trim()
  if (store === '') return { ok: false, error: 'store 不能为空' }
  if (store.length > 60) return { ok: false, error: 'store 超过 60 字' }
  const validated = await validateCheck(definition, input, workspaceDir)
  if (!validated.ok) return validated
  const saved = await appendRecord(workspaceDir, {
    date,
    store,
    item: validated.item,
    status: validated.status,
    note: validated.note,
    ...(validated.photo === undefined ? {} : { photo: validated.photo }),
    at: new Date(now).toISOString(),
  })
  const view = await todayView(workspaceDir, { date, store, now })
  return {
    ok: true,
    itemId: validated.item.id,
    label: validated.item.label,
    status: validated.status,
    note: validated.note,
    ...(validated.photo === undefined ? {} : { photo: validated.photo }),
    recordPath: saved.recordPath,
    view,
  }
}

/**
 * The plain-text daily report: completion, exceptions, and the trend against
 * the previous period. No charts, no LLM — just the numbers a manager reads.
 * @param {string} workspaceDir - absolute workspace directory.
 * @param {{ date?: string, store?: string, now?: Date }} [options] - report options.
 * @returns {Promise<object>} report payload with a `summary` string.
 */
export async function reportFor(workspaceDir, options = {}) {
  const now = options.now ?? new Date()
  const date = options.date ?? localDate(now)
  if (!isDateString(date)) return { ok: false, error: 'date 必须是 YYYY-MM-DD' }
  const loaded = await readDefinition(workspaceDir)
  if (!loaded.ok) return { ok: false, missing: loaded.missing === true, error: loaded.error }
  const definition = loaded.definition
  const store = options.store ?? defaultStore(workspaceDir, definition)
  const window = periodWindow(definition.frequency, date)
  const currentRead = await readRecords(workspaceDir, window.dates)
  const previousRead = await readRecords(workspaceDir, window.previous.dates)
  const currentStatuses = foldStatuses(currentRead.records, store)
  const previousStatuses = foldStatuses(previousRead.records, store)
  const progress = computeProgress(definition, currentStatuses)
  const previousProgress = computeProgress(definition, previousStatuses)
  const previousRecordCount = previousRead.records.filter(record => record.store === store).length
  const pending = progress.items.filter(item => item.status === 'pending')
  const failed = progress.items.filter(item => item.status === 'fail')
  const trend = previousRecordCount === 0
    ? { baseline: 'previous-period', available: false, deltaPoints: null, exceptionDelta: null, direction: 'no-baseline' }
    : {
      baseline: 'previous-period',
      available: true,
      deltaPoints: progress.completionRate - previousProgress.completionRate,
      exceptionDelta: progress.failed - previousProgress.failed,
      direction: progress.completionRate > previousProgress.completionRate
        ? 'up'
        : progress.completionRate < previousProgress.completionRate ? 'down' : 'flat',
    }
  const periodLabel = definition.frequency === 'weekly'
    ? `${window.start} ~ ${window.end}`
    : date
  const summary = renderSummary({
    name: definition.name,
    store,
    date,
    periodLabel,
    frequency: definition.frequency,
    progress,
    pending,
    failed,
    trend,
    previousProgress,
    previousAvailable: trend.available,
    previousLabel: window.previous.start === window.previous.end ? window.previous.start : `${window.previous.start} ~ ${window.previous.end}`,
  })
  return {
    ok: true,
    name: definition.name,
    frequency: definition.frequency,
    store,
    date,
    period: periodLabel,
    total: progress.total,
    checked: progress.checked,
    passed: progress.passed,
    failed: progress.failed,
    completionRate: progress.completionRate,
    pendingIds: pending.map(item => item.id),
    failedIds: failed.map(item => item.id),
    failedItems: failed.map(item => ({ id: item.id, label: item.label, note: item.note, ...(item.photo === undefined ? {} : { photo: item.photo }) })),
    previousPeriod: { start: window.previous.start, end: window.previous.end, completionRate: previousProgress.completionRate, failed: previousProgress.failed, records: previousRecordCount },
    trend,
    summary,
  }
}

/**
 * Render the report text. Kept pure so the tool renderer and tests share it.
 * @param {object} data - computed report facts.
 * @returns {string} plain-text summary.
 */
export function renderSummary(data) {
  const lines = []
  lines.push(`SOP 日报 · ${data.date} · 门店：${data.store}`)
  lines.push(`SOP：${data.name}（${data.frequency}，周期 ${data.periodLabel}）`)
  lines.push(`完成率 ${data.progress.checked}/${data.progress.total}（${data.progress.completionRate}%）· 异常 ${data.progress.failed} 项`)
  lines.push(data.pending.length === 0
    ? '未完成：无'
    : `未完成：${data.pending.map(item => `${item.label}${item.required ? '' : '（选做）'}`).join('、')}`)
  lines.push(data.failed.length === 0
    ? '异常项：无'
    : `异常项：${data.failed.map(item => `${item.label}${item.note === '' ? '' : ` — ${item.note}`}`).join('；')}`)
  if (!data.previousAvailable) {
    lines.push(`与上一周期（${data.previousLabel}）对比：无基线记录`)
  } else {
    const delta = data.trend.deltaPoints
    const deltaText = delta === 0 ? '持平' : `${delta > 0 ? '+' : ''}${delta} 个百分点`
    const exceptionDelta = data.trend.exceptionDelta
    const exceptionText = exceptionDelta === 0 ? '持平' : `${exceptionDelta > 0 ? '+' : ''}${exceptionDelta} 项`
    lines.push(`与上一周期（${data.previousLabel}）对比：完成率 ${data.previousProgress.completionRate}% → ${data.progress.completionRate}%（${deltaText}），异常 ${data.previousProgress.failed} → ${data.progress.failed}（${exceptionText}）`)
  }
  return lines.join('\n')
}
