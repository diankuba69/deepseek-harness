/** Diagnostik retensi fallback melalui tool dan layanan terminal yang sudah dibangun. */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { unsupportedModel, provideWorkingDirectoryFixture, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalSendOperation,
  TerminalWaitReason,
} from '@deepseek-ai/dsh-terminal'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolBashPersistent from '@deepseek-ai/dsh-tool-bash-persistent'

import { performance } from 'node:perf_hooks'

let callNumber = 0
async function agent(ctx: Context, cwd: string | undefined): Promise<Agent> {
  const id = SessionId(`persistent-bash-owner-${callNumber}`)
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    isSeeded: false,
    ...cwd === undefined ? {} : { cwd },
  })
  const value: Agent = {
    id,
    options: {},
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function call(
  ctx: Context,
  owner: Agent | undefined,
  command: string,
  signal = new AbortController().signal,
) {
  return executeToolFixture(ctx, {
    signal,
    callId: ToolCallId(`persistent-bash-${++callNumber}`),
    name: 'bash',
    arguments: { command },
    ...owner === undefined ? {} : { agent: owner },
  })
}


const rounds = 200
const chunkBytes = 256 * 1024
const ctx = new Context()
provideWorkingDirectoryFixture(ctx)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(NativeToolExecutor)
await ctx.plugin(AgentRegistry)
await ctx.plugin(TerminalSessionService)
let index = 0
let retained = 0
let baseline = 0
let peak = process.memoryUsage().rss
let start = ''
const backend: TerminalBackend = {
  type: 'measurement',
  async spawn() {
    const session: TerminalBackendSession = {
      pid: 123,
      motd: '',
      startSend(request) {
        if (request.text.startsWith('stty -echo')) return operation('', 'stdin_read')
        if (index === 0) start = /__DSH_PERSISTENT_BASH_START_[^_]+__/.exec(request.text)?.[0] ?? ''
        if (index === rounds) {
          global.gc?.()
          retained = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers - baseline
          peak = Math.max(peak, process.memoryUsage().rss)
          return operation('FINAL OUTPUT', 'stdin_read')
        }
        const output = (index === 0 ? start + '\n' : '') + Buffer.from(String(index % 10).repeat(chunkBytes)).toString()
        index++
        peak = Math.max(peak, process.memoryUsage().rss)
        return operation(output, 'inferred_idle')
      },
      read: () => ({ text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false }),
      status: () => ({ kind: 'running' }),
      signal: async () => ({ delivered: true, targetPgid: 123 }),
      close: async () => {},
    }
    return session
  },
}
function operation(delta: string, waitReason: TerminalWaitReason): TerminalSendOperation {
  return {
    done: Promise.resolve({ viewport: '', waitReason, sessionStatus: { kind: 'running' }, truncated: false }),
    readOutput: () => ({ delta, truncated: false }),
    cancel: () => false,
  }
}
ctx.terminals.registerBackend(backend)
await ctx.plugin(ToolBashPersistent, { backendType: 'measurement', maxOutputChars: 1024 })
const owner = await agent(ctx, '/workspace')
global.gc?.()
baseline = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers
const before = performance.now()
const result = text(await call(ctx, owner, 'synthetic fallback'))
const elapsedMs = performance.now() - before
if (!result.includes('<response clipped>')) throw new Error('expected clipped tool output')
process.stdout.write(JSON.stringify({ node: process.version, rounds, chunkBytes, elapsedMs, retainedBytes: retained, peakRssBytes: peak, processMaxRssBytes: process.resourceUsage().maxRSS * 1024, outputChars: result.length }) + '\n')
await ctx.fiber.dispose()
