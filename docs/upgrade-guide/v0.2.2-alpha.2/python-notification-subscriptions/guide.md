---
kind: upgrade-guide
description: "Python notification subscriptions discard queued notifications on close and retain terminal errors across reads."
---

# Python notification subscriptions terminate persistently

English | [中文](guide.zh.md)

## Change

Previously, `NotificationSubscription.close()` detached delivery but left queued notifications readable and pending readers blocked. Transport or filter failures appeared once; later reads and subscriptions created after runtime termination could wait indefinitely.

Closing a subscription now discards its queue and wakes all pending readers. Closing an active subscription sets `TransportClosedError`; an earlier terminal error remains unchanged. Runtime and filter failures preserve queued notifications, then `next()` and `drain()` keep raising the first terminal error. New subscriptions after runtime termination fail immediately. Restarting `HarnessClient` does not reactivate old subscriptions. Public method signatures remain unchanged.

## Migration

1. In Python SDK consumers, read required queued notifications before calling `NotificationSubscription.close()`.
2. Catch `TransportClosedError` around notification reads and stop reading a terminated subscription. Handle filter exceptions separately; they terminate only the affected subscription. A local `TimeoutError` still permits another read.
3. After `HarnessClient.close()` and `start()`, call `subscribe_notifications()` or `subscribe_session_notifications()` again for the new runtime.
4. Confirm that closing a subscription wakes pending readers, repeated terminal reads raise, and a new subscription receives notifications after restart. See the [SDK reference](../../../../python/sdk/README.md).
