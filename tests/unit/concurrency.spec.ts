import { describe, expect, it } from 'vitest'

import {
  BoundedExecutor,
  SingleFlight,
} from '../../packages/transport-http/src/concurrency.js'

describe('concurrency controls', () => {
  it('bounds active work while allowing queued work to complete', async () => {
    const executor = new BoundedExecutor(3)
    let active = 0
    let maximum = 0

    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      executor.run(async () => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        return index
      })))

    expect(maximum).toBe(3)
    expect(results).toEqual(Array.from({ length: 12 }, (_, index) => index))
  })

  it('coalesces identical active work and clears failures', async () => {
    const flights = new SingleFlight()
    let calls = 0
    const task = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return 'result'
    }

    await expect(Promise.all([
      flights.run('same', task),
      flights.run('same', task),
      flights.run('same', task),
    ])).resolves.toEqual(['result', 'result', 'result'])
    expect(calls).toBe(1)

    await expect(flights.run('failure', async () => {
      throw new Error('failed')
    })).rejects.toThrow('failed')
    await expect(flights.run('failure', async () => 'recovered')).resolves.toBe('recovered')
  })
})
