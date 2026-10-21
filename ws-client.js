/**
 * Minimal RFC 6455 WebSocket client.
 *
 * Only what the speech handshake needs: one text/binary frame stream over TLS,
 * client-side masking, fragmentation reassembly, ping/pong and close. There is
 * deliberately no dependency, because a Host bundle that fails to import takes
 * the whole feature down with it.
 */
import { createHash, randomBytes } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

function encodeFrame(payload, opcode) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  const mask = randomBytes(4)
  const masked = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index & 3]
  return Buffer.concat([header, mask, masked])
}

/**
 * Open one WebSocket.
 *
 * @param {string} target `ws:`/`wss:` URL including its query string.
 * @param {Record<string, string>} extraHeaders Additional handshake headers.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ send(text: string): void, close(): void, onMessage(fn: (message: { data: Buffer, isText: boolean }) => void): void, onClose(fn: () => void): void, onError(fn: (error: Error) => void): void }>}
 */
export function connectWebSocket(target, extraHeaders = {}, options = {}) {
  const url = new URL(target)
  const secure = url.protocol === 'wss:'
  const port = Number(url.port || (secure ? 443 : 80))
  const handshakeKey = randomBytes(16).toString('base64')
  const expectedAccept = createHash('sha1').update(handshakeKey + GUID).digest('base64')
  const requestPath = `${url.pathname}${url.search}`

  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host: url.hostname, port, servername: url.hostname })
      : net.connect({ host: url.hostname, port })

    const listeners = { message: [], close: [], error: [] }
    const emit = (name, value) => {
      for (const listener of listeners[name]) listener(value)
    }

    let upgraded = false
    let settled = false
    let pending = Buffer.alloc(0)
    let fragments = []
    let fragmentOpcode = OPCODE.TEXT

    const fail = (error) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* already closed */
      }
      reject(error)
    }

    const api = {
      send(text) {
        if (!upgraded) return
        socket.write(encodeFrame(Buffer.from(text, 'utf8'), OPCODE.TEXT))
      },
      close() {
        if (upgraded) {
          try {
            socket.write(encodeFrame(Buffer.alloc(0), OPCODE.CLOSE))
          } catch {
            /* peer already gone */
          }
        }
        socket.end()
      },
      onMessage(listener) {
        listeners.message.push(listener)
      },
      onClose(listener) {
        listeners.close.push(listener)
      },
      onError(listener) {
        listeners.error.push(listener)
      },
    }

    const handleFrame = (fin, opcode, payload) => {
      if (opcode === OPCODE.PING) {
        socket.write(encodeFrame(payload, OPCODE.PONG))
        return
      }
      if (opcode === OPCODE.PONG) return
      if (opcode === OPCODE.CLOSE) {
        api.close()
        return
      }
      if (opcode === OPCODE.CONTINUATION) {
        fragments.push(payload)
      } else {
        fragments = [payload]
        fragmentOpcode = opcode
      }
      if (!fin) return
      const data = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments)
      fragments = []
      emit('message', { data, isText: fragmentOpcode === OPCODE.TEXT })
    }

    const drain = () => {
      while (pending.length >= 2) {
        const first = pending[0]
        const second = pending[1]
        let length = second & 0x7f
        let offset = 2
        if (length === 126) {
          if (pending.length < 4) return
          length = pending.readUInt16BE(2)
          offset = 4
        } else if (length === 127) {
          if (pending.length < 10) return
          length = Number(pending.readBigUInt64BE(2))
          offset = 10
        }
        const masked = (second & 0x80) !== 0
        if (masked) {
          if (pending.length < offset + 4) return
          offset += 4
        }
        if (pending.length < offset + length) return
        let payload = pending.subarray(offset, offset + length)
        if (masked) {
          const mask = pending.subarray(offset - 4, offset)
          const unmasked = Buffer.alloc(length)
          for (let index = 0; index < length; index += 1) unmasked[index] = payload[index] ^ mask[index & 3]
          payload = unmasked
        }
        pending = pending.subarray(offset + length)
        handleFrame((first & 0x80) !== 0, first & 0x0f, payload)
      }
    }

    const upgradeTimer = setTimeout(() => fail(new Error('websocket handshake timed out')), options.timeoutMs ?? 15000)

    socket.on('error', (error) => {
      if (!settled) {
        fail(error)
        return
      }
      emit('error', error)
    })

    socket.on('close', () => {
      clearTimeout(upgradeTimer)
      if (!settled) {
        fail(new Error('websocket closed during handshake'))
        return
      }
      emit('close')
    })

    if (!secure) {
      socket.on('connect', () => {
        socket.write(handshake(key, url, port, requestPath, extraHeaders))
      })
    } else {
      socket.on('secureConnect', () => {
        socket.write(handshake(handshakeKey, url, port, requestPath, extraHeaders))
      })
    }

    socket.on('data', (chunk) => {
      if (!upgraded) {
        pending = Buffer.concat([pending, chunk])
        const end = pending.indexOf('\r\n\r\n')
        if (end === -1) return
        const head = pending.subarray(0, end).toString('latin1')
        pending = pending.subarray(end + 4)
        if (!/^HTTP\/1\.1 101/i.test(head)) {
          const status = Number(/^HTTP\/1\.1 (\d{3})/i.exec(head)?.[1])
          const date = /(?:^|\r\n)date:\s*([^\r\n]+)/i.exec(head)?.[1]
          const error = new Error(`websocket upgrade rejected: ${head.split('\r\n')[0]}`)
          error.statusCode = status
          error.serverDate = date
          fail(error)
          return
        }
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)
        if (!accept || accept[1] !== expectedAccept) {
          fail(new Error('websocket upgrade returned a bad accept key'))
          return
        }
        upgraded = true
        settled = true
        clearTimeout(upgradeTimer)
        resolve(api)
        if (pending.length > 0) drain()
        return
      }
      pending = Buffer.concat([pending, chunk])
      drain()
    })
  })
}

function handshake(key, url, port, requestPath, extraHeaders) {
  const lines = [
    `GET ${requestPath} HTTP/1.1`,
    `Host: ${url.hostname}:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ]
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value !== undefined && value !== null) lines.push(`${name}: ${value}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}
