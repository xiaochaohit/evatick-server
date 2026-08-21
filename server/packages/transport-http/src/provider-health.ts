import {
  ProviderError,
  retryProviderCall,
  type DataSourceCategory,
  type InstrumentProvider,
  type ProviderDataSource,
} from '@market-cli/core'

export type DataSourceStatus = 'unknown' | 'checking' | 'healthy' | 'unhealthy'

interface HealthRecord {
  status: DataSourceStatus
  lastCheckedAt: string | null
  lastSuccessAt: string | null
  latencyMs: number | null
  recordsChecked: number | null
  error: { code: string; message: string } | null
}

interface DataSourceProbe {
  provider: InstrumentProvider
  source: ProviderDataSource
  category: DataSourceCategory
}

export interface DataSourceHealthRecord {
  provider_id: string
  source_id: string
  source_name: string
  category: DataSourceCategory
  status: DataSourceStatus
  capabilities: readonly string[]
  last_checked_at: string | null
  last_success_at: string | null
  latency_ms: number | null
  records_checked: number | null
  error: { code: string; message: string } | null
}

const unknownHealth = (): HealthRecord => ({
  status: 'unknown',
  lastCheckedAt: null,
  lastSuccessAt: null,
  latencyMs: null,
  recordsChecked: null,
  error: null,
})

function probeKey(probe: DataSourceProbe): string {
  return `${probe.provider.id}:${probe.source.id}:${probe.category}`
}

export class ProviderHealthMonitor {
  private readonly records = new Map<string, HealthRecord>()
  private readonly running = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private nextCheckAt: string | null = null

  constructor(
    private readonly listProviders: () => readonly InstrumentProvider[],
    private intervalMs: number,
    private readonly timeoutMs: number,
  ) {
    this.configureTimer()
  }

  get schedule() {
    return {
      enabled: this.intervalMs > 0,
      interval_seconds: this.intervalMs / 1_000,
      next_check_at: this.nextCheckAt,
    }
  }

  list(): DataSourceHealthRecord[] {
    return this.probes().map((probe) => {
      const record = this.records.get(probeKey(probe)) ?? unknownHealth()
      return {
        provider_id: probe.provider.id,
        source_id: probe.source.id,
        source_name: probe.source.name,
        category: probe.category,
        status: record.status,
        capabilities: probe.source.capabilities[probe.category] ?? [],
        last_checked_at: record.lastCheckedAt,
        last_success_at: record.lastSuccessAt,
        latency_ms: record.latencyMs,
        records_checked: record.recordsChecked,
        error: record.error,
      }
    })
  }

  setIntervalMs(intervalMs: number): void {
    this.intervalMs = intervalMs
    this.configureTimer()
  }

  async checkAll(): Promise<DataSourceHealthRecord[]> {
    await Promise.all(this.probes().map((probe) => this.check(probe)))
    return this.list()
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.nextCheckAt = null
  }

  private probes(): DataSourceProbe[] {
    return this.listProviders().flatMap((provider) =>
      (provider.dataSources ?? []).flatMap((source) =>
        source.categories.map((category) => ({ provider, source, category })),
      ),
    )
  }

  private configureTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.nextCheckAt = null
    if (this.intervalMs <= 0) return

    this.nextCheckAt = new Date(Date.now() + this.intervalMs).toISOString()
    this.timer = setInterval(() => {
      this.nextCheckAt = new Date(Date.now() + this.intervalMs).toISOString()
      void this.checkAll()
    }, this.intervalMs)
    this.timer.unref()
  }

  private check(probe: DataSourceProbe): Promise<void> {
    const key = probeKey(probe)
    const current = this.running.get(key)
    if (current) return current

    const run = this.performCheck(probe).finally(() => {
      this.running.delete(key)
    })
    this.running.set(key, run)
    return run
  }

  private async performCheck(probe: DataSourceProbe): Promise<void> {
    const key = probeKey(probe)
    const previous = this.records.get(key) ?? unknownHealth()
    this.records.set(key, { ...previous, status: 'checking' })
    const startedAt = Date.now()
    try {
      if (!probe.provider.checkDataSource) {
        throw new ProviderError(
          'DATA_SOURCE_CHECK_UNAVAILABLE',
          'provider does not implement data source checks',
          false,
        )
      }
      const result = await retryProviderCall({
        retryAttempts: 1,
        timeoutMs: this.timeoutMs,
        invoke: (signal) => probe.provider.checkDataSource!({
          sourceId: probe.source.id,
          category: probe.category,
          signal,
        }),
      })
      const checkedAt = new Date().toISOString()
      this.records.set(key, {
        status: 'healthy',
        lastCheckedAt: checkedAt,
        lastSuccessAt: checkedAt,
        latencyMs: Date.now() - startedAt,
        recordsChecked: result.value.recordsChecked,
        error: null,
      })
    } catch (error) {
      const normalized = error instanceof ProviderError
        ? error
        : new ProviderError('PROVIDER_ERROR', 'data source health check failed', true)
      this.records.set(key, {
        ...previous,
        status: 'unhealthy',
        lastCheckedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        error: { code: normalized.code, message: normalized.message },
      })
    }
  }
}
