---
kind: upgrade-guide
description: "当回退累积超出预算时，持久 shell 的部分结果可能保留输出尾部。"
---

# 持久 shell 回退保留有界尾部

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-tool-bash-persistent` 和 `@deepseek-ai/dsh-tool-pwsh-persistent` 以前没有为回退输出的累积设置内存预算，并裁剪返回的前缀。当 terminal 滚动回溯缺少起始标记且回退累积超出预算时，部分结果现在返回最后 `maxOutputChars` 个字符，并附上回退保留通知。完整的滚动回溯结果保留现有的选择和状态行为。工具参数和配置键不变。

## 迁移

1. 更新假定每个部分 `bash` 或 `pwsh` 结果都从命令输出开头开始的使用方。将回退保留通知视为不完整的尾部。
2. 如果任务需要完整输出，将命令重定向到工作区文件，并通过文件工具读取相关范围。
3. 确认大型中断命令报告裁剪，并且后续调用保留文档所述的 shell 重置行为。输出限制见 [Bash](../../../../packages/shell/tool-bash-persistent/README.zh.md) 和 [PowerShell](../../../../packages/shell/tool-pwsh-persistent/README.zh.md) 包参考。
