import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { addDays, localDate } from '../src/core/sop.js'

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** Load the built host entry the way the loader does (real plugin apply). */
async function loadHost() {
  const mod = await import(pathToFileURL(path.resolve('lib/index.js')).href)
  const tools = {}
  const registrations = []
  const ctx = {
    fiber: { state: 0 },
    tools: { register(tool) { tools[tool.name] = tool; registrations.push(tool.name) } },
    effect(callback) { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
    on() {},
    logger: console,
    inject() {},
  }
  mod.apply(ctx, {})
  return { mod, tools, registrations }
}

/** Real workspace exec context. */
const execFor = workspace => ({ agent: { session: { header: { cwd: workspace } } } })

/** Fresh workspace with a photo file. */
async function workspaceWithPhoto() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'sop-host-'))
  await writeFile(path.join(workspace, 'proof.png'), TINY_PNG)
  return workspace
}

/** Start the real bridge over a real HTTP server. */
async function startBridge(handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

test('host registers the four tools with real parameter names', async () => {
  const { registrations, tools } = await loadHost()
  assert.deepEqual(registrations, ['sop_init', 'sop_today', 'sop_check', 'sop_report'])
  assert.ok(tools.sop_init.parameters.properties.name)
  assert.ok(tools.sop_init.parameters.required.includes('name'))
  assert.deepEqual(tools.sop_check.parameters.properties.status.enum, ['pass', 'fail'])
  assert.ok(tools.sop_check.parameters.required.includes('item_id'))
})

test('tools drive a full check day from the session workspace', async () => {
  const { tools } = await loadHost()
  const workspace = await workspaceWithPhoto()
  const exec = execFor(workspace)

  const init = await tools.sop_init.execute({
    name: '开档前自检',
    frequency: 'daily',
    store: '望京店',
    items: [
      { id: 'table-clean', label: '台面清洁并消毒', type: 'confirm', required: true },
      { id: 'fridge-temp', label: '冷藏柜温度 ≤ 5℃', type: 'photo', required: true },
    ],
  }, exec)
  assert.equal(init.created, true)
  assert.equal(init.itemCount, 2)
  assert.equal(init.store, '望京店')

  await assert.rejects(
    tools.sop_init.execute({ name: '重复', items: [{ id: 'x', label: 'X' }] }, exec),
    /已存在/,
  )

  const today = await tools.sop_today.execute({}, exec)
  assert.equal(today.total, 2)
  assert.equal(today.completionRate, 0)
  assert.equal('ok' in today, false)
  assert.deepEqual(today.pendingRequiredIds, ['table-clean', 'fridge-temp'])
  const render = tools.sop_today.output.render({}, today)
  assert.match(render[0].text, /完成率 0\/2（0%）/)

  await assert.rejects(
    tools.sop_check.execute({ item_id: 'table-clean', status: 'fail' }, exec),
    /note/,
  )
  await assert.rejects(
    tools.sop_check.execute({ item_id: 'fridge-temp', status: 'pass' }, exec),
    /照片/,
  )

  const photo = await tools.sop_check.execute({ item_id: 'fridge-temp', status: 'pass', photo: 'proof.png' }, exec)
  assert.equal(photo.status, 'pass')
  assert.equal(photo.view.completionRate, 50)
  assert.equal(photo.view.checked, 1)

  const pass = await tools.sop_check.execute({ item_id: 'table-clean', status: 'pass' }, exec)
  assert.equal(pass.view.completionRate, 100)
  assert.match(tools.sop_check.output.render({}, pass)[0].text, /所有条目已检查/)

  // A fail for yesterday gives the report a real baseline.
  const yesterday = addDays(localDate(), -1)
  await tools.sop_check.execute({ item_id: 'table-clean', status: 'fail', note: '台面有残留', date: yesterday }, exec)
  await tools.sop_check.execute({ item_id: 'fridge-temp', status: 'pass', photo: 'proof.png', date: yesterday }, exec)

  const report = await tools.sop_report.execute({}, exec)
  assert.equal(report.completionRate, 100)
  assert.equal(report.previousPeriod.records, 2)
  assert.equal(report.previousPeriod.completionRate, 100)
  assert.equal(report.previousPeriod.failed, 1)
  assert.match(report.summary, /SOP 日报 · \d{4}-\d{2}-\d{2} · 门店：望京店/)
  assert.match(report.summary, /异常 1 → 0（-1 项）/)

  const lines = (await readFile(path.join(workspace, '.sop/records', `${localDate()}.jsonl`), 'utf8')).trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).results[0].photo, 'proof.png')
})

test('bridge serves the checklist, writes a real photo and JSONL, and reports', async () => {
  const { mod } = await loadHost()
  const workspace = await workspaceWithPhoto()
  const bridge = await startBridge(mod.createBridgeHandler())
  try {
    const empty = await fetch(`${bridge.base}/sop-runner/api`)
    assert.equal(empty.status, 400)

    const init = await fetch(`${bridge.base}/sop-runner/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dir: workspace,
        item_id: 'table-clean',
        status: 'pass',
        note: '',
      }),
    })
    const noSop = await init.json()
    assert.equal(noSop.ok, false)
    assert.match(noSop.error, /sop_init/)

    // Seed the definition through the host tool path (same code the model uses).
    const { tools } = await loadHost()
    await tools.sop_init.execute({
      name: '开档前自检',
      store: '望京店',
      items: [
        { id: 'table-clean', label: '台面清洁并消毒', type: 'confirm', required: true },
        { id: 'fridge-temp', label: '冷藏柜温度 ≤ 5℃', type: 'photo', required: true },
      ],
    }, execFor(workspace))

    const list = await (await fetch(`${bridge.base}/sop-runner/api?dir=${encodeURIComponent(workspace)}`)).json()
    assert.equal(list.ok, true)
    assert.equal(list.total, 2)
    assert.equal(list.completionRate, 0)

    // An unknown item is rejected before the photo is archived: no orphan image.
    const badItem = await fetch(`${bridge.base}/sop-runner/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dir: workspace,
        item_id: 'nope',
        status: 'pass',
        photo: { name: 'orphan.png', data: TINY_PNG.toString('base64') },
      }),
    })
    assert.equal(badItem.status, 400)
    await assert.rejects(readdir(path.join(workspace, '.sop/photos', localDate())), /ENOENT/)

    const withPhoto = await fetch(`${bridge.base}/sop-runner/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dir: workspace,
        item_id: 'fridge-temp',
        status: 'pass',
        photo: { name: 'fridge.png', data: TINY_PNG.toString('base64') },
      }),
    })
    const photoResult = await withPhoto.json()
    assert.equal(photoResult.ok, true, photoResult.error)
    assert.equal(photoResult.view.completionRate, 50)
    assert.match(photoResult.saved.photo, /^\.sop\/photos\//)

    const archived = await stat(path.join(workspace, photoResult.saved.photo))
    assert.ok(archived.size > 0)
    const photos = await readdir(path.join(workspace, '.sop/photos', localDate()))
    assert.equal(photos.length, 1)

    const fail = await fetch(`${bridge.base}/sop-runner/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: workspace, item_id: 'table-clean', status: 'fail' }),
    })
    assert.equal(fail.status, 400)
    const rejected = await fail.json()
    assert.match(rejected.error, /note/)

    const pass = await fetch(`${bridge.base}/sop-runner/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: workspace, item_id: 'table-clean', status: 'pass', note: '' }),
    })
    const passed = await pass.json()
    assert.equal(passed.view.completionRate, 100)

    const records = (await readFile(path.join(workspace, '.sop/records', `${localDate()}.jsonl`), 'utf8')).trim().split('\n')
    assert.equal(records.length, 2)
    const line = JSON.parse(records[0])
    assert.equal(line.date, localDate())
    assert.equal(line.store, '望京店')
    assert.equal(line.results[0].item_id, 'fridge-temp')
    assert.equal(line.results[0].status, 'pass')

    const report = await (await fetch(`${bridge.base}/sop-runner/api?dir=${encodeURIComponent(workspace)}&report=1`)).json()
    assert.equal(report.ok, true)
    assert.equal(report.completionRate, 100)
    assert.match(report.summary, /无基线记录/)

    const unknownPath = await fetch(`${bridge.base}/elsewhere`)
    assert.equal(unknownPath.status, 404)
  } finally {
    await bridge.close()
  }
})
