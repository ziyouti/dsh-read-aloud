/**
 * Headless smoke test for the read-aloud client bundle.
 *
 * Evaluates client.js in a stub browser and exercises the paths that do not
 * need a real page: reply-text lookup, Markdown cleanup, chunking, the neural
 * request/playback loop, the transport controls, the system fallback, auto-read
 * and the settings row.
 */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const file = path.join(__dirname, 'client.js')
const source = fs.readFileSync(file, 'utf8')

const requests = []
const played = []
const revocations = []
/** How long one fake chunk takes to "play"; the transport cases stretch it. */
let audioMs = 5
/** When true the fake player never ends on its own, freezing the position. */
let audioHold = false

class FakeAudio {
  constructor() {
    this.preload = ''
    this.src = ''
    this.onended = null
    this.onerror = null
    this.paused = true
  }
  play() {
    this.paused = false
    played.push(this.src)
    setTimeout(() => {
      if (!audioHold && this.onended) this.onended()
    }, audioMs)
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
  removeAttribute() {
    this.src = ''
  }
}

class FakeUtterance {
  constructor(text) {
    this.text = text
    this.rate = 1
    this.lang = ''
    this.voice = null
    this.onend = null
    this.onerror = null
  }
}

const systemVoices = [
  { voiceURI: 'zh-a', name: 'Microsoft Huihui - Chinese', lang: 'zh-CN', default: false },
  { voiceURI: 'en-a', name: 'Microsoft Zira - English', lang: 'en-US', default: true },
]
const spokenBySystem = []
const speechSynthesis = {
  getVoices: () => systemVoices,
  speak: (utterance) => {
    spokenBySystem.push(utterance.text)
  },
  cancel: () => {},
  pause: () => {},
  resume: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
}

const catalogVoices = [
  { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao', locale: 'zh-CN', gender: 'f' },
  { id: 'zh-CN-YunxiNeural', name: 'Yunxi', locale: 'zh-CN', gender: 'm' },
  { id: 'zh-CN-UnknownNeural', name: 'Unknown', locale: 'zh-CN', gender: 'f' },
]

let neuralOnline = true
const fetchStub = (url, options) => {
  requests.push({ url, options })
  if (url === '/read-aloud/ping') {
    return Promise.resolve(
      neuralOnline
        ? { ok: true, json: async () => ({ ok: true, engine: 'edge-neural' }) }
        : { ok: false, json: async () => ({ error: 'not found' }) },
    )
  }
  if (url.startsWith('/read-aloud/voices')) {
    return Promise.resolve({ ok: true, json: async () => ({ voices: catalogVoices }) })
  }
  if (url === '/read-aloud/synthesize') {
    return Promise.resolve({ ok: true, blob: async () => ({ byteLength: 1024, body: options.body }) })
  }
  return Promise.resolve({ ok: false, json: async () => ({}) })
}

const storage = new Map()

const sandbox = {
  console,
  setTimeout: (fn, ms) => setTimeout(fn, ms ?? 0),
  clearTimeout: (id) => clearTimeout(id),
  AbortController,
  Blob,
  URL: {
    createObjectURL: () => `blob:${played.length}-${Math.random()}`,
    revokeObjectURL: (url) => revocations.push(url),
  },
  Audio: FakeAudio,
  SpeechSynthesisUtterance: FakeUtterance,
  fetch: fetchStub,
  window: {
    speechSynthesis,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, value),
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms ?? 0),
    clearTimeout: (id) => clearTimeout(id),
    __ModuleLoader__: {
      load: (definition) => {
        sandbox.__definition = definition
      },
    },
  },
  document: {
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, remove: () => {} }),
    querySelector: () => null,
  },
}
sandbox.globalThis = sandbox
sandbox.__DSH_READ_ALOUD_TEST__ = true
sandbox.window.fetch = fetchStub
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: file })

const flatten = (items) => items.flatMap((item) => (Array.isArray(item) ? flatten(item) : [item]))
const createElement = (type, props, ...children) => ({
  type,
  props: props || {},
  children: flatten(children).filter((child) => child !== null && child !== undefined && child !== false),
})
const react = {
  createElement,
  useState: (initial) => {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect: (effect) => {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanup()
  },
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  memo: (component) => component,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function buttonsOf(element) {
  return element.children.flatMap((child) => (child && child.type === 'button' ? [child] : [])).concat(
    element.children.flatMap((child) =>
      child && child.children ? child.children.filter((grand) => grand && grand.type === 'button') : [],
    ),
  )
}

async function main() {
  const plugin = sandbox.__definition.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  })
  if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots')) throw new Error('missing inject')

  const registry = new Map()
  const ctx = {
    effect: (fn, label) => {
      const dispose = fn()
      if (typeof dispose !== 'function') throw new Error(`effect ${label} returned no disposer`)
      return dispose
    },
    locale: {
      register: (ns, dicts) => {
        const zhKeys = Object.keys(dicts.zh)
        const enKeys = Object.keys(dicts.en)
        if (zhKeys.length !== enKeys.length || zhKeys.some((key) => !(key in dicts.en))) {
          throw new Error('zh/en dictionaries have different key sets')
        }
        return () => {}
      },
    },
    slots: {
      inject: (owner, callback) => callback(),
      register: (options, Component) => {
        registry.set(options.id, { options, Component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)

  const action = registry.get('read-aloud')
  const settingsRow = registry.get('read-aloud-voice')
  if (!action || !settingsRow) throw new Error('slot entries were not registered')

  const now = Date.now()
  const snapshot = {
    nodes: new Map([
      ['a', { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: 'ignored' }] } }],
      [
        'b',
        {
          kind: 'turn-tail',
          data: {
            closing: {
              time: now,
              finalNode: { messageId: 'm1', seq: 9, blocks: [] },
              blocks: [
                { kind: 'reasoning', text: 'thinking' },
                { kind: 'text', text: '# 标题\n这是**正文**，还有 `code` 和 [链接](https://x)。' },
                { kind: 'tool-call' },
                {
                  kind: 'text',
                  text:
                    '第二段。插件会把回复拆成若干句再交给语音引擎，避免长句子被浏览器截断。' +
                    '每句话合成好就立刻播放，同时提前合成下一句，所以听起来是连续的。' +
                    '遇到代码块和表格会跳过，只念正文。这条测试文本故意写得长一些，方便检查分段逻辑。' +
                    '如果这一段仍然不够长，那么再补一句：语音引擎每次只处理一小段文字，' +
                    '这样首句出声更快，后面的句子在播放时已经准备好了。' +
                    '再补一句，确保总长度明显超过一个分段的阈值，这样测试就能看到多个请求。',
                },
              ],
            },
          },
        },
      ],
    ]),
  }

  const t = (key) => key
  const render = (extra) =>
    action.Component(Object.assign({ messageId: 'm1', useChat: (selector) => selector(snapshot), t }, extra || {}))

  // ---- idle row ----------------------------------------------------
  const idle = render()
  if (!idle || idle.type !== 'span') throw new Error('action did not render a group')
  const idleButtons = buttonsOf(idle)
  if (idleButtons.length !== 2) throw new Error(`idle row should show speaker + auto toggle, got ${idleButtons.length}`)
  if (idleButtons[1].props['aria-pressed'] !== false) throw new Error('auto-read should start off')

  const missing = action.Component({ messageId: 'nope', useChat: (selector) => selector(snapshot), t })
  if (missing !== null) throw new Error('unknown message should render null')

  // ---- neural playback --------------------------------------------
  idleButtons[0].props.onClick()
  await sleep(300)
  const synthCalls = requests.filter((request) => request.url === '/read-aloud/synthesize')
  if (synthCalls.length < 2) throw new Error(`expected several chunks, got ${synthCalls.length}`)
  if (played.length !== synthCalls.length) {
    throw new Error(`played ${played.length} chunks for ${synthCalls.length} requests`)
  }
  if (spokenBySystem.length !== 0) throw new Error('fell back to the system voice while neural worked')
  const payload = JSON.parse(synthCalls[0].options.body)
  if (!payload.voice || !payload.text) throw new Error('request payload is incomplete')
  if (/```|\*\*|thinking/.test(payload.text)) throw new Error(`bad payload text: ${payload.text}`)
  if (synthCalls.some((call) => call.options.headers['x-dsh-read-aloud'] !== '1')) {
    throw new Error('missing route guard header')
  }
  if (revocations.length === 0) throw new Error('object URLs were never revoked')

  // ---- transport controls ------------------------------------------
  // Start a run and freeze it on the first sentence, so every button state
  // below is a property of the code rather than of the clock.
  audioHold = true
  idleButtons[0].props.onClick()
  await sleep(40)
  const playing = render()
  const transport = buttonsOf(playing)
  if (transport.length !== 5) throw new Error(`playing row should show 5 buttons, got ${transport.length}`)
  const [prevButton, pauseButton, nextButton, stopButton] = transport
  if (!prevButton.props.disabled) throw new Error('previous should be disabled on the first sentence')
  if (nextButton.props.disabled) throw new Error('next should be enabled on the first sentence')

  // Skipping must keep the audio coming; whether the target chunk was already
  // prefetched decides the request count, so assert on playback instead.
  const beforeSkip = played.length
  nextButton.props.onClick()
  await sleep(120)
  if (played.length <= beforeSkip) throw new Error('next sentence never reached the audio output')

  pauseButton.props.onClick()
  const paused = render()
  const pausedTransport = buttonsOf(paused)
  if (pausedTransport[1].props['aria-label'] !== 'action.resume') throw new Error('pause did not flip to resume')
  pausedTransport[1].props.onClick()
  const resumed = render()
  if (buttonsOf(resumed)[1].props['aria-label'] !== 'action.pause') throw new Error('resume did not flip back')

  stopButton.props.onClick()
  const stopped = render()
  if (buttonsOf(stopped).length !== 2) throw new Error('stop should return to the idle row')
  audioMs = 5
  audioHold = false

  // ---- neural outage falls back to the system engine ---------------
  const backupFetch = sandbox.fetch
  sandbox.fetch = (url, options) => {
    if (url === '/read-aloud/synthesize') return Promise.resolve({ ok: false, status: 502 })
    return backupFetch(url, options)
  }
  spokenBySystem.length = 0
  buttonsOf(render())[0].props.onClick()
  await sleep(300)
  if (spokenBySystem.length === 0) throw new Error('no system fallback after a neural failure')
  sandbox.fetch = backupFetch
  neuralOnline = true
  stopPlaybackOnce(render())

  // ---- auto-read toggle --------------------------------------------
  const toggled = buttonsOf(render())[1]
  toggled.props.onClick()
  const savedAuto = JSON.parse(storage.get('dsh.read-aloud.v2'))
  if (savedAuto.autoRead !== true) throw new Error('auto-read preference was not persisted')

  // ---- settings row ------------------------------------------------
  const row = settingsRow.Component({ t })
  const controls = row.children[1]
  const selects = controls.children.filter((child) => child.type === 'select')
  if (selects.length !== 3) throw new Error('expected engine, voice and rate selects')
  const [engineSelect, voiceSelect] = selects
  if (engineSelect.children.length !== 2) throw new Error('engine select should offer two engines')
  await sleep(50)
  const row2 = settingsRow.Component({ t })
  const voice2 = row2.children[1].children.filter((child) => child.type === 'select')[1]
  if (voice2.children.length !== 5) {
    throw new Error(`catalog voices plus dialects should be used, got ${voice2.children.length}`)
  }
  const dialectIds = voice2.children.map((child) => child.props.value)
  for (const id of ['zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural']) {
    if (!dialectIds.includes(id)) throw new Error(`dialect voice missing from the picker: ${id}`)
  }
  if (voice2.children[0].props.value !== 'zh-CN-XiaoxiaoNeural') throw new Error('catalog order changed')
  if (voiceSelect.children.length === 0) throw new Error('voice list is empty')

  engineSelect.props.onChange({ target: { value: 'system' } })
  if (JSON.parse(storage.get('dsh.read-aloud.v2')).engine !== 'system') {
    throw new Error('engine preference was not persisted')
  }
  const row3 = settingsRow.Component({ t })
  const systemVoice = row3.children[1].children.filter((child) => child.type === 'select')[1]
  if (systemVoice.children.length !== 3) throw new Error('system voice list should be default + two voices')
  systemVoice.props.onChange({ target: { value: 'en-a' } })
  if (JSON.parse(storage.get('dsh.read-aloud.v2')).systemVoiceURI !== 'en-a') {
    throw new Error('system voice preference was not persisted')
  }

  const preview = row3.children[1].children.find(
    (child) =>
      child.type === 'button' &&
      ['settings.preview', 'settings.previewing'].includes(String(flatten([child.children])[0])),
  )
  if (!preview) throw new Error('preview button missing')
  spokenBySystem.length = 0
  preview.props.onClick()
  await sleep(200)
  if (spokenBySystem.length === 0) throw new Error('preview produced no speech')

  // ---- highlight colours -------------------------------------------
  const colourRow = settingsRow.Component({ t })
  const colourLabels = colourRow.children[1].children.filter((child) => child.type === 'label')
  if (colourLabels.length !== 3) {
    throw new Error(`expected background, text and opacity controls, got ${colourLabels.length}`)
  }
  const backgroundInput = colourLabels[0].children.find((child) => child.type === 'input')
  const textInput = colourLabels[1].children.find((child) => child.type === 'input')
  const alphaInput = colourLabels[2].children.find((child) => child.type === 'input')
  if (!backgroundInput || !textInput || !alphaInput) throw new Error('colour inputs missing')
  if (backgroundInput.props.type !== 'color' || textInput.props.type !== 'color') throw new Error('wrong input type')
  if (alphaInput.props.type !== 'range') throw new Error('opacity control is not a slider')
  if (alphaInput.props.min !== 5 || alphaInput.props.max !== 100) throw new Error('slider range is wrong')
  alphaInput.props.onChange({ target: { value: '60' } })
  if (JSON.parse(storage.get('dsh.read-aloud.v2')).highlightAlpha !== 0.6) {
    throw new Error('opacity was not persisted')
  }
  backgroundInput.props.onChange({ target: { value: '#ff8800' } })
  if (JSON.parse(storage.get('dsh.read-aloud.v2')).highlightBackground !== '#ff8800') {
    throw new Error('background colour was not persisted')
  }
  textInput.props.onChange({ target: { value: '#00ffaa' } })
  if (JSON.parse(storage.get('dsh.read-aloud.v2')).highlightText !== '#00ffaa') {
    throw new Error('text colour was not persisted')
  }
  // React re-renders after a preference change; the stub does not, so the row
  // is rendered again here to read the fresh settings, exactly as it would.
  const colourRow2 = settingsRow.Component({ t })
  const colourLabels2 = colourRow2.children[1].children.filter((child) => child.type === 'label')
  const autoButton = colourLabels2[1].children.find(
    (child) => child.type === 'button' && String(flatten([child.children])[0]) === 'settings.highlightTextAuto',
  )
  if (!autoButton) throw new Error('follow-theme button missing')
  autoButton.props.onClick()
  if (JSON.parse(storage.get('dsh.read-aloud.v2')).highlightText !== '') {
    throw new Error('follow-theme did not clear the text colour')
  }
  const resetButton = colourRow.children[1].children.find(
    (child) => child.type === 'button' && String(flatten([child.children])[0]) === 'settings.highlightReset',
  )
  if (!resetButton) throw new Error('reset button missing')
  resetButton.props.onClick()
  const reset = JSON.parse(storage.get('dsh.read-aloud.v2'))
  if (reset.highlightBackground !== '#3b82f6') throw new Error('reset did not restore the background colour')

  // ---- sentence highlight ------------------------------------------
  const test = plugin.__test
  if (!test) throw new Error('highlight test hook missing')

  // The chunk text is already Markdown-free; the key only drops what speech drops.
  const key = test.speechKey('这是正文，还有 code 和 链接。')
  if (key !== '这是正文还有code和链接') throw new Error(`speechKey mismatch: ${key}`)
  const digits = test.speechKey('第 2 步：共 10 项')
  if (digits !== '第2步共10项') throw new Error(`speechKey mangled digits: ${digits}`)

  const nodeA = { nodeValue: '第一段。' }
  const nodeB = { nodeValue: '第二段，带列表' }
  const index = test.flatten([nodeA, nodeB])
  if (index.text !== '第一段第二段带列表') throw new Error(`flatten mismatch: ${index.text}`)
  if (index.map[0].node !== nodeA || index.map[0].offset !== 0) throw new Error('flatten lost the node mapping')

  const opening = test.locateChunk(index, '第一段第二段')
  if (!opening || opening.start !== 0 || opening.end !== 6) {
    throw new Error(`locateChunk missed the opening sentence: ${JSON.stringify(opening)}`)
  }
  const later = test.locateChunk(index, '第二段带列表')
  if (!later || later.start !== 3 || later.end !== 9) {
    throw new Error(`locateChunk missed the following sentence: ${JSON.stringify(later)}`)
  }  // A list marker survives the splitter but not the renderer; the edges get trimmed.
  const numbered = test.locateChunk(index, '1第一段')
  if (!numbered || numbered.start !== 0) throw new Error('locateChunk did not trim a leading list number')

  // The cursor belongs to the caller now: each paint rebuilds the index, so it
  // resumes from the offset of the previous match instead of stored state.
  const repeated = test.flatten([{ nodeValue: '好。' }, { nodeValue: '好。' }])
  const first = test.locateChunk(repeated, '好', 0)
  const second = test.locateChunk(repeated, '好', first.start + 1)
  if (!first || !second || second.start <= first.start) throw new Error('repeated sentences did not advance')

  // A sentence whose rendering gained a token in the middle must still paint:
  // the loose pass joins the pieces it can find instead of failing outright.
  const noisy = test.flatten([{ nodeValue: '开头部分完全相同，这里多了个 7 号标记，结尾部分也完全相同。' }])
  const noisyNeedle = test.speechKey('开头部分完全相同这里多了个号标记结尾部分也完全相同')
  const loose = test.locateChunk(noisy, noisyNeedle, 0)
  if (!loose) throw new Error('loose match did not paint a sentence with a middle difference')
  if (loose.start !== 0) throw new Error(`loose match started at ${loose.start}`)

  console.log('OK')
  console.log('neural requests:', synthCalls.length)
  console.log('first payload:', JSON.stringify(payload))
  console.log('transport buttons verified, system utterances:', spokenBySystem.length)
}

/** Press stop when a row is playing, so the next case starts clean. */
function stopPlaybackOnce(element) {
  const buttons = element.children[0] && element.children[0].children ? buttonsOf(element) : buttonsOf(element)
  const stop = buttons.find((button) => button.props['aria-label'] === 'action.stop')
  if (stop) stop.props.onClick()
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exitCode = 1
})
