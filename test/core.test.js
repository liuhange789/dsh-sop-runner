import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  addDays,
  checkItem,
  defaultStore,
  isDateString,
  localDate,
  normalizeDefinition,
  periodWindow,
  readDefinition,
  readRecords,
  reportFor,
  todayView,
  validatePhotoPath,
  writeDefinition,
} from '../src/core/sop.js'

/** Tiny valid PNG header bytes: enough to exist and be archived. */
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** A fresh workspace plus a photo on disk, and a normalized SOP definition. */
async function setup(options = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'sop-runner-'))
  await writeFile(path.join(workspace, 'proof.png'), TINY_PNG)
  const definition = {
    name: '开档前自检',
    frequency: options.frequency ?? 'daily',
    store: '望京店',
    items: [
      { id: 'table-clean', label: '台面清洁并消毒', type: 'confirm', required: true },
      { id: 'fridge-temp', label: '冷藏柜温度 ≤ 5℃', type: 'photo', required: true },
      { id: 'music', label: '背景音乐音量合适', type: 'confirm', required: false },
    ],
  }
  const normalized = normalizeDefinition(definition)
  assert.equal(normalized.ok, true, normalized.error)
  await writeDefinition(workspace, normalized.definition)
  return { workspace, definition: normalized.definition }
}

/** The workspace-shaped exec context the host tools read. */
function execFor(workspace) {
  return { agent: { session: { header: { cwd: workspace } } } }
}

test('normalizeDefinition fills defaults and rejects structural mistakes', () => {
  const ok = normalizeDefinition({
    name: '  日常巡检  ',
    items: [{ id: 'a', label: '查 A' }, { id: 'b', label: '查 B', type: 'photo', required: false }],
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.definition.name, '日常巡检')
  assert.equal(ok.definition.frequency, 'daily')
  assert.deepEqual(ok.definition.items[0], { id: 'a', label: '查 A', type: 'confirm', required: true })
  assert.equal(ok.definition.items[1].required, false)

  assert.equal(normalizeDefinition({ name: '', items: [{ id: 'a', label: 'x' }] }).ok, false)
  assert.equal(normalizeDefinition({ name: 'x', items: [] }).ok, false)
  assert.equal(normalizeDefinition({ name: 'x', frequency: 'hourly', items: [{ id: 'a', label: 'x' }] }).ok, false)
  assert.equal(normalizeDefinition({ name: 'x', items: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] }).ok, false)
  assert.equal(normalizeDefinition({ name: 'x', items: [{ id: 'a', label: 'x', type: 'video' }] }).ok, false)
  assert.equal(normalizeDefinition({ name: 'x', items: [{ id: 'bad id', label: 'x' }] }).ok, false)
})

test('writeDefinition refuses silent replacement, overwrite is explicit', async () => {
  const { workspace } = await setup()
  const again = await writeDefinition(workspace, { name: '另一个', frequency: 'daily', items: [{ id: 'z', label: 'Z', type: 'confirm', required: true }] })
  assert.equal(again.ok, false)
  assert.match(again.error, /已存在/)

  const replaced = await writeDefinition(
    workspace,
    { name: '另一个', frequency: 'daily', items: [{ id: 'z', label: 'Z', type: 'confirm', required: true }] },
    { overwrite: true },
  )
  assert.equal(replaced.ok, true)
  assert.equal(replaced.overwritten, true)
  const loaded = await readDefinition(workspace)
  assert.equal(loaded.definition.name, '另一个')
})

test('todayView reports missing SOP instead of throwing', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'sop-empty-'))
  const view = await todayView(workspace)
  assert.equal(view.ok, false)
  assert.equal(view.missing, true)
  assert.match(view.error, /sop_init/)
})

test('check without required evidence writes nothing', async () => {
  const { workspace } = await setup()
  const failedNote = await checkItem(workspace, { item_id: 'table-clean', status: 'fail' })
  assert.equal(failedNote.ok, false)
  assert.match(failedNote.error, /note/)

  const photoMissing = await checkItem(workspace, { item_id: 'fridge-temp', status: 'pass' })
  assert.equal(photoMissing.ok, false)
  assert.match(photoMissing.error, /照片/)

  const unknown = await checkItem(workspace, { item_id: 'nope', status: 'pass' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /未知 item_id/)

  const future = await checkItem(workspace, { item_id: 'table-clean', status: 'pass', date: addDays(localDate(), 1) })
  assert.equal(future.ok, false)
  assert.match(future.error, /未来/)

  const records = await readRecords(workspace, [localDate()])
  assert.equal(records.records.length, 0)
})

test('photo path validation stays inside the workspace', async () => {
  const { workspace } = await setup()
  assert.equal((await validatePhotoPath(workspace, 'proof.png')).ok, true)
  assert.equal((await validatePhotoPath(workspace, '../escape.png')).ok, false)
  assert.equal((await validatePhotoPath(workspace, 'C:/Windows/x.png')).ok, false)
  assert.equal((await validatePhotoPath(workspace, 'missing.png')).ok, false)
  assert.equal((await validatePhotoPath(workspace, 'proof.txt')).ok, false)
})

test('full daily loop: pass, fail with note, photo evidence, dedupe, report trend', async () => {
  const { workspace } = await setup()
  const today = localDate()
  const yesterday = addDays(today, -1)

  // Yesterday: only the first required item was checked → 50%.
  const yesterdayCheck = await checkItem(workspace, { item_id: 'table-clean', status: 'pass', date: yesterday })
  assert.equal(yesterdayCheck.ok, true, yesterdayCheck.error)

  const initial = await todayView(workspace)
  assert.equal(initial.total, 2)
  assert.equal(initial.checked, 0)
  assert.equal(initial.completionRate, 0)
  assert.deepEqual(initial.pendingRequiredIds, ['table-clean', 'fridge-temp'])

  const photo = await checkItem(workspace, { item_id: 'fridge-temp', status: 'pass', photo: 'proof.png' })
  assert.equal(photo.ok, true, photo.error)
  assert.equal(photo.view.checked, 1)
  assert.equal(photo.view.completionRate, 50)

  const pass = await checkItem(workspace, { item_id: 'table-clean', status: 'pass' })
  assert.equal(pass.ok, true, pass.error)
  assert.equal(pass.view.completionRate, 100)
  assert.equal(pass.view.failed, 0)

  // Optional item failing is an exception but does not move completion.
  const optionalFail = await checkItem(workspace, { item_id: 'music', status: 'fail', note: '音量偏大' })
  assert.equal(optionalFail.ok, true, optionalFail.error)
  assert.equal(optionalFail.view.completionRate, 100)
  assert.equal(optionalFail.view.failed, 1)
  assert.deepEqual(optionalFail.view.failedIds, ['music'])

  // Newest submission wins for the same store/date/item.
  const overridden = await checkItem(workspace, { item_id: 'table-clean', status: 'fail', note: '台面有残留污渍' })
  assert.equal(overridden.ok, true, overridden.error)
  const after = await todayView(workspace)
  assert.equal(after.items.find(item => item.id === 'table-clean').status, 'fail')
  assert.equal(after.items.find(item => item.id === 'table-clean').note, '台面有残留污渍')
  assert.equal(after.completionRate, 100)
  assert.equal(after.failed, 2)
  assert.equal(after.recordsRead, 4)

  const lines = (await readFile(path.join(workspace, '.sop/records', `${today}.jsonl`), 'utf8')).trim().split('\n')
  assert.equal(lines.length, 4)
  const last = JSON.parse(lines[3])
  assert.equal(last.store, '望京店')
  assert.equal(last.results[0].status, 'fail')
  assert.equal(last.results[0].note, '台面有残留污渍')

  const report = await reportFor(workspace)
  assert.equal(report.ok, true)
  assert.equal(report.completionRate, 100)
  assert.equal(report.failed, 2)
  assert.equal(report.trend.available, true)
  assert.equal(report.trend.deltaPoints, 50)
  assert.equal(report.trend.exceptionDelta, 2)
  assert.equal(report.trend.direction, 'up')
  assert.match(report.summary, /完成率 50% → 100%（\+50 个百分点）/)
  assert.match(report.summary, /异常 0 → 2（\+2 项）/)
  assert.match(report.summary, /台面有残留污渍/)
})

test('report without baseline says so and does not invent a delta', async () => {
  const { workspace } = await setup()
  await checkItem(workspace, { item_id: 'table-clean', status: 'pass' })
  const report = await reportFor(workspace)
  assert.equal(report.trend.available, false)
  assert.equal(report.trend.direction, 'no-baseline')
  assert.equal(report.trend.deltaPoints, null)
  assert.match(report.summary, /无基线记录/)
})

test('weekly SOP rolls the Monday–Sunday window and compares with last week', async () => {
  const { workspace } = await setup({ frequency: 'weekly' })
  const today = localDate()
  const window = periodWindow('weekly', today)
  assert.equal(window.start, addDays(today, -((new Date().getDay() + 6) % 7)))
  assert.ok(window.end >= window.start)

  const monday = window.start
  const check = await checkItem(workspace, { item_id: 'table-clean', status: 'pass', date: monday })
  assert.equal(check.ok, true, check.error)

  const view = await todayView(workspace)
  assert.equal(view.windowStart, window.start)
  assert.equal(view.windowEnd, today)
  assert.equal(view.checked, 1)
  assert.equal(view.completionRate, 50)

  const lastWeek = addDays(window.start, -7)
  const lastWeekCheck = await checkItem(workspace, { item_id: 'fridge-temp', status: 'pass', photo: 'proof.png', date: lastWeek })
  assert.equal(lastWeekCheck.ok, true, lastWeekCheck.error)
  const report = await reportFor(workspace)
  assert.equal(report.trend.available, true)
  assert.equal(report.previousPeriod.start, lastWeek)
  assert.equal(report.previousPeriod.completionRate, 50)
  assert.equal(report.trend.deltaPoints, 0)
  assert.equal(report.trend.direction, 'flat')
})

test('malformed JSONL lines are counted and skipped, not fatal', async () => {
  const { workspace } = await setup()
  await checkItem(workspace, { item_id: 'table-clean', status: 'pass' })
  const file = path.join(workspace, '.sop/records', `${localDate()}.jsonl`)
  const existing = await readFile(file, 'utf8')
  await writeFile(file, `${existing}{broken json\n{"date":"${localDate()}","store":"望京店","results":[]}\n`, 'utf8')
  const view = await todayView(workspace)
  assert.equal(view.invalidLines, 1)
  assert.equal(view.checked, 1)
})

test('store scoping keeps two stores apart in one workspace', async () => {
  const { workspace } = await setup()
  const storeA = await checkItem(workspace, { item_id: 'table-clean', status: 'pass', store: 'A 店' })
  assert.equal(storeA.ok, true, storeA.error)
  const viewB = await todayView(workspace, { store: 'B 店' })
  assert.equal(viewB.checked, 0)
  const viewA = await todayView(workspace, { store: 'A 店' })
  assert.equal(viewA.checked, 1)
  assert.equal(defaultStore(workspace, (await readDefinition(workspace)).definition), '望京店')
})

test('date helpers round-trip and reject non-calendar strings', () => {
  assert.equal(isDateString('2026-02-29'), false)
  assert.equal(isDateString('2026-13-01'), false)
  assert.equal(isDateString('2026-11-16'), true)
})
