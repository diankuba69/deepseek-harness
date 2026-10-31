# Agent Note: 在消费者清理完成前保持清理依赖可用

Status: proposed

[English](2026-10-09-cordis-cleanup-dependency-lifetimes.md) | 中文

## 问题

一个 disposer（清理函数）可能仍在等待消费者，另一个 disposer 却已经移除消费者需要的监听器或关闭资源。因此，等待 provider（提供者）的最终释放 promise，不能保证资源在此期间一直可用。这会影响关闭与插件替换，包括最终 Session 事件、已接受的提醒投递、凭据提交和远程进程终止。

[Cordis 审查 skill](../../../skills/cordis-styling-nitpicking/SKILL.md#p0-cleanup-dependency-released-before-consumer-completion) 将这种生命周期违规归为 P0。固定版本的 [Fiber 卸载 (`Fiber._unload`)](../../../../vendor/cordis/src/fiber.ts) 在释放 provider fiber 的 effect 前，会保留声明的实现依赖者直到其全部清理完成，包括并发根释放。同级或父 effect 拥有的资源仍需与服务撤销显式组合。[事件订阅 (`EventsService.register`)](../../../../vendor/cordis/src/events.ts) 是独立拥有的 effect，包括通过追踪调用方的服务上下文建立的订阅。

## 提案

让每项必需资源的所有者，在消费者完成全部异步清理之前保留该资源。停止接收新工作，完成已接受的工作和最终发布，然后排空并释放资源。将实际 disposer 组合成明确等待的所有权顺序；返回包装函数不能收纳独立注册的原始 effect。保留取消和错误报告，同时保证一次失败不会绕过余下清理。

以下审查记录了 2026-10-09 检查到的生产路径。Session 生命周期要求已实现；其他领域仍为提案，该修复没有重新审查它们。发现仅针对清理依赖规则，不覆盖 skill 中独立的单例与未撤销副作用规则。

## P0 发现

### Session 持久化生命周期已实现

[Agent 持久化生命周期决定](../../implemented/architecture/2026-10-31-agent-persistence-lifetime.zh.md)从获取开始保留一个注入后端，直到回滚或最终 Agent teardown 完成。结合 JSONL 现有服务与 tracker 组合 effect，它在根释放和 provider 卸载期间保留最终事件路由。聚焦测试比较实时与重新打开的历史、重新获取写所有权，并覆盖迟到获取与清理失败；两种 SDK 快照路径保留被取消子 Agent 的尾部。

[基于句柄的持久化决定](../../implemented/architecture/2026-08-27-handle-based-session-persistence.zh.md)保留其句柄 API 与存储所有权；其原先允许有序关闭丢失尾部的策略被替代。[逻辑会话存储提案](2026-09-06-logical-session-storage-rebuild.zh.md)若重新分配入队所有权，必须保留此顺序。无需修改 Session 格式或全局串行化 Cordis 释放。

### Storage 在 Schedule 提交已接受的投递前关闭

**所有者与证据。** storage-domain 插件独立注册[设施关闭与服务提供 (`apply / DomainFacility.closeAll`)](../../../../packages/storage/storage-domain/src/index.ts)。[Domain close (`DomainImpl.runClose`)](../../../../packages/storage/storage-domain/src/domain.ts) 将 domain 标记为 disposing，[之后的入队会拒绝 (`DomainImpl.enqueue`)](../../../../packages/storage/storage-domain/src/domain.ts)。Schedule [等待运行时与管理工作后才关闭自己的 domain (`ScheduleService`)](../../../../packages/schedule/schedule/src/index.ts)。已接受的投递[先 flush Session，再结束任务或推进下一次执行 (`ScheduleRuntime.drive`)](../../../../packages/schedule/schedule/src/runtime.ts)。

**失败与修正。** 暂停该 Session flush，卸载 storage-domain，然后放行 flush。provider 的同级关闭器可以在 Schedule 仍在排空时将 domain 标记为关闭，导致最终任务提交失败。已持久化到 inbox 的提醒在任务存储中仍处于活动状态，重启后可能再次投递。应先撤销服务并等待消费者，再关闭剩余 domain；在 domain 排空期间保留后端存储单元。[JSON 后端](../../../../packages/storage/storage-json/src/index.ts)与 [SQLite 后端](../../../../packages/storage/storage-sqlite/src/index.ts)也存在同级关闭的所有权风险，应纳入同一次实现审查，而不应在未确认消费者时另立发现。

使用实际 Cordis 与 storage-domain 实现的内存实验，在注入消费者最终写入前暂停，开始释放 provider，再放行消费者，得到 `domain 'audit' is closed`。这复现了资源提前关闭；完整 Schedule 重启后果由源码追踪得出。Session 持久化与任务提交之间已有的崩溃窗口仍然存在；有序关闭不应通过提前关闭存储主动制造这个窗口。

### Authorization 丢失必需的提交观察或已接受的凭据写入

**所有者与证据。** Authorization 的[提交观察器 (`AuthorizationService.attempt`)](../../../../packages/credentials/authorization/src/index.ts)是调用方拥有的 `ctx.on` effect。[提交操作 (`AuthorizationService.attempt`)](../../../../packages/credentials/authorization/src/index.ts)等待凭据存储，而[成功要求观察到更新 (`AuthorizationService.attempt`)](../../../../packages/credentials/authorization/src/index.ts)。账号服务[不会中止正在提交的尝试，并等待其完成 (`PlatformAccount`)](../../../../packages/credentials/deepseek-account-platform/src/index.ts)。

**写入成功，却报告失败。** 暂停凭据写入，释放账号消费者，再完成写入并发出更新。观察器可以与账号的排空并发自动退订；随后 Authorization 即使存储成功也会以 `NOT_COMMITTED` 拒绝。应让操作拥有观察器直到结果确定，或直接确认成功的 `session.commit`，同时给旧式直接写入观察明确的生命周期。使用实际 Cordis 与 Authorization、配合延迟的内存凭据 provider 的实验，复现了 provider 写入成功后返回 `NOT_COMMITTED`；完整浏览器登录路径由源码追踪确认。

**provider 释放期间拒绝已接受的写入。** 另一个问题是，credentials-local [先设置 `closed` 再等待队列操作 (`LocalCredentialProvider[Service.init]`)](../../../../packages/credentials/credentials-local/src/index.ts)，而[排队中的记录写入再次检查该标志 (`LocalCredentialProvider.modifyRecord`)](../../../../packages/credentials/credentials-local/src/index.ts)。当较早的文档操作暂停时，账号已进入提交阶段；provider 开始释放后队列继续推进，该已接受写入仍可能被拒绝。应区分新工作准入与已接受操作，并保留写入能力直到依赖者的提交排空。此变体由源码追踪确认，未单独复现。仅修复观察器无法解决它。

### SSH 在依赖者的进程清理完成前禁用清理请求

**所有者与证据。** SSH 服务的[释放逻辑 (`SshConnection.disposeOnce`)](../../../../packages/ssh/ssh/src/index.ts)在等待 helper 关闭前设置 `closed` 并中止自身 lifetime。[请求检查 (`SshConnection.assertOpen`)](../../../../packages/ssh/ssh/src/index.ts)拒绝后续使用。注入该服务的 subprocess provider [在清理时终止并等待存活进程与终端 (`SshSubprocessRuntime`)](../../../../packages/ssh/subprocess-ssh/src/index.ts)，这些工作需要 SSH 请求。

**失败与修正。** 即使有 `inject = ['ssh']`，SSH provider 释放仍可以在 subprocess 清理需要终止和退出确认时关闭请求准入。依赖者因此报告无法确认 SSH 进程清理。应保留清理请求能力直到依赖者结束，再关闭 helper、socket 和 master。helper 自身的 close 也会尝试远程清理：证据证明清理能力丢失与可能的释放错误，并不证明必然留下远程孤儿进程。聚焦复现使用实际 Cordis、SSH 与 subprocess provider，模拟子进程和文件系统传输。启动进程，并在退出等待 RPC 准入后卸载 SSH，句柄以 `SSH connection is closed` 拒绝；helper 收到 `close`，却未收到 `process.terminate`。这验证了 provider 组合中的缺陷，没有验证实际远程进程是否完全停止。

### Windows sandbox 在消费者清理期间释放进程临时资源

**所有者与证据。** 本地 sandbox 的[同级清理 effect (`LocalSandboxProvider`)](../../../../packages/sandbox/sandbox-local/src/index.ts)调用[权限撤销与临时目录移除 (`LocalSandboxProvider.revokeAclGrants`)](../../../../packages/sandbox/sandbox-local/src/index.ts)。[临时能力 (`LocalSandboxProvider.materializeAclGrant`)](../../../../packages/sandbox/sandbox-local/src/index.ts)属于 provider，并被嵌入受限 runner 的参数中。注入该服务的 Node PTC runtime [中止并等待已接受的运行 (`NodePtcRuntime`)](../../../../packages/ptc-runtime/ptc-runtime-node/src/index.ts)；[完成流程等待进程退出与输出排空 (`NodePtcRuntime.execute`)](../../../../packages/ptc-runtime/ptc-runtime-node/src/index.ts)。

**失败与修正。** 卸载 sandbox 时，PTC 消费者可能仍在等待进程终止，但存活进程的临时目录权限已被撤销，目录已被移除。最终临时文件访问可能失败，删除操作也可能遇到仍在运行的进程。应在已准入进程存活期间保留临时能力，在进程真正停止后再撤销权限并移除目录。长期工作区权限有意保留；本项只涉及可撤销的临时资源。由持有者管理的 shell 进程也需要与进程生命周期绑定的所有权，因此仅排列 executor 卸载顺序并不足够。

受控复现使用实际 Cordis、本地 sandbox provider 与真实临时目录，并模拟 Windows ACL 操作。当注入消费者的 disposer 暂停、provider 释放仍未完成时，目录已不存在，临时权限已被撤销。这确认了 provider 的释放时序；具体 PTC 依赖通过源码追踪确认。未执行原生 Windows 受限令牌访问与存活 PTC 进程终止测试。

## 范围与现有决定

[持久化 PTY 决定](../../implemented/feature/2026-07-16-persistent-pty-sessions.zh.md)继续生效。其提前撤销注册的规则不允许移除完全停稳所需的观察器。准入与可选通知可以先停止；完成操作所需的依赖必须保持可用。这里澄清该清理策略的范围，不替代 PTY 所有权、回滚或进程树清理决定。

四个独立目录扫描分别覆盖 core/session/jobs；执行、SSH、终端、sandbox、subagent 与 workflow；host/client/API/boot/SDK/ACP/MCP/browser/computer 包与 apps；storage/schedule/credentials 及其余 provider 分组。候选发现从清理注册开始，再追踪消费者与资源所有者。刷新检出后，对保留的发现按当前 master 重新验证。这不是对每个包的穷尽语义证明。

当前 AgentLoop 的组合 effect 在 ownership 释放期间保留 projection 注册，因此排除早先的 projection 候选。Jobs 取消已等待结束。Working-directory 和 title 工作在 await 后重新检查取消。Projection-cache 失败明确允许可重建数据降级；已检查的生产 telemetry 消费者按需调用。Session history 的 promotion 候选涉及排空快照之后接纳新工作，没有确认提前释放的清理依赖，因此不纳入本次聚焦规则。

活动 Note 替代审查保留并交叉链接了上面的基于句柄的持久化决定与逻辑会话存储提案：只有有序关闭时的尾部保留发生重叠，而它们的句柄 API、格式、存储分离及其他理由仍然适用。本提案没有完整替代任何 implemented Note。[Host schedule 存储决定](../../implemented/architecture/2026-09-16-host-schedule-storage.zh.md)、[授权流程决定](../../implemented/architecture/2026-08-13-credential-records-and-authorization-flows.zh.md)和[账号登录决定](../../implemented/architecture/2026-09-14-deepseek-account-login.zh.md)继续生效：独立任务权威、当次提交证据与已准入提交的完成仍然必要。已有的 configured 记录不能替代本次尝试成功提交的证据。[Windows ACL sandbox 决定](../../implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.zh.md)也继续生效：临时能力仍可撤销，但最终撤销应排在进程生命周期结束之后。本提案补充缺失的跨所有者释放要求。

## 考虑过的替代方案

**不检查资源所有权就增加注入，或逆转 disposer 注册顺序。** 注入保留实际服务实现直到消费者结束。JSONL 已将资源释放组合在服务撤销之后，因此它可以解决 Session 消费者生命周期；但它不能修复被同级或父 effect 独立关闭的资源。仅逆序调用仍会并发启动同级异步清理。

**全局串行化所有 Cordis disposer。** 这会改变无关生命周期，带来依赖死锁风险，并掩盖具体哪些操作需要哪些资源。显式组合可以在局部表达必要顺序。

**捕获资源已关闭错误或依赖崩溃修复。** 吞掉错误无法恢复未路由的结果或失败的任务提交，还可能将成功的凭据写入报告为失败。崩溃恢复仍适用于突然中断，不能替代有序完成。

**等待完整的存储或 Session 重构。** 逻辑会话提案可能移除对事件路由的依赖，但同一生命周期规则也影响凭据与 SSH。每个所有者都可以建立必要顺序，无需等待所有架构阶段完成。

## 验收标准

- 为每项发现增加受控 promise 回归：在真实消费者最后使用依赖前暂停，开始 provider 或外层所有者释放，放行暂停，并等待操作和释放都完成。验证必需资源与监听器在暂停期间仍然可用，之后确实释放。
- 在处理其他资源所有者时，保留已实现的 [Session 生命周期保证](../../implemented/architecture/2026-10-31-agent-persistence-lifetime.zh.md)。
- Schedule 在 flush 到任务提交的间隔中卸载 provider，仍保留成功投递的最终任务状态；重启不会再次投递已完成的这次提醒。保留单独记录的突然崩溃重复投递策略。
- 成功提交期间释放账号消费者，返回结果应与已存凭据一致。释放凭据 provider 应排空已接受且排队中的提交，并拒绝新准入，不能取消该提交。
- SSH provider 带存活进程和 PTY 卸载时，先完成依赖者的终止与确认，再关闭请求资源。通过真实 helper 验证远程工作完全停止；测试失败传播，不能仅凭顶层进程退出就声称清理成功。
- Windows sandbox 卸载或替换期间，保留临时权限与目录，直到受限进程完成延迟终止与最终临时写入。在原生 Windows 上验证受限令牌访问，再断言权限已撤销、目录已移除。
- 修复交付时更新受影响 provider 文档与当前所属决策；保留持久格式，并为任何改变的用户可见结果补充所需组合与快照覆盖。

## 风险

错误组合依赖可能使关闭死锁或无限保留资源。测试即使失败也必须放行受控暂停，实现必须保留现有外部操作时限策略。延长 provider 存活时间可能增加关闭延迟；隐藏清理失败或静默丢弃必需的最终写入不能作为捷径。

聚焦实验隔离了 storage、Authorization、组合 SSH provider 的释放，以及 sandbox 资源释放时序，没有覆盖完整产品组合或原生 Windows 访问。Schedule 后果、凭据队列变体、实际远程进程退出与原生 sandbox 行为仍需上述集成证据，才能认定修复完成。监听器所有权跟随实际调用方上下文，因此只将清理移动到 provider 对象，而不转移其 effect 所有权，可能仍会保留竞态。
