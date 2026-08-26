import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import { ProviderError } from '@evatick/core'

import type { AmazingDataRequest, AmazingDataResult } from './index.js'

export interface AmazingDataBridgeOptions {
  pythonExecutable: string
  pythonModule?: string
  pythonPath?: string
  username: string
  password: string
  host: string
  port: number
  cachePath: string
}

interface PendingRequest {
  resolve: (result: AmazingDataResult) => void
  reject: (error: ProviderError) => void
  removeAbortListener: () => void
}

interface BridgeEnvelope {
  id?: unknown
  ok?: unknown
  source?: unknown
  data?: unknown
  error?: { code?: unknown; message?: unknown; retryable?: unknown }
}

function required(value: string, description: string): string {
  if (!value) throw new Error(`${description} must not be empty`)
  return value
}

function childEnvironment(options: AmazingDataBridgeOptions): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    AMAZINGDATA_USERNAME: options.username,
    AMAZINGDATA_PASSWORD: options.password,
    AMAZINGDATA_HOST: options.host,
    AMAZINGDATA_PORT: String(options.port),
    AMAZINGDATA_CACHE_PATH: options.cachePath,
  }
  for (const name of [
    'PATH', 'LANG', 'LC_ALL', 'HOME', 'TMPDIR', 'LD_LIBRARY_PATH',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ]) {
    if (process.env[name]) environment[name] = process.env[name]
  }
  if (options.pythonPath) environment.PYTHONPATH = options.pythonPath
  return environment
}

export class AmazingDataBridge {
  private readonly options: AmazingDataBridgeOptions
  private child: ChildProcessWithoutNullStreams | undefined
  private nextId = 1
  private readonly pending = new Map<string, PendingRequest>()
  private closed = false

  constructor(options: AmazingDataBridgeOptions) {
    required(options.pythonExecutable, 'AmazingData Python executable')
    required(options.username, 'AmazingData username')
    required(options.password, 'AmazingData password')
    required(options.host, 'AmazingData host')
    required(options.cachePath, 'AmazingData cache path')
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new Error('AmazingData port must be an integer between 1 and 65535')
    }
    this.options = options
  }

  async run(request: AmazingDataRequest, signal: AbortSignal): Promise<AmazingDataResult> {
    if (this.closed) {
      throw new ProviderError('PROVIDER_CLOSED', 'AmazingData bridge is closed', false)
    }
    if (signal.aborted) {
      throw new ProviderError('PROVIDER_ABORTED', 'AmazingData request was aborted', true)
    }
    const child = this.ensureProcess()
    const id = String(this.nextId++)
    return new Promise<AmazingDataResult>((resolve, reject) => {
      const abort = () => {
        const error = new ProviderError('PROVIDER_ABORTED', 'AmazingData request was aborted', true)
        this.failProcess(child, error)
      }
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener('abort', abort),
      })
      child.stdin.write(`${JSON.stringify({ id, ...request })}\n`, (error) => {
        if (error) {
          this.failProcess(child, new ProviderError(
            'PROVIDER_PROCESS_ERROR', 'AmazingData bridge input failed', true,
          ))
        }
      })
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    const child = this.child
    if (child) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2_000)
      try {
        await this.run({ operation: 'shutdown' }, controller.signal)
      } catch {
        // The process may exit before the shutdown acknowledgement is observed.
      } finally {
        clearTimeout(timeout)
      }
      if (this.child === child) this.stopProcess(child)
    }
    this.closed = true
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child
    const child = spawn(
      this.options.pythonExecutable,
      ['-m', this.options.pythonModule ?? 'evatick_server_amazingdata'],
      {
        env: childEnvironment(this.options),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    this.child = child
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(child, line))
    child.stderr.resume()
    child.once('error', () => this.failProcess(child, new ProviderError(
      'PROVIDER_PROCESS_ERROR', 'AmazingData bridge could not start', true,
    )))
    child.once('exit', () => this.failProcess(child, new ProviderError(
      'PROVIDER_PROCESS_ERROR', 'AmazingData bridge exited', true,
    )))
    return child
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    let envelope: BridgeEnvelope
    try {
      envelope = JSON.parse(line) as BridgeEnvelope
    } catch {
      this.failProcess(child, new ProviderError(
        'PROVIDER_INVALID_RESPONSE', 'AmazingData bridge returned invalid JSON', true,
      ))
      return
    }
    const id = typeof envelope.id === 'string' ? envelope.id : undefined
    const pending = id ? this.pending.get(id) : undefined
    if (!id || !pending) return
    this.pending.delete(id)
    pending.removeAbortListener()
    if (envelope.ok === true && typeof envelope.source === 'string') {
      pending.resolve({ source: envelope.source, data: envelope.data })
      return
    }
    pending.reject(new ProviderError(
      typeof envelope.error?.code === 'string' ? envelope.error.code : 'PROVIDER_ERROR',
      typeof envelope.error?.message === 'string'
        ? envelope.error.message
        : 'AmazingData bridge request failed',
      envelope.error?.retryable === true,
    ))
  }

  private failProcess(child: ChildProcessWithoutNullStreams, error: ProviderError): void {
    if (this.child !== child) return
    this.child = undefined
    for (const pending of this.pending.values()) {
      pending.removeAbortListener()
      pending.reject(error)
    }
    this.pending.clear()
    if (!child.killed) child.kill('SIGTERM')
  }

  private stopProcess(child: ChildProcessWithoutNullStreams): void {
    if (this.child === child) this.child = undefined
    if (!child.killed) child.kill('SIGTERM')
  }
}
