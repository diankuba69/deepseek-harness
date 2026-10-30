# Agent Note: Retain the acquired persistence backend through Agent teardown

Status: implemented

English | [中文](2026-10-31-agent-persistence-lifetime.zh.md)

## Problem

AgentLoop read the optional persistence service without declaring a lifetime dependency. The JSONL provider already composed service withdrawal before listener removal and writer closure, but a root or provider unload could release those resources before an Agent emitted its final cancellation events. The earlier [handle-based persistence decision](2026-08-27-handle-based-session-persistence.md) permitted this tail loss; graceful shutdown must preserve actual outcomes rather than rely on later crash repair.

## Decision

Each persisted Agent acquisition owns a child fiber injected with `sessionPersistence` before backend `create` or `open` begins. The same binding supplies the handle and remains retained through acquisition rollback or the Agent's existing memoized teardown. Cleanup cancels work, awaits idle, disposes the scope, closes the write handle, and removes registry entries before releasing the dependency. The child stays outside the Agent scope and awaits the inner teardown, so neither scope disposal nor the public handle waits on itself.

Cancellation while backend acquisition is pending rejects the public call promptly, while owner and factory disposal await the backend's settlement and close any late handle. Once Agent initialization begins, failure retains the existing rollback-before-rejection guarantee. Cleanup failures remain observable, and one failed handle cannot prevent independent Agents from draining.

Pinned Cordis retains implementation dependents until their cleanup finishes, even after their registry removal. Together with the JSONL provider's existing composed effects, the per-acquisition dependency retains final-event routing and storage through root shutdown. This guarantee depends on both consumer dependency ownership and provider resource composition; it does not establish correct cleanup for other providers.

Memory-only Agents acquire no persistence dependency. Provider unload cancels only Agents using that backend; replacement never adopts an old handle and the factory remains available. Independent Agent teardowns remain concurrent. Session formats and crash repair are unchanged.

## Alternatives considered

**Require persistence in AgentLoop's static injection.** This would remove supported memory-only operation and couple every Agent to an optional provider.

**Acquire the dependency after obtaining a handle.** Provider disposal can overlap a pending `create` or `open`; the handle could arrive after its storage owner closed.

**Release ownership when the public call rejects.** A canceled backend operation can still return a handle. Releasing its provider first leaves rollback outside an observable lifecycle.

**Serialize all plugin disposal.** The necessary order concerns one acquired backend and its consumers; global ordering changes unrelated lifetimes and creates avoidable deadlock risks.

## Consequences

Graceful shutdown persists final inbox cancellation, `step/end`, and `turn/end` before releasing write ownership. A backend that ignores cancellation can delay disposal until its acquisition settles; callers must not interpret early public rejection as complete resource cleanup. Abrupt termination still requires crash repair.

Agent-loop lifecycle tests compare live and reopened logs, reclaim write leases, exercise direct create/resume, provider replacement, late acquisition, and failure cleanup. TypeScript and Python SDK root-shutdown scenarios run shipped profiles with an active plugin-owned child and pin its durable suffix alongside the parent SDK projection. Other resource-owner findings remain in the [partial cleanup proposal](../../proposed/architecture/2026-10-09-cordis-cleanup-dependency-lifetimes.md).
