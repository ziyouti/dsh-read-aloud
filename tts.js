/**
 * Neural text-to-speech engine (Microsoft Edge read-aloud voices).
 *
 * Talks to the same public endpoint the Edge browser uses for "Read aloud",
 * which needs no account or key. One connection serves one request; the caller
 * supplies the text, the voice name and a rate.
 *
 * Protocol notes:
 *  - the handshake carries `Sec-MS-GEC`, a SHA-256 of a 5-minute-rounded
 *    Windows file-time plus the public client token;
 *  - messages are `header\r\n\r\nbody` text frames plus binary audio frames
 *    whose payload follows the `Path:audio\r\n` marker;
 *  - `Path:turn.end` closes one synthesis.
 */
import { createHash, randomBytes } from 'node:crypto'
import { connectWebSocket } from './ws-client.js'

const CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WSS_URL = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1'
const GEC_VERSION = '1-143.0.3650.96'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
const AUDIO_DELIM = 'Path:audio\r\n'

/** Server clock minus local clock, learned from one rejected handshake. */
let clockOffsetMs = 0

function connectionId() {
  return randomBytes(16).toString('hex')
}

function requestId() {
  return randomBytes(16).toString('hex')
}

function secMsGec() {
  const seconds = Math.floor((Date.now() + clockOffsetMs) / 1000) + 11644473600
  const rounded = seconds - (seconds % 300)
  const ticks = rounded * 10000000
  return createHash('sha256')
    .update(`${ticks}${CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase()
}

function buildUrl() {
  return `${WSS_URL}?Ocp-Apim-Subscription-Key=${CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${connectionId()}`
}

/** Escape the five XML entities so arbitrary reply text cannot break the SSML. */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Map a 0.5–2.0 multiplier onto SSML's percentage form. */
function ratePercent(rate) {
  const value = Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1
  return `${value >= 1 ? '+' : ''}${Math.round((value - 1) * 100)}%`
}

function ssmlFor(text, voice, rate) {
  const language = /^([a-z]{2,3}-[A-Z]{2,4})/i.exec(voice)?.[1] ?? 'zh-CN'
  return [
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${language}">`,
    `<voice name="${voice}"><prosody pitch="+0Hz" rate="${ratePercent(rate)}" volume="+0%">`,
    escapeXml(text),
    '</prosody></voice></speak>',
  ].join('')
}

/**
 * Synthesize one text fragment.
 *
 * @param {{ text: string, voice?: string, rate?: number, timeoutMs?: number }} request
 * @returns {Promise<Buffer>} MP3 bytes.
 */
export function synthesize(request) {
  const text = String(request.text ?? '').trim()
  if (!text) return Promise.reject(new Error('nothing to speak'))
  const voice = request.voice || 'zh-CN-XiaoxiaoNeural'
  const timeoutMs = request.timeoutMs ?? 30000

  return new Promise((resolve, reject) => {
    const chunks = []
    let settled = false
    let socket = null

    const settle = (error, audio) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (socket) {
        try {
          socket.close()
        } catch {
          /* already gone */
        }
      }
      if (error) reject(error)
      else resolve(audio)
    }

    const timer = setTimeout(() => settle(new Error('speech synthesis timed out')), timeoutMs)

    connectWebSocket(buildUrl(), { 'User-Agent': USER_AGENT, Origin: ORIGIN }, { timeoutMs: 15000 })
      .then((connection) => {
        socket = connection
        if (settled) {
          connection.close()
          return
        }
        connection.onMessage(({ data, isText }) => {
          if (settled) return
          if (isText) {
            if (data.includes('Path:turn.end')) {
              const audio = Buffer.concat(chunks)
              if (audio.length === 0) settle(new Error('speech service returned no audio'))
              else settle(null, audio)
            }
            return
          }
          const marker = data.indexOf(AUDIO_DELIM)
          if (marker === -1) return
          chunks.push(data.subarray(marker + AUDIO_DELIM.length))
        })
        connection.onError((error) => settle(error))
        connection.onClose(() => {
          if (!settled) settle(new Error('speech connection closed before the audio finished'))
        })
        connection.send(
          'Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
            '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}',
        )
        connection.send(
          `X-RequestId:${requestId()}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n` +
            ssmlFor(text, voice, request.rate),
        )
      })
      .catch((error) => {
        const serverTime =
          error && error.statusCode === 403 && typeof error.serverDate === 'string'
            ? Date.parse(error.serverDate)
            : NaN
        if (Number.isFinite(serverTime)) {
          // The handshake clock check failed; remember the offset for the retry.
          clockOffsetMs = serverTime - Date.now()
          settle(Object.assign(new Error('speech service rejected the handshake'), { code: 'clock' }))
          return
        }
        settle(error instanceof Error ? error : new Error(String(error)))
      })
  })
}

/**
 * Synthesize, retrying after a rejected clock handshake and after transient
 * handshake failures. The first connection of a process often fails the clock
 * check, so one retry is normal rather than exceptional.
 *
 * @param {{ text: string, voice?: string, rate?: number, timeoutMs?: number, attempts?: number }} request
 * @returns {Promise<Buffer>} MP3 bytes.
 */
export async function synthesizeWithRetry(request) {
  const attempts = request.attempts ?? 3
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await synthesize(request)
    } catch (error) {
      lastError = error
      // A synthesized-but-empty answer or a timeout will not improve on retry.
      if (error && (error.message === 'speech synthesis timed out' || error.message === 'nothing to speak')) break
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
