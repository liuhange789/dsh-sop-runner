# dsh-sop-runner

**别在微信群里问「检查了吗」——让门店自己完成 SOP 自检。**

A DSH plugin for chain/multi-store SOP self-check. The head office or the store manager writes the SOP once as a checklist; the store staff ticks items off inside DSH (confirm, or confirm with a photo). Every tick is appended to a per-day JSONL record, exceptions require a note, and the assistant can produce a plain-text daily report: what was due today, what has been checked, what was not done, and how it compares with yesterday.

It is deliberately **not** a store-visit/inspection system: no multi-store admin backend, no permissions, no real-time monitoring, no image AI. Photos are archived, never analysed.

## Install

```bash
npm install @liuhange/dsh-sop-runner
```

Add the bundle to a DSH profile's `package.json` (alongside the base bundles) and run `npm install` in the profile:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "@liuhange/dsh-sop-runner"
      ]
    }
  },
  "dependencies": {
    "@liuhange/dsh-sop-runner": "0.1.0"
  }
}
```

The host half registers four tools; under the web composition it also mounts a small bridge for the browser card. The browser half adds a「SOP 自检」bar above the composer.

## Workspace layout

Everything lives under the session workspace (the same `cwd` the file tools use):

```
.sop/
  sop.json                       # the SOP definition
  records/2026-11-16.jsonl       # one append-only file per calendar day
  photos/2026-11-16/             # archived photos, one folder per day
    fridge-temp-1699999999999.jpg
```

`SOP` definition (`sop.json`):

```json
{
  "name": "开档前自检",
  "frequency": "daily",
  "store": "望京店",
  "items": [
    { "id": "table-clean", "label": "台面清洁并消毒", "type": "confirm", "required": true },
    { "id": "fridge-temp", "label": "冷藏柜温度 ≤ 5℃", "type": "photo", "required": true },
    { "id": "music", "label": "背景音乐音量合适", "type": "confirm", "required": false }
  ]
}
```

- `frequency`: `daily` or `weekly`.
- `type`: `confirm` or `photo`; a `photo` item cannot pass without a photo.
- `required`: counted in the completion rate; optional items are still recorded and any failure is still an exception.
- `store`: optional; when absent the store label is the workspace folder name.
- Item ids are the stable keys in the JSONL history — renaming them starts fresh history for that item.

Record line (`.sop/records/<date>.jsonl`):

```json
{"date":"2026-11-16","store":"望京店","results":[{"item_id":"table-clean","status":"pass","note":""}],"at":"2026-11-16T09:12:31.000Z"}
```

A failed result always carries a non-empty `note`; a passing photo item carries `photo` with the workspace-relative archived path. Records are append-only: re-checking an item appends another line, and the newest line for the same store, date and item wins when reading.

## Tools

| Tool | What it does |
| --- | --- |
| `sop_init` | Create (or replace with `overwrite: true`) `.sop/sop.json`. Validates unique item ids, `type`, `required`, frequency, and field lengths. |
| `sop_today` | Today's checklist: every item with its last recorded status/note/photo, the completion rate, and the ids still pending or failed. Read-only. |
| `sop_check` | Record one item: `status` `pass` or `fail`. `fail` requires `note`; a `photo` item marked `pass` requires a `photo` path inside the workspace. Unknown item ids and future dates are rejected **before** anything is written. Returns the refreshed checklist. |
| `sop_report` | Plain-text daily report for one store: completion rate, exception items with their notes, pending items, and the trend against the previous period. No charts, no LLM. |

Store scoping: every tool takes an optional `store`; records and reports are filtered by that exact store label, so two stores sharing one workspace still keep separate numbers.

### How the numbers are computed

- **Completion rate** = checked required items / required items. A `fail` counts as *checked* — the question is “did someone look”; exceptions are reported separately. If the SOP has no required item, all items form the basis.
- **Exceptions** = every item whose latest status is `fail`, including optional items; the report lists them with their notes.
- **Trend** compares the same measure with the previous period: yesterday for a `daily` SOP, the previous Monday–Sunday for a `weekly` one. With no previous records the report says `无基线记录` instead of inventing a delta.
- **Weekly SOP** rolls the current Monday–Sunday window up; records from any day in that week count once per item (newest wins). The current week stops at the viewed date, so future days are never counted.
- A malformed JSONL line is skipped and counted in `invalidLines` (`sop_today`) instead of failing the whole day.

## Browser card

Under the web composition the host registers `GET`/`POST /sop-runner/api`. It is a local, same-origin endpoint for the DSH shell — it has no authentication and only serves the SOP checklist/report of the workspace named by `dir`:

- `GET /sop-runner/api?dir=<workspace>` → the same checklist payload as `sop_today`; `&report=1` → the `sop_report` payload.
- `POST /sop-runner/api` `{dir, item_id, status, note?, photo?:{name,data}}` → validates, archives the photo under `.sop/photos/<date>/`, appends the JSONL line, and returns the refreshed checklist.

The「SOP 自检」bar reads the current session's workspace from the client session list, shows `完成率 · 异常数`, and expands into the checklist with 通过 / 不通过（备注必填）/ 拍照通过 (real file upload, 8 MB cap) and a 生成今日日报 button. If no SOP exists the bar says so and points at `sop_init`.

Photo upload path: the browser sends base64, the host writes the file and records the relative path. Only `png/jpg/jpeg/webp/gif` are accepted; nothing is sent to an external service or analysed.

## Development

```bash
npm test    # builds lib/ and runs node:test core + host suites
npm run build
```

Tests use real temporary workspaces (`node:fs`), a real in-process HTTP server for the bridge, and the DSH tool-payload harness — no fake core.

## License

MIT
