import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { DataSourceCategory, InstrumentProvider } from '@evatick/core'

interface PersistedPreferences {
  schema: 'eva.data-source-preferences.v1'
  orders: Record<string, string[]>
}

export interface DataSourceRoutingOrder {
  category: DataSourceCategory
  source_ids: readonly string[]
}

const sourceKey = (providerId: string, sourceId: string) => `${providerId}:${sourceId}`

export class DataSourcePreferences {
  private readonly orders = new Map<string, string[]>()
  private readonly ready: Promise<void>

  constructor(
    private readonly listProviders: () => readonly InstrumentProvider[],
    private readonly path?: string,
  ) {
    this.ready = this.load()
  }

  async list(): Promise<DataSourceRoutingOrder[]> {
    await this.ready
    const categories = new Set<DataSourceCategory>()
    for (const provider of this.listProviders()) {
      for (const source of provider.dataSources ?? []) {
        for (const category of source.categories) categories.add(category)
      }
    }
    const orders = [...categories]
      .map((category) => ({ category, source_ids: this.normalizedOrder(category) }))
    await this.apply(orders)
    return orders
  }

  async update(category: string, requestedOrder: readonly unknown[]): Promise<DataSourceRoutingOrder> {
    await this.ready
    const available = this.availableSourceIds(category)
    if (!available.length) throw new Error('unknown data source category')
    if (
      requestedOrder.length !== available.length ||
      requestedOrder.some((value) => typeof value !== 'string') ||
      new Set(requestedOrder).size !== requestedOrder.length ||
      requestedOrder.some((value) => !available.includes(value as string))
    ) {
      throw new Error('source_ids must contain every available source exactly once')
    }
    const normalized = requestedOrder as string[]
    this.orders.set(category, [...normalized])
    await this.persist()
    const order = { category: category as DataSourceCategory, source_ids: normalized }
    await this.apply([order])
    return order
  }

  async orderProviders(category: DataSourceCategory): Promise<readonly InstrumentProvider[]> {
    const orders = await this.list()
    const order = orders.find((candidate) => candidate.category === category)?.source_ids ?? []
    const positions = new Map(order.map((id, index) => [id, index]))
    return this.listProviders()
      .map((provider, index) => ({
        provider,
        index,
        priority: Math.min(
          ...(provider.dataSources ?? [])
            .filter((source) => source.categories.includes(category))
            .map((source) => positions.get(sourceKey(provider.id, source.id)) ?? Number.MAX_SAFE_INTEGER),
        ),
      }))
      .sort((left, right) => left.priority - right.priority || left.index - right.index)
      .map(({ provider }) => provider)
  }

  private availableSourceIds(category: string): string[] {
    return this.listProviders().flatMap((provider) =>
      (provider.dataSources ?? [])
        .filter((source) => source.categories.some((candidate) => candidate === category))
        .map((source) => sourceKey(provider.id, source.id)),
    )
  }

  private normalizedOrder(category: DataSourceCategory): string[] {
    const available = this.availableSourceIds(category)
    const availableSet = new Set(available)
    const configured = (this.orders.get(category) ?? []).filter((id) => availableSet.has(id))
    const configuredSet = new Set(configured)
    return [...configured, ...available.filter((id) => !configuredSet.has(id))]
  }

  private async apply(orders: readonly DataSourceRoutingOrder[]): Promise<void> {
    for (const order of orders) {
      for (const provider of this.listProviders()) {
        if (!provider.setDataSourceOrder) continue
        const prefix = `${provider.id}:`
        const sourceIds = order.source_ids
          .filter((id) => id.startsWith(prefix))
          .map((id) => id.slice(prefix.length))
        await provider.setDataSourceOrder(order.category, sourceIds)
      }
    }
  }

  private async load(): Promise<void> {
    if (!this.path) return
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as PersistedPreferences
      if (parsed.schema !== 'eva.data-source-preferences.v1' || !parsed.orders || typeof parsed.orders !== 'object') {
        throw new Error('unsupported data source preferences schema')
      }
      for (const [category, ids] of Object.entries(parsed.orders)) {
        if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) this.orders.set(category, [...ids])
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async persist(): Promise<void> {
    if (!this.path) return
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const payload: PersistedPreferences = {
      schema: 'eva.data-source-preferences.v1',
      orders: Object.fromEntries(this.orders),
    }
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
  }
}
