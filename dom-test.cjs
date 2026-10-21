/**
 * DOM-level test for the read-aloud client bundle.
 *
 * Evaluates client.js against a miniature DOM that mirrors the chat layout the
 * real UI renders: flow items carrying `data-chat-turn` / `data-chat-flow-kind`,
 * a turn-tail row holding the action buttons, and prose inside <p> elements.
 * It then drives the real component and checks the painted sentence through
 * the CSS Custom Highlight API, plus the teardown when playback stops.
 */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/* ------------------------------------------------------------------ */
/* Mini DOM                                                            */
/* ------------------------------------------------------------------ */

const PRECEDING = 2
const FOLLOWING = 4

class TextNode {
  constructor(value) {
    this.nodeValue = value
    this.parentElement = null
  }
}

class Element {
  constructor(tagName, attributes) {
    this.tagName = String(tagName).toUpperCase()
    this.attributes = attributes || {}
    this.children = []
    this.parentElement = null
    this.isConnected = true
    this.scrollHeight = 0
    this.clientHeight = 0
    this.dataset = {}
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this
      this.children.push(child)
    }
    return this
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  closest(selector) {
    let node = this
    while (node) {
      if (node instanceof Element && matches(node, selector)) return node
      node = node.parentElement
    }
    return null
  }

  querySelectorAll(selector) {
    const found = []
    walk(this, (node) => {
      if (node instanceof Element && node !== this && matches(node, selector)) found.push(node)
    })
    return found
  }

  compareDocumentPosition(other) {
    const order = documentOrder()
    // Mirrors the DOM spec: PRECEDING when `other` comes before this node.
    return order.indexOf(other) < order.indexOf(this) ? PRECEDING : FOLLOWING
  }

  getBoundingClientRect() {
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }
  }

  remove() {
    if (this.parentElement) {
      const at = this.parentElement.children.indexOf(this)
      if (at >= 0) this.parentElement.children.splice(at, 1)
    }
  }
}

/** Depth-first walk over an element's descendants. */
function walk(node, visit) {
  if (!node.children) return
  for (const child of node.children) {
    visit(child)
    if (child && child.children) walk(child, visit)
  }
}

/** Every element and text node in document order. */
function documentOrder() {
  const flat = []
  const collect = (node) => {
    flat.push(node)
    if (!node.children) return
    for (const child of node.children) collect(child)
  }
  collect(document)
  return flat
}

/** Supports the selector shapes the plugin uses: tags, [attr], [attr="value"]. */
function matches(element, selector) {
  return String(selector)
    .split(',')
    .some((part) => {
      const test = part.trim()
      if (!test) return false
      if (test.startsWith('[')) {
        const body = test.slice(1, -1)
        const eq = body.indexOf('=')
        if (eq < 0) return element.getAttribute(body) !== null
        const name = body.slice(0, eq)
        const value = body.slice(eq + 1).replace(/^["']|["']$/g, '')
        return element.getAttribute(name) === value
      }
      return element.tagName === test.toUpperCase()
    })
}

const document = new Element('#document')
const head = new Element('head')
const body = new Element('body')
document.append(head, body)
document.head = head
document.body = body
head.appendChild = (element) => head.append(element)
document.createElement = (tag) => new Element(tag)
document.createTreeWalker = (root) => {
  const nodes = []
  walk(root, (node) => {
    if (node instanceof TextNode) nodes.push(node)
  })
  let at = -1
  return {
    nextNode() {
      at += 1
      return at < nodes.length ? nodes[at] : null
    },
  }
}
document.createRange = () => new FakeRange()

class FakeRange {
  constructor() {
    this.startNode = null
    this.startOffset = 0
    this.endNode = null
    this.endOffset = 0
  }
  setStart(node, offset) {
    this.startNode = node
    this.startOffset = offset
  }
  setEnd(node, offset) {
    this.endNode = node
    this.endOffset = offset
  }
  getBoundingClientRect() {
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }
  }
}

const Highlight = class {
  constructor(...ranges) {
    this.ranges = ranges
  }
}
const CSS = { highlights: new Map() }
const NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }
const Node = { DOCUMENT_POSITION_PRECEDING: PRECEDING, DOCUMENT_POSITION_FOLLOWING: FOLLOWING }

/* ------------------------------------------------------------------ */
/* Fixture: one turn with a reply and its action row                    */
/* ------------------------------------------------------------------ */

const sentence = (n) => `第${n}句：` + '内容'.repeat(60) + '。'
const firstText = sentence(1)
const secondText = sentence(2)
const replyText = firstText + secondText

const flow = new Element('div', { 'data-slot': 'conversation.chat.flow' })
body.append(flow)

const stepItem = new Element('div', { 'data-chat-turn': '1', 'data-chat-flow-kind': 'assistant-step' })
const markdownBody = new Element('div')
const paragraphOne = new Element('p')
const textOne = new TextNode(firstText)
paragraphOne.append(textOne)
const paragraphTwo = new Element('p')
const textTwo = new TextNode(secondText)
paragraphTwo.append(textTwo)
markdownBody.append(paragraphOne, paragraphTwo)
stepItem.append(markdownBody)

const tailItem = new Element('div', { 'data-chat-turn': '1', 'data-chat-flow-kind': 'turn-tail' })
const tailRoot = new Element('div', { 'data-turn-tail': '1' })
const group = new Element('span', { class: 'dsh-ra_group' })
tailRoot.append(group)
tailItem.append(tailRoot)
flow.append(stepItem, tailItem)

/* ------------------------------------------------------------------ */
/* Sandbox                                                             */
/* ------------------------------------------------------------------ */

const audio = []
let audioHold = true

class FakeAudio {
  constructor() {
    this.src = ''
    this.onended = null
    this.onerror = null
    this.paused = true
    this.preload = ''
  }
  play() {
    this.paused = false
    audio.push(this.src)
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
  removeAttribute() {
    this.src = ''
  }
  load() {}
}

let currentElement = null

class FakeAudioFactory extends FakeAudio {
  constructor() {
    super()
    currentElement = this
  }
}

const played = []
const requests = []

const storage = new Map()

const sandbox = {
  console,
  setTimeout: (fn, ms) => setTimeout(fn, ms ?? 0),
  clearTimeout: (id) => clearTimeout(id),
  AbortController,
  Blob,
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  Audio: FakeAudioFactory,
  SpeechSynthesisUtterance: class {},
  fetch: (url, options) => {
    requests.push(url)
    if (url === '/read-aloud/ping') return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
    if (url.startsWith('/read-aloud/voices')) return Promise.resolve({ ok: true, json: async () => ({ voices: [] }) })
    if (url === '/read-aloud/synthesize') return Promise.resolve({ ok: true, blob: async () => ({ size: 1 }) })
    return Promise.resolve({ ok: false, status: 404 })
  },
  document,
  CSS,
  Highlight,
  Node,
  NodeFilter,
  window: {
    speechSynthesis: { getVoices: () => [], addEventListener: () => {}, removeEventListener: () => {}, cancel: () => {}, speak: () => {} },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, value),
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms ?? 0),
    clearTimeout: (id) => clearTimeout(id),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    __ModuleLoader__: { load: (definition) => { sandbox.__definition = definition } },
  },
}
sandbox.window.document = document
// In a browser these are also properties of `window`, which is how the bundle
// reaches the registry (a local name must never shadow it).
sandbox.window.CSS = CSS
sandbox.window.Highlight = Highlight
sandbox.window.Node = Node
sandbox.window.NodeFilter = NodeFilter
sandbox.globalThis = sandbox
sandbox.__DSH_READ_ALOUD_TEST__ = true
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8'), sandbox, { filename: 'client.js' })

/* ------------------------------------------------------------------ */
/* React stub                                                          */
/* ------------------------------------------------------------------ */

const flattenChildren = (items) => items.flatMap((item) => (Array.isArray(item) ? flattenChildren(item) : [item]))
const createElement = (type, props, ...children) => ({
  type,
  props: props || {},
  children: flattenChildren(children).filter((child) => child !== null && child !== undefined && child !== false),
})
const react = {
  createElement,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  // React runs cleanups on unmount; this stub keeps the effect alive so the
  // component's registrations stay visible to the test.
  useEffect: (effect) => {
    effect()
  },
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  memo: (component) => component,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function buttonsOf(element) {
  return element.children.filter((child) => child && child.type === 'button')
}

async function main() {
  const plugin = sandbox.__definition.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  })

  const registry = new Map()
  plugin.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: {
      inject: (owner, callback) => callback(),
      register: (options, Component) => {
        registry.set(options.id, { options, Component })
        return () => {}
      },
    },
  })

  const action = registry.get('read-aloud')
  const snapshot = {
    nodes: new Map([
      [
        'tail',
        {
          kind: 'turn-tail',
          data: {
            closing: {
              time: Date.now(),
              finalNode: { messageId: 'm1', seq: 4, blocks: [] },
              blocks: [{ kind: 'text', text: replyText }],
            },
          },
        },
      ],
    ]),
  }
  const render = () => {
    const element = action.Component({ messageId: 'm1', useChat: (selector) => selector(snapshot), t: (key) => key })
    // React would attach the ref; the stub leaves it for us.
    if (element && element.props && element.props.ref) element.props.ref.current = group
    return element
  }

  const idle = render()
  audioHold = true
  buttonsOf(idle)[0].props.onClick()
  await sleep(60)

  const painted = CSS.highlights.get('dsh-read-aloud-current')
  if (!painted) {
    const probe = plugin.__test
    const roots = probe.replyRoots('m1')
    console.error(
      'diagnostics',
      JSON.stringify({
        anchors: probe.anchors(),
        state: probe.state(),
        miss: probe.miss(),
        chunks: probe.chunks().map((chunk) => chunk.slice(0, 12)),
        roots: roots ? roots.roots.length : null,
        audio: audio.length,
        requests,
      }),
    )
    throw new Error('播放后没有出现高亮')
  }
  const range = painted.ranges[0]
  if (range.startNode !== textOne) throw new Error('高亮没有落在第一句上')
  if (range.startOffset !== 0) throw new Error(`高亮起点不对: ${range.startOffset}`)
  if (range.endNode !== textOne) throw new Error('高亮跨越了不该跨的节点')

  // Advance one sentence: the paint must follow.
  const playing = render()
  const next = buttonsOf(playing).find((button) => button.props['aria-label'] === 'action.next')
  next.props.onClick()
  await sleep(60)
  const moved = CSS.highlights.get('dsh-read-aloud-current')
  if (!moved) throw new Error('跳到下一句后高亮消失了')
  if (moved.ranges[0].startNode !== textTwo) throw new Error('跳到下一句后高亮没有跟着移动')

  // Stop: paint cleared and the audio element actually silenced.
  const transport = buttonsOf(render())
  const stop = transport.find((button) => button.props['aria-label'] === 'action.stop')
  if (!stop) throw new Error('播放时没有停止按钮')
  stop.props.onClick()
  await sleep(20)
  if (CSS.highlights.has('dsh-read-aloud-current')) throw new Error('停止后高亮没有清除')
  if (!currentElement) throw new Error('没有创建音频元素')
  if (!currentElement.paused) throw new Error('停止后音频仍在播放')
  if (currentElement.src !== '') throw new Error('停止后音频源没有断开')

  // Idle row comes back.
  if (buttonsOf(render()).length !== 2) throw new Error('停止后没有回到初始按钮组')

  console.log('OK')
  console.log('高亮文本:', JSON.stringify(firstText.slice(0, 8)) + '…')
  console.log('请求数:', requests.filter((url) => url === '/read-aloud/synthesize').length, '播放次数:', audio.length)
}

main().catch((error) => {
  console.error('FAILED:', error.message)
  process.exitCode = 1
})
