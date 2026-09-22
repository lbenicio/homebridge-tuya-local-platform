import dgram from 'dgram'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import net from 'net'
import type { Logger } from 'homebridge'
import type { DiscoveredDevice } from '../types'

const UDP_KEY = Buffer.from('6c1ec8e2bb9bb59ab50b0daf649b410a', 'hex')

interface DiscoveryOptions {
  log: Logger
  ids?: string[]
  clear?: boolean
}

class TuyaDiscovery extends EventEmitter {
  discovered: Map<string, string> = new Map()
  limitedIds: string[] = []
  log!: Logger

  private _servers: Record<number, dgram.Socket | null> = {}
  private _running = false
  private _lastDiagnosticAt = 0

  constructor() {
    super()
  }

  start(props: DiscoveryOptions): this {
    this.log = props.log
    this._lastDiagnosticAt = 0

    if (props.clear) {
      this.removeAllListeners()
      this.discovered.clear()
    }

    this.limitedIds.splice(0)
    if (Array.isArray(props.ids)) [].push.apply(this.limitedIds, props.ids)

    this._running = true
    this._start(6666)
    this._start(6667)

    return this
  }

  stop(): this {
    this._running = false
    this._stop(6666)
    this._stop(6667)

    return this
  }

  end(): this {
    this.stop()
    process.nextTick(() => {
      this.removeAllListeners()
      this.discovered.clear()
      this.log.info('Discovery ended.')
      this.emit('end')
    })

    return this
  }

  private _start(port: number): void {
    this._stop(port)

    const server = (this._servers[port] = dgram.createSocket({ type: 'udp4', reuseAddr: true }))
    server.on('error', this._onDgramError.bind(this, port))
    server.on('close', this._onDgramClose.bind(this, port))
    server.on('message', this._onDgramMessage.bind(this, port))

    server.bind(port, () => {
      this.log.info(`Discovery - Discovery started on port ${port}.`)
    })
  }

  private _stop(port: number): void {
    if (this._servers[port]) {
      this._servers[port]!.removeAllListeners()
      this._servers[port]!.close()
      this._servers[port] = null
    }
  }

  private _onDgramError(port: number, err: NodeJS.ErrnoException): void {
    this._stop(port)

    if (err && err.code === 'EADDRINUSE') {
      this.log.warn(`Discovery - Port ${port} is in use. Will retry in 15 seconds.`)

      setTimeout(() => {
        this._start(port)
      }, 15000)
    } else {
      this.log.error(`Discovery - Port ${port} failed:\n${err.stack}`)
    }
  }

  private _onDgramClose(port: number): void {
    this._stop(port)

    this.log.info(`Discovery - Port ${port} closed.${this._running ? ' Restarting...' : ''}`)
    if (this._running)
      setTimeout(() => {
        this._start(port)
      }, 1000)
  }

  private _onDgramMessage(port: number, msg: Buffer, info: dgram.RemoteInfo): void {
    const len = msg.length
    if (len < 16 || msg.readUInt32BE(0) !== 0x000055aa || msg.readUInt32BE(len - 4) !== 0x0000aa55) {
      this._logDiagnostic(`Discovery - Ignoring invalid UDP packet on port ${port} with length ${len}.`)
      return
    }

    const size = msg.readUInt32BE(12)
    if (size < 12 || size > len - 8) {
      this._logDiagnostic(`Discovery - Ignoring invalid UDP packet on port ${port} with payload size ${size}.`)
      return
    }

    const cleanMsg = msg.slice(len - size + 4, len - 8)

    let decryptedMsg: string | undefined
    if (port === 6667) {
      try {
        const decipher = crypto.createDecipheriv('aes-128-ecb', UDP_KEY, '')
        decryptedMsg = decipher.update(cleanMsg, undefined, 'utf8')
        decryptedMsg += decipher.final('utf8')
      } catch (_ex) {
        // Encrypted broadcast could not be decrypted — device may already
        // have been discovered on port 6666.  Silently ignore.
        return
      }
    }

    if (!decryptedMsg) decryptedMsg = cleanMsg.toString('utf8')

    try {
      const result = JSON.parse(decryptedMsg) as Record<string, unknown>
      const gwId = typeof result?.gwId === 'string' ? result.gwId : undefined
      const payloadIp = typeof result?.ip === 'string' ? result.ip : undefined
      if (!gwId || !payloadIp || net.isIP(payloadIp) !== 4 || payloadIp !== info.address) {
        this._logDiagnostic(`Discovery - Ignoring untrusted UDP response on port ${port}.`)
        return
      }
      if (this.limitedIds.length && !this.limitedIds.includes(gwId)) return

      const version =
        typeof result.version === 'string' && /^3\.(1|3|4|5)$/.test(result.version) ? result.version : undefined
      this._onDiscover({ id: gwId, ip: info.address, ...(version ? { version } : {}) })
    } catch (_ex) {
      this._logDiagnostic(`Discovery - Failed to parse discovery response on port ${port}.`)
    }
  }

  private _onDiscover(data: DiscoveredDevice): void {
    if (this.discovered.has(data.id)) return

    this.discovered.set(data.id, data.ip)

    this.emit('discover', data)

    if (
      this.limitedIds.length &&
      this.limitedIds.includes(data.id) &&
      this.limitedIds.length <= this.discovered.size &&
      this.limitedIds.every((id) => this.discovered.has(id))
    ) {
      process.nextTick(() => {
        this.end()
      })
    }
  }

  private _logDiagnostic(message: string): void {
    const now = Date.now()
    if (now - this._lastDiagnosticAt < 1000) return
    this._lastDiagnosticAt = now
    this.log.error(message)
  }
}

export default new TuyaDiscovery()
