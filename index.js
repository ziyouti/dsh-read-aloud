/**
 * Host half of the read-aloud bundle.
 *
 * Serves two things to the browser over local routes: the neural voice catalog
 * (so the picker can never offer a voice that does not exist) and MP3 synthesis.
 * Synthesis runs here rather than in the page because the Edge read-aloud
 * handshake needs headers a browser refuses to set on a WebSocket.
 */
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { synthesizeWithRetry } from './tts.js'

/** Route prefix owned by this plugin. */
const ROUTE = '/read-aloud'
/** Largest synthesis request body accepted, in bytes. */
const MAX_BODY = 32 * 1024
/** Largest highlight diagnosis accepted, in bytes. */
const MAX_REPORT = 1024 * 1024
/** Cached MP3s kept for instant replays. */
const CACHE_LIMIT = 40
/** The Edge voice catalog, which needs no key. */
const VOICES_URL =
  'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const CATALOG_TTL = 24 * 60 * 60 * 1000
/** Locale groups offered in the picker, in display order. */
const LOCALE_GROUPS = ['zh-CN', 'zh-HK', 'zh-TW', 'en-US', 'en-GB']

/** Insertion-ordered cache so the oldest entry is evicted first. */
const cache = new Map()
/** `{ at, list }` for the voice catalog. */
let catalog = { at: 0, list: null }

function remember(key, audio) {
  cache.set(key, audio)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      parts.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    request.on('error', reject)
  })
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * Only the page served by this Host may call the routes. A custom header makes
 * cross-site calls preflight, and no CORS headers are ever sent, so another
 * origin cannot reach them.
 */
function sameOrigin(request) {
  if (request.headers['x-dsh-read-aloud'] === undefined) return false
  const host = String(request.headers.host ?? '')
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
}

/** One HTTPS GET, resolved as text. */
function getText(target) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      target,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`voice catalog responded ${response.statusCode}`))
          return
        }
        const parts = []
        response.on('data', (chunk) => parts.push(chunk))
        response.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
      },
    )
    request.setTimeout(15000, () => request.destroy(new Error('voice catalog timed out')))
    request.on('error', reject)
  })
}

/** Fetch and normalize the voice catalog, filtered to the offered locales. */
async function loadCatalog() {
  if (catalog.list && Date.now() - catalog.at < CATALOG_TTL) return catalog.list
  const raw = await getText(VOICES_URL)
  const parsed = JSON.parse(raw)
  const list = []
  for (const group of LOCALE_GROUPS) {
    // Regional variants report their own locale (`zh-CN-liaoning`, `zh-CN-shaanxi`),
    // so an exact match would silently drop every dialect voice.
    const inGroup = parsed
      .filter((voice) => {
        const locale = String(voice.Locale ?? '')
        return locale === group || locale.startsWith(`${group}-`)
      })
      .map((voice) => ({
        id: voice.ShortName,
        locale: voice.Locale,
        gender: voice.Gender === 'Male' ? 'm' : 'f',
        name: String(voice.ShortName).slice(String(voice.Locale).length + 1).replace(/Neural$/, ''),
        // Standard accent first, then the regional variants.
        rank: voice.Locale === group ? 0 : 1,
      }))
      .sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name))
      .map((voice) => ({ id: voice.id, locale: voice.locale, gender: voice.gender, name: voice.name }))
    list.push(...inGroup)
  }
  catalog = { at: Date.now(), list }
  return list
}

async function handleSynthesize(request, response) {
  let payload
  try {
    payload = JSON.parse(await readBody(request, MAX_BODY))
  } catch {
    json(response, 400, { error: 'bad request' })
    return
  }
  const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
  if (!text) {
    json(response, 400, { error: 'empty text' })
    return
  }
  const voice = typeof payload.voice === 'string' && payload.voice ? payload.voice : 'zh-CN-XiaoxiaoNeural'
  const rate = Number.isFinite(payload.rate) ? Math.min(2, Math.max(0.5, payload.rate)) : 1
  const key = `${voice}|${rate}|${text}`
  const cached = cache.get(key)
  if (cached !== undefined) {
    response.writeHead(200, {
      'content-type': 'audio/mpeg',
      'content-length': cached.length,
      'cache-control': 'no-store',
    })
    response.end(cached)
    return
  }
  try {
    const audio = await synthesizeWithRetry({ text, voice, rate })
    remember(key, audio)
    response.writeHead(200, {
      'content-type': 'audio/mpeg',
      'content-length': audio.length,
      'cache-control': 'no-store',
    })
    response.end(audio)
  } catch (error) {
    const detail = String(error?.message ?? error)
    // Keep the failure around: the first request after a reload has failed
    // intermittently and a 502 alone says nothing about why.
    try {
      fs.appendFileSync(
        path.join(os.tmpdir(), 'dsh-read-aloud-error.log'),
        `${new Date().toISOString()}\t${voice}\t${rate}\t${text.slice(0, 40)}\t${detail}\t${error?.stack ?? ''}\n`,
        'utf8',
      )
    } catch {
      /* logging is best effort */
    }
    json(response, 502, { error: 'synthesis failed', detail })
  }
}

/**
 * Record one highlight failure. The page sends the DOM path and the markup it
 * could not read, which is the only way to see a layout that the highlighter
 * cannot locate from outside the browser. The file stays on this machine.
 */
async function handleReport(request, response) {
  let payload
  try {
    payload = JSON.parse(await readBody(request, MAX_REPORT))
  } catch {
    json(response, 400, { error: 'bad request' })
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(os.tmpdir(), `dsh-read-aloud-report-${stamp}.json`)
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
    json(response, 200, { ok: true, file })
  } catch (error) {
    json(response, 500, { error: 'cannot write report', detail: String(error?.message ?? error) })
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (ctx) => {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler: (request, response) => {
            if (!sameOrigin(request)) {
              json(response, 403, { error: 'forbidden' })
              return
            }
            const path = String(request.url ?? '').split('?')[0]
            if (path === `${ROUTE}/ping`) {
              json(response, 200, { ok: true, engine: 'edge-neural' })
              return
            }
            if (path === `${ROUTE}/voices`) {
              loadCatalog().then(
                (list) => json(response, 200, { voices: list }),
                (error) => json(response, 502, { error: 'catalog unavailable', detail: String(error?.message ?? error) }),
              )
              return
            }
            if (path === `${ROUTE}/synthesize` && request.method === 'POST') {
              void handleSynthesize(request, response)
              return
            }
            if (path === `${ROUTE}/report` && request.method === 'POST') {
              void handleReport(request, response)
              return
            }
            json(response, 404, { error: 'not found' })
          },
        }),
      'read-aloud: speech routes',
    )
  })
}
