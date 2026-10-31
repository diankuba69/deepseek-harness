---
kind: upgrade-guide
description: "原子写入遇到次要的关闭句柄或清理临时目录失败时，报告 FS_IO_ERROR 而非 FS_NOT_FOUND。"
---
# 原子写入双重失败使用 FS_IO_ERROR

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-fs-local` 的原子写入失败后，若关闭临时文件或删除临时目录也失败，现在报告 `FS_IO_ERROR`。这些组合失败此前报告 `FS_NOT_FOUND`。按错误码分流的文件系统调用方和工具结果调用方会受影响。主要失败仍保留在 cause 链中，消息保留次要失败。原目标保持不变；临时目录清理失败可能留下私有残留。成功发布后的清理失败仍保持写入成功。

## 迁移

1. 将组合原子写入失败的错误码处理和预期输出从 `FS_NOT_FOUND` 更新为 `FS_IO_ERROR`。缺失路径的处理仍使用 `FS_NOT_FOUND`。
2. 确认发布失败后临时目录清理也失败，或写入或同步失败后关闭句柄也失败时，进入 I/O 错误处理路径。检查 cause 链和消息以了解两次失败；重试前解决 I/O 问题并删除私有临时残留。
