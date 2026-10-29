/**
 * Isolated acceptance of the built plugins: real Cordis, tools, HTTP routes,
 * React bundles and Chrome, with a deterministic substitute for ChatGPT.
 * No credentials, existing DSH profile, or external provider is used.
 * Run after npm run build: node scripts/acceptance-smoke.mjs
 */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, appendFile, mkdtemp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const repo = fileURLToPath(new URL('..', import.meta.url))
const names = { research: 'chatgpt-pro-research', design: 'gpt-image-design' }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const json = async path => JSON.parse(await readFile(path, 'utf8'))

// Valid deterministic PNG fixture, deliberately unrelated to model quality.
function png() {
  const crc = data => { let n = -1; for (const byte of data) { n ^= byte; for (let k = 0; k < 8; k++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1)) } return (n ^ -1) >>> 0 }
  const chunk = (type, data) => { const t = Buffer.from(type); const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length); t.copy(b, 4); data.copy(b, 8); b.writeUInt32BE(crc(Buffer.concat([t, data])), b.length - 4); return b }
  const header = Buffer.alloc(13); header.writeUInt32BE(600); header.writeUInt32BE(300, 4); header[8] = 8; header[9] = 2
  const raw = Buffer.alloc(300 * 1801)
  for (let y = 0; y < 300; y++) for (let x = 0; x < 600; x++) { const i = y * 1801 + 1 + x * 3; raw[i] = 30 + x % 160; raw[i + 1] = 60 + y % 150; raw[i + 2] = 150 }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

async function host(root) {
  process.env.DSH_HOME = join(root, 'home')
  process.chdir(root)
  let state = { loggedIn: false, fault: '', hang: false, judgeFail: false, apiHang: false, apiFailure: false }
  const jobsFile = join(root, 'jobs.json')
  const jobs = await json(jobsFile).catch(() => ({}))
  const record = data => appendFile(join(root, 'calls.ndjson'), JSON.stringify(data) + '\n')
  const fault = (message, failure, submissionState) => Object.assign(new Error(message), { name: 'TransportError', failure, submissionState })
  const fake = {
    async probe() { return { ok: state.loggedIn, loggedIn: state.loggedIn, model: 'Pro fixture', available: ['pro'], reason: state.loggedIn ? undefined : 'login required (fixture)' } },
    async login() { state.loggedIn = true; return { ok: true, note: 'Fixture login completed' } },
    async submit(request) {
      await record({ kind: 'submit', topicId: request.topicId, round: request.round, brief: request.brief, files: request.files, fault: state.fault })
      if (!state.loggedIn) throw fault('login required (fixture)', 'login', 'not_sent')
      if (state.fault) { const mode = state.fault; state.fault = ''; throw fault(`fixture ${mode}`, 'ui', mode) }
      const id = `${request.topicId}:${request.round}`
      jobs[id] = { topicId: request.topicId, round: request.round, brief: request.brief, design: request.designs !== undefined }
      await writeFile(jobsFile, JSON.stringify(jobs))
      return { submissionId: id, fingerprint: id, attachments: request.files, conversationUrl: `https://example.invalid/c/${request.topicId}`, model: 'Pro fixture' }
    },
    async reattach(request) {
      const id = `${request.topicId}:${request.round}`
      await record({ kind: 'reattach', topicId: request.topicId, round: request.round })
      return jobs[id] ? { attached: true, submissionId: id } : { attached: false }
    },
    async poll({ submissionId }) { await sleep(25); return !jobs[submissionId] ? { state: 'unknown' } : state.hang ? { state: 'waiting' } : { state: 'answered', answer: 'fixture complete' } },
    async fetch({ submissionId }) {
      const job = jobs[submissionId]; assert.ok(job)
      return {
        answer: `# 模拟答复\n\n${job.brief}\n\n|选项|优点|代价|\n|---|---|---|\n|A：文本清单|简单|手动维护|\n|B：看板|状态清晰|需要配置|\n\n未决问题：是否需要多人协作？\n${job.design ? '包含图片和演示' : '包含两个选项'}。`,
        ...(job.design ? { images: [{ mime: 'image/png', base64: png().toString('base64') }], codeBlocks: [{ language: 'html', text: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>QA Demo</title><body><h1>简单待办</h1><button onclick="this.textContent=\'已完成\'">完成任务</button></body></html>' }] } : {}),
      }
    },
    async cancelSubmission(id) { await record({ kind: 'cancel', id }) }, async cancel() {}, async close() {},
  }
  globalThis[Symbol.for('dsh-pro.transport.shared.v1')] = new Map([[resolve(process.env.DSH_HOME, 'pro-research/browser'), { transport: fake, refs: 0, lockFile: join(root, 'unused.lock'), token: 'fixture' }]])
  const routes = [], tools = new Map()
  const ctx = new Context()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  ctx.provide('webServer', { register(route) { routes.push(route); return () => {} } })
  ctx.provide('skills', { registerProvider: () => () => {} })
  ctx.provide('connection', { requestRejection: () => undefined })
  ctx.provide('llm', { async *stream(options) {
    await record({ kind: 'judge', sessionId: options.sessionId })
    if (state.judgeFail) { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'fixture judge unavailable', code: 'TEST' } } }; return }
    const serialized = JSON.stringify(options.messages)
    const criterion = serialized.includes('包含图片和演示') ? '包含图片和演示' : '包含两个选项'
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ verdict: 'accepted', done: true, reason: 'fixture criterion met', summary: '模拟任务完成', criteria: [{ criterion, status: 'met', evidence: criterion }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } })
  const api = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    await record({ kind: 'api', path: req.url, hasBaseImage: body.includes(png()), failure: state.apiFailure })
    while (state.apiHang && !res.destroyed) await sleep(25)
    if (res.destroyed) return
    res.writeHead(state.apiFailure ? 404 : 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(state.apiFailure ? { error: { message: 'fixture edits unsupported' } } : { data: [{ b64_json: png().toString('base64') }] }))
  })
  api.listen(0, '127.0.0.1'); await once(api, 'listening')
  for (const dir of Object.keys(names)) ctx.plugin(await import(pathToFileURL(join(repo, `packages/${dir}/lib/index.js`))), {
    store: 'local', autoReview: false, rounds: 1, designs: 1, judgeProvider: 'fixture', judgeModel: 'fixture',
    ...(dir === 'design' && process.argv.includes('--api') ? { channel: 'api', imageBaseUrl: `http://127.0.0.1:${api.address().port}/v1`, imageApiKey: 'fixture-only', imageModel: 'fixture-image', judgeProvider: 'off' } : {}),
  })
  await sleep(200)
  assert.equal(tools.size, 2); assert.equal(routes.length, 18)
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname.startsWith('/__qa/')) {
        const chunks = []; for await (const c of req) chunks.push(c)
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
        let result
        if (url.pathname === '/__qa/control') { Object.assign(state, body); result = state }
        else if (url.pathname === '/__qa/tool') result = await tools.get(body.plugin === 'design' ? 'gpt_image_design' : 'pro_research').execute(body.args, { agent: { session: { id: 'qa-session', header: { cwd: root } } } })
        else throw new Error('unknown test route')
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); return
      }
      const route = routes.find(r => r.kind === 'prefix' ? url.pathname.startsWith(r.path + '/') : url.pathname === r.path)
      if (route) { await route.handler(req, res); return }
      if (url.pathname === '/bridge.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(join(root, 'bridge.js'))); return }
      const dir = url.pathname === '/design' ? 'design' : 'research'
      if (url.pathname.endsWith('/client.js')) { const pkg = url.pathname.includes('design') ? 'design' : 'research'; res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(join(repo, `packages/${pkg}/lib/client.js`))); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>DSH isolated QA</title><style>html,body,#root{height:100%;margin:0}*{box-sizing:border-box}</style><div id="root"></div><script src="/bridge.js"></script><script src="/${dir}/client.js"></script><script>mount(${JSON.stringify(names[dir])})</script></html>`)
    } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  process.send({ port: server.address().port })
}

async function acceptance() {
  const parent = join(repo, '.tmp/acceptance-20261028'); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'run-'))
  await build({ stdin: { contents: `
    import * as React from 'react';
    import * as jsx from 'react/jsx-runtime';
    import {createRoot} from 'react-dom/client';
    const entries = new Map();
    window.__ModuleLoader__ = {load: e => entries.set(e.id, e)};
    window.mount = id => {
      const client = entries.get(id).factory(s => s === 'react' ? React : jsx);
      client.apply({slots: {
        inject: (name, fn) => fn(),
        register: (options, render) => {
          if (options.name === 'main') createRoot(document.getElementById('root')).render(render());
          return () => {};
        }
      }});
    };
  `, resolveDir: repo }, bundle: true, outfile: join(root, 'bridge.js'), platform: 'browser', format: 'iife' })
  const checks = [], errors = [], findings = []
  let child, browser, base, page
  const check = (name, detail = {}) => { checks.push({ name, ...detail }); console.log('PASS', name) }
  async function startHost(targetRoot = root, api = false) {
    child = fork(fileURLToPath(import.meta.url), ['--host', targetRoot, ...(api ? ['--api'] : [])], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    child.stdout.on('data', b => appendFile(join(root, 'host.log'), b)); child.stderr.on('data', b => appendFile(join(root, 'host.log'), b))
    const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`host exited ${code}`) }), sleep(15000).then(() => { throw new Error('host startup timeout') })])
    base = `http://127.0.0.1:${message[0].port}`
  }
  const stopHost = async () => { if (child?.exitCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
  const request = async (path, body) => { const response = await fetch(base + path, { signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); const value = await response.json(); if (!response.ok) throw new Error(value.error); return value }
  const tool = (plugin, args) => request('/__qa/tool', { plugin, args })
  const control = body => request('/__qa/control', body)
  const detail = (plugin, id) => request(`/${names[plugin]}/topic?id=${encodeURIComponent(id)}`).then(x => x.topic)
  const wait = async (plugin, id, statuses = ['completed', 'capped', 'stalled', 'failed', 'reviewing']) => { for (let i = 0; i < 160; i++) { const t = await detail(plugin, id); if (statuses.includes(t.status)) return t; await sleep(125) } throw new Error('topic did not settle: ' + JSON.stringify(await detail(plugin, id))) }
  const calls = async () => (await readFile(join(root, 'calls.ndjson'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const submits = async id => (await calls()).filter(x => x.kind === 'submit' && (!id || x.topicId === id)).length
  const card = (title, extra = {}) => ({ action: 'start', confirmed: true, title, question: '比较文本清单与看板', brief: '给出两个选项、一张取舍表和一个未决问题。', criteria: ['包含两个选项'], rounds: 1, store: 'local', ...extra })
  try {
    await startHost()
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('pageerror', e => errors.push(e.message))
    for (const plugin of ['research', 'design']) {
      await page.goto(`${base}/${plugin}`)
      await page.getByText(plugin === 'research' ? '还没有研究任务' : '还没有设计任务', { exact: true }).waitFor()
      await page.screenshot({ path: join(root, `${plugin}-first-use.png`) })
      assert.equal((await tool(plugin, { action: 'probe' })).probe?.ok ?? false, false)
      await assert.rejects(tool(plugin, { ...card('unconfirmed'), confirmed: false }), /confirmed/)
    }
    assert.equal(await submits(), 0); check('first use: empty panels, logged-out probe, confirmation guard')
    await tool('research', { action: 'login' })
    const probe = await tool('design', { action: 'probe' }); assert.equal(probe.probe.ok, true)
    const first = await tool('research', card('QA 简单方案比较'))
    const research = first.topic_id
    const complete = await wait('research', research); assert.equal(complete.status, 'completed'); assert.equal(complete.store, 'local'); assert.equal(await submits(research), 1)
    assert.match(await readFile(join(complete.path, 'final.md'), 'utf8'), /模拟任务完成|fixture/)
    check('research: tool → submit → saved answer → criterion verdict → run summary', { topic: research })
    await page.goto(`${base}/research`); await page.getByRole('heading', { name: 'QA 简单方案比较', exact: true }).waitFor()
    await page.getByRole('button', { name: '继续一轮', exact: true }).click()
    await page.getByRole('button', { name: '提交继续', exact: true }).click()
    await page.getByText('请填写这一轮要补充的问题', { exact: true }).waitFor()
    assert.equal(await submits(research), 1)
    await page.locator('#dshpro-continue').fill('只补充离线使用的差异。')
    await page.getByRole('button', { name: '提交继续', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await wait('research', research); assert.equal((await detail('research', research)).rounds, 2); assert.equal(await submits(research), 2)
    check('research UI: blank continue blocked; valid continue adds exactly one round')
    const designStart = await tool('design', card('QA 待办卡片设计', { brief: '一张待办卡片图和一个完成按钮 HTML demo。', question: '做一个简单待办卡片', criteria: ['包含图片和演示'], designs: 1 }))
    const design = designStart.topic_id
    const designed = await wait('design', design); assert.ok(['capped', 'completed'].includes(designed.status)); assert.equal(designed.artifacts.filter(x => x.endsWith('.png')).length, 1); assert.ok(designed.artifact_details.some(x => x.kind === 'demo'))
    await writeFile(join(designed.path, 'design.md'), '<!-- dsh-pro-report: {"generation":1,"throughRound":1} -->\n# QA design handoff\nFixture review of saved PNG and HTML.')
    assert.equal((await detail('design', design)).report, 'design.md')
    assert.equal((await detail('design', design)).report_info.status, 'current')
    await page.goto(`${base}/design`); await page.getByRole('heading', { name: 'QA 待办卡片设计', exact: true }).waitFor()
    await page.getByRole('tab', { name: /产物/ }).click()
    await page.getByText('design.md', { exact: true }).waitFor()
    await page.locator('.dshpro-final').getByRole('button', { name: '查看', exact: true }).click()
    await page.getByRole('dialog').getByText(/Fixture review of saved PNG and HTML/).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await page.evaluate(() => window.postMessage({ type: 'dsh-pro:preview-escape' }, '*'))
    await sleep(100); assert.equal(await page.getByRole('dialog').count(), 1)
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts')
    const frame = page.frameLocator('iframe'); await frame.getByRole('button', { name: '完成任务', exact: true }).click(); await frame.getByRole('button', { name: '已完成', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal(await page.getByRole('button', { name: '预览', exact: true }).evaluate(el => el === document.activeElement), true)
    check('design: generated PNG decoded and HTML demo button works in preview', { topic: design })
    for (const width of [1280, 520, 360]) {
      await page.setViewportSize({ width, height: 600 })
      if (!await page.getByRole('button', { name: '以这张继续改', exact: true }).isVisible()) {
        await page.locator(`[data-topic-id="${design}"]`).click()
        await page.getByRole('tab', { name: /产物/ }).click()
      }
      await page.getByRole('button', { name: '以这张继续改', exact: true }).click()
      await page.getByRole('dialog').waitFor()
      assert.equal(await page.getByRole('dialog').locator('img').evaluate(async img => {
        await img.decode()
        return img.complete && img.naturalWidth === 600
      }), true)
      const box = await page.getByRole('button', { name: '提交修改', exact: true }).boundingBox(); assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 600)
      await page.screenshot({ path: join(root, `design-edit-${width}.png`) })
      await page.keyboard.press('Escape')
    }
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByRole('button', { name: '以这张继续改', exact: true }).click(); await page.locator('#dshpro-continue').fill('保留布局，只改背景色。'); await page.getByRole('button', { name: '提交修改', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    const edited = await wait('design', design); assert.equal(edited.rounds, 2); assert.equal(edited.rounds_detail[1].baseArtifact, designed.artifacts.find(x => x.endsWith('.png'))); assert.equal(await submits(design), 2)
    check('design UI: 1280/520/360 × 600 modal fits; chosen base image continued once')
    await control({ fault: 'not_sent' })
    const beforeSend = (await tool('research', card('QA 发送前失败'))).topic_id
    assert.equal((await wait('research', beforeSend)).status, 'stalled'); assert.equal((await detail('research', beforeSend)).rounds_detail[0].submissionState, 'not_sent')
    await page.goto(`${base}/research`); await page.getByRole('heading', { name: 'QA 发送前失败', exact: true }).waitFor()
    const recentAnswer = page.getByRole('complementary', { name: '运行摘要' }).getByRole('button', { name: /查看回答/ })
    assert.equal(await recentAnswer.isDisabled(), true)
    await page.screenshot({ path: join(root, 'unsent-answer-disabled.png') })
    await page.getByRole('tab', { name: /轮次/ }).click(); assert.equal(await page.getByRole('button', { name: '查看回答', exact: true }).isDisabled(), true)
    await page.screenshot({ path: join(root, 'unsent-round-disabled.png') })
    await control({ fault: 'unknown' })
    const unknown = (await tool('research', card('QA 提交结果不明'))).topic_id
    assert.equal((await wait('research', unknown)).status, 'stalled')
    await assert.rejects(tool('research', { action: 'resume', topic_id: unknown }), /核对|submission|确认/i); assert.equal(await submits(unknown), 1)
    await control({ judgeFail: true })
    const judge = (await tool('research', card('QA 裁决服务失败'))).topic_id
    assert.equal((await wait('research', judge)).status, 'reviewing')
    await control({ judgeFail: false, hang: true })
    const pending = (await tool('research', card('QA 重启接回已发送任务'))).topic_id
    await wait('research', pending, ['waiting'])
    const countBeforeRestart = await submits()
    await stopHost(); await startHost(); await control({ loggedIn: true })
    await wait('research', pending, ['completed']); assert.equal(await submits(), countBeforeRestart)
    assert.equal((await detail('research', judge)).status, 'reviewing')
    assert.equal((await detail('research', beforeSend)).status, 'stalled')
    assert.equal((await detail('design', design)).rounds, 2)
    check('process restart: reattach waiting job, preserve judge/pre-send failures and design history; zero resubmits')
    await tool('research', { action: 'resume', topic_id: beforeSend }); await wait('research', beforeSend, ['completed']); assert.equal(await submits(beforeSend), 2); assert.equal((await detail('research', beforeSend)).rounds, 1)
    await tool('research', { action: 'resume', topic_id: judge }); await wait('research', judge, ['completed']); assert.equal(await submits(judge), 1)
    await tool('research', { action: 'human_check', topic_id: unknown, conclusion: 'not_submitted', note: '测试夹具确认没有发出' }); await wait('research', unknown, ['completed']); assert.equal(await submits(unknown), 2)
    check('explicit recovery: pre-send retries same round; judge uses saved answer; unknown requires human check')
    await control({ hang: true }); const cancelled = (await tool('research', card('QA 取消任务'))).topic_id; await wait('research', cancelled, ['waiting']); await tool('research', { action: 'cancel', topic_id: cancelled }); assert.equal((await detail('research', cancelled)).status, 'cancelled'); assert.equal(await submits(cancelled), 1); await control({ hang: false })
    check('cancel in-flight task: cancelled state persisted, no resubmit')
    for (const plugin of ['research', 'design']) {
      await page.goto(`${base}/${plugin}`); await page.locator('[data-topic-id]').first().waitFor(); await page.reload(); await page.locator('[data-topic-id]').first().waitFor()
      for (const dark of [false, true]) {
        await page.evaluate(dark => { document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; document.body.toggleAttribute('data-ds-dark-theme', dark) }, dark)
        for (const width of [1280, 520, 360]) { await page.setViewportSize({ width, height: 600 }); if (width < 720 && await page.locator('[data-topic-id]').first().isVisible()) await page.locator('[data-topic-id]').first().click(); await page.screenshot({ path: join(root, `${plugin}-${dark ? 'dark' : 'light'}-${width}.png`) }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false) }
      }
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.getByRole('textbox', { name: '搜索主题' }).fill('no matching topic QA'); await page.getByText(/没有匹配/).waitFor()
    }
    assert.deepEqual(errors, []); check('reload, search empty, light/dark and 360/520/1280 layouts; no browser exceptions')
    await stopHost()
    const apiRoot = join(root, 'api'); await mkdir(apiRoot); await writeFile(join(apiRoot, 'bridge.js'), await readFile(join(root, 'bridge.js')))
    await startHost(apiRoot, true)
    const apiCalls = async () => (await readFile(join(apiRoot, 'calls.ndjson'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(c => c.kind === 'api')
    assert.equal((await tool('design', { action: 'probe' })).probe.ok, true)
    const apiId = (await tool('design', card('QA API 首次生图', { designs: 1 }))).topic_id
    const apiDone = await wait('design', apiId); assert.equal(apiDone.status, 'capped'); assert.equal(apiDone.channel, 'api'); assert.equal(apiDone.artifacts.filter(x => x.endsWith('.png')).length, 1); assert.equal(apiDone.artifact_details.filter(x => x.kind === 'demo').length, 0)
    const apiBase = apiDone.artifacts.find(x => x.endsWith('.png'))
    await tool('design', { action: 'continue', topic_id: apiId, confirmed: true, brief: '只改背景', base_artifact: apiBase }); await wait('design', apiId)
    assert.ok((await apiCalls()).some(c => c.path === '/v1/images/edits' && c.hasBaseImage))
    await control({ apiFailure: true }); await tool('design', { action: 'continue', topic_id: apiId, confirmed: true, brief: '错误服务模拟', base_artifact: apiBase }); assert.equal((await wait('design', apiId)).status, 'stalled')
    await control({ apiFailure: false, apiHang: true })
    const lostApi = (await tool('design', card('QA API 重启丢失请求', { designs: 1 }))).topic_id
    await wait('design', lostApi, ['waiting']); const apiBefore = (await apiCalls()).length
    await stopHost(); await startHost(apiRoot, true)
    const apiLost = await wait('design', lostApi, ['stalled']); assert.match(apiLost.stop_reason, /丢失|重启/)
    assert.equal((await apiCalls()).length, apiBefore)
    await assert.rejects(tool('design', { action: 'resume', topic_id: lostApi }), /丢失|重启|重新|失效|恢复/)
    assert.equal((await apiCalls()).length, apiBefore)
    await tool('design', { action: 'regenerate', topic_id: lostApi, confirmed: true, note: '已核对丢失的模拟请求，重新生成' }); assert.equal((await wait('design', lostApi)).status, 'capped'); assert.equal((await apiCalls()).length, apiBefore + 1)
    check('API: first image, selected-base edits, HTTP failure, process loss blocks resend, explicit regenerate succeeds')
    await writeFile(join(root, 'result.json'), JSON.stringify({ ok: true, uiAcceptance: findings.length ? 'issues-found' : 'passed', checks, errors, findings }, null, 2))
    console.log('Evidence:', root)
  } catch (error) { await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {}); await writeFile(join(root, 'result.json'), JSON.stringify({ ok: false, checks, errors, findings, error: error.stack }, null, 2)); console.error('Evidence:', root); throw error }
  finally { await browser?.close(); if (child?.exitCode === null) child.kill('SIGKILL') }
}

if (process.argv[2] === '--host') await host(resolve(process.argv[3])); else await acceptance()
