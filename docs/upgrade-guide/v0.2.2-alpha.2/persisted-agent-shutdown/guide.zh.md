---
kind: upgrade-guide
description: 持久化 Agent 释放会等待被取消的后端获取，并在替换后端前关闭活跃 Agent。
---

# 持久化 Agent 关闭

[English](guide.md) | 中文

## 变更

AgentLoop 保留持久化后端，直到其 Agent（智能体）结束且写句柄关闭。根上下文关闭会保存最终取消事件。卸载后端会先取消其持久化 Agent，再释放存储；纯内存 Agent 和 factory 保持可用。

被取消的 `ctx.agents.create()` 或 `ctx.agents.resume()` 可以在后端获取尚未完成时拒绝。调用方和 AgentLoop 释放现在会等待该获取结束并关闭迟到句柄，不再在回滚未完成时就结束。

## 迁移

1. 自定义 `SessionPersistence` 提供方 必须使被取消的 `create` 和 `open` 调用结束，并支持不可取消的 `SessionHandle.close()`。遵守传入的 `AbortSignal`，避免关闭等待无界后端操作。
2. 替换所有者资源前等待其释放；替换后端后，显式恢复仍需要的已停止 Agent。
3. 以写模式重新打开会话，检查最终 `turn/end` 和已取消收件箱事件，验证有序关闭。Session 格式和现有持久文件不变。
