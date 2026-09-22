import net from 'net'
import async from 'async'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import type { Logger } from 'homebridge'
import type { DPSState, DPSValue, TuyaDeviceContext } from '../types'

const isNonEmptyPlainObject = (o: unknown): o is Record<string, unknown> => {
  if (!o || typeof o !== 'object') return false
  for (const _i in o) return true
  return false
}

const formatOutage = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

const OUTAGE_FAILURE_THRESHOLD = 2

interface TuyaSocket extends net.Socket {
  _pinger?: ReturnType<typeof setTimeout> | null
  _connTimeout?: ReturnType<typeof setTimeout> | null
  _errorReconnect?: ReturnType<typeof setTimeout> | null
  reconnect: () => void
  _ping: () => void
}

interface MessageTask {
  msg: Buffer
}

interface SendPayload {
  cmd: number
  data?: Buffer | Record<string, unknown> | string
  encrypted?: boolean
}

class TuyaAccessory extends EventEmitter {
  log!: Logger
  context!: TuyaDeviceContext & {
    port: number
    pingGap?: number
    pingTimeout?: number
    connectTimeout?: number
    intro?: boolean
    sendEmptyUpdate?: boolean
    fake?: boolean
  }
  state: DPSState = {}
  connected = false

  private _cachedBuffer: Buffer = Buffer.allocUnsafe(0)
  private _msgQueue!: async.QueueObject<MessageTask>
  private _socket!: TuyaSocket
  private _connectionAttempts = 0
  private _unreachableSince: number | null = null
  private _consecutiveFailures = 0
  private _outageReported = false
  private _sendCounter = 0
  private _tmpLocalKey: Buffer | null = null
  private _tmpRemoteKey: Buffer | null = null
  private _parent: TuyaAccessory | null = null
  private _children = new Map<string, TuyaAccessory>()
  session_key: Buffer | null = null

  constructor(
    props: Partial<TuyaDeviceContext> & {
      log: Logger
      fake?: boolean
      port?: number
      connect?: boolean
      parent?: TuyaAccessory
    },
  ) {
    super()

    if (!(props.id && props.key && props.ip) && !props.fake) {
      if (props.log) props.log.info('Insufficient details to initialize:', JSON.stringify(props))
      return
    }

    this.log = props.log
    const { parent, ...contextProps } = props
    this.context = { version: '3.1', port: 6668, ...contextProps } as TuyaAccessory['context']
    this._parent = parent || null
    this.state = props.initialState ? { ...props.initialState } : {}
    this._cachedBuffer = Buffer.allocUnsafe(0)

    const version = parseFloat(this.context.version || '3.1')
    const handlerName =
      version < 3.2
        ? '_msgHandler_3_1'
        : this.context.version === '3.4'
          ? '_msgHandler_3_4'
          : this.context.version === '3.5'
            ? '_msgHandler_3_5'
            : '_msgHandler_3_3'
    this._msgQueue = async.queue((task: MessageTask, callback: () => void) => {
      try {
        this[handlerName](task, callback)
      } catch (err) {
        this._handleProtocolError(err)
        callback()
      }
    }, 1)

    if (version >= 3.2) {
      this.context.pingGap = Math.min(this.context.pingGap || 9, 9)
    }

    this.connected = false
    if (props.connect !== false) this._connect()

    if (this.context.initialState && Object.keys(this.context.initialState).length > 0)
      process.nextTick(() => this.emit('change', {}, this.state))

    this._connectionAttempts = 0
    this._sendCounter = 0

    this._tmpLocalKey = null
    this._tmpRemoteKey = null
    this.session_key = null
  }

  _connect(): void {
    if (this._parent) {
      this._parent._registerChild(this)
      this._parent.on('connect', () => this._connectToParent())
      this._parent.on('disconnect', () => this._disconnectFromParent())
      if (this._parent.connected) process.nextTick(() => this._connectToParent())
      return
    }

    if (this.context.fake) {
      this.connected = true
      if (!this.context.initialState || Object.keys(this.context.initialState).length === 0)
        return void setTimeout(() => this.emit('change', {}, this.state), 1000)
      return
    }

    this._socket = new net.Socket() as TuyaSocket

    this._incrementAttemptCounter()
    ;(this._socket.reconnect = () => {
      if (this._socket._pinger) {
        clearTimeout(this._socket._pinger)
        this._socket._pinger = null
      }

      if (this._socket._connTimeout) {
        clearTimeout(this._socket._connTimeout)
        this._socket._connTimeout = null
      }

      if (this._socket._errorReconnect) {
        clearTimeout(this._socket._errorReconnect)
        this._socket._errorReconnect = null
      }

      this._socket.setKeepAlive(true)
      this._socket.setNoDelay(true)

      this._socket._connTimeout = setTimeout(
        () => {
          this._socket.emit('error', new Error('ERR_CONNECTION_TIMED_OUT'))
        },
        (this.context.connectTimeout || 30) * 1000,
      )

      this._incrementAttemptCounter()

      this._socket.connect(this.context.port, this.context.ip!)
    })()

    this._socket._ping = () => {
      if (this._socket._pinger) clearTimeout(this._socket._pinger)
      this._socket._pinger = setTimeout(
        () => {
          this._socket._pinger = setTimeout(() => {
            this._socket.emit('error', new Error('ERR_PING_TIMED_OUT'))
          }, 5000)

          this._send({ cmd: 9 })
        },
        (this.context.pingTimeout || 30) * 1000,
      )

      this._send({ cmd: 9 })
    }

    this._socket.on('connect', () => {
      if (this.context.version !== '3.4' && this.context.version !== '3.5') {
        clearTimeout(this._socket._connTimeout!)

        this.connected = true
        this.emit('connect')
        if (this._socket._pinger) clearTimeout(this._socket._pinger)
        this._socket._pinger = setTimeout(() => this._socket._ping(), 1000)

        if (this.context.intro === false) {
          this.emit('change', {}, this.state)
          process.nextTick(this.update.bind(this))
        }
      }
    })

    this._socket.on('ready', () => {
      if (this.context.intro === false) return
      this.connected = true

      if (this.context.version === '3.4' || this.context.version === '3.5') {
        this._tmpLocalKey = crypto.randomBytes(16)
        const payload: SendPayload = {
          data: this._tmpLocalKey,
          encrypted: true,
          cmd: 3,
        }
        this._send(payload)
      } else {
        this.update()
      }
    })

    this._socket.on('data', (msg: Buffer) => {
      this._cachedBuffer = Buffer.concat([this._cachedBuffer, msg])

      do {
        const legacyIndex = this._cachedBuffer.indexOf('000055aa', 'hex')
        const modernIndex = this._cachedBuffer.indexOf('00006699', 'hex')
        const startingIndex =
          legacyIndex === -1 ? modernIndex : modernIndex === -1 ? legacyIndex : Math.min(legacyIndex, modernIndex)
        if (startingIndex === -1) {
          this._cachedBuffer = Buffer.allocUnsafe(0)
          break
        }
        if (startingIndex !== 0) this._cachedBuffer = this._cachedBuffer.slice(startingIndex)

        const suffix = this._cachedBuffer.readUInt32BE(0) === 0x00006699 ? '00009966' : '0000aa55'
        let endingIndex = this._cachedBuffer.indexOf(suffix, 4, 'hex')
        if (endingIndex === -1) break

        endingIndex += 4

        this._msgQueue.push({ msg: this._cachedBuffer.slice(0, endingIndex) })

        this._cachedBuffer = this._cachedBuffer.slice(endingIndex)
      } while (this._cachedBuffer.length)
    })

    this._socket.on('error', (err: NodeJS.ErrnoException) => {
      this._disconnectChildren()
      this.connected = false
      this._reportUnreachable(err)

      if (err && (err.code === 'ECONNRESET' || err.code === 'EPIPE') && this._connectionAttempts < 10) {
        this.log.debug(`Reconnecting with connection attempts =  ${this._connectionAttempts}`)
        return process.nextTick(this._socket.reconnect.bind(this))
      }

      this._socket.destroy()

      let delay = 5000
      if (err) {
        if (err.code === 'ENOBUFS') {
          this.log.warn('Operating system complained of resource exhaustion; did I open too many sockets?')
          this._logOutageDetail(
            'Slowing down retry attempts; if you see this happening often, it could mean some sort of incompatibility.',
          )
          delay = 60000
        } else if (this._connectionAttempts > 10) {
          this._logOutageDetail(
            'Slowing down retry attempts; if you see this happening often, it could mean some sort of incompatibility.',
          )
          delay = 60000
        }
      }

      if (!this._socket._errorReconnect) {
        this.log.debug(`after error setting _connect in ${delay}ms`)
        this._socket._errorReconnect = setTimeout(() => {
          this.log.debug(`executing _connect after ${delay}ms delay`)
          process.nextTick(this._connect.bind(this))
        }, delay)
      }
    })

    this._socket.on('close', () => {
      this._disconnectChildren()
      this.connected = false
      this.session_key = null
    })

    this._socket.on('end', () => {
      this._disconnectChildren()
      this.connected = false
      this.session_key = null
      this.log.info('Disconnected from', this.context.name)
    })
  }

  private _registerChild(child: TuyaAccessory): void {
    const childId = String(child.context.id)
    const cid = child.context.cid || child.context.nodeId
    this._children.set(childId, child)
    if (cid) this._children.set(String(cid), child)
  }

  private _connectToParent(): void {
    if (!this._parent?.connected || this.connected) return
    this.connected = true
    this.emit('connect')
    this.update()
  }

  private _disconnectFromParent(): void {
    if (!this.connected) return
    this.connected = false
    this.emit('disconnect')
  }

  private _disconnectChildren(): void {
    const children = new Set(this._children.values())
    children.forEach((child) => child._disconnectFromParent())
  }

  private _incrementAttemptCounter(): void {
    this._connectionAttempts++
    setTimeout(() => {
      this.log.debug(`decrementing this._connectionAttempts, currently ${this._connectionAttempts}`)
      this._connectionAttempts--
    }, 10000)
  }

  private _handleProtocolError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err))
    this.log.warn(`Protocol error from ${this.context.name}: ${error.message}`)
    this._socket.emit('error', error as NodeJS.ErrnoException)
  }

  private _msgHandler_3_1(task: MessageTask, callback: () => void): void {
    if (!(task.msg instanceof Buffer)) return callback()

    const len = task.msg.length
    if (len < 16 || task.msg.readUInt32BE(0) !== 0x000055aa || task.msg.readUInt32BE(len - 4) !== 0x0000aa55)
      return callback()

    const size = task.msg.readUInt32BE(12)
    if (len - 8 < size) return callback()

    const cmd = task.msg.readUInt32BE(8)
    let data: string | { dps?: DPSState } = task.msg
      .slice(len - size, len - 8)
      .toString('utf8')
      .trim()
      .replace(/\0/g, '')

    if (this.context.intro === false && cmd !== 9) this.log.info('Message from', this.context.name + ':', data)

    switch (cmd) {
      case 7:
        break

      case 9:
        if (this._socket._pinger) clearTimeout(this._socket._pinger)
        this._socket._pinger = setTimeout(
          () => {
            this._socket._ping()
          },
          ((this.context.pingGap || 20) as number) * 1000,
        )
        break

      case 8: {
        let decryptedMsg: string
        try {
          const decipher = crypto.createDecipheriv('aes-128-ecb', this.context.key, '')
          decryptedMsg = decipher.update((data as string).substr(19), 'base64', 'utf8')
          decryptedMsg += decipher.final('utf8')
        } catch (_ex) {
          decryptedMsg = (data as string).substr(19).toString()
        }

        try {
          data = JSON.parse(decryptedMsg)
        } catch (_ex) {
          data = decryptedMsg
          this.log.info(`Odd message from ${this.context.name} with command ${cmd}:`, data)
          this.log.info(
            `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
            task.msg.toString('hex'),
          )
          break
        }

        if (data && typeof data === 'object' && data.dps) this._changePayload(data)
        break
      }

      case 10:
        if (data) {
          if (data === 'json obj data unvalid') {
            this._logOutageDetail(
              `${this.context.name} (${this.context.version}) didn't respond with its current state.`,
            )
            this.emit('change', {}, this.state)
            break
          }

          try {
            data = JSON.parse(data as string)
          } catch (_ex) {
            this.log.info(`Malformed update from ${this.context.name} with command ${cmd}:`, data)
            this.log.info(
              `Raw update from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
              task.msg.toString('hex'),
            )
            break
          }

          if (data && typeof data === 'object' && data.dps) this._changePayload(data)
        }
        break

      default:
        this.log.info(`Odd message from ${this.context.name} with command ${cmd}:`, data)
        this.log.info(
          `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
          task.msg.toString('hex'),
        )
    }

    callback()
  }

  private _msgHandler_3_3(task: MessageTask, callback: () => void): void {
    if (!(task.msg instanceof Buffer)) return callback()

    const len = task.msg.length
    if (len < 16 || task.msg.readUInt32BE(0) !== 0x000055aa || task.msg.readUInt32BE(len - 4) !== 0x0000aa55)
      return callback()

    const size = task.msg.readUInt32BE(12)
    if (len - 8 < size) return callback()

    const cmd = task.msg.readUInt32BE(8)

    if (cmd === 7) return callback()
    if (cmd === 9) {
      if (this._socket._pinger) clearTimeout(this._socket._pinger)
      this._socket._pinger = setTimeout(
        () => {
          this._socket._ping()
        },
        ((this.context.pingGap || 20) as number) * 1000,
      )

      return callback()
    }

    let versionPos = task.msg.indexOf('3.3')
    if (versionPos === -1) versionPos = task.msg.indexOf('3.2')
    const cleanMsg = task.msg.slice(
      versionPos === -1 ? len - size + (task.msg.readUInt32BE(16) & 0xffffff00 ? 0 : 4) : 15 + versionPos,
      len - 8,
    )

    let decryptedMsg: string
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', this.context.key, '')
      decryptedMsg = decipher.update(cleanMsg, undefined, 'utf8')
      decryptedMsg += decipher.final('utf8')
    } catch (_ex) {
      decryptedMsg = cleanMsg.toString('utf8')
    }

    if (cmd === 10 && decryptedMsg === 'json obj data unvalid') {
      this._logOutageDetail(`${this.context.name} (${this.context.version}) didn't respond with its current state.`)
      this.emit('change', {}, this.state)
      return callback()
    }

    let data: { dps?: DPSState }
    try {
      data = JSON.parse(decryptedMsg)
    } catch (_ex) {
      this.log.info(`Odd message from ${this.context.name} with command ${cmd}:`, decryptedMsg)
      this.log.info(
        `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
        task.msg.toString('hex'),
      )
      return callback()
    }

    switch (cmd) {
      case 8:
      case 10:
        if (data) {
          if (data.dps) {
            this._changePayload(data)
          } else {
            this.log.info(`Malformed message from ${this.context.name} with command ${cmd}:`, decryptedMsg)
            this.log.info(
              `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
              task.msg.toString('hex'),
            )
          }
        }
        break

      default:
        this.log.info(`Odd message from ${this.context.name} with command ${cmd}:`, decryptedMsg)
        this.log.info(
          `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
          task.msg.toString('hex'),
        )
    }

    callback()
  }

  private _msgHandler_3_4(task: MessageTask, callback: () => void): void {
    if (!(task.msg instanceof Buffer)) return callback()

    const len = task.msg.length
    if (len < 16 || task.msg.readUInt32BE(0) !== 0x000055aa || task.msg.readUInt32BE(len - 4) !== 0x0000aa55)
      return callback()

    const size = task.msg.readUInt32BE(12)
    if (len - 8 < size) return callback()

    const cmd = task.msg.readUInt32BE(8)

    if (cmd === 7 || cmd === 13) return callback()
    if (cmd === 9) {
      if (this._socket._pinger) clearTimeout(this._socket._pinger)
      this._socket._pinger = setTimeout(
        () => {
          this._socket._ping()
        },
        ((this.context.pingGap || 20) as number) * 1000,
      )

      return callback()
    }

    const versionPos = task.msg.indexOf('3.4')
    const cleanMsg = task.msg.slice(
      versionPos === -1 ? len - size + (task.msg.readUInt32BE(16) & 0xffffff00 ? 0 : 4) : 15 + versionPos,
      len - 0x24,
    )

    const expectedCrc = task.msg.slice(len - 0x24, task.msg.length - 4).toString('hex')
    const sessionKey = this.session_key ?? this.context.key
    let messageKey: Buffer | string = sessionKey
    let computedCrc = hmac(task.msg.slice(0, len - 0x24), sessionKey).toString('hex')

    if (expectedCrc !== computedCrc && this.session_key) {
      const localKeyCrc = hmac(task.msg.slice(0, len - 0x24), this.context.key).toString('hex')
      if (expectedCrc === localKeyCrc) {
        messageKey = this.context.key
        computedCrc = localKeyCrc
        this.log.debug(
          `Using the device key for an unsolicited ${this.context.version} message from ${this.context.name}`,
        )
      }
    }

    if (expectedCrc !== computedCrc) {
      throw new Error(`HMAC mismatch: expected ${expectedCrc}, was ${computedCrc}. ${task.msg.toString('hex')}`)
    }

    const decipher = crypto.createDecipheriv('aes-128-ecb', messageKey, null)
    decipher.setAutoPadding(false)
    let decryptedMsg: Buffer = decipher.update(cleanMsg)
    decipher.final()
    decryptedMsg = decryptedMsg.slice(0, decryptedMsg.length - decryptedMsg[decryptedMsg.length - 1])

    let parsedPayload: any
    try {
      let sliced = decryptedMsg
      if (decryptedMsg.indexOf(this.context.version!) === 0) {
        sliced = decryptedMsg.slice(15)
      }
      const res = JSON.parse(sliced.toString())
      if ('data' in res) {
        const resdata = res.data
        resdata.t = res.t
        parsedPayload = resdata
      } else {
        parsedPayload = res
      }
    } catch (_) {
      parsedPayload = decryptedMsg
    }

    if (cmd === 4) {
      this._tmpRemoteKey = parsedPayload.subarray(0, 16)
      const calcLocalHmac = hmac(this._tmpLocalKey!, this.session_key ?? this.context.key).toString('hex')
      const expLocalHmac = parsedPayload.slice(16, 16 + 32).toString('hex')
      if (expLocalHmac !== calcLocalHmac) {
        throw new Error(
          `HMAC mismatch(keys): expected ${expLocalHmac}, was ${calcLocalHmac}. ${parsedPayload.toString('hex')}`,
        )
      }
      const payload: SendPayload = {
        data: hmac(this._tmpRemoteKey!, this.context.key) as unknown as Buffer,
        encrypted: true,
        cmd: 5,
      }
      this._send(payload)
      clearTimeout(this._socket._connTimeout!)

      this.session_key = Buffer.from(this._tmpLocalKey!)
      for (let i = 0; i < this._tmpLocalKey!.length; i++) {
        this.session_key[i] = this._tmpLocalKey![i] ^ this._tmpRemoteKey![i]
      }

      this.session_key = encrypt34(this.session_key, this.context.key)
      clearTimeout(this._socket._connTimeout!)

      this.connected = true
      this.update()
      this.emit('connect')
      if (this._socket._pinger) clearTimeout(this._socket._pinger)
      this._socket._pinger = setTimeout(() => this._socket._ping(), 1000)

      return callback()
    }

    if ((cmd === 10 || cmd === 16) && parsedPayload === 'json obj data unvalid') {
      this._logOutageDetail(`${this.context.name} (${this.context.version}) didn't respond with its current state.`)
      this.emit('change', {}, this.state)
      return callback()
    }

    switch (cmd) {
      case 8:
      case 10:
      case 16:
        if (parsedPayload) {
          if (parsedPayload.dps) {
            this._changePayload(parsedPayload)
          } else {
            this.log.info(`Malformed message from ${this.context.name} with command ${cmd}:`, decryptedMsg)
            this.log.info(
              `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
              task.msg.toString('hex'),
            )
          }
        }
        break

      case 64:
        this.emit('payload', parsedPayload)
        break

      default:
        this.log.info(`Odd message from ${this.context.name} with command ${cmd}:`, decryptedMsg)
        this.log.info(
          `Raw message from ${this.context.name} (${this.context.version}) with command ${cmd}:`,
          task.msg.toString('hex'),
        )
    }

    callback()
  }

  private _msgHandler_3_5(task: MessageTask, callback: () => void): void {
    if (!(task.msg instanceof Buffer)) return callback()

    const len = task.msg.length
    if (len < 24 || task.msg.readUInt32BE(0) !== 0x00006699 || task.msg.readUInt32BE(len - 4) !== 0x00009966)
      return callback()

    const cmd = task.msg.readUInt32BE(10)
    if (cmd === 9) {
      if (this._socket._pinger) clearTimeout(this._socket._pinger)
      this._socket._pinger = setTimeout(
        () => {
          this._socket._ping()
        },
        ((this.context.pingGap || 20) as number) * 1000,
      )
      return callback()
    }

    const encrypted = task.msg.slice(4, len - 4)
    let decrypted: Buffer
    try {
      decrypted = decrypt35(encrypted, this.session_key ?? this.context.key)
    } catch (err) {
      throw new Error(`Protocol 3.5 decrypt failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }

    if (cmd === 4) {
      this._sendCounter = task.msg.readUInt32BE(6) - 1
      this._tmpRemoteKey = decrypted.subarray(0, 16)
      const expectedHmac = decrypted.subarray(16, 48).toString('hex')
      const actualHmac = hmac(this._tmpLocalKey!, this.context.key).toString('hex')
      if (expectedHmac !== actualHmac) {
        throw new Error(`HMAC mismatch(keys): expected ${expectedHmac}, was ${actualHmac}`)
      }

      this._send({ cmd: 5, data: hmac(this._tmpRemoteKey, this.context.key) })

      this.session_key = Buffer.alloc(16)
      for (let index = 0; index < 16; index++)
        this.session_key[index] = this._tmpLocalKey![index] ^ this._tmpRemoteKey[index]
      this.session_key = encrypt35(this.session_key, this.context.key, this._tmpLocalKey)

      clearTimeout(this._socket._connTimeout!)
      this.connected = true
      this.emit('connect')
      this.update()
      if (this._socket._pinger) clearTimeout(this._socket._pinger)
      this._socket._pinger = setTimeout(() => this._socket._ping(), 1000)
      return callback()
    }

    const parsed = parse35Payload(decrypted)
    if (cmd === 16 && parsed === 'json obj data unvalid') {
      this._logOutageDetail(`${this.context.name} (${this.context.version}) didn't respond with its current state.`)
      this.emit('change', {}, this.state)
      return callback()
    }

    if (
      (cmd === 8 || cmd === 10 || cmd === 13 || cmd === 16) &&
      parsed &&
      typeof parsed === 'object' &&
      'dps' in parsed
    ) {
      this._changePayload(parsed as { dps: DPSState })
    } else if (cmd !== 7 && cmd !== 13 && parsed) {
      this.log.debug(`Message from ${this.context.name} with command ${cmd}:`, parsed)
    }

    callback()
  }

  update(o?: Record<string, DPSValue>): boolean {
    const dps: DPSState = {}
    let hasDataPoint = false
    if (o) {
      Object.keys(o).forEach((key) => {
        if (!isNaN(Number(key))) {
          dps['' + key] = o[key]
          hasDataPoint = true
        }
      })
    }

    if (this.context.fake) {
      if (hasDataPoint) this._fakeUpdate(dps)
      return true
    }

    let result: boolean | undefined
    if (hasDataPoint) {
      const t = (Date.now() / 1000).toFixed(0)
      const modern = this.context.version === '3.4' || this.context.version === '3.5'
      const cid = this.context.cid || this.context.nodeId
      const payload: Record<string, unknown> = this._parent
        ? modern
          ? { protocol: 5, t: Number(t), data: { cid: cid || this.context.id, ctype: 0, dps } }
          : { t: Number(t), cid: cid || this.context.id, dps }
        : {
            devId: this.context.id,
            uid: '',
            t,
            dps,
          }
      const data = modern && !this._parent ? { data: { ...payload, ctype: 0, t: undefined }, protocol: 5, t } : payload
      result = this._send({
        data: data as Record<string, unknown>,
        cmd: modern ? 13 : 7,
      })
      if (result !== true) this.log.info(' Result', result)
      if (this.context.sendEmptyUpdate) {
        this._send({ cmd: modern ? 13 : 7 })
      }
    } else {
      const modern = this.context.version === '3.4' || this.context.version === '3.5'
      const cid = this.context.cid || this.context.nodeId
      result = this._send({
        data: this._parent
          ? modern
            ? { cid: cid || this.context.id }
            : { t: Number((Date.now() / 1000).toFixed(0)), cid: cid || this.context.id }
          : {
              gwId: this.context.id,
              devId: this.context.id,
            },
        cmd: modern ? 16 : 10,
      })
    }

    return result as boolean
  }

  querySubdevices(): boolean {
    if (this._parent) return this._parent.querySubdevices()
    return this._send({
      cmd: 64,
      data: { reqType: 'subdev_online_stat_query', data: { cids: [] } },
    }) as boolean
  }

  // An outage is reported once, not once per retry. A device that drops off the
  // network otherwise produces a socket error every few seconds for as long as it
  // is gone, which drowns the Homebridge log for anyone with a device that is
  // intentionally off (seasonal lights, a plug on a switched socket).
  private _reportUnreachable(err: NodeJS.ErrnoException): void {
    const reason = (err && (err.code || err.message)) || String(err)

    if (this._unreachableSince === null) {
      this._unreachableSince = Date.now()
    }

    this._consecutiveFailures++

    if (!this._outageReported && this._consecutiveFailures >= OUTAGE_FAILURE_THRESHOLD) {
      this._outageReported = true
      this.log.info(
        `Device ${this.context.name} became unreachable after ${this._consecutiveFailures} consecutive failures; attempting to reconnect (${reason})`,
      )
      return
    }

    this.log.debug(
      `Socket error for ${this.context.name}: ${reason}; reconnecting (consecutive failure ${this._consecutiveFailures})`,
    )
  }

  private _reportReachable(): void {
    if (this._unreachableSince === null) return

    const outage = formatOutage(Date.now() - this._unreachableSince)
    const outageReported = this._outageReported
    this._unreachableSince = null
    this._consecutiveFailures = 0
    this._outageReported = false
    if (outageReported) this.log.info(`Device ${this.context.name} is reachable again (${outage})`)
  }

  // Detail that is worth a normal log line the first time, and noise once the
  // device is already known to be unreachable.
  private _logOutageDetail(message: string): void {
    if (this._unreachableSince === null) return this.log.info(message)

    this.log.debug(message)
  }

  private _changePayload(payload: {
    dps?: DPSState
    cid?: string
    devId?: string
    data?: { cid?: string; dps?: DPSState }
  }): void {
    if (!payload.dps) return

    const childKey = payload.cid || payload.data?.cid || payload.devId
    const child = childKey ? this._children.get(String(childKey)) : undefined
    if (child) return child._change(payload.dps)

    this._change(payload.dps)
  }

  private _change(data: DPSState): void {
    if (!isNonEmptyPlainObject(data)) return

    // A valid state payload is the first thing that proves the device is actually
    // talking to us again, rather than merely accepting a TCP connection.
    this._reportReachable()

    const changes: DPSState = {}
    Object.keys(data).forEach((key) => {
      if (data[key] !== this.state[key]) {
        changes[key] = data[key]
      }
    })

    if (isNonEmptyPlainObject(changes)) {
      this.state = { ...this.state, ...data }
      this.emit('change', changes, this.state)
    }
  }

  private _send(o: SendPayload): boolean | undefined {
    if (this._parent) return this._parent._send(o)
    if (this.context.fake) return
    if (!this.connected && o.cmd !== 3 && o.cmd !== 5) return false

    const version = parseFloat(this.context.version || '3.1')
    if (version < 3.2) return this._send_3_1(o)
    if (this.context.version === '3.3') return this._send_3_3(o)
    if (this.context.version === '3.5') return this._send_3_5(o)
    return this._send_3_4(o)
  }

  private _send_3_1(o: SendPayload): boolean {
    const { cmd, data } = { ...o }

    let msg = ''

    if (data && typeof data !== 'string' && !(data instanceof Buffer)) {
      switch (cmd) {
        case 7: {
          const cipher = crypto.createCipheriv('aes-128-ecb', this.context.key, '')
          let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64')
          encrypted += cipher.final('base64')

          const hash = crypto
            .createHash('md5')
            .update(`data=${encrypted}||lpv=${this.context.version}||${this.context.key}`, 'utf8')
            .digest('hex')
            .substr(8, 16)

          msg = this.context.version + hash + encrypted
          break
        }

        case 10:
          msg = JSON.stringify(data)
          break
      }
    }

    const payload = Buffer.from(msg)
    const prefix = Buffer.from('000055aa00000000000000' + cmd.toString(16).padStart(2, '0'), 'hex')
    const suffix = Buffer.concat([payload, Buffer.from('000000000000aa55', 'hex')])

    const len = Buffer.allocUnsafe(4)
    len.writeInt32BE(suffix.length, 0)

    return this._socket.write(Buffer.concat([prefix, len, suffix]))
  }

  private _send_3_3(o: SendPayload): boolean {
    const { cmd, data } = { ...o }

    if (cmd !== 7 || data) this._sendCounter++

    const hex: string[] = [
      '000055aa',
      this._sendCounter.toString(16).padStart(8, '0'),
      cmd.toString(16).padStart(8, '0'),
      '00000000',
    ]

    if (cmd === 7 && !data) hex.push('00000000')
    else if (cmd !== 9 && cmd !== 10) hex.push('332e33000000000000000000000000')

    if (data && !(data instanceof Buffer)) {
      const cipher = crypto.createCipheriv('aes-128-ecb', this.context.key, '')
      let encrypted = cipher.update(Buffer.from(JSON.stringify(data)), undefined, 'hex')
      encrypted += cipher.final('hex')
      hex.push(encrypted)
    }

    hex.push('00000000')
    hex.push('0000aa55')

    const payload = Buffer.from(hex.join(''), 'hex')
    payload.writeUInt32BE(payload.length - 16, 12)
    payload.writeInt32BE(getCRC32(payload.slice(0, payload.length - 8)), payload.length - 8)

    return this._socket.write(payload)
  }

  private _fakeUpdate(dps: DPSState): void {
    this.log.info('Fake update:', JSON.stringify(dps))
    Object.keys(dps).forEach((dp) => {
      this.state[dp] = dps[dp]
    })
    setTimeout(() => {
      this.emit('change', dps, this.state)
    }, 1000)
  }

  private _send_3_4(o: SendPayload): boolean {
    const { cmd, data: _data } = { ...o }
    let data = _data

    if (!data) {
      data = Buffer.allocUnsafe(0)
    }
    if (!(data instanceof Buffer)) {
      if (typeof data !== 'string') {
        data = JSON.stringify(data)
      }
      data = Buffer.from(data)
    }

    if (cmd !== 10 && cmd !== 9 && cmd !== 16 && cmd !== 3 && cmd !== 5 && cmd !== 18 && cmd !== 64) {
      const buffer = Buffer.alloc((data as Buffer).length + 15)
      Buffer.from('3.4').copy(buffer, 0)
      ;(data as Buffer).copy(buffer, 15)
      data = buffer
    }

    const padding = 0x10 - ((data as Buffer).length & 0xf)
    const buf34 = Buffer.alloc((data as Buffer).length + padding, padding)
    ;(data as Buffer).copy(buf34)
    data = buf34
    const encrypted = encrypt34(data as Buffer, this.session_key ?? this.context.key)

    const encryptedBuffer = Buffer.from(encrypted)
    const buffer = Buffer.alloc(encryptedBuffer.length + 52)
    buffer.writeUInt32BE(0x000055aa, 0)
    buffer.writeUInt32BE(cmd, 8)
    buffer.writeUInt32BE(encryptedBuffer.length + 0x24, 12)

    if ((cmd !== 7 && cmd !== 13) || data) {
      this._sendCounter++
      buffer.writeUInt32BE(this._sendCounter, 4)
    }

    encryptedBuffer.copy(buffer, 16)
    const calculatedCrc = hmac(buffer.slice(0, encryptedBuffer.length + 16), this.session_key ?? this.context.key)
    calculatedCrc.copy(buffer, encryptedBuffer.length + 16)
    buffer.writeUInt32BE(0x0000aa55, encryptedBuffer.length + 48)

    return this._socket.write(buffer)
  }

  private _send_3_5(o: SendPayload): boolean {
    const { cmd, data: rawData } = o
    let data =
      rawData instanceof Buffer
        ? rawData
        : rawData === undefined
          ? Buffer.alloc(0)
          : Buffer.from(typeof rawData === 'string' ? rawData : JSON.stringify(rawData))

    if (cmd !== 10 && cmd !== 9 && cmd !== 16 && cmd !== 3 && cmd !== 5 && cmd !== 18 && cmd !== 64) {
      const payload = Buffer.alloc(data.length + 15)
      Buffer.from('3.5').copy(payload, 0)
      data.copy(payload, 15)
      data = payload
    }

    this._sendCounter++
    const header = Buffer.alloc(18)
    header.writeUInt32BE(0x00006699, 0)
    header.writeUInt16BE(0, 4)
    header.writeUInt32BE(this._sendCounter, 6)
    header.writeUInt32BE(cmd, 10)
    header.writeUInt32BE(data.length + 28, 14)

    return this._socket.write(
      Buffer.concat([
        header,
        encrypt35(data, this.session_key ?? this.context.key, undefined, header.slice(4, 18), true),
      ]),
    )
  }
}

const encrypt34 = (data: Buffer, encryptKey: string | Buffer): Buffer => {
  const cipher = crypto.createCipheriv('aes-128-ecb', encryptKey, null)
  cipher.setAutoPadding(false)
  const encrypted = cipher.update(data)
  cipher.final()
  return encrypted
}

const hmac = (data: Buffer, hmacKey: string | Buffer): Buffer => {
  return crypto.createHmac('sha256', hmacKey).update(data).digest()
}

const encrypt35 = (
  data: Buffer,
  encryptKey: string | Buffer,
  iv?: Buffer,
  aad?: Buffer,
  includeHeader = false,
): Buffer => {
  const localIV = iv ? iv.subarray(0, 12) : Buffer.from((Date.now() * 10).toString().slice(0, 12))
  const cipher = crypto.createCipheriv('aes-128-gcm', encryptKey, localIV)
  if (aad) cipher.setAAD(aad)
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()])
  if (!includeHeader) return encrypted
  return Buffer.concat([localIV, encrypted, cipher.getAuthTag(), Buffer.from('00009966', 'hex')])
}

const decrypt35 = (data: Buffer, decryptKey: string | Buffer): Buffer => {
  const header = data.slice(0, 14)
  const localIV = data.slice(14, 26)
  const authTag = data.slice(data.length - 16)
  const encrypted = data.slice(26, data.length - 16)
  const decipher = crypto.createDecipheriv('aes-128-gcm', decryptKey, localIV)
  decipher.setAuthTag(authTag)
  decipher.setAAD(header)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).slice(4)
}

const parse35Payload = (payload: Buffer): DPSState | string | Buffer => {
  let decoded = payload
  if (decoded.subarray(0, 3).toString() === '3.5') decoded = decoded.subarray(15)

  try {
    const parsed = JSON.parse(decoded.toString())
    if (parsed && typeof parsed === 'object' && 'data' in parsed) {
      const inner = parsed.data
      if (inner && typeof inner === 'object') {
        inner.t = parsed.t
        return inner
      }
    }
    return parsed
  } catch (_err) {
    return decoded.toString()
  }
}

const crc32LookupTable: number[] = []
;(() => {
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let j = 8; j > 0; j--) crc = crc & 1 ? (crc >>> 1) ^ 3988292384 : crc >>> 1
    crc32LookupTable.push(crc)
  }
})()

const getCRC32 = (buffer: Buffer): number => {
  let crc = 0xffffffff
  for (let i = 0, len = buffer.length; i < len; i++) crc = crc32LookupTable[buffer[i] ^ (crc & 0xff)] ^ (crc >>> 8)
  return ~crc
}

export default TuyaAccessory
