---
kind: upgrade-guide
description: "Atomic writes with a secondary close or staging-cleanup failure report FS_IO_ERROR instead of FS_NOT_FOUND."
---
# Atomic-write double failures use FS_IO_ERROR

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-fs-local` now reports `FS_IO_ERROR` when an atomic write fails and closing its temporary file or removing its staging directory also fails. These combined failures previously reported `FS_NOT_FOUND`. Filesystem consumers and tool-result consumers that route errors by code are affected. The primary failure remains in the cause chain, and the message retains the secondary failure. The previous target remains unchanged; a staging-cleanup failure can leave private residue. Cleanup failure after successful publication still preserves write success.

## Migration

1. Update error-code handling and expected outputs for combined atomic-write failures from `FS_NOT_FOUND` to `FS_IO_ERROR`. Keep missing-path handling on `FS_NOT_FOUND`.
2. Confirm that a failed publication followed by failed staging cleanup, or a failed write or sync followed by failed close, follows the I/O-error path. Inspect the cause chain and message for both failures; resolve the I/O problem and remove private staging residue before retrying.
