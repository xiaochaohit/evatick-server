import { describe, expect, it } from 'vitest'

import { nextDataSyncRun } from '../../packages/transport-http/src/data-sync-manager.js'

describe('daily data sync scheduling', () => {
  it('can schedule the catalog refresh for 08:00 China Standard Time', () => {
    const beforeRefresh = new Date('2026-08-23T23:59:00.000Z')

    expect(nextDataSyncRun(beforeRefresh, '08:00', false).toISOString())
      .toBe('2026-08-24T00:00:00.000Z')
  })

  it('keeps weekend runs when weekend skipping is disabled', () => {
    const fridayAfterRun = new Date('2026-08-21T11:00:00.000Z')

    expect(nextDataSyncRun(fridayAfterRun, '18:00', false).toISOString())
      .toBe('2026-08-22T10:00:00.000Z')
  })

  it('moves a weekend run to Monday in China Standard Time', () => {
    const fridayAfterRun = new Date('2026-08-21T11:00:00.000Z')

    expect(nextDataSyncRun(fridayAfterRun, '18:00', true).toISOString())
      .toBe('2026-08-24T10:00:00.000Z')
  })

  it('uses China Standard Time independently of the server timezone', () => {
    const fridayBeforeRun = new Date('2026-08-21T09:59:00.000Z')

    expect(nextDataSyncRun(fridayBeforeRun, '18:00', true).toISOString())
      .toBe('2026-08-21T10:00:00.000Z')
  })
})
