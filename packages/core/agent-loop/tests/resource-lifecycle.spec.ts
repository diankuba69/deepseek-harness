import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { setImmediate } from 'node:timers/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { MockAdapter, textResponse } from './mock-adapter.ts'

it.each([0, 1, 2])('retains Agent resources until all work exits with %i failed teardowns', async (failures) => {
  const ctx = new Context()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    release.resolve(undefined)
    await ctx.fiber.dispose()
  })
  await mountAgentLoopTestDependencies(ctx)
  const loop = await ctx.plugin(AgentLoop, { agents: [] })
  const failed = []
  for (let index = 0; index < failures; index++) {
    const handle = await ctx.agents.create({ sessionId: SessionId(`failed-cleanup-${index}`) })
    const error = new Error(`teardown failure ${index}`)
    vi.spyOn(handle.agent, 'cancel').mockImplementation(() => { throw error })
    failed.push({ handle, error })
  }
  let ownerCtx!: Context
  const owner = await ctx.plugin(Object.assign((inner: Context) => { ownerCtx = inner }, { inject: ['agents'] }))
  const { agent } = await ownerCtx.agents.create({ sessionId: SessionId('pending-cleanup') })
  const aborted = Promise.withResolvers<undefined>()
  let workExited = false
  let scopeDisposedBeforeWorkExit = false
  let scopeDisposed = false
  let abortHandled = 0
  const controller = new AbortController()
  controller.signal.addEventListener('abort', () => {
    agent.cancel({ kind: 'parent' })
    agent.cancel({ kind: 'parent' })
    abortHandled++
  }, { once: true })
  agent.ctx.effect(() => () => {
    controller.abort()
    controller.abort()
    scopeDisposed = true
    scopeDisposedBeforeWorkExit = !workExited
  })
  const projections = ctx.sessionProjections
  const work = agent.runMaintenance(async (signal) => {
    signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    await release.promise
    workExited = true
  })
  const disposal = loop.dispose()
  await aborted.promise
  const ownerDisposal = owner.dispose()
  // Drain runnable unload callbacks while the Agent is held at an explicit barrier.
  await setImmediate()
  release.resolve(undefined)
  await work
  await Promise.all([disposal, ownerDisposal])
  for (const { handle, error } of failed) await expect(handle.dispose()).rejects.toBe(error)
  expect(scopeDisposedBeforeWorkExit).toBe(false)
  expect(scopeDisposed).toBe(true)
  expect(abortHandled).toBe(1)
  expect(projections.checkpoint(agent.session).inbox).toBeUndefined()
  expect(projections.checkpoint(agent.session).turnBoundary).toBeDefined()
  expect(ctx.agents.get(agent.id)).toBeUndefined()
  expect(ctx.sessions.get(agent.session.id)).toBeUndefined()
})

it.each(['loop', 'root'] as const)('unloads %s while a background child is stopping', async (owner) => {
  const ctx = new Context()
  const release = Promise.withResolvers<undefined>()
  const root = mkdtempSync(join(tmpdir(), 'dsh-resource-lifecycle-'))
  onTestFinished(async () => {
    release.resolve(undefined)
    await ctx.fiber.dispose()
    await ctx.fiber.await()
    rmSync(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root })
  const loop = await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(SubagentSpawn)
  await ctx.plugin(ToolSubagent, { provider: 'spawn' })
  ctx.jobs.attachController('resource-lifecycle')
  const parentId = SessionId('background-parent')
  const childCancelObserved = Promise.withResolvers<undefined>()
  ctx.on('agent/created', ({ agent }) => {
    const cancel = agent.cancel.bind(agent)
    vi.spyOn(agent, 'cancel').mockImplementation((cause, options) => {
      if (agent.id !== parentId) childCancelObserved.resolve(undefined)
      cancel(cause, options)
    })
  })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('unused')]))
  const { agent: parent } = await ctx.agents.create({
    sessionId: parentId, agentOptions: { provider: 'mock', model: 'mock' },
  })
  const requestEntered = Promise.withResolvers<Agent>()
  ctx.on('agent/request', async (event, next) => {
    expect(event.agent).not.toBe(parent)
    requestEntered.resolve(event.agent)
    await release.promise
    return next()
  })
  const started = await executeToolFixture(ctx, {
    agent: parent, signal: new AbortController().signal,
    callId: ToolCallId('background-start'), name: 'subagent',
    arguments: { description: 'child', prompt: 'wait' },
  })
  expect(started.isError).toBe(false)
  const child = await requestEntered.promise
  for (const target of ['next-step', 'next-turn'] as const) {
    child.send(createUserMessage({ content: [{ type: 'text', text: target }], source: { kind: 'user' } }), target, false)
  }
  let disposed = false
  const disposal = (owner === 'loop' ? loop.dispose() : ctx.fiber.dispose()).then(() => { disposed = true })
  // Teardown cancels the in-flight child while it is still inside agent/request.
  await childCancelObserved.promise
  expect(disposed).toBe(false)
  release.resolve(undefined)
  await disposal
  expect(child.status).toBe('idle')
  const events = child.session.snapshotEvents()
  expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  expect(events.filter(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled'))
    .toMatchObject([
      { data: { target: 'next-step', removedCount: 1 } },
      { data: { target: 'next-turn', removedCount: 1 } },
    ])
  const verify = new Context()
  onTestFinished(async () => { await verify.fiber.dispose() })
  await verify.plugin(JsonlSessionPersistence, { root })
  const reader = await verify.sessionPersistence.open(child.id, 'write')
  expect((await reader.read()).events).toEqual(events)
  await reader.close()
})

it.each([false, true])('releases the Agent scope after cancel failure with scope failure %s', async (failScope) => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  let ownerCtx!: Context
  const owner = await ctx.plugin(Object.assign((inner: Context) => { ownerCtx = inner }, { inject: ['agents'] }))
  const handle = await ownerCtx.agents.create({ sessionId: SessionId('failed-owner-cleanup') })
  let scopeDisposed = false
  handle.agent.ctx.effect(() => () => { scopeDisposed = true })
  const failure = new Error('teardown failure')
  vi.spyOn(handle.agent, 'cancel').mockImplementation(() => { throw failure })
  const scopeFailure = new Error('scope teardown failure')
  if (failScope) {
    const fiber = handle.agent.ctx.fiber
    const rawDispose = fiber.dispose
    vi.spyOn(fiber, 'dispose').mockImplementation(async () => {
      await rawDispose()
      throw scopeFailure
    })
  }
  await owner.dispose()
  if (failScope) await expect(handle.dispose()).rejects.toMatchObject({ errors: [failure, scopeFailure] })
  else await expect(handle.dispose()).rejects.toBe(failure)
  expect(scopeDisposed).toBe(true)
})

it.each(['create', 'resume'] as const)('retains persistence until a direct %s Agent stops during provider unload', async (operation) => {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-provider-lifecycle-'))
  const release = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    release.resolve(undefined)
    await ctx.fiber.dispose()
    await ctx.fiber.await()
    rmSync(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const memory = await ctx.agents.create({ sessionId: SessionId('memory-agent') })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('seed')]))
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root })
  const sessionId = SessionId('direct-persisted-agent')
  let handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
  if (operation === 'resume') {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'seed' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    await handle.dispose()
    handle = await ctx.agents.resume({ resumeSessionId: sessionId })
  }
  const { agent } = handle
  const canceled = Promise.withResolvers<undefined>()
  const cancel = agent.cancel.bind(agent)
  vi.spyOn(agent, 'cancel').mockImplementation((cause, options) => {
    cancel(cause, options)
    canceled.resolve(undefined)
  })
  const entered = Promise.withResolvers<undefined>()
  ctx.on('agent/request', async (_event, next) => {
    entered.resolve(undefined)
    await release.promise
    return next()
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'pending request' }], source: { kind: 'user' } }))
  await entered.promise
  for (const target of ['next-step', 'next-turn'] as const) {
    agent.send(createUserMessage({ content: [{ type: 'text', text: target }], source: { kind: 'user' } }), target, false)
  }
  let disposed = false
  const disposal = persistence.dispose().then(() => { disposed = true })
  expect(await Promise.race([canceled.promise.then(() => 'canceled'), disposal.then(() => 'disposed')])).toBe('canceled')
  expect(disposed).toBe(false)
  release.resolve(undefined)
  await disposal
  await handle.dispose()
  expect(ctx.agents.get(sessionId)).toBeUndefined()
  expect(ctx.agents.get(memory.agent.id)).toBe(memory.agent)
  const events = agent.session.snapshotEvents()
  expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  expect(events.filter(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled'))
    .toMatchObject([{ data: { target: 'next-step', removedCount: 1 } }, { data: { target: 'next-turn', removedCount: 1 } }])
  await ctx.plugin(JsonlSessionPersistence, { root })
  const reopened = await ctx.sessionPersistence.open(sessionId, 'write')
  expect((await reopened.read()).events).toEqual(events)
  await reopened.close()
  const replacement = await ctx.agents.create({ sessionId: SessionId('replacement-provider-agent') })
  await replacement.dispose()
})

it.each(['create', 'resume'] as const)('holds the backend until canceled %s acquisition closes its late handle', async (operation) => {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-acquisition-lifecycle-'))
  const release = Promise.withResolvers<undefined>()
  onTestFinished(async () => {
    release.resolve(undefined)
    await ctx.fiber.dispose()
    await ctx.fiber.await()
    rmSync(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root })
  const sessionId = SessionId('late-acquisition')
  if (operation === 'resume') {
    const seed = await ctx.agents.create({ sessionId })
    seed.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'saved input' }], source: { kind: 'user' } }))
    await seed.dispose()
  }
  const entered = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  let closeCompleted = false
  let providerClosedBeforeHandle = false
  const originalCreate = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  const originalOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
  const waitForRelease = async (handle: Awaited<ReturnType<typeof originalCreate>>, signal?: AbortSignal) => {
    const close = handle.close.bind(handle)
    vi.spyOn(handle, 'close').mockImplementation(async () => {
      await close()
      closeCompleted = true
    })
    signal?.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    entered.resolve(undefined)
    await release.promise
    return handle
  }
  if (operation === 'create') {
    vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (header, options) =>
      waitForRelease(await originalCreate(header, options), options?.signal))
  } else {
    vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (id, access, options) =>
      waitForRelease(await originalOpen(id, access, options), options?.signal))
  }
  const creating = operation === 'create'
    ? ctx.agents.create({ sessionId })
    : ctx.agents.resume({ resumeSessionId: sessionId })
  const outcome = creating.then(() => 'published', () => 'rejected')
  await entered.promise
  let disposed = false
  const disposal = ctx.fiber.dispose().then(() => {
    providerClosedBeforeHandle = !closeCompleted
    disposed = true
  })
  await aborted.promise
  expect(await outcome).toBe('rejected')
  expect(disposed).toBe(false)
  release.resolve(undefined)
  await disposal
  expect(closeCompleted).toBe(true)
  expect(providerClosedBeforeHandle).toBe(false)
  const verify = new Context()
  onTestFinished(async () => { await verify.fiber.dispose() })
  await verify.plugin(JsonlSessionPersistence, { root })
  if (operation === 'resume') {
    const reopened = await verify.sessionPersistence.open(sessionId, 'write')
    await reopened.close()
  } else {
    const reopened = await verify.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: 0,
    })
    await reopened.close()
  }
})

it('reports a failed final close while releasing every persisted Agent during root shutdown', async () => {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-close-failure-'))
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await ctx.fiber.await()
    rmSync(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  const failure = new Error('final drain failed')
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => {
    const handle = await create(header, options)
    if (header.id === 'failed-close') {
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close()
        throw failure
      })
    }
    return handle
  })
  const failed = await ctx.agents.create({ sessionId: SessionId('failed-close') })
  const healthy = await ctx.agents.create({ sessionId: SessionId('healthy-close') })
  for (const { agent } of [failed, healthy]) {
    agent.inject(createUserMessage({ content: [{ type: 'text', text: 'pending' }], source: { kind: 'user' } }))
  }
  const errors = vi.spyOn(ctx.logger, 'error')
  await ctx.fiber.dispose()
  await expect(failed.dispose()).rejects.toBe(failure)
  await healthy.dispose()
  expect(errors).toHaveBeenCalledWith(failure)
  const verify = new Context()
  onTestFinished(async () => { await verify.fiber.dispose() })
  await verify.plugin(JsonlSessionPersistence, { root })
  for (const { agent } of [failed, healthy]) {
    const handle = await verify.sessionPersistence.open(agent.id, 'write')
    expect((await handle.read()).events).toEqual(agent.session.snapshotEvents())
    await handle.close()
  }
})

it('retains the factory backend when the caller has an isolated persistence provider', async () => {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-persistence-binding-'))
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await ctx.fiber.await()
    rmSync(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'factory') })
  await ctx.plugin(AgentLoop, { agents: [] })
  const isolated = ctx.isolate('sessionPersistence')
  await isolated.plugin(JsonlSessionPersistence, { root: join(root, 'caller') })
  const sessionId = SessionId('factory-backend')
  const handle = await isolated.agents.create({ sessionId })
  handle.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'retained' }], source: { kind: 'user' } }))
  await handle.dispose()
  const reader = await ctx.sessionPersistence.open(sessionId, 'write')
  expect((await reader.read()).events).toEqual(handle.agent.session.snapshotEvents())
  await reader.close()
  await expect(isolated.sessionPersistence.open(sessionId, 'read')).rejects.toThrow(/not found/)
})

it('cancels independent persisted Agents before waiting for either one to stop', async () => {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-parallel-persistence-'))
  const releases = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  onTestFinished(async () => {
    for (const release of releases) release.resolve(undefined)
    await ctx.fiber.dispose()
    await ctx.fiber.await()
    rmSync(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const aborts: Promise<void>[] = []
  const work: Promise<void>[] = []
  for (const [index, release] of releases.entries()) {
    const { agent } = await ctx.agents.create({ sessionId: SessionId(`parallel-${index}`) })
    const aborted = Promise.withResolvers<undefined>()
    aborts.push(aborted.promise)
    work.push(agent.runMaintenance(async (signal) => {
      signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      await release.promise
    }))
  }
  let disposed = false
  const disposal = ctx.fiber.dispose().then(() => { disposed = true })
  await Promise.all(aborts)
  expect(disposed).toBe(false)
  for (const release of releases) release.resolve(undefined)
  await Promise.all(work)
  await disposal
})
