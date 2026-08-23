export class BoundedExecutor {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('concurrency must be a positive integer')
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.active -= 1
  }
}

export class SingleFlight {
  private readonly active = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.active.get(key)
    if (existing) return existing as Promise<T>

    const request = task()
    this.active.set(key, request)
    void request.finally(() => {
      if (this.active.get(key) === request) this.active.delete(key)
    }).catch(() => undefined)
    return request
  }
}
