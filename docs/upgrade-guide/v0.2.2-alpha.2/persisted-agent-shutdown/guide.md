---
kind: upgrade-guide
description: Persisted Agent disposal waits for canceled backend acquisition and closes active Agents before backend replacement.
---

# Persisted Agent shutdown

English | [中文](guide.zh.md)

## Change

AgentLoop retains a persistence backend until its Agents finish and their write handles close. Root shutdown saves final cancellation events. Unloading a backend cancels its persisted Agents before releasing storage; memory-only Agents and the factory remain available.

A canceled `ctx.agents.create()` or `ctx.agents.resume()` can reject while backend acquisition is pending. Caller and AgentLoop disposal now wait for that acquisition to settle and close its late handle, instead of completing while rollback remains outstanding.

## Migration

1. Custom `SessionPersistence` providers must settle canceled `create` and `open` calls and support uncancellable `SessionHandle.close()`. Honor the supplied `AbortSignal` so shutdown need not await an unbounded backend operation.
2. Await owner disposal before replacing its resources; after backend replacement, explicitly resume any stopped Agents you still need.
3. Verify graceful shutdown by reopening a session for write and checking its final `turn/end` and canceled inbox events. Session formats and existing persisted files do not change.
