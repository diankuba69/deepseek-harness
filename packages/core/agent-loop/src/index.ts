/**
 * Concrete agent-loop plugin: creates scoped ReactLoopAgents, publishes them
 * through the agent/session registries, and owns their ordered teardown.
 *
 * @module @deepseek-ai/dsh-agent-loop
 */
import type { Volatile } from '@deepseek-ai/cosmokit'

import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
  ModelSelection,
  ModelSelectionProjectionState,
  InboxState,
} from '@deepseek-ai/dsh-agent'
import { modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import { errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { interruptedTurnClosers, SessionLogOffset, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { ReactLoopAgent } from './agent.ts'
import { inboxProjectionDefinition } from './inbox.ts'
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from './constants.ts'
import type {} from './runtime-context.ts'

/** Fiber states that cannot own or serve a new lifecycle. */
const INACTIVE_STATES: ReadonlySet<FiberState> = new Set([
  FiberState.UNLOADING,
  FiberState.DISPOSED,
  FiberState.FAILED,
])

/** Re-throw one collected failure as itself, or several as one `AggregateError`. */
function throwCollectedFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}

/** Factory-level ownership: live agent teardowns plus config startup work. */
class FactoryOwnership {
  private accepting = true
  private readonly teardown = new AbortController()
  private readonly inactive = Promise.withResolvers<void>()
  private readonly liveAgents = new Set<() => Promise<void>>()
  private startupTasks = new Set<Promise<void>>()

  constructor(private readonly fiber: Context['fiber']) {}

  /** Aborts (reason: `agent loop is not active` error) when factory teardown begins. */
  get signal(): AbortSignal {
    return this.teardown.signal
  }

  isActive(): boolean {
    return this.accepting && !INACTIVE_STATES.has(this.fiber.state)
  }

  /** Track one live agent's shared teardown until it has run. */
  track(dispose: () => Promise<void>): () => void {
    this.liveAgents.add(dispose)
    return () => { this.liveAgents.delete(dispose) }
  }

  /** Join config startup work that begins before an agent exists. */
  trackStartup(job: Promise<void>): void {
    this.startupTasks.add(job)
    const forget = () => { this.startupTasks.delete(job) }
    void job.then(forget, forget)
  }

  /** Join one public create/resume continuation; factory dispose awaits its settlement. */
  trackWrapper(job: Promise<unknown>): void {
    this.trackStartup(job.then(() => undefined, () => undefined))
  }

  /** Resolve `task`, or stop waiting when factory teardown begins. */
  async waitWhileActive(job: Promise<void>): Promise<void> {
    await Promise.race([job, this.inactive.promise])
  }

  async dispose(): Promise<void> {
    this.accepting = false
    this.teardown.abort(new Error('agent loop is not active'))
    this.inactive.resolve()
    const settlements = await Promise.allSettled([
      ...[...this.liveAgents].map(dispose => dispose()),
      ...this.startupTasks,
    ])
    const failures: unknown[] = []
    for (const result of settlements) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    throwCollectedFailures(failures, 'agent loop disposal failed')
  }
}

/** Await `operation`, or throw the signal's reason as soon as it aborts. */
async function raceAbort<T>(operation: PromiseLike<T> | T, signal: AbortSignal, id: SessionId): Promise<T> {
  const toAbortError = (): Error => signal.reason instanceof Error
    ? signal.reason
    : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  if (signal.aborted) throw toAbortError()
  const aborted = Promise.withResolvers<never>()
  const listener = (): void => { aborted.reject(toAbortError()) }
  signal.addEventListener('abort', listener, { once: true })
  try {
    return await Promise.race([Promise.resolve(operation), aborted.promise])
  } finally {
    signal.removeEventListener('abort', listener)
  }
}

/** Reject an output-token cap that cannot be represented exactly on the request wire. */
function assertAgentOptions(options: AgentOptions): void {
  if (options.maxTokens !== undefined
    && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
    throw new TypeError('agent maxTokens must be a positive safe integer')
  }
}

/** One session's owned write handle plus the count of events already stored through it. */
interface StoredSession {
  readonly handle: SessionHandle
  storedCount: number
}

/** Acquired Session resources and composition inputs for one Agent initialization. */
interface AgentInitializationOptions {
  readonly session: Session
  readonly agentOptions: AgentOptions
  readonly source: SessionStartSource
  readonly stored?: StoredSession | undefined
  readonly setup?: AgentSetup | undefined
  readonly signal?: AbortSignal | undefined
  readonly parentAgent?: Agent | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoop: AgentLoop
    /**
     * Launcher-owned exact session identities for configured agents, keyed by
     * the agent's config `id` and set with `ctx.provide()` before any Loader
     * entry mounts (see {@link CONFIGURED_AGENT_IDENTITIES_KEY}). A launcher
     * owns identity because only it knows whether the session already exists,
     * while the `cordis.yml` row keeps the model route as ordinary patchable
     * config. An entry with no matching key keeps its configured identity.
     */
    configuredAgentIdentities?: ConfiguredAgentIdentities
  }
  interface Events {
    /**
     * A declarative agent entry failed before it could publish a live agent.
     * Consumers that buffer work for the configured identity use this
     * transient signal to reject that work instead of waiting forever. Normal
     * factory teardown suppresses failures from the cancelled startup attempt.
     * @param payload.sessionId - exact shared agent/session identity that failed startup.
     * @param payload.error - persistence, setup, or publication failure.
     * @mode emit
     */
    'agent-loop/config-start-failed'(payload: { sessionId: SessionId; error: unknown }): void
  }
}

export { DEFAULT_MAX_PARALLEL_TOOL_CALLS }

/**
 * One launcher-selected session identity for a configured agent. `resume`
 * distinguishes rehydrating existing persisted history from creating the
 * session fresh under that exact id, which the two config keys express as
 * `resumeSessionId` and `sessionId`.
 */
export interface LauncherAgentIdentity {
  /** Exact session id to create fresh or resume. */
  id: SessionId
  /** Resume existing persisted history instead of creating the session fresh. */
  resume: boolean
}

/** Launcher-selected identities keyed by the configured agent's `id`. */
export interface ConfiguredAgentIdentities extends Readonly<Record<string, LauncherAgentIdentity>> {}

/**
 * Context key a launcher sets before any Loader entry mounts
 * (`ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, identities)`) to fix
 * configured agents' session identities without a config key, so an overlay
 * repointing the row's model route cannot drop them.
 */
export const CONFIGURED_AGENT_IDENTITIES_KEY = 'configuredAgentIdentities'

/**
 * Apply launcher-owned identities over the configured agents, replacing both
 * identity keys for every entry the launcher named so a config-supplied
 * identity can never survive alongside a launcher-supplied one.
 * @param agents - the configured agent entries.
 * @param identities - launcher identities keyed by configured agent `id`, or `undefined`.
 * @returns the entries with launcher-owned identities applied.
 */
function applyLauncherIdentities(
  agents: Config['agents'],
  identities: ConfiguredAgentIdentities | undefined,
): Config['agents'] {
  if (identities === undefined) return agents
  return agents.map((agent) => {
    const identity = identities[agent.id]
    if (identity === undefined) return agent
    const { sessionId: _sessionId, resumeSessionId: _resumeSessionId, ...rest } = agent
    return identity.resume
      ? { ...rest, resumeSessionId: identity.id }
      : { ...rest, sessionId: identity.id }
  })
}

/** Agent-loop plugin configuration. */
export interface Config {
  /**
   * Maximum parallel-safe calls in flight per agent step. `1` is serial;
   * omission defaults to {@link DEFAULT_MAX_PARALLEL_TOOL_CALLS}.
   */
  maxParallelToolCalls: Volatile<number>
  /** Agents created or resumed at plugin startup; a resumed agent records its configured route as the Session's model selection. */
  agents: (AgentOptions & {
    /** Stable config label used in logs and as the fresh combined-id prefix. */
    id: string
    /** Optional stable identity; remounts resume its materialized history, while first use creates it fresh. */
    sessionId?: SessionId
    /** Optional workspace for a fresh session. */
    cwd?: string
    /** Persisted session to resume instead of creating a fresh session. */
    resumeSessionId?: SessionId
  })[]
}

/** Reject self-contained identity conflicts before any configured agent starts. */
function validateConfiguredAgents(agents: Config['agents']): void {
  const exactIdentities = new Map<SessionId, string>()
  for (const { id, sessionId, resumeSessionId } of agents) {
    const hasResumeId = resumeSessionId !== undefined && resumeSessionId !== ''
    if (sessionId !== undefined && hasResumeId) {
      throw new Error(`agent "${id}": sessionId and resumeSessionId are mutually exclusive`)
    }
    const exactIdentity = hasResumeId ? resumeSessionId : sessionId
    if (exactIdentity === undefined) continue
    const firstId = exactIdentities.get(exactIdentity)
    if (firstId !== undefined) {
      throw new Error(`agents "${firstId}" and "${id}" use duplicate exact session identity "${exactIdentity}"`)
    }
    exactIdentities.set(exactIdentity, id)
  }
}

/** Concrete agent factory and driver service. */
export class AgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']

  /** Runtime schema for declarative agents. */
  static Config: z<{ agents?: Config['agents']; maxParallelToolCalls?: number }, Config> = z.object({
    maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS).volatile(),
    agents: z.array(z.object({
      id: z.string().required(),
      sessionId: z.string().min(1),
      provider: z.string(),
      model: z.string(),
      reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId>>,
      maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
      cwd: z.string(),
      resumeSessionId: z.string(),
    })).default([]),
  }) as z<{ agents?: Config['agents']; maxParallelToolCalls?: number }, Config>

  /** Validated configuration owned by the agent-loop service. */
  readonly config: Config
  private readonly ownership: FactoryOwnership
  /** Plain holder prevents Cordis from re-tracing the factory's dependency context through a caller shadow. */
  private readonly runtime: { ctx: Context }
  private modelProjectionHandle!: ProjectionHandle<ModelSelectionProjectionState>
  private inboxProjectionHandle!: ProjectionHandle<InboxState>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentLoop')

    this.config = {
      agents: applyLauncherIdentities(config.agents, ctx.get(CONFIGURED_AGENT_IDENTITIES_KEY)),
      maxParallelToolCalls: config.maxParallelToolCalls,
    }
    validateConfiguredAgents(this.config.agents)
    this.ownership = new FactoryOwnership(ctx.fiber)
    this.runtime = { ctx }
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.runtime.ctx
    const ownership = this.ownership
    // Agent projections remain readable until teardown finishes.
    ctx.effect(() => () => ownership.dispose(), 'agentLoop.transactions()')
    this.modelProjectionHandle = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
    this.inboxProjectionHandle = await ctx.sessionProjections.register(inboxProjectionDefinition)
    ctx.effect(() => ctx.agents.setFactory(this), 'agentLoop.setFactory()')
    ctx.systemPrompt.variable('provider', context => context.modelSelection?.provider ?? context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.modelSelection?.model ?? context.agent?.options.model)

    for (const { id, sessionId, cwd, resumeSessionId, ...options } of this.config.agents) {
      const meta = cwd === undefined ? {} : { cwd }
      if (resumeSessionId === undefined || resumeSessionId === '') {
        const configuredId = sessionId ?? brandString<SessionId>(`${id}-session-${randomUUID()}`)
        const persistence = sessionId === undefined ? undefined : ctx.get('sessionPersistence')
        if (persistence === undefined) {
          const startup = this.create(configuredId, options, meta).then(() => undefined, (error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'restore', configuredId, error)
          })
          this.ownership.trackStartup(startup)
        } else {
          const startup = this.restoreOrCreateConfigured(ctx, configuredId, options, meta).catch((error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'restore', configuredId, error)
          })
          this.ownership.trackStartup(startup)
        }
        continue
      }
      ctx.effect(() => {
        const fiber = ctx.inject(['sessionPersistence'], (_childCtx: Context) => {
          void this.resume(ctx, {
            resumeSessionId,
            agentOptions: options,
            setup: (_agentCtx, agent) => { this.applyConfiguredRoute(agent, options) },
          }).catch((error: unknown) => {
            this.reportConfiguredStartupFailure(id, 'resume', resumeSessionId, error)
          })
        })
        return fiber.dispose
      }, `agentLoop.resume(${id})`)
    }
  }

  private applyConfiguredRoute(agent: Agent, options: AgentOptions): void {
    const { provider, model, reasoningEffort } = options
    if (!provider || !model) return
    const previous = agent.model.current()
    const selection: ModelSelection = { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
    if (selection.reasoningEffort === undefined && previous !== undefined
      && previous.provider === selection.provider && previous.model === selection.model
      && previous.reasoningEffort !== undefined) {
      selection.reasoningEffort = previous.reasoningEffort
    }
    agent.model.select(selection)
  }

  /** Report a contained declarative-start failure to identity-bound consumers. */
  private reportConfiguredStartupFailure(
    configId: string,
    action: 'restore' | 'resume',
    sessionId: SessionId,
    error: unknown,
  ): void {
    if (!this.ownership.isActive()) return
    this.ctx.logger.warn(`agent "${configId}": config-driven ${action} of "${sessionId}" failed: ${errorChain(error)}`)
    const args: unknown[] = ['agent-loop/config-start-failed', { sessionId, error }]
    for (const callback of this.ctx.events.dispatch('emit', args)) {
      try {
        const returned: unknown = callback(...args)
        void Promise.resolve(returned).catch((listenerError: unknown) => {
          this.ctx.logger.warn(`agent "${configId}": config-start-failed listener rejected: ${errorChain(listenerError)}`)
        })
      } catch (listenerError: unknown) {
        this.ctx.logger.warn(`agent "${configId}": config-start-failed listener threw: ${errorChain(listenerError)}`)
      }
    }
  }

  /** Restore a materialized exact config identity on remount, or create it on first use. */
  private async restoreOrCreateConfigured(
    ownerCtx: Context,
    sessionId: SessionId,
    agentOptions: AgentOptions,
    meta: Pick<SessionHeader, 'cwd'>,
  ): Promise<void> {
    await this.waitForDrainingConfiguredIdentity(ownerCtx, sessionId)
    if (!this.ownership.isActive()) return
    try {
      await this.resume(ownerCtx, {
        resumeSessionId: sessionId,
        agentOptions,
        setup: (_agentCtx, agent) => { this.applyConfiguredRoute(agent, agentOptions) },
      })
      return
    } catch (error: unknown) {
      if (!this.ownership.isActive()) return
      // Only a genuinely absent stored session falls back to first creation;
      // corruption, ownership conflicts, and backend failures stay loud.
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error
    }
    await this.create(sessionId, agentOptions, meta)
  }

  /** Wait for a draining same-id lifecycle to finish registry teardown. */
  private async waitForDrainingConfiguredIdentity(ownerCtx: Context, sessionId: SessionId): Promise<void> {
    // Only an id still occupying a registry needs waiting for; a live healthy
    // occupant is a collision the create/resume below will surface itself.
    if (ownerCtx.agents.get(sessionId) === undefined && ownerCtx.sessions.get(sessionId) === undefined) return

    const released = Promise.withResolvers<void>()
    const checkReleased = (): void => {
      if (ownerCtx.agents.get(sessionId) === undefined && ownerCtx.sessions.get(sessionId) === undefined) {
        released.resolve()
      }
    }
    const disposeAgentListener = ownerCtx.on('agent/disposed', () => { checkReleased() })
    const disposeSessionListener = ownerCtx.on('session/disposed', checkReleased)
    try {
      checkReleased()
      await this.ownership.waitWhileActive(released.promise)
    } finally {
      disposeAgentListener()
      disposeSessionListener()
    }
  }

  /**
   * Own initialization and teardown from an acquired Session to a published Agent.
   * Registers factory teardown and caller cancellation before constructing the scope.
   * Failed initialization drains cleanup while retaining stored events and inbox input.
   * @param ownerCtx - caller context that owns the Agent lifecycle.
   * @param options - acquired Session/write handle, loop options, start source, parent Agent, setup, and cancellation.
   * @returns the initialized Agent and its shared disposer.
   */
  private async initializeAgent(
    ownerCtx: Context,
    options: AgentInitializationOptions,
  ): Promise<AgentHandle> {
    const { session, agentOptions, source, stored, setup, signal: callerSignal, parentAgent } = options
    const id = session.id
    const loopCtx = this.runtime.ctx

    // Deactivation fuses three owners, each with its own reason: the caller's
    // cancellation signal, the owner fiber's unload, and factory teardown.
    // It is registered BEFORE any resource exists, over mutable slots, so an
    // unload arriving while the scope is still minting finds a working
    // disposer instead of a leak.
    const abort = new AbortController()
    const onCallerAbort = (): void => {
      abort.abort(callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new Error(`agent "${id}" creation aborted`, { cause: callerSignal?.reason }))
    }
    const onFactoryTeardown = (): void => { abort.abort(this.ownership.signal.reason) }
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    this.ownership.signal.addEventListener('abort', onFactoryTeardown, { once: true })

    let machine: ReactLoopAgent | undefined
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    let publication: ReturnType<typeof Promise.withResolvers<void>> | undefined
    let ready = false
    const machineReady = Promise.withResolvers<void>()
    // Reverse teardown, memoized so every racing owner awaits one quiescence:
    // stop the machine, unwind the scope, drain and close the session's write
    // path, leave the registries, release bookkeeping.
    const teardown = (): Promise<void> => (disposing ??= (async () => {
      abort.abort(new Error(this.ownership.isActive()
        ? `agent "${id}" lifecycle disposed`
        : 'agent loop is not active'))
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.ownership.signal.removeEventListener('abort', onFactoryTeardown)
      // Teardown failures are collected, never swallowed: registry, scope,
      // and ownership cleanup always run to quiescence, then the memoized
      // disposal rejects with what failed so every racing owner observes it.
      const failures: unknown[] = []
      try {
        // Creation listeners retain the session and scope through their awaits.
        if (publication !== undefined) await publication.promise
        // Disposal IS a disposed-cause cancel followed by quiescence. New work
        // sent after this point is the sender's bug — the registries are about
        // to drop the agent, so nothing should still hold it.
        /* v8 ignore next -- Cordis effect teardown waits for synchronous setup before observing the machine slot. */
        if (machine === undefined) await machineReady.promise
        /* v8 ignore next -- setup failure untracks this disposer before resolving without a machine. */
        if (machine !== undefined) {
          machine.cancel({ kind: 'disposed' }, { keepInbox: !ready })
          await machine.whenIdle()
        }
      } catch (error: unknown) {
        failures.push(error)
      }
      try {
        await machine?.scope.dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
      // Close drains events already routed into the handle. The backend's
      // live-event listeners must stay mounted through driver shutdown to
      // receive all closing events. A failed final drain is retained here
      // rather than logged away.
      try {
        await stored?.handle.close()
      } catch (error: unknown) {
        failures.push(error)
      }
      try {
        detachAgent?.()
        detachSession?.()
      } finally {
        untrack()
      }
      throwCollectedFailures(failures, `agent "${id}" disposal failed`)
    })())
    let unfollowScope: (() => Promise<void> | void) | undefined
    let unfollowOwner: () => Promise<void> | void
    const dispose = async (): Promise<void> => {
      try {
        await teardown()
      } finally {
        await Promise.all([unfollowOwner(), unfollowScope?.()])
      }
    }
    const untrack = this.ownership.track(dispose)
    try {
      assertAgentOptions(agentOptions)
      ownerCtx.fiber.assertActive()
      // Factory dispatch and resume's load barrier already require a live owner.
      /* v8 ignore next -- unreachable backstop for factory ownership */
      if (!this.ownership.isActive()) throw new Error('agent loop is not active')
      if (callerSignal?.aborted) {
        throw callerSignal.reason instanceof Error
          ? callerSignal.reason
          : new Error(`agent "${id}" creation aborted`, { cause: callerSignal.reason })
      }
      const lastTurn = loopCtx.agents.turnBoundaryOf(session).lastTurn
      const projections = {
        modelSelection: this.modelProjectionHandle.readerFor(session),
        inbox: this.inboxProjectionHandle.readerFor(session),
      }
      unfollowOwner = ownerCtx.effect(function* () {
        const created = machine = new ReactLoopAgent(
          loopCtx, id, agentOptions, session,
          projections,
          lastTurn,
        )
        machineReady.resolve()
        // Adopt the scope on its original fiber so it cannot unload before teardown.
        // A loop already unloading during minting owns the provisional scope itself.
        if (!INACTIVE_STATES.has(loopCtx.fiber.state)) {
          unfollowScope = loopCtx.effect(function* () {
            yield created.scope.rawDispose
            yield () => teardown()
          }, `agentLoop.scope(${id})`)
        }
        yield async () => {
          abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
          try {
            await teardown()
          } finally {
            await unfollowScope?.()
          }
        }
      }, `agentLoop.lifecycle(${id})`)
    } catch (error: unknown) {
      machineReady.resolve()
      untrack()
      callerSignal?.removeEventListener('abort', onCallerAbort)
      this.ownership.signal.removeEventListener('abort', onFactoryTeardown)
      await stored?.handle.close().catch((closeError: unknown) => {
        // Error inisialisasi tetap utama; kegagalan pelepasan handle tetap terlihat.
        loopCtx.logger.error(closeError)
      })
      throw error
    }

    const assertLive = (): void => {
      if (!abort.signal.aborted) return
      // Every fused abort source carries an Error reason: onCallerAbort and
      // raceAbort wrap non-Error caller reasons, and the factory/lifecycle
      // owners abort with constructed Errors.
      /* v8 ignore next -- unreachable String() arm, see above */
      throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason))
    }
    try {
      /* v8 ignore next -- a synchronous effect exhausts the generator before returning */
      if (machine === undefined) throw new Error(`agent "${id}" lifecycle did not construct its driver`)
      const agent = machine
      assertLive()

      return await agent.runMaintenance(async () => {
        publication = Promise.withResolvers<void>()
        try {
          assertLive()
          await this.appendUnstoredSuffix(stored, session)
          assertLive()
          detachSession = agent.ctx.sessions.enter(session)
          agent.ctx.sessions.announce(session)
          assertLive()
          const setupCommit = await raceAbort(setup?.(agent.ctx, agent), abort.signal, id)
          assertLive()
          setupCommit?.commit()
          assertLive()
          // The mounted backend routes announced live events into the active
          // write handle by session id; the loop only owns the handle itself.
          detachAgent = loopCtx.agents.enter(agent, parentAgent)
          await loopCtx.agents.announce(agent, source, abort.signal)
          assertLive()
          ready = true
          return { agent, dispose }
        } catch (error: unknown) {
          // Failed initialization must not release queued input into a new turn.
          agent.cancel({ kind: 'disposed' }, { keepInbox: true })
          throw error
        } finally {
          publication.resolve()
          publication = undefined
        }
      })
    } catch (error: unknown) {
      await dispose().catch((disposeError: unknown) => {
        // Error inisialisasi tetap utama setelah cleanup selesai; kegagalan drain tetap dilaporkan.
        loopCtx.logger.error(disposeError)
      })
      throw error
    }
  }

  /**
   * Create an agent and session under one caller-supplied identity, owned by
   * the accessing fiber. Constructor-driven config calls mint a fresh combined
   * id before entering this boundary. When a persistence backend is mounted,
   * the session's durable identity and any seed are stored before publication.
   * @param id - shared agent/session identity.
   * @param options - concrete loop options.
   * @param meta - optional fresh-session workspace metadata.
   * @returns the published running agent.
   */
  async create(id: SessionId, options: AgentOptions = {}, meta: Pick<SessionHeader, 'cwd'> = {}): Promise<Agent> {
    return (await this.createAgent(this.ctx, { sessionId: id, agentOptions: options, meta })).agent
  }

  /**
   * Mempertahankan backend yang sama sejak akuisisi hingga rollback atau teardown Agent selesai.
   * Penolakan publik saat pembatalan tidak melepaskan dependency sebelum operasi backend selesai.
   */
  private async withPersistence(
    ownerCtx: Context,
    id: SessionId,
    callerSignal: AbortSignal | undefined,
    operation: (persistence: SessionPersistence | undefined, signal: AbortSignal, beginInitialization: () => void) => Promise<AgentHandle>,
  ): Promise<AgentHandle> {
    ownerCtx.fiber.assertActive()
    if (!this.ownership.isActive()) throw new Error('agent loop is not active')
    if (this.runtime.ctx.get('sessionPersistence') === undefined) {
      return operation(undefined, AbortSignal.any([
        this.ownership.signal, ...callerSignal === undefined ? [] : [callerSignal],
      ]), () => {})
    }
    const abort = new AbortController()
    const signal = AbortSignal.any([
      abort.signal, this.ownership.signal, ...callerSignal === undefined ? [] : [callerSignal],
    ])
    const unfollowOwner = ownerCtx.effect(() => async () => {
      abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
      await fiber.dispose()
      await fiber.await()
    }, `agentLoop.persistence-owner(${id})`)
    let pending: Promise<AgentHandle> | undefined
    const phase = { initializing: false }
    const fiber = this.runtime.ctx.inject(['sessionPersistence'], (childCtx: Context) => {
      childCtx.effect(() => async () => {
        signal.removeEventListener('abort', stop)
        abort.abort(new Error(`agent "${id}" persistence lifecycle disposed`))
        // Hanya akuisisi ini yang memiliki fiber; replacement provider tidak menghidupkannya kembali.
        stop()
        const handle = await pending?.catch((_acquisitionError: unknown) => {
          // Promise publik menangani kegagalan akuisisi; rollback melaporkan error cleanup sendiri.
          return undefined
        })
        await handle?.dispose()
      }, `agentLoop.persistence(${id})`)
      pending = operation(childCtx.sessionPersistence, signal, () => { phase.initializing = true })
      this.ownership.trackWrapper(pending)
    })
    const stop = (): void => {
      void (async () => {
        await fiber.dispose()
        await fiber.await()
        await unfollowOwner()
      })().catch((error: unknown) => { ownerCtx.logger.error(error) })
    }
    signal.addEventListener('abort', stop, { once: true })
    const published = (async () => {
      await fiber
      await raceAbort(undefined, signal, id)
      if (pending === undefined) throw new Error(`agent "${id}" persistence backend is not active`)
      return await pending
    })()
    this.ownership.trackWrapper(published)
    try {
      const handle = await raceAbort(published, signal, id)
      return {
        agent: handle.agent,
        async dispose() {
          try {
            await handle.dispose()
          } finally {
            await fiber.dispose()
            await fiber.await()
            await unfollowOwner()
          }
        },
      }
    } catch (error: unknown) {
      stop()
      if (phase.initializing) await pending?.catch(() => undefined)
      if (pending === undefined) await unfollowOwner()
      throw error
    }
  }

  /**
   * Durably store the session events appended since the last stored cursor.
   * @param stored - the session's owned handle and stored cursor, if any.
   * @param session - the unpublished session whose suffix is stored.
   */
  private async appendUnstoredSuffix(stored: StoredSession | undefined, session: Session): Promise<void> {
    if (stored === undefined) return
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
    if (suffix.length > 0) await stored.handle.append(suffix)
    stored.storedCount += suffix.length
  }

  /**
   * Create an owned agent on a caller-supplied session id.
   * @param ownerCtx - caller context that structurally owns the lifecycle.
   * @param options - identities, optional live parent, session seed/metadata, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const published = this.withPersistence(ownerCtx, options.sessionId, options.signal, async (persistence, signal, begin) => {
      using preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: options.seed },
        ...options.meta === undefined ? {} : { meta: options.meta },
        ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
      }))
      await raceAbort(undefined, signal, options.sessionId)
      const handle = await persistence?.create(preparation.session.header, {
        inheritedEventCount: preparation.session.inheritedEventCount,
        signal,
      })
      begin()
      return await this.initializeAgent(ownerCtx, {
        session: preparation.session,
        stored: handle === undefined ? undefined : { handle, storedCount: 0 },
        agentOptions: options.agentOptions ?? {},
        setup: options.setup,
        signal,
        source: 'startup',
        parentAgent: options.parentAgent,
      })
    })
    this.ownership.trackWrapper(published)
    return published
  }

  /**
   * Resume an owned agent from the configured persistence service.
   * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
   * @param options - persisted identity, optional live parent, loop options, setup, and cancellation.
   * @returns the published handle.
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const id = options.resumeSessionId
    const published = this.withPersistence(ownerCtx, id, options.signal, async (persistence, signal, beginInitialization) => {
      if (persistence === undefined) {
        throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
      }
      await raceAbort(undefined, signal, id)
      let handle: SessionHandle | undefined
      let preparation: SessionPreparation | undefined
      try {
        handle = await persistence.open(id, 'write', { signal })
        await raceAbort(undefined, signal, id)
        const coldRead = await handle.read(0, undefined, { signal })
        await raceAbort(undefined, signal, id)
        const persisted = coldRead.events
        const closers = interruptedTurnClosers(persisted)
        if (closers.length > 0) await handle.append(closers)
        preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(id, {
          seed: [...persisted, ...closers],
          meta: structuredClone(handle.header),
          inheritedEventCount: handle.inheritedEventCount,
          eventState: coldRead.eventState,
        }))
        const stored = { handle, storedCount: persisted.length + closers.length }
        await this.appendUnstoredSuffix(stored, preparation.session)
        handle = undefined
        beginInitialization()
        return await this.initializeAgent(ownerCtx, {
          session: preparation.session,
          stored,
          agentOptions: options.agentOptions ?? {},
          setup: options.setup,
          signal,
          source: 'resume',
          parentAgent: options.parentAgent,
        })
      } finally {
        preparation?.[Symbol.dispose]()
        await handle?.close().catch((error: unknown) => { ownerCtx.logger.error(error) })
      }
    })
    this.ownership.trackWrapper(published)
    return published
  }
}

export default AgentLoop
