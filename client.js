/**
 * Read-aloud Client half.
 *
 * Three contributions, all plain React without JSX:
 *  - a speaker in `conversation.chat.assistant-actions` that becomes a small
 *    transport bar (previous sentence, pause/resume, next sentence, stop) while
 *    that reply is playing, plus an auto-read toggle;
 *  - one preference row in `settings.general.item` for the engine, the voice,
 *    the rate and a preview;
 *  - the shared player state that keeps only one reply speaking at a time.
 *
 * Two engines: the Host synthesizes Microsoft Edge neural voices (natural,
 * needs the network, no key) over `/read-aloud/synthesize`; the browser's own
 * Web Speech API stays available offline and is used when the neural route is
 * missing or fails.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-read-aloud',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'read-aloud'
    /** localStorage key holding the client-side preferences. */
    const STORAGE_KEY = 'dsh.read-aloud.v2'
    /** Chunk size for one neural request: bigger means fewer round trips. */
    const NEURAL_CHUNK = 180
    /** Chunk size for the system engine, which cuts off long utterances. */
    const SYSTEM_CHUNK = 110
    const RATE_MIN = 0.5
    const RATE_MAX = 2
    /** A reply older than this is never read automatically. */
    const AUTO_READ_WINDOW = 120000

    const zh = {
      'action.play': '朗读这条回复',
      'action.stop': '停止朗读',
      'action.pause': '暂停',
      'action.resume': '继续',
      'action.prev': '上一句',
      'action.next': '下一句',
      'action.auto.on': '自动朗读新回复：开',
      'action.auto.off': '自动朗读新回复：关',
      'action.unsupported': '当前环境没有可用的语音',
      'settings.title': '朗读语音',
      'settings.description': '回复下面的喇叭按钮会用这个声音朗读。',
      'settings.preview': '试听',
      'settings.previewing': '生成中…',
      'settings.engine': '引擎',
      'settings.engine.neural': '在线神经语音（更自然）',
      'settings.engine.system': '系统语音（离线）',
      'settings.voice': '声音',
      'settings.rate': '语速',
      'settings.highlightBackground': '高亮底色',
      'settings.highlightText': '高亮文字',
      'settings.highlightTextAuto': '跟随',
      'settings.highlightReset': '恢复默认',
      'settings.highlightAlpha': '浓淡',
      'settings.default': '跟随系统',
      'settings.noVoices': '这个浏览器没有可用的系统语音；在线神经语音需要联网。',
      'settings.neuralOffline': '在线神经语音连不上，正在使用系统语音。',
      'settings.previewText': '你好，我是你的编程助手，这条回复会这样读给你听。',
    }
    const en = {
      'action.play': 'Read this reply aloud',
      'action.stop': 'Stop reading',
      'action.pause': 'Pause',
      'action.resume': 'Resume',
      'action.prev': 'Previous sentence',
      'action.next': 'Next sentence',
      'action.auto.on': 'Auto-read new replies: on',
      'action.auto.off': 'Auto-read new replies: off',
      'action.unsupported': 'No speech engine is available',
      'settings.title': 'Read-aloud voice',
      'settings.description': 'The speaker button under each reply uses this voice.',
      'settings.preview': 'Preview',
      'settings.previewing': 'Synthesizing…',
      'settings.engine': 'Engine',
      'settings.engine.neural': 'Neural (natural)',
      'settings.engine.system': 'System (offline)',
      'settings.voice': 'Voice',
      'settings.rate': 'Speed',
      'settings.highlightBackground': 'Highlight',
      'settings.highlightText': 'Text',
      'settings.highlightTextAuto': 'Auto',
      'settings.highlightReset': 'Reset',
      'settings.highlightAlpha': 'Opacity',
      'settings.default': 'System default',
      'settings.noVoices': 'This browser exposes no system voices; the neural engine needs the network.',
      'settings.neuralOffline': 'The neural engine is unreachable; using the system voice.',
      'settings.previewText': 'Hello, this is how the reply will sound.',
    }

    /**
     * Chinese labels for the voices the Edge catalog actually ships. Anything
     * outside this table falls back to its catalog name, so the picker can
     * never offer a voice that does not exist.
     */
    const VOICE_LABELS = {
      'zh-CN-XiaoxiaoNeural': '晓晓 · 女声（自然温柔，推荐）',
      'zh-CN-XiaoyiNeural': '晓伊 · 女声（活泼）',
      'zh-CN-YunxiNeural': '云希 · 男声（年轻）',
      'zh-CN-YunjianNeural': '云健 · 男声（浑厚）',
      'zh-CN-YunyangNeural': '云扬 · 男声（播报）',
      'zh-CN-YunxiaNeural': '云夏 · 男声（少年）',
      'zh-CN-liaoning-XiaobeiNeural': '晓北 · 女声（东北话）',
      'zh-CN-shaanxi-XiaoniNeural': '晓妮 · 女声（陕西话）',
      'zh-HK-HiuGaaiNeural': '曉佳 · 粤语女声',
      'zh-HK-HiuMaanNeural': '曉曼 · 粤语女声',
      'zh-HK-WanLungNeural': '雲龍 · 粤语男声',
      'zh-TW-HsiaoChenNeural': '曉臻 · 台湾女声',
      'zh-TW-HsiaoYuNeural': '曉雨 · 台湾女声',
      'zh-TW-YunJheNeural': '雲哲 · 台湾男声',
      'en-US-AriaNeural': 'Aria · English female',
      'en-US-JennyNeural': 'Jenny · English female',
      'en-US-GuyNeural': 'Guy · English male',
      'en-US-EmmaNeural': 'Emma · English female',
      'en-US-AndrewNeural': 'Andrew · English male',
      'en-GB-SoniaNeural': 'Sonia · English female',
      'en-GB-RyanNeural': 'Ryan · English male',
    }

    /** Used until the Host catalog arrives, and when it cannot be fetched. */
    const FALLBACK_VOICES = [
      'zh-CN-XiaoxiaoNeural',
      'zh-CN-XiaoyiNeural',
      'zh-CN-YunxiNeural',
      'zh-CN-YunjianNeural',
      'zh-CN-YunyangNeural',
      'zh-CN-YunxiaNeural',
      'zh-CN-liaoning-XiaobeiNeural',
      'zh-CN-shaanxi-XiaoniNeural',
      'zh-HK-HiuGaaiNeural',
      'zh-HK-HiuMaanNeural',
      'zh-HK-WanLungNeural',
      'zh-TW-HsiaoChenNeural',
      'zh-TW-HsiaoYuNeural',
      'zh-TW-YunJheNeural',
      'en-US-AriaNeural',
      'en-US-GuyNeural',
    ].map((id) => ({ id, label: VOICE_LABELS[id] || id }))

    /* ------------------------------------------------------------------ */
    /* Preferences                                                         */
    /* ------------------------------------------------------------------ */

    const DEFAULTS = {
      engine: 'neural',
      neuralVoice: 'zh-CN-XiaoxiaoNeural',
      systemVoiceURI: '',
      rate: 1,
      autoRead: false,
      highlight: true,
      /** Base colour of the painted sentence; drawn translucent so the text stays readable. */
      highlightBackground: '#3b82f6',
      /** Text colour while highlighted; empty means "keep the normal text colour". */
      highlightText: '',
      /** Opacity of the painted background, 0.05–1. */
      highlightAlpha: 0.26,
    }

    function readSettings() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return { ...DEFAULTS }
        const parsed = JSON.parse(raw)
        return {
          engine: parsed.engine === 'system' ? 'system' : 'neural',
          neuralVoice:
            typeof parsed.neuralVoice === 'string' && parsed.neuralVoice ? parsed.neuralVoice : DEFAULTS.neuralVoice,
          systemVoiceURI: typeof parsed.systemVoiceURI === 'string' ? parsed.systemVoiceURI : '',
          rate:
            typeof parsed.rate === 'number' && parsed.rate >= RATE_MIN && parsed.rate <= RATE_MAX ? parsed.rate : 1,
          autoRead: parsed.autoRead === true,
          highlight: parsed.highlight !== false,
          highlightBackground: isHexColor(parsed.highlightBackground)
            ? parsed.highlightBackground
            : DEFAULTS.highlightBackground,
          highlightText: isHexColor(parsed.highlightText) ? parsed.highlightText : '',
          highlightAlpha:
            typeof parsed.highlightAlpha === 'number' && parsed.highlightAlpha >= 0.05 && parsed.highlightAlpha <= 1
              ? parsed.highlightAlpha
              : DEFAULTS.highlightAlpha,
        }
      } catch {
        return { ...DEFAULTS }
      }
    }

    function isHexColor(value) {
      return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    }

    let settings = readSettings()
    const settingsListeners = new Set()

    function setSettings(patch) {
      settings = { ...settings, ...patch }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
      } catch {
        /* a blocked storage keeps the in-memory value */
      }
      applyHighlightColors()
      for (const listener of settingsListeners) listener(settings)
    }

    function useSettings() {
      const [value, setValue] = React.useState(settings)
      React.useEffect(() => {
        setValue(settings)
        settingsListeners.add(setValue)
        return () => settingsListeners.delete(setValue)
      }, [])
      return value
    }

    /* ------------------------------------------------------------------ */
    /* Player state                                                        */
    /* ------------------------------------------------------------------ */

    /** @type {{ messageId: string | null, index: number, total: number, paused: boolean }} */
    let playerState = { messageId: null, index: 0, total: 0, paused: false }
    const playerListeners = new Set()

    function publish(patch) {
      const before = playerState
      playerState = { ...playerState, ...patch }
      for (const listener of playerListeners) listener(playerState)
      if (!playerState.messageId) {
        resetHighlight()
      } else if (playerState.messageId !== before.messageId || playerState.index !== before.index) {
        scheduleHighlight()
      }
    }

    function usePlayer() {
      const [state, setState] = React.useState(playerState)
      React.useEffect(() => {
        setState(playerState)
        playerListeners.add(setState)
        return () => playerListeners.delete(setState)
      }, [])
      return state
    }

    let runId = 0
    let seekVersion = 0
    let chunkList = []
    let currentEngine = 'neural'
    let abortController = null
    const blobCache = new Map()
    const pauseWaiters = new Set()
    let audioElement = null
    let playingFinish = null
    let systemStep = null
    /** Message ids already read by the auto-reader. */
    const autoSpoken = new Set()
    /** Replies completed before this instant are never auto-read. */
    let autoReadSince = 0

    /* ------------------------------------------------------------------ */
    /* Sentence highlight                                                   */
    /* ------------------------------------------------------------------ */

    /**
     * The sentence being spoken is painted with the CSS Custom Highlight API:
     * one Range over the reply's own text nodes, no DOM edits at all, so React
     * never sees a change it did not make. Chromium-only, which is what the
     * Desktop app embeds; elsewhere the feature simply stays quiet.
     */
    const HIGHLIGHT_NAME = 'dsh-read-aloud-current'
    /** messageId -> ref of this reply's action row, the handle to its DOM. */
    const actionAnchors = new Map()
    /** Per-run lookup: reply text flattened to what speech keeps, plus offsets. */
    let highlightIndex = null
    let highlightOwner = null
    let highlightFrame = 0

    /**
     * Paint colours travel as CSS variables on the root element, because a
     * `::highlight()` rule cannot be edited inline: the rule reads the variable
     * and the setting only rewrites the variable.
     */
    function hexToRgba(hex, alpha) {
      if (!isHexColor(hex)) return null
      const value = Number.parseInt(hex.slice(1), 16)
      const red = (value >> 16) & 255
      const green = (value >> 8) & 255
      const blue = value & 255
      return `rgba(${red}, ${green}, ${blue}, ${alpha})`
    }

    function applyHighlightColors() {
      if (typeof document === 'undefined') return
      const root = document.documentElement
      if (!root || !root.style) return
      const alpha = settings.highlightAlpha >= 0.05 ? settings.highlightAlpha : DEFAULTS.highlightAlpha
      const background = hexToRgba(settings.highlightBackground, alpha) || `rgba(59, 130, 246, ${alpha})`
      root.style.setProperty('--dsh-ra-hl-bg', background)
      // `inherit` keeps the reply's own text colour when no override is set.
      root.style.setProperty('--dsh-ra-hl-fg', isHexColor(settings.highlightText) ? settings.highlightText : 'inherit')
    }

    function clearHighlightColors() {
      if (typeof document === 'undefined') return
      const root = document.documentElement
      if (!root || !root.style) return
      root.style.removeProperty('--dsh-ra-hl-bg')
      root.style.removeProperty('--dsh-ra-hl-fg')
    }

    /**
     * The highlight registry lives on the global `CSS` object, so every access
     * goes through `window` explicitly: this module has its own stylesheet
     * constant, and a local name that shadowed the registry would silently
     * disable the feature.
     */
    function highlightRegistry() {
      const registry = typeof window === 'undefined' ? null : window.CSS
      return registry && registry.highlights ? registry.highlights : null
    }

    function supportsHighlight() {
      if (typeof window === 'undefined') return false
      if (typeof window.Highlight === 'undefined') return false
      return highlightRegistry() !== null
    }

    function clearHighlight() {
      const registry = highlightRegistry()
      if (!registry) return
      try {
        registry.delete(HIGHLIGHT_NAME)
      } catch {
        /* no highlight support */
      }
    }

    /**
     * Reduce text to the characters speech actually keeps: no whitespace, no
     * punctuation, no symbols. Markdown emphasis, list numbering and the
     * sentence punctuation the splitter inserts all disappear, so the spoken
     * chunk and the rendered paragraph compare equal.
     */
    function speechKey(text) {
      return String(text || '')
        .replace(/[\s\u00a0\u200b-\u200d\ufeff]+/g, '')
        .replace(/[\p{P}\p{S}]/gu, '')
    }

    /** Markdown block elements hold the prose; everything else is chrome. */
    const PROSE_BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,dd,dt,figcaption,pre'
    /** Subtrees that are never read out loud. */
    const SKIP_SUBTREES = 'pre,button,textarea,input,select,script,style,svg,[data-read-aloud-ignore]'

    /**
     * Two passes: the strict one trusts that prose lives in a paragraph-like
     * block, the relaxed one takes any text outside the chrome. The relaxed pass
     * exists because a renderer is free to use plain divs, and a highlight that
     * needs one particular element name is a highlight that silently vanishes.
     */
    function isProse(parent, strict) {
      if (parent.closest(SKIP_SUBTREES)) return false
      if (!strict) return true
      return parent.closest(PROSE_BLOCKS) !== null
    }

    function textNodesIn(roots, strict) {
      const nodes = []
      for (const root of roots) {
        if (!root) continue
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            if (!node.nodeValue || node.nodeValue.trim() === '') return NodeFilter.FILTER_REJECT
            const parent = node.parentElement
            if (!parent || !isProse(parent, strict)) return NodeFilter.FILTER_REJECT
            return NodeFilter.FILTER_ACCEPT
          },
        })
        let node
        while ((node = walker.nextNode())) nodes.push(node)
      }
      return nodes
    }

    /**
     * Reduce collected text nodes to one string plus a `{node, offset}` pair per
     * character, so a match position turns straight back into a DOM Range.
     */
    function flatten(nodes) {
      const map = []
      let text = ''
      for (const node of nodes) {
        const value = node.nodeValue || ''
        for (let offset = 0; offset < value.length; offset += 1) {
          const ch = value[offset]
          if (/[\s\u00a0\u200b-\u200d\ufeff]/.test(ch)) continue
          if (/[\p{P}\p{S}]/u.test(ch)) continue
          text += ch
          map.push({ node, offset })
        }
      }
      return { text, map, cursor: 0 }
    }

    function buildIndex(roots, strict) {
      return flatten(textNodesIn(roots, strict))
    }

    /**
     * Find one spoken chunk inside the flattened reply.
     *
     * Two passes. The exact one trims a few characters from either end, which
     * covers list numbers and punctuation differences. When that fails the
     * sentence is hunted piece by piece: a reply can render the same sentence
     * with a list marker, an inline-code run or a collapsed fragment in the
     * middle, and one unbroken comparison then never matches at all. The loose
     * pass joins whichever pieces it finds, so those sentences still light up.
     *
     * `from` makes repeated sentences advance instead of sticking on the first
     * occurrence.
     */
    function locateChunk(index, needle, from) {
      if (!needle) return null
      const start = Math.max(0, from || 0)
      return locateExact(index, needle, start) || locateLoose(index, needle, start)
    }

    function locateExact(index, needle, from) {
      const limit = Math.min(10, Math.max(2, Math.floor(needle.length / 8)))
      // Keep enough of the needle to stay unambiguous, but never demand more
      // characters than a short sentence can spare (a one-character line still
      // has to match, or the highlight would vanish on terse replies).
      const floor = Math.max(1, Math.min(6, needle.length - 2))
      for (let front = 0; front <= limit; front += 1) {
        for (let back = 0; back <= limit; back += 1) {
          const end = needle.length - back
          if (end - front < floor) continue
          const part = needle.slice(front, end)
          let at = index.text.indexOf(part, from)
          if (at < 0 && from > 0) at = index.text.indexOf(part)
          if (at >= 0) return { start: at, end: at + part.length }
        }
      }
      return null
    }

    /** Pieces are short enough to survive a small difference, long enough to stay unique. */
    const LOOSE_PIECE = 6

    function locateLoose(index, needle, from) {
      if (needle.length < LOOSE_PIECE * 2) return null
      const pieces = []
      for (let at = 0; at < needle.length; at += LOOSE_PIECE) pieces.push(needle.slice(at, at + LOOSE_PIECE))
      const required = Math.max(2, Math.ceil(pieces.length * 0.6))
      let cursor = from
      let first = -1
      let last = -1
      let hits = 0
      for (const piece of pieces) {
        let at = index.text.indexOf(piece, cursor)
        if (at < 0) at = index.text.indexOf(piece, from)
        if (at < 0) continue
        if (first < 0) first = at
        last = at + piece.length
        cursor = last
        hits += 1
      }
      if (first < 0 || hits < required) return null
      return { start: first, end: last }
    }

    /**
     * The DOM scopes worth searching for one reply's prose, widest last. The
     * action row sits inside the reply's turn item, so that item and its
     * preceding siblings of the same turn come first; the whole flow is the
     * safety net when the layout groups rows differently.
     */
    function replyRoots(messageId) {
      const anchor = actionAnchors.get(messageId)
      const element = anchor && anchor.current
      if (!element || !element.isConnected) return null
      const flow =
        element.closest('[data-slot="conversation.chat.flow"]') ??
        element.closest('[data-conversation-scroll]') ??
        document.body
      const item = element.closest('[data-chat-turn]')
      if (!item) {
        // No turn marker at all: search the conversation and this row's parent.
        return { roots: [], item: element.parentElement || element, flow }
      }
      const turn = item.getAttribute('data-chat-turn')
      const container = item.parentElement || flow
      const earlier = []
      for (const sibling of container.children) {
        if (sibling === item) continue
        if (sibling.getAttribute('data-chat-turn') !== turn) continue
        if (!(item.compareDocumentPosition(sibling) & Node.DOCUMENT_POSITION_PRECEDING)) continue
        earlier.push(sibling)
      }
      const answers = earlier.filter((sibling) => sibling.getAttribute('data-chat-flow-kind') === 'assistant-step')
      return { roots: answers.length > 0 ? answers : earlier, item, flow: container }
    }

    /** Nudge the chat only when the painted sentence is not on screen. */
    function revealRange(range, scope) {
      let box = scope
      while (box && box !== document.body) {
        if (box.scrollHeight > box.clientHeight + 4) break
        box = box.parentElement
      }
      if (!box || box === document.body) return
      const rect = range.getBoundingClientRect()
      const area = box.getBoundingClientRect()
      if (rect.height === 0 && rect.width === 0) return
      if (rect.top >= area.top + 24 && rect.bottom <= area.bottom - 24) return
      box.scrollTop += rect.top - area.top - area.height / 2 + rect.height / 2
    }

    /** Why the last paint found nothing, sent with the report. */
    let lastMiss = ''
    /** Reports per page: enough to diagnose several sentences, not enough to spam. */
    const MISS_REPORT_LIMIT = 5
    let reportedMissCount = 0
    /** Resume offset per message so a repeated sentence still advances. */
    let highlightCursor = 0

    /**
     * Report a failed paint to the Host, together with the DOM path and the
     * surrounding markup, so a layout the highlighter cannot read leaves behind
     * evidence instead of silence. Local only: the Host writes it to a temp file.
     */
    function reportMiss(chunk, located) {
      if (reportedMissCount >= MISS_REPORT_LIMIT) return
      reportedMissCount += 1
      try {
        const anchor = actionAnchors.get(playerState.messageId)
        const element = anchor && anchor.current
        const chain = []
        let node = element
        while (node && node !== document.body && chain.length < 12) {
          const attrs = []
          for (const attribute of node.attributes || []) {
            if (/^(class|data-|role|aria-)/.test(attribute.name)) {
              attrs.push(`${attribute.name}="${String(attribute.value).slice(0, 60)}"`)
            }
          }
          chain.push(`${node.tagName.toLowerCase()} ${attrs.join(' ')}`)
          node = node.parentElement
        }
        const scope = (located && (located.flow || located.item)) || element
        void fetch('/read-aloud/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-read-aloud': '1' },
          body: JSON.stringify({
            reason: lastMiss,
            chunk: String(chunk || '').slice(0, 200),
            highlightApi: supportsHighlight(),
            path: chain,
            html: scope && scope.outerHTML ? scope.outerHTML.slice(0, 300000) : '',
          }),
        }).catch(() => {})
      } catch {
        /* reporting is best effort */
      }
    }

    /** Paint the sentence at `playerState.index`; called on every move. */
    function markSentence() {
      clearHighlight()
      lastMiss = ''
      if (!settings.highlight) {
        lastMiss = 'disabled'
        return
      }
      if (!supportsHighlight()) {
        lastMiss = 'no-highlight-api'
        return
      }
      const state = playerState
      if (!state.messageId || state.total === 0) return
      const chunk = chunkList[state.index]
      if (!chunk) {
        lastMiss = 'no-chunk'
        return
      }
      const located = replyRoots(state.messageId)
      if (!located) {
        lastMiss = 'no-anchor'
        reportMiss(chunk, null)
        return
      }
      if (highlightOwner !== state.messageId) {
        highlightOwner = state.messageId
        highlightIndex = null
        highlightCursor = 0
      }
      const needle = speechKey(chunk)
      // Widen step by step: prose rows of this turn, the same rows laxly, the
      // reply row itself, then the whole conversation.
      const sources = [
        [located.roots, true],
        [located.roots, false],
        [[located.item], false],
        [[located.flow], false],
      ]
      let span = null
      for (const [roots, strict] of sources) {
        if (!roots || roots.length === 0) continue
        highlightIndex = buildIndex(roots, strict)
        span = locateChunk(highlightIndex, needle, highlightCursor)
        if (span) break
      }
      if (!span) {
        lastMiss = 'no-match'
        reportMiss(chunk, located)
        return
      }
      const start = highlightIndex.map[span.start]
      const end = highlightIndex.map[span.end - 1]
      if (!start || !end) {
        lastMiss = 'no-range'
        reportMiss(chunk, located)
        return
      }
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset + 1)
      const registry = highlightRegistry()
      try {
        registry.set(HIGHLIGHT_NAME, new window.Highlight(range))
      } catch {
        lastMiss = 'set-failed'
        reportMiss(chunk, located)
        return
      }
      highlightCursor = span.start + 1
      revealRange(range, located.flow)
    }

    function scheduleHighlight() {
      if (highlightFrame) return
      const request = window.requestAnimationFrame || ((callback) => window.setTimeout(callback, 16))
      highlightFrame = request(() => {
        highlightFrame = 0
        markSentence()
      })
    }

    function resetHighlight() {
      highlightOwner = null
      highlightIndex = null
      clearHighlight()
    }

    /* ------------------------------------------------------------------ */
    /* System engine (Web Speech API)                                      */
    /* ------------------------------------------------------------------ */

    const synth = typeof window === 'undefined' ? undefined : window.speechSynthesis

    function listVoices() {
      if (!synth) return []
      try {
        return synth.getVoices() || []
      } catch {
        return []
      }
    }

    function useVoices() {
      const [voices, setVoices] = React.useState(listVoices)
      React.useEffect(() => {
        if (!synth) return undefined
        let alive = true
        const refresh = () => {
          if (alive) setVoices(listVoices())
        }
        refresh()
        if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', refresh)
        const timers = [window.setTimeout(refresh, 400), window.setTimeout(refresh, 1500)]
        return () => {
          alive = false
          if (typeof synth.removeEventListener === 'function') synth.removeEventListener('voiceschanged', refresh)
          for (const id of timers) window.clearTimeout(id)
        }
      }, [])
      return voices
    }

    function pickSystemVoice(voices, preferredURI) {
      if (preferredURI) {
        const chosen = voices.find((voice) => voice.voiceURI === preferredURI)
        if (chosen) return chosen
      }
      const chinese = voices.filter((voice) => /^zh([-_]|$)/i.test(voice.lang || ''))
      if (chinese.length > 0) return chinese.find((voice) => voice.default) || chinese[0]
      return voices.find((voice) => voice.default) || voices[0] || null
    }

    function runSystem(messageId, text) {
      const run = ++runId
      currentEngine = 'system'
      chunkList = chunkText(text, SYSTEM_CHUNK)
      if (chunkList.length === 0) {
        finishRun()
        return
      }
      publish({ messageId, index: 0, total: chunkList.length, paused: false })
      const voice = pickSystemVoice(listVoices(), settings.systemVoiceURI)
      const step = () => {
        systemStep = step
        if (run !== runId) return
        if (playerState.paused) {
          window.setTimeout(() => {
            if (run === runId) step()
          }, 150)
          return
        }
        const index = playerState.index
        if (index >= chunkList.length) {
          finishRun()
          return
        }
        const utterance = new SpeechSynthesisUtterance(chunkList[index])
        utterance.rate = settings.rate
        if (voice) {
          utterance.voice = voice
          utterance.lang = voice.lang
        }
        utterance.onend = () => {
          if (run !== runId) return
          publish({ index: index + 1 })
          step()
        }
        utterance.onerror = (event) => {
          if (run !== runId) return
          const reason = event && event.error
          if (reason === 'interrupted' || reason === 'canceled') return
          finishRun()
        }
        // Chromium drops a `speak()` that follows `cancel()` immediately.
        window.setTimeout(() => {
          if (run === runId && !playerState.paused) {
            try {
              synth.speak(utterance)
            } catch {
              finishRun()
            }
          }
        }, 30)
      }
      step()
    }

    /* ------------------------------------------------------------------ */
    /* Neural engine (Host route)                                          */
    /* ------------------------------------------------------------------ */

    let neuralPing = null
    let neuralBroken = false

    function pingNeural() {
      if (neuralPing) return neuralPing
      const pending = fetch('/read-aloud/ping', { headers: { 'x-dsh-read-aloud': '1' } })
        .then((response) => (response.ok ? response.json() : null))
        .then((value) => value?.ok === true)
        .catch(() => false)
        .then((ok) => {
          if (!ok) neuralPing = null
          return ok
        })
      neuralPing = pending
      return pending
    }

    function useNeuralReady() {
      const [ready, setReady] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        pingNeural().then((ok) => {
          if (alive) setReady(ok)
        })
        return () => {
          alive = false
        }
      }, [])
      return ready
    }

    /** The Host catalog, or `null` while it loads or when it is unreachable. */
    let voiceCatalog = null

    /** Dialect voices worth showing even if a stale catalog omits them. */
    const DIALECT_VOICES = ['zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural']

    function fetchCatalog() {
      // The timestamp keeps any HTTP cache from handing back a catalog fetched
      // before a dialect-aware Host was installed.
      return fetch(`/read-aloud/voices?t=${Date.now()}`, { headers: { 'x-dsh-read-aloud': '1' } })
        .then((response) => (response.ok ? response.json() : null))
        .then((value) => {
          if (!value || !Array.isArray(value.voices) || value.voices.length === 0) return null
          const list = value.voices.map((voice) => ({
            id: voice.id,
            label: VOICE_LABELS[voice.id] || `${voice.name} (${voice.id.split('-')[0]})`,
          }))
          for (const id of DIALECT_VOICES) {
            if (!list.some((voice) => voice.id === id)) list.push({ id, label: VOICE_LABELS[id] || id })
          }
          voiceCatalog = list
          return voiceCatalog
        })
        .catch(() => null)
    }

    function useVoiceCatalog() {
      const [list, setList] = React.useState(voiceCatalog)
      React.useEffect(() => {
        if (voiceCatalog) {
          setList(voiceCatalog)
          return
        }
        let alive = true
        fetchCatalog().then((value) => {
          if (alive && value) setList(value)
        })
        return () => {
          alive = false
        }
      }, [])
      return list
    }

    function getAudio() {
      if (!audioElement) {
        audioElement = new Audio()
        audioElement.preload = 'auto'
      }
      return audioElement
    }

    /**
     * Play one chunk.
     *
     * @returns {Promise<'ended' | 'stopped' | 'error'>} How playback finished.
     */
    function playBlob(blob) {
      return new Promise((resolve) => {
        const audio = getAudio()
        const url = URL.createObjectURL(blob)
        let settled = false
        const finish = (reason) => {
          if (settled) return
          settled = true
          playingFinish = null
          audio.onended = null
          audio.onerror = null
          URL.revokeObjectURL(url)
          resolve(reason)
        }
        playingFinish = finish
        audio.onended = () => finish('ended')
        audio.onerror = () => finish('error')
        audio.src = url
        audio.play().catch(() => finish('error'))
      })
    }

    function fetchAudio(text, signal) {
      const attempt = () =>
        fetch('/read-aloud/synthesize', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-read-aloud': '1' },
          body: JSON.stringify({ text, voice: settings.neuralVoice, rate: settings.rate }),
          signal,
        }).then(async (response) => {
          if (!response.ok) {
            const error = new Error(`speech request failed: ${response.status}`)
            error.status = response.status
            throw error
          }
          return await response.blob()
        })
      // A 5xx is the speech service hiccuping; one more try keeps the natural
      // voice instead of dropping straight to the robotic system one. A 4xx
      // means the route is not there, which retrying cannot fix.
      return attempt().catch((error) => {
        if (!error || !error.status || error.status < 500) throw error
        return new Promise((resolve) => setTimeout(resolve, 250)).then(attempt)
      })
    }

    function blobFor(index) {
      const cached = blobCache.get(index)
      if (cached) return cached
      const promise = fetchAudio(chunkList[index], abortController?.signal)
      blobCache.set(index, promise)
      promise.catch(() => blobCache.delete(index))
      return promise
    }

    function waitPause() {
      return new Promise((resolve) => pauseWaiters.add(resolve))
    }

    async function awaitPause(run) {
      while (run === runId && playerState.paused) {
        await waitPause()
      }
    }

    async function runNeural(messageId, text) {
      const run = ++runId
      currentEngine = 'neural'
      chunkList = chunkText(text, NEURAL_CHUNK)
      blobCache.clear()
      if (chunkList.length === 0) return
      const controller = new AbortController()
      abortController = controller
      publish({ messageId, index: 0, total: chunkList.length, paused: false })
      try {
        while (run === runId) {
          await awaitPause(run)
          if (run !== runId) return
          const index = playerState.index
          if (index < 0) {
            publish({ index: 0 })
            continue
          }
          if (index >= chunkList.length) break
          const version = seekVersion
          const blob = await blobFor(index)
          if (run !== runId) return
          if (version !== seekVersion) continue
          await awaitPause(run)
          if (run !== runId) return
          if (version !== seekVersion) continue
          // Warm the next chunk while this one plays, so the gap stays small.
          if (index + 1 < chunkList.length) blobFor(index + 1).catch(() => {})
          const reason = await playBlob(blob)
          if (run !== runId) return
          if (reason === 'stopped') continue
          if (version !== seekVersion) continue
          publish({ index: index + 1 })
        }
        if (run === runId) finishRun()
      } catch (error) {
        if (run !== runId) return
        abortController = null
        // A missing or refused route means this page never had the neural
        // engine; a transient failure only costs this one reply.
        if (error && (error.status === 403 || error.status === 404)) {
          neuralBroken = true
          neuralPing = null
        }
        finishRun()
        runSystem(messageId, text)
      }
    }

    /* ------------------------------------------------------------------ */
    /* Transport                                                           */
    /* ------------------------------------------------------------------ */

    function finishRun() {
      playingFinish = null
      abortController = null
      blobCache.clear()
      chunkList = []
      systemStep = null
      publish({ messageId: null, index: 0, total: 0, paused: false })
    }

    function stopPlayback() {
      runId += 1
      seekVersion += 1
      if (abortController) {
        try {
          abortController.abort()
        } catch {
          /* already aborted */
        }
        abortController = null
      }
      if (playingFinish) {
        const finish = playingFinish
        finish('stopped')
      }
      // Detaching the source is what actually silences a neural chunk; without
      // it the shared element keeps playing the current sentence to its end.
      if (audioElement) {
        try {
          audioElement.pause()
          audioElement.removeAttribute('src')
          audioElement.load()
        } catch {
          /* element already detached */
        }
      }
      for (const resolve of pauseWaiters) resolve()
      pauseWaiters.clear()
      if (synth) {
        try {
          synth.cancel()
        } catch {
          /* engine already gone */
        }
      }
      finishRun()
    }

    function startSpeaking(messageId, text) {
      if (!text) return
      stopPlayback()
      resetHighlight()
      if (settings.engine === 'system' || neuralBroken) {
        runSystem(messageId, text)
        return
      }
      void runNeural(messageId, text)
    }

    function togglePause() {
      if (!playerState.messageId) return
      if (playerState.paused) {
        publish({ paused: false })
        for (const resolve of pauseWaiters) resolve()
        pauseWaiters.clear()
        const audio = audioElement
        if (audio && playingFinish) audio.play().catch(() => {})
        return
      }
      publish({ paused: true })
      const audio = audioElement
      if (audio && playingFinish) {
        try {
          audio.pause()
        } catch {
          /* element already detached */
        }
      }
    }

    /** Move by whole sentences; that is the useful unit for speech. */
    function skipSentence(delta) {
      if (!playerState.messageId) return
      const total = playerState.total
      const target = Math.min(total - 1, Math.max(0, playerState.index + delta))
      seekVersion += 1
      publish({ index: target })
      if (currentEngine === 'neural') {
        if (playingFinish) playingFinish('stopped')
        return
      }
      try {
        synth?.cancel()
      } catch {
        /* engine already gone */
      }
      if (systemStep) {
        const step = systemStep
        window.setTimeout(() => {
          if (playerState.messageId && systemStep === step) step()
        }, 40)
      }
    }

    /* ------------------------------------------------------------------ */
    /* Text                                                                */
    /* ------------------------------------------------------------------ */

    /** Strip Markdown that reads badly out loud. */
    function speakable(text) {
      return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s{0,3}>\s?/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/[*_~|]/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim()
    }

    /** Split text into utterance-sized chunks. */
    function chunkText(text, limit) {
      const normalized = speakable(text)
        .replace(/\n+/g, '。')
        .replace(/([。！？!?；;])\1+/gu, '$1')
      if (!normalized) return []
      const pieces = normalized.split(/(?<=[。！？!?；;])/u).filter((piece) => piece.trim() !== '')
      const chunks = []
      let buffer = ''
      for (const piece of pieces) {
        if (piece.length > limit) {
          if (buffer) {
            chunks.push(buffer)
            buffer = ''
          }
          for (let index = 0; index < piece.length; index += limit) {
            chunks.push(piece.slice(index, index + limit))
          }
          continue
        }
        if ((buffer + piece).length > limit) {
          if (buffer) chunks.push(buffer)
          buffer = piece
        } else {
          buffer += piece
        }
      }
      if (buffer) chunks.push(buffer)
      return chunks
    }

    function textOfBlocks(blocks) {
      if (!Array.isArray(blocks)) return ''
      return blocks
        .filter((block) => block && block.kind === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim()
    }

    /** The closing snapshot of the turn whose final message is `messageId`. */
    function findClosing(snapshot, messageId) {
      if (!snapshot || !messageId) return null
      const match = (closing) =>
        closing && closing.finalNode && closing.finalNode.messageId === messageId ? closing : null
      const nodes = snapshot.nodes
      if (nodes && typeof nodes.values === 'function') {
        for (const node of nodes.values()) {
          if (!node || node.kind !== 'turn-tail') continue
          const found = match(node.data && node.data.closing)
          if (found) return found
        }
      }
      const timeline = snapshot.timeline
      if (timeline && timeline.turns && typeof timeline.turns.values === 'function') {
        for (const turn of timeline.turns.values()) {
          const tail =
            turn && turn.data && typeof turn.data.get === 'function' ? turn.data.get('turn-tail') : undefined
          const found = match(tail && tail.data && tail.data.closing)
          if (found) return found
        }
      }
      return null
    }

    function readMessageText(snapshot, messageId) {
      const closing = findClosing(snapshot, messageId)
      if (!closing) return ''
      return textOfBlocks(closing.blocks) || textOfBlocks(closing.finalNode.blocks)
    }

    /** `"seq|completedAt"`, or an empty string. A stable primitive per message. */
    function readMessageInfo(snapshot, messageId) {
      const closing = findClosing(snapshot, messageId)
      if (!closing) return ''
      const seq = Number(closing.finalNode.seq)
      const time = Number(closing.time)
      if (!Number.isFinite(seq)) return ''
      return `${seq}|${Number.isFinite(time) ? time : 0}`
    }

    /** Highest finalized sequence number in the session. */
    function readMaxSeq(snapshot) {
      if (!snapshot) return 0
      let max = 0
      const nodes = snapshot.nodes
      if (nodes && typeof nodes.values === 'function') {
        for (const node of nodes.values()) {
          if (!node || node.kind !== 'turn-tail') continue
          const seq = Number(node.data && node.data.closing && node.data.closing.finalNode && node.data.closing.finalNode.seq)
          if (Number.isFinite(seq) && seq > max) max = seq
        }
      }
      return max
    }

    /* ------------------------------------------------------------------ */
    /* Icons                                                               */
    /* ------------------------------------------------------------------ */

    function icon(paths, extra) {
      return h(
        'svg',
        Object.assign(
          {
            viewBox: '0 0 16 16',
            width: 15,
            height: 15,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          extra || {},
        ),
        paths,
      )
    }

    /**
     * The read-aloud button: four bars sharing one base height, so a bar is short
     * or tall depending on where the wave currently is rather than being fixed.
     *
     * The wave is always animating, and simply paused when nothing is playing.
     * That makes the idle shape the animation's own first frame: pressing play
     * continues the motion instead of jumping to a different look.
     */
    const WAVE_BASE = 9.6
    /**
     * Negative delays hold every bar at a different point of the same cycle, so
     * the paused frame is already a wave and the crest travels to the right.
     */
    const WAVE_DELAYS = [-0.75, -0.5, -0.25, 0]

    function WaveIcon(props) {
      const playing = Boolean(props && props.playing)
      return icon(
        WAVE_DELAYS.map((delay, index) =>
          h('rect', {
            key: index,
            className: 'dsh-ra_bar',
            x: 2.5 + index * 3,
            y: 8 - WAVE_BASE / 2,
            width: 1.93,
            height: WAVE_BASE,
            rx: 0.96,
            fill: 'currentColor',
            stroke: 'none',
            style: { animationDelay: `${delay}s` },
          }),
        ),
        { className: playing ? 'dsh-ra_wave dsh-ra_wave-live' : 'dsh-ra_wave' },
      )
    }

    function SpeakerIcon() {
      return icon([
        h('path', { key: 'a', d: 'M3 6.2h2.1L8.3 3.6v8.8L5.1 9.8H3a.6.6 0 0 1-.6-.6V6.8a.6.6 0 0 1 .6-.6Z' }),
        h('path', { key: 'b', d: 'M10.6 5.6a3.2 3.2 0 0 1 0 4.8' }),
        h('path', { key: 'c', d: 'M12.3 3.9a5.6 5.6 0 0 1 0 8.2' }),
      ])
    }

    function StopIcon() {
      return icon([h('rect', { key: 'a', x: 4.2, y: 4.2, width: 7.6, height: 7.6, rx: 1.4, fill: 'currentColor', stroke: 'none' })])
    }

    function PauseIcon() {
      return icon([
        h('rect', { key: 'a', x: 4.6, y: 3.6, width: 2.4, height: 8.8, rx: 1, fill: 'currentColor', stroke: 'none' }),
        h('rect', { key: 'b', x: 9, y: 3.6, width: 2.4, height: 8.8, rx: 1, fill: 'currentColor', stroke: 'none' }),
      ])
    }

    function PlayIcon() {
      return icon([h('path', { key: 'a', d: 'M5.6 3.9 12 8l-6.4 4.1V3.9Z', fill: 'currentColor', stroke: 'none' })])
    }

    function PrevIcon() {
      return icon([
        h('path', { key: 'a', d: 'M4.2 3.8v8.4' }),
        h('path', { key: 'b', d: 'M11.6 4.2 6.4 8l5.2 3.8V4.2Z', fill: 'currentColor', stroke: 'none' }),
      ])
    }

    function NextIcon() {
      return icon([
        h('path', { key: 'a', d: 'M11.8 3.8v8.4' }),
        h('path', { key: 'b', d: 'M4.4 4.2 9.6 8l-5.2 3.8V4.2Z', fill: 'currentColor', stroke: 'none' }),
      ])
    }

    /** Auto-read on: a plain speaker. */
    function AutoOnIcon() {
      return icon([
        h('path', { key: 'a', d: 'M3 6.2h2.1L8.3 3.6v8.8L5.1 9.8H3a.6.6 0 0 1-.6-.6V6.8a.6.6 0 0 1 .6-.6Z' }),
        h('path', { key: 'b', d: 'M10.6 5.6a3.2 3.2 0 0 1 0 4.8' }),
        h('path', { key: 'c', d: 'M12.3 3.9a5.6 5.6 0 0 1 0 8.2' }),
      ])
    }

    /** Auto-read off: the same speaker with a slash from top left to bottom right. */
    function AutoOffIcon() {
      return icon([
        h('path', { key: 'a', d: 'M3 6.2h2.1L8.3 3.6v8.8L5.1 9.8H3a.6.6 0 0 1-.6-.6V6.8a.6.6 0 0 1 .6-.6Z' }),
        h('path', { key: 'b', d: 'M10.6 5.6a3.2 3.2 0 0 1 0 4.8' }),
        h('path', { key: 'c', d: 'M12.3 3.9a5.6 5.6 0 0 1 0 8.2' }),
        h('path', { key: 'slash', d: 'M2.6 2.6 13.4 13.4', strokeWidth: 1.5 }),
      ])
    }

    /* ------------------------------------------------------------------ */
    /* Styles                                                              */
    /* ------------------------------------------------------------------ */

    const STYLES = `
.dsh-ra_group{display:inline-flex;align-items:center;gap:2px}
.dsh-ra_action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}
.dsh-ra_action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
.dsh-ra_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-ra_action[data-playing],.dsh-ra_action[data-on]{color:var(--dsw-alias-brand-primary)}
.dsh-ra_wave .dsh-ra_bar{transform-box:fill-box;transform-origin:center;animation:dsh-ra-wave 1.1s ease-in-out infinite;animation-play-state:paused}
.dsh-ra_wave-live .dsh-ra_bar{animation-play-state:running}
@keyframes dsh-ra-wave{0%,100%{transform:scaleY(.45)}50%{transform:scaleY(1)}}
@media (prefers-reduced-motion:reduce){.dsh-ra_wave-live .dsh-ra_bar{animation-play-state:paused}}
.dsh-ra_action[data-on]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.dsh-ra_action:disabled{cursor:default;opacity:.35}
.dsh-ra_action:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-ra_row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:24px;padding:16px 0;display:flex;flex-wrap:wrap}
.dsh-ra_copy{min-width:240px;flex:1}
.dsh-ra_title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dsh-ra_description{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px;max-width:460px}
.dsh-ra_controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-ra_select{box-sizing:border-box;height:32px;max-width:230px;padding:0 8px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dsh-ra_select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-ra_rate{width:88px}
.dsh-ra_button{box-sizing:border-box;height:32px;padding:0 12px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.dsh-ra_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ra_button:disabled{cursor:default;opacity:.4}
.dsh-ra_button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-ra_mini{height:26px;padding:0 8px;font-size:12px}
.dsh-ra_mini[data-on]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsh-ra_color{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 8px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsh-ra_color input{width:24px;height:20px;padding:0;border:none;background:0 0;cursor:pointer}
.dsh-ra_slider{gap:8px}
.dsh-ra_slider input[type=range]{width:96px;height:20px;padding:0;border:none;background:0 0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary)}
.dsh-ra_value{min-width:34px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
::highlight(dsh-read-aloud-current){background-color:var(--dsh-ra-hl-bg,rgba(59,130,246,.26));color:var(--dsh-ra-hl-fg,inherit)}
`

    /* ------------------------------------------------------------------ */
    /* Components                                                          */
    /* ------------------------------------------------------------------ */

    function actionButton(key, label, active, disabled, onClick, content, extra) {
      return h(
        'button',
        Object.assign(
          {
            key,
            type: 'button',
            className: 'dsh-ra_action',
            'aria-label': label,
            title: label,
            disabled: disabled || undefined,
            'data-playing': active || undefined,
            onClick,
          },
          extra || {},
        ),
        content,
      )
    }

    function ReadAloudAction(props) {
      const messageId = props.messageId
      const useChat = props.useChat
      const t = props.t || ((key) => key)
      const text = useChat ? useChat((snapshot) => readMessageText(snapshot, messageId)) : ''
      const info = useChat ? useChat((snapshot) => readMessageInfo(snapshot, messageId)) : ''
      const maxSeq = useChat ? useChat((snapshot) => readMaxSeq(snapshot)) : 0
      const audioState = usePlayer()
      const current = useSettings()
      const systemVoices = useVoices()
      const neuralReady = useNeuralReady()
      const playable = neuralReady === true || systemVoices.length > 0
      const active = audioState.messageId === messageId

      // The action row is rendered inside this reply's turn tail, which makes
      // it the handle that finds the reply's prose in the DOM.
      const anchorRef = React.useRef(null)
      React.useEffect(() => {
        actionAnchors.set(messageId, anchorRef)
        return () => {
          if (actionAnchors.get(messageId) === anchorRef) actionAnchors.delete(messageId)
        }
      }, [messageId])

      // Auto-read: only a reply that just finished, in the newest turn, and
      // never one that existed before auto-read was switched on.
      React.useEffect(() => {
        if (!current.autoRead || !text || !info || !playable) return
        const [seqText, timeText] = info.split('|')
        const seq = Number(seqText)
        const completedAt = Number(timeText)
        if (!Number.isFinite(seq) || seq !== maxSeq || maxSeq === 0) return
        if (completedAt > 0 && Date.now() - completedAt > AUTO_READ_WINDOW) return
        if (completedAt > 0 && completedAt < autoReadSince) return
        if (autoSpoken.has(messageId)) return
        autoSpoken.add(messageId)
        startSpeaking(messageId, text)
      }, [current.autoRead, text, info, maxSeq, messageId, playable])

      if (!text) return null

      const autoLabel = current.autoRead ? t('action.auto.on') : t('action.auto.off')
      const autoToggle = actionButton(
        'auto',
        autoLabel,
        false,
        false,
        () => {
          const next = !current.autoRead
          if (next) autoReadSince = Date.now()
          setSettings({ autoRead: next })
        },
        current.autoRead ? h(AutoOnIcon) : h(AutoOffIcon),
        { 'data-on': current.autoRead || undefined, 'aria-pressed': current.autoRead, className: 'dsh-ra_action' },
      )

      if (!active) {
        const label = playable ? t('action.play') : t('action.unsupported')
        return h('span', { className: 'dsh-ra_group', ref: anchorRef }, [
          actionButton('play', label, false, !playable, () => startSpeaking(messageId, text), h(WaveIcon)),
          autoToggle,
        ])
      }

      const atStart = audioState.index <= 0
      const atEnd = audioState.index >= audioState.total - 1
      return h('span', { className: 'dsh-ra_group', ref: anchorRef }, [
        actionButton('prev', t('action.prev'), false, atStart, () => skipSentence(-1), h(PrevIcon)),
        actionButton(
          'pause',
          audioState.paused ? t('action.resume') : t('action.pause'),
          true,
          false,
          togglePause,
          audioState.paused ? h(PlayIcon) : h(WaveIcon, { playing: true }),
        ),
        actionButton('next', t('action.next'), false, atEnd, () => skipSentence(1), h(NextIcon)),
        actionButton('stop', t('action.stop'), false, false, stopPlayback, h(StopIcon)),
        autoToggle,
      ])
    }

    function ReadAloudSettingsRow(props) {
      const t = props.t || ((key) => key)
      const current = useSettings()
      const systemVoices = useVoices()
      const neuralReady = useNeuralReady()
      const catalog = useVoiceCatalog()
      const [busy, setBusy] = React.useState(false)

      const neural = current.engine !== 'system'
      const voices = catalog && catalog.length > 0 ? catalog : FALLBACK_VOICES
      const voiceOptions = neural
        ? voices.map((voice) => h('option', { key: voice.id, value: voice.id }, voice.label))
        : [h('option', { key: '__auto', value: '' }, t('settings.default'))].concat(
            systemVoices.map((voice) =>
              h('option', { key: voice.voiceURI, value: voice.voiceURI }, `${voice.name} (${voice.lang})`),
            ),
          )
      const voiceValue = neural ? current.neuralVoice : current.systemVoiceURI
      const description = neural
        ? neuralReady === false
          ? t('settings.neuralOffline')
          : t('settings.description')
        : systemVoices.length === 0
          ? t('settings.noVoices')
          : t('settings.description')

      const preview = () => {
        setBusy(true)
        startSpeaking('__preview__', t('settings.previewText'))
        window.setTimeout(() => setBusy(false), 700)
      }

      return h('div', { className: 'dsh-ra_row' }, [
        h('div', { className: 'dsh-ra_copy', key: 'copy' }, [
          h('div', { className: 'dsh-ra_title', key: 'title' }, t('settings.title')),
          h('div', { className: 'dsh-ra_description', key: 'description' }, description),
        ]),
        h('div', { className: 'dsh-ra_controls', key: 'controls' }, [
          h(
            'select',
            {
              key: 'engine',
              className: 'dsh-ra_select',
              'aria-label': t('settings.engine'),
              value: current.engine,
              onChange: (event) => {
                stopPlayback()
                setSettings({ engine: event.target.value === 'system' ? 'system' : 'neural' })
              },
            },
            [
              h('option', { key: 'neural', value: 'neural' }, t('settings.engine.neural')),
              h('option', { key: 'system', value: 'system' }, t('settings.engine.system')),
            ],
          ),
          h(
            'select',
            {
              key: 'voice',
              className: 'dsh-ra_select',
              'aria-label': t('settings.voice'),
              value: voiceValue,
              onChange: (event) => {
                stopPlayback()
                setSettings(neural ? { neuralVoice: event.target.value } : { systemVoiceURI: event.target.value })
              },
            },
            voiceOptions,
          ),
          h(
            'select',
            {
              key: 'rate',
              className: 'dsh-ra_select dsh-ra_rate',
              'aria-label': t('settings.rate'),
              value: String(current.rate),
              onChange: (event) => {
                stopPlayback()
                setSettings({ rate: Number(event.target.value) })
              },
            },
            [0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => h('option', { key: rate, value: String(rate) }, `${rate}x`)),
          ),
          h(
            'label',
            { key: 'hlbg', className: 'dsh-ra_color', title: t('settings.highlightBackground') },
            [
              h('span', { key: 'label' }, t('settings.highlightBackground')),
              h('input', {
                key: 'input',
                type: 'color',
                value: current.highlightBackground,
                'aria-label': t('settings.highlightBackground'),
                onChange: (event) => setSettings({ highlightBackground: event.target.value }),
              }),
            ],
          ),
          h(
            'label',
            { key: 'hlfg', className: 'dsh-ra_color', title: t('settings.highlightText') },
            [
              h('span', { key: 'label' }, t('settings.highlightText')),
              h('input', {
                key: 'input',
                type: 'color',
                value: current.highlightText || '#ffffff',
                'aria-label': t('settings.highlightText'),
                onChange: (event) => setSettings({ highlightText: event.target.value }),
              }),
              h(
                'button',
                {
                  key: 'auto',
                  type: 'button',
                  className: 'dsh-ra_button dsh-ra_mini',
                  'aria-pressed': !current.highlightText,
                  'data-on': !current.highlightText || undefined,
                  title: t('settings.highlightTextAuto'),
                  onClick: () => setSettings({ highlightText: current.highlightText ? '' : '#ffffff' }),
                },
                t('settings.highlightTextAuto'),
              ),
            ],
          ),
          h(
            'label',
            { key: 'hlalpha', className: 'dsh-ra_color dsh-ra_slider', title: t('settings.highlightAlpha') },
            [
              h('span', { key: 'label' }, t('settings.highlightAlpha')),
              h('input', {
                key: 'input',
                type: 'range',
                min: 5,
                max: 100,
                step: 5,
                value: String(Math.round(current.highlightAlpha * 100)),
                'aria-label': t('settings.highlightAlpha'),
                onChange: (event) => setSettings({ highlightAlpha: Number(event.target.value) / 100 }),
              }),
              h('span', { key: 'value', className: 'dsh-ra_value' }, `${Math.round(current.highlightAlpha * 100)}%`),
            ],
          ),
          h(
            'button',
            {
              key: 'reset',
              type: 'button',
              className: 'dsh-ra_button',
              title: t('settings.highlightReset'),
              onClick: () =>
                setSettings({
                  highlightBackground: DEFAULTS.highlightBackground,
                  highlightText: DEFAULTS.highlightText,
                  highlightAlpha: DEFAULTS.highlightAlpha,
                }),
            },
            t('settings.highlightReset'),
          ),
          h(
            'button',
            { key: 'preview', type: 'button', className: 'dsh-ra_button', disabled: busy, onClick: preview },
            busy ? t('settings.previewing') : t('settings.preview'),
          ),
        ]),
      ])
    }

    /* ------------------------------------------------------------------ */
    /* Plugin                                                              */
    /* ------------------------------------------------------------------ */

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'read-aloud: dictionaries')

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = '@local/dsh-read-aloud'
        tag.dataset.pluginCss = '@local/dsh-read-aloud/read-aloud.css'
        tag.textContent = STYLES
        document.head.appendChild(tag)
        applyHighlightColors()
        return () => {
          stopPlayback()
          clearHighlightColors()
          tag.remove()
        }
      }, 'read-aloud: stylesheet and playback teardown')

      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          { name: 'conversation.chat.assistant-actions', id: 'read-aloud', order: 5, locale: NS },
          ReadAloudAction,
        ),
      )

      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          { name: 'settings.general.item', id: 'read-aloud-voice', order: 21, locale: NS },
          ReadAloudSettingsRow,
        ),
      )
    }

    // Test hook: only attached when a harness opts in before evaluation.
    if (typeof globalThis !== 'undefined' && globalThis.__DSH_READ_ALOUD_TEST__ === true) {
      return {
        inject,
        apply,
        __test: {
          speechKey,
          locateChunk,
          flatten,
          replyRoots,
          markSentence,
          miss: () => lastMiss,
          chunks: () => chunkList.slice(),
          anchors: () => [...actionAnchors.keys()],
          state: () => playerState,
        },
      }
    }
    return { inject, apply }
  },
})
