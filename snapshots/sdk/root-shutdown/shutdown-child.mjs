/** Menahan Agent milik plugin hingga root shutdown membatalkannya. */
export const inject = ['agents', 'loader']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Runtime fixture. */
export async function apply(ctx) {
  const { SessionId } = await ctx.loader.import('@deepseek-ai/dsh-session')
  const { createUserMessage } = await ctx.loader.import('@deepseek-ai/dsh-llm')
  const entered = Promise.withResolvers()
  let childId
  const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    if (agent.id !== childId) return next()
    const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    agent.send(message('queued next step'), 'next-step', false)
    agent.send(message('queued next turn'), 'next-turn', false)
    entered.resolve()
    await aborted
    return next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (childId !== undefined) return
    childId = SessionId(`${agent.id}-shutdown-child`)
    const child = await ctx.agents.create({
      sessionId: childId,
      parentAgent: agent,
      agentOptions: agent.options,
      meta: { cwd: agent.session.header.cwd, parentSession: agent.id, delegationDepth: 1 },
    })
    child.agent.followup(message('wait for root shutdown'))
    await entered.promise
  })
}
