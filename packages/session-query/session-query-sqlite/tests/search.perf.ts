/** Diagnostik lokal pencarian SQLite melalui artefak produksi; bukan gate waktu CI. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'

const workloads = {
  typical: { live: 4, events: 40, persisted: 0 },
  corpus: { live: 24, events: 40, persisted: 0 },
  history: { live: 4, events: 2000, persisted: 0 },
  mixed: { live: 16, events: 1000, persisted: 16 },
} as const
const name = process.argv[2]
assert(name !== undefined && Object.hasOwn(workloads, name), 'Pilih typical, corpus, history, atau mixed')
const workload = workloads[name as keyof typeof workloads]
assert(globalThis.gc !== undefined, 'Jalankan dengan --expose-gc')
const collect = globalThis.gc
function events(count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'user/message', seq: SessionSeq(index), time: index + 1, surfaceOp: 'append',
    data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: `${index % 8 === 0 ? 'needle ' : ''}Synthetic ${index} ${'ordinary context '.repeat(index % 10 === 0 ? 128 : 16)}`,
    }] }),
  }))
}
const root = await mkdtemp(join(tmpdir(), 'dsh-search-perf-'))
const ctx = new Context()
const fibers: Fiber[] = []
try {
  fibers.push(await ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(SessionProjectionRegistry))
  if (workload.persisted > 0) {
    fibers.push(await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' }))
    for (let index = 0; index < workload.persisted; index += 1) {
      const handle = await ctx.sessionPersistence.create({
        version: SESSION_FORMAT_VERSION, id: SessionId(`persisted-${index}`), createdAt: index, isSeeded: false,
      })
      try { await handle.append(events(40)) } finally { await handle.close() }
    }
  }
  for (let index = 0; index < workload.live; index += 1) {
    ctx.sessions.create(SessionId(`live-${index}`), { seed: events(workload.events), meta: { createdAt: index } })
  }
  fibers.push(await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'derived.db') }))
  collect(); collect()
  const baseline = process.memoryUsage()
  const maxRSSBeforeKiB = process.resourceUsage().maxRSS
  const phases: Record<string, number[]> = {}
  const retainedOutputs: unknown[] = []
  let sampledHeapMax = baseline.heapUsed
  let sampledRssMax = baseline.rss
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  histogram.enable()
  await delay(10)
  const sampleMemory = (): void => {
    const memory = process.memoryUsage()
    sampledHeapMax = Math.max(sampledHeapMax, memory.heapUsed)
    sampledRssMax = Math.max(sampledRssMax, memory.rss)
  }
  const timer = setInterval(sampleMemory, 1)
  async function measure<T>(phase: string, operation: () => Promise<T>): Promise<T> {
    const start = performance.now()
    const result = await operation()
    ;(phases[phase] ??= []).push(performance.now() - start)
    retainedOutputs.push(result)
    sampleMemory()
    // Biarkan timer mengamati stall terakhir sebelum fase berikutnya.
    await delay(2)
    return result
  }
  try {
    const first = await measure('cold', () => ctx.sessionQuery.searchSessions({ query: 'needle', limit: 2 }))
    assert.equal(first.items.length, 2)
    const firstCursor = first.nextCursor
    assert(firstCursor)
    for (let index = 0; index < 6; index += 1) {
      const page = await measure('warm', () => ctx.sessionQuery.searchSessions({ query: 'needle', limit: 2 }))
      assert.deepEqual(page, first)
    }
    const next = await measure('pagination', () => ctx.sessionQuery.searchSessions({ query: 'needle', limit: 2, cursor: firstCursor }))
    assert.equal(next.items.length, 2)
    assert(!first.items.some(item => next.items.some(other => item.header.id === other.header.id)))
    for (let index = 0; index < 6; index += 1) {
      const page = await measure('targeted', () => ctx.sessionQuery.searchEvents({ sessionId: SessionId('live-0'), query: 'needle', limit: 2 }))
      assert.equal(page.items.length, 2)
    }
    await delay(10)
  } finally {
    clearInterval(timer)
    histogram.disable()
  }
  collect(); collect()
  const retained = process.memoryUsage()
  console.log(JSON.stringify({ name, workload, node: process.version, platform: process.platform,
    phases, eventLoopDelayMaxMs: histogram.max / 1e6, baseline, retained,
    retainedHeapDelta: retained.heapUsed - baseline.heapUsed, sampledHeapMax, sampledRssMax,
    maxRSSBeforeKiB, maxRSSAfterKiB: process.resourceUsage().maxRSS, outputs: retainedOutputs.length,
    liveSessions: ctx.sessions.list().length,
  }))
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
