function impl(ctx, node, createEngine) {
  const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = node.fs
  const join = node.path.join
  const homedir = node.os.homedir

  const home = join(homedir(), '.dsh', 'knowledge')
  const stateDir = join(home, 'state')
  const reqDir = join(stateDir, 'dreq')
  const resDir = join(stateDir, 'dres')
  const pidFile = join(stateDir, 'desktop.pid')
  const pinFile = join(stateDir, 'pinned')
  const servedFile = join(stateDir, 'served')
  const logFile = join(stateDir, 'desktop.log')
  const widgetScript = join(home, 'desktop.ps1')
  mkdirSync(reqDir, { recursive: true })
  mkdirSync(resDir, { recursive: true })

  function mark(label) {
    try { writeFileSync(join(stateDir, 'apply.txt'), new Date().toISOString() + ' ' + label + '\n', { flag: 'a' }) } catch { /* 标记写入失败不影响功能 */ }
  }
  mark('apply entered')

  const startup = ctx.get('webStartup')
  const port = startup !== undefined && startup !== null && startup.port ? startup.port : 3080
  const panelUrl = 'http://127.0.0.1:' + port + '/?kb=1'

  const engine = createEngine(ctx)
  ctx.provide('knowledgeBase', engine)
  mark('service provided')

  const log = []
  function note(line) {
    log.push(new Date().toISOString().slice(11, 19) + ' ' + line)
    if (log.length > 120) log.shift()
    try { writeFileSync(logFile, log.join('\n')) } catch { /* 日志写入失败不影响功能 */ }
  }

  mark('a: before desktop helpers')
  // ── desktop icon supervision ───────────────────────────────────────────────

  function readPinned() {
    try { return readFileSync(pinFile, 'utf8').trim() === '1' } catch { return false }
  }
  function writePinned(value) {
    try { writeFileSync(pinFile, value ? '1' : '0') } catch { /* 偏好写入失败时下次按未置顶处理 */ }
  }
  function widgetPid() {
    let pid = 0
    try { pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10) } catch { return 0 }
    if (!Number.isFinite(pid) || pid <= 0) return 0
    try { process.kill(pid, 0); return pid } catch { return 0 }
  }

  /** Single-quoted PowerShell literal carrying the double quotes Windows needs. */
  function psLiteral(value) {
    return "'\"" + String(value).split("'").join("''") + "\"'"
  }

  async function startWidget() {
    const alive = widgetPid()
    if (alive > 0) return { ok: true, pid: alive, already: true }
    if (!existsSync(widgetScript)) return { ok: false, error: '缺少 desktop.ps1' }
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', widgetScript,
      '-Dir', stateDir, '-PidFile', pidFile, '-Url', panelUrl,
    ].map(psLiteral).join(',')
    const command = "$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @(" + args + ") -WindowStyle Hidden -PassThru; $p.Id"
    const result = await ctx.shell.run(ctx.shell.resolve({
      command,
      timeoutMs: 30000,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: home },
    }))
    const pid = parseInt(String((result.stdout && result.stdout.text) || '').trim(), 10)
    note('start exit=' + String(result.exitCode) + ' pid=' + String(pid))
    return { ok: result.exitCode === 0, pid: Number.isFinite(pid) ? pid : 0 }
  }

  function stopWidget() {
    const pid = widgetPid()
    if (pid <= 0) return { ok: true, stopped: false }
    try { process.kill(pid) } catch { /* 进程已退出 */ }
    note('stop pid=' + String(pid))
    return { ok: true, stopped: true, pid }
  }

  async function setPinned(on) {
    writePinned(on === true)
    if (on === true) {
      const started = await startWidget()
      return { ok: true, pinned: true, running: started.ok === true && started.pid > 0, pid: started.pid }
    }
    const stopped = stopWidget()
    return { ok: true, pinned: false, running: false, pid: stopped.pid }
  }

  // ── request pump (widget → host) ───────────────────────────────────────────

  async function statePayload() {
    const snapshot = await engine.state()
    return {
      ok: true,
      root: snapshot.root,
      rootExists: snapshot.rootExists,
      docCount: snapshot.docCount,
      chunkCount: snapshot.chunkCount,
      dim: snapshot.dim,
      defaultTopK: snapshot.defaultTopK,
      lastError: snapshot.lastError,
      docs: snapshot.docs.map(function (doc) {
        return { name: doc.name, kind: doc.kind, bytes: doc.bytes, chunks: doc.chunks, note: doc.note }
      }),
      desktop: { pinned: readPinned(), running: widgetPid() > 0 },
    }
  }

  async function handle(request) {
    const op = String((request && request.op) || '')
    const id = request && request.id
    try {
      if (op === 'state') return Object.assign({ id: id, op: op }, await statePayload())
      if (op === 'search') {
        const response = await engine.search(String((request && request.query) || ''), (request && request.topK) || 4)
        return { id: id, op: op, ok: true, results: response.results }
      }
      if (op === 'ingest') {
        if (request && request.path) {
          const result = await engine.ingestPath(String(request.path), '')
          const ok = result !== null && result !== undefined && result.ok === true
          note('ingest ' + (ok ? 'ok' : 'failed') + ': ' + String(request.path).split('\\').pop())
          return ok
            ? { id: id, op: op, ok: true, chunks: result.result.chunks, name: result.result.name }
            : { id: id, op: op, ok: false, error: String((result && result.error) || '入库失败') }
        }
        const result = await engine.ingest(String(request.name || 'upload.bin'), String(request.base64 || ''), false)
        const ok = result !== null && result !== undefined && result.ok === true
        return ok
          ? { id: id, op: op, ok: true, chunks: result.result.chunks, name: result.result.name }
          : { id: id, op: op, ok: false, error: String((result && result.error) || '入库失败') }
      }
      if (op === 'remove') {
        const result = await engine.remove(String((request && request.name) || ''))
        note('remove ' + String(request && request.name))
        return { id: id, op: op, ok: true, docCount: result && result.docCount }
      }
      if (op === 'open-folder') {
        return Object.assign({ id: id, op: op }, await engine.openFolder(String((request && request.path) || '')))
      }
      if (op === 'desktop') {
        return Object.assign({ id: id, op: op }, await setPinned(request && request.on === true))
      }
      return { id: id, op: op, ok: false, error: 'unknown op ' + op }
    } catch (error) {
      note('op ' + op + ' failed: ' + String((error && error.message) || error))
      return { id: id, op: op, ok: false, error: String((error && error.message) || error) }
    }
  }

  let serving = false
  let lastServed = ''
  try { lastServed = readFileSync(servedFile, 'utf8').trim() } catch { lastServed = '' }

  async function pump() {
    if (serving) return
    serving = true
    try {
      let names = []
      try { names = readdirSync(reqDir).filter(function (n) { return /^[0-9]{18}-[0-9]+\.json$/.test(n) }).sort() } catch { names = [] }
      for (let i = 0; i < names.length; i++) {
        if (names[i] <= lastServed) continue
        lastServed = names[i]
        try { writeFileSync(servedFile, lastServed) } catch { /* 游标写入失败只会重复处理一次 */ }
        let request = null
        try { request = JSON.parse(readFileSync(join(reqDir, names[i]), 'utf8')) } catch { request = null }
        if (request === null) continue
        const response = await handle(request)
        try { writeFileSync(join(resDir, names[i]), JSON.stringify(response)) } catch { /* 响应写入失败时界面保持上一状态 */ }
      }
    } finally {
      serving = false
    }
  }

  mark('b: before pump timer')
  const pumpTimer = ctx.timer.interval(function () { pump() }, 300)
  ctx.effect(function () { return function () { pumpTimer() } }, 'knowledge request pump')
  mark('c: pump timer ready')

  /** Register one model-facing tool, recording the loader's rejection reason. */
  function registerTool(definition) {
    try { ctx.tools.register(definition); mark('tool ok: ' + definition.name) }
    catch (error) { mark('tool FAILED ' + definition.name + ': ' + String((error && (error.message || error)) || error)) }
  }  mark('d: before tools')
  // ── model-facing tools ─────────────────────────────────────────────────────

  registerTool({
    name: 'knowledge_search',
    description: '检索本地知识库（RAG 召回）：按关键词/句子做向量相似度检索，返回最相关的原文片段与来源文件，供你据此生成回答。知识库文件在根目录的 files 下。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要检索的问题或关键词。' },
        topK: { type: 'number', description: '返回片段数量，默认 4。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render(_args, value) { return [{ type: 'text', text: String((value && value.text) || '') }] },
    },
    async execute(args) {
      const query = String((args && args.query) || '').trim()
      const topK = Math.max(1, Math.min(20, Number(args && args.topK) || 4))
      const response = await engine.search(query, topK)
      if (response.results.length === 0) return { text: '知识库未检索到「' + query + '」相关内容。' }
      const lines = ['知识库检索「' + query + '」，命中 ' + response.results.length + ' 个片段：']
      for (let i = 0; i < response.results.length; i++) {
        const item = response.results[i]
        lines.push('')
        lines.push('[' + (i + 1) + '] ' + item.file + ' #' + item.ordinal + '（相似度 ' + item.score + '）')
        lines.push(item.text)
      }
      return { text: lines.join('\n') }
    },
  })

  registerTool({
    name: 'kb_dev',
    description: '知识库调试：查看状态、预览提取结果、按路径入库、检索、重建索引。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'state | preview | ingest | search | rescan' },
        path: { type: 'string', description: '文件绝对路径（preview / ingest）。' },
        query: { type: 'string', description: '检索词（search）。' },
        name: { type: 'string', description: '入库后的文件名（ingest）。' },
        topK: { type: 'number', description: '返回条数（search）。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    },
    async execute(args) {
      const action = String((args && args.action) || 'state')
      if (action === 'state') return await statePayload()
      if (action === 'search') return await engine.search(args.query, args.topK)
      if (action === 'ingest') return await engine.ingestPath(args.path, args.name)
      if (action === 'preview') return await engine.preview(args.path, args.name)
      if (action === 'rescan') return await engine.rescan()
      return { error: 'unknown action ' + action }
    },
  })

  mark('e: before browser surface')
  // ── browser surface ────────────────────────────────────────────────────────

  mark('tools registered')

  function reject(req) {
    const connection = ctx.get('connection')
    if (connection === undefined || connection === null) return undefined
    try { return connection.requestRejection(req) } catch { return undefined }
  }
  function send(res, status, value) {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(value))
  }
  async function readBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    return text === '' ? {} : JSON.parse(text)
  }

  function route(path, method, run) {
    return ctx.webServer.register({
      kind: 'exact',
      path: path,
      handler: async function (req, res) {
        const rejection = reject(req)
        if (rejection !== undefined) { send(res, rejection, { ok: false, error: 'unauthorized' }); return }
        if (req.method !== method) { send(res, 405, { ok: false, error: 'method not allowed' }); return }
        try {
          const body = method === 'POST' ? await readBody(req) : {}
          send(res, 200, await run(body))
        } catch (error) {
          send(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    })
  }

  ctx.effect(function () { return route('/knowledge/state', 'GET', async function () { return await statePayload() }) }, 'knowledge state route')
  ctx.effect(function () { return route('/knowledge/search', 'POST', async function (body) { return await handle({ op: 'search', query: body.query, topK: body.topK }) }) }, 'knowledge search route')
  ctx.effect(function () { return route('/knowledge/ingest', 'POST', async function (body) { return await handle({ op: 'ingest', name: body.name, base64: body.base64 }) }) }, 'knowledge ingest route')
  ctx.effect(function () { return route('/knowledge/remove', 'POST', async function (body) { return await handle({ op: 'remove', name: body.name }) }) }, 'knowledge remove route')
  ctx.effect(function () { return route('/knowledge/open-folder', 'POST', async function () { return await handle({ op: 'open-folder', path: '' }) }) }, 'knowledge folder route')
  ctx.effect(function () { return route('/knowledge/desktop', 'POST', async function (body) { return await handle({ op: 'desktop', on: body.on === true }) }) }, 'knowledge desktop route')

  // ── startup ────────────────────────────────────────────────────────────────

  mark('f: before startup')
  if (readPinned()) {
    startWidget().then(function (result) { note('boot pinned start ok=' + String(result.ok)) })
  } else {
    note('boot: 置顶关闭，桌面图标不启动')
  }
  mark('apply finished; pinned=' + String(readPinned()))

  ctx.effect(function () {
    return function () {
      // The widget is deliberately left running when the row unwinds: it is a
      // desktop object, not a child of the page. `置顶` is its only owner.
      note('knowledge row disposed')
    }
  }, 'knowledge desktop lifecycle')
}
