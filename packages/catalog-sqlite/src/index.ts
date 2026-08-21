import { DatabaseSync } from 'node:sqlite'

import type {
  CatalogSnapshotStore,
  StoredProviderCatalog,
} from '@evatick/core'

export class SqliteCatalogSnapshotStore implements CatalogSnapshotStore {
  private readonly database: DatabaseSync

  constructor(path: string) {
    this.database = new DatabaseSync(path)
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS provider_catalog (
        provider_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      ) STRICT
    `)
  }

  async readProvider(provider: string): Promise<StoredProviderCatalog | undefined> {
    const row = this.database
      .prepare(
        'SELECT snapshot_json, fetched_at FROM provider_catalog WHERE provider_id = ?',
      )
      .get(provider) as
      | { snapshot_json: string; fetched_at: string }
      | undefined
    if (!row) return undefined
    return {
      provider,
      instruments: JSON.parse(row.snapshot_json) as StoredProviderCatalog['instruments'],
      fetchedAt: row.fetched_at,
    }
  }

  async writeProvider(snapshot: StoredProviderCatalog): Promise<void> {
    this.database
      .prepare(`
        INSERT INTO provider_catalog (provider_id, snapshot_json, fetched_at)
        VALUES (?, ?, ?)
        ON CONFLICT(provider_id) DO UPDATE SET
          snapshot_json = excluded.snapshot_json,
          fetched_at = excluded.fetched_at
      `)
      .run(
        snapshot.provider,
        JSON.stringify(snapshot.instruments),
        snapshot.fetchedAt,
      )
  }

  close(): void {
    this.database.close()
  }
}
