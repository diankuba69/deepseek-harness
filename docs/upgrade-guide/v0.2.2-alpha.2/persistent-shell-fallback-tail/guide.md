---
kind: upgrade-guide
description: "Persistent shell partial results can retain the output tail when fallback accumulation exceeds its budget."
---

# Persistent shell fallback keeps a bounded tail

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-tool-bash-persistent` and `@deepseek-ai/dsh-tool-pwsh-persistent` previously accumulated fallback output without a memory budget and clipped the returned prefix. When terminal scrollback lacks the start marker and fallback accumulation exceeds its budget, partial results now return the last `maxOutputChars` characters with a fallback-retention notice. Complete scrollback results keep their existing selection and status behavior. Tool arguments and configuration keys are unchanged.

## Migration

1. Update consumers that assume every partial `bash` or `pwsh` result starts at the beginning of command output. Treat the fallback-retention notice as an incomplete tail.
2. If a task needs complete output, redirect the command to a workspace file and read the relevant range with file tools.
3. Confirm that a large interrupted command reports clipping and that subsequent calls retain the documented shell reset behavior. See the [Bash](../../../../packages/shell/tool-bash-persistent/README.md) and [PowerShell](../../../../packages/shell/tool-pwsh-persistent/README.md) package references for output limits.
