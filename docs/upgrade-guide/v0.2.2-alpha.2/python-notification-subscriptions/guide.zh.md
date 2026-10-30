---
kind: upgrade-guide
description: "Python 通知订阅在关闭时丢弃已排队的通知，并在多次读取中保留终止错误。"
---

# Python 通知订阅持续保持终止状态

[English](guide.md) | 中文

## 变更

此前，`NotificationSubscription.close()` 会停止接收通知，但已排队的通知仍可读取，等待中的读取仍会阻塞。传输或过滤器错误只出现一次；之后的读取，以及运行时终止后创建的订阅，可能无限等待。

现在，关闭订阅会丢弃其队列，并唤醒所有等待中的读取。关闭活动订阅会设置 `TransportClosedError`；若此前已有终止错误，则保持该错误。运行时和过滤器失败会保留已排队的通知，随后 `next()` 与 `drain()` 持续抛出首次终止错误。运行时终止后创建的新订阅立即失败。重启 `HarnessClient` 不会重新激活旧订阅。公开方法签名保持不变。

## 迁移

1. 在 Python SDK 调用方中，先读取需要保留的已排队通知，再调用 `NotificationSubscription.close()`。
2. 在通知读取周围捕获 `TransportClosedError`，并停止读取已终止的订阅。单独处理过滤器异常；这些异常仅终止对应订阅。本地 `TimeoutError` 仍允许再次读取。
3. 调用 `HarnessClient.close()` 和 `start()` 后，再次调用 `subscribe_notifications()` 或 `subscribe_session_notifications()`，为新运行时创建订阅。
4. 确认关闭订阅会唤醒等待中的读取，重复终止读取会抛出异常，并且新订阅在重启后可以接收通知。参见 [SDK 参考](../../../../python/sdk/README.zh.md)。
