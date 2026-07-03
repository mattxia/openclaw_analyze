# 一次性 Shell 调用 vs 长时 Shell 执行 对比分析

## 一、总览对比

| 维度 | 一次性 Shell 调用 | 长时 Shell 执行 |
|------|-------------------|-----------------|
| **核心工具** | `exec`（同步模式） | `exec`（yield/background 模式） + `process` |
| **进程模式** | 前台阻塞，等待退出 | `backgrounded=true`，工具立即返回 |
| **Agent 交互轮次** | **单轮**：调用→等待→获取结果 | **多轮**：启动→轮询→写入→终止 |
| **核心文件** | `bash-tools.exec.ts`, `bash-tools.exec-runtime.ts` | `bash-tools.exec.ts`, `bash-tools.process.ts`, `bash-process-registry.ts` |
| **进程管理层** | `ProcessSupervisor` | `ProcessSupervisor` + `ProcessSession` 注册表 |
| **stdin 交互** | 不支持（`pipe-closed`） | 支持（`pipe-open`），通过 `process write/submit/paste/send-keys` |
| **输出获取** | 一次性返回全部 output | 分批：通过 `process poll` 增量获取 |
| **超时控制** | `timeout` 参数 + `overall-timeout` / `no-output-timeout` | 同上，但 `background=true` 且未显式传 `timeout` 时**绕过超时** |
| **PTY 支持** | 支持 `pty=true` | 支持（交互式 TUI、编码代理等） |

## 二、一次性 Shell 调用 完整流程

### 2.1 流程图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  模型调用 exec 工具：{ command: "ls -la /app", timeout: 30 }                 │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  createExecTool().execute()                                                  │
│  src/agents/bash-tools.exec.ts                                              │
│                                                                             │
│  Step 1: 参数验证                                                            │
│    - command 非空检查                                                        │
│    - background/yield 未设置 → yieldWindow = null（不启用后台）               │
│                                                                             │
│  Step 2: 安全策略解析                                                         │
│    - host: sandbox / gateway / node                                         │
│    - security: deny / allowlist / full                                      │
│    - ask: off / on-miss / always                                            │
│    - elevated 权限检查                                                        │
│                                                                             │
│  Step 3: 环境准备                                                            │
│    - 解析 workdir（沙箱/主机映射）                                            │
│    - 合并环境变量（sanitizeHostBaseEnv）                                      │
│    - PATH 前置配置（pathPrepend）                                            │
│    - 脚本预检（validateScriptFileForShellBleed）                             │
│                                                                             │
│  Step 4: 按 host 路由                                                        │
│    - host=sandbox → Docker exec                                              │
│    - host=gateway → 本地执行 + 白名单审批                                     │
│    - host=node → 远程节点执行                                                 │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  runExecProcess()                                                            │
│  src/agents/bash-tools.exec-runtime.ts                                      │
│                                                                             │
│  Step 5: 创建 ProcessSession（bash-process-registry）                        │
│                                                                             │
│  Step 6: 选择 spawn 模式                                                     │
│    ┌──────────────────────────────────────┐                                  │
│    │ pty=true → mode: "pty" (node-pty)     │                                 │
│    │ 否则    → mode: "child" (child_process)│                                 │
│    │ stdinMode: "pipe-closed"（一次性调用） │                                │
│    └──────────────────────────────────────┘                                  │
│                                                                             │
│  Step 7: 调用 ProcessSupervisor.spawn()                                     │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  ProcessSupervisor.spawn()                                                   │
│  src/process/supervisor/supervisor.ts                                       │
│                                                                             │
│  Step 8: 创建 adapter（ChildAdapter / PtyAdapter）                           │
│  Step 9: 设置超时定时器                                                      │
│    - overall-timeout: timeoutSec → timeoutMs                                 │
│    - no-output-timeout: noOutputTimeoutMs                                   │
│  Step 10: 绑定 stdout/stderr 回调 → 累积到 ProcessSession                    │
│  Step 11: 注册到 RunRegistry（state: running）                               │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  进程执行中...                                                               │
│                                                                             │
│  stdout → handleStdout() → appendOutput(session, "stdout", chunk)            │
│  stderr → handleStderr() → appendOutput(session, "stderr", chunk)            │
│                                                                             │
│  通过 onUpdate 回调实时推送 tail 到模型（输出流式显示）                        │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  进程退出 → managedRun.wait() → RunExit                                      │
│                                                                             │
│  Step 12: 判断退出原因                                                        │
│    - exit → status: "completed" (exitCode=0) / "failed" (exitCode≠0)         │
│    - overall-timeout → status: "failed", reason: "Command timed out..."      │
│    - no-output-timeout → status: "failed"                                    │
│    - signal → status: "failed"                                               │
│                                                                             │
│  Step 13: markExited(session) → 移到 finishedSessions                        │
│  Step 14: maybeNotifyOnExit() → 后台通知                                     │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  返回结果到模型                                                              │
│                                                                             │
│  resolve({                                                                  │
│    content: [{ type: "text", text: outcome.aggregated }],                    │
│    details: {                                                               │
│      status: "completed",                                                    │
│      exitCode: 0,                                                           │
│      durationMs: 1234,                                                       │
│      aggregated: "file1.txt\nfile2.txt\n..."                                │
│    }                                                                        │
│  })                                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 关键代码片段

**exec 工具入口** — [bash-tools.exec.ts L285-L340](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts#L285-L340):

```typescript
// src/agents/bash-tools.exec.ts → createExecTool().execute()
execute: async (_toolCallId, args, signal, onUpdate) => {
  const params = args as {
    command: string; workdir?: string; env?: Record<string, string>;
    yieldMs?: number; background?: boolean; timeout?: number;
    pty?: boolean; elevated?: boolean; host?: string;
    security?: string; ask?: string; node?: string;
  };

  // 一次性调用：yieldWindow = null
  const yieldWindow = allowBackground
    ? backgroundRequested ? 0
    : clampWithDefault(params.yieldMs ?? defaultBackgroundMs, defaultBackgroundMs, 10, 120_000)
    : null;  // ← 如果未传 background/yieldMs，则为 null

  // ... 安全策略、环境准备 ...

  // 目标超时时间
  const effectiveTimeout = (explicitTimeoutSec ?? defaultTimeoutSec);

  // 启动进程
  const run = await runExecProcess({
    command: params.command,
    workdir, env, sandbox, usePty,
    timeoutSec: effectiveTimeout,
    // ...
  });

  // 等待进程完成 → 返回结果
  run.promise.then((outcome) => {
    if (outcome.status === "failed") {
      reject(new Error(outcome.reason ?? "Command failed."));
      return;
    }
    resolve({
      content: [{ type: "text", text: outcome.aggregated }],
      details: { status: "completed", exitCode: outcome.exitCode, ... }
    });
  });
}
```

**进程启动** — [bash-tools.exec-runtime.ts L399-L648](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts#L399-L648):

```typescript
// src/agents/bash-tools.exec-runtime.ts → runExecProcess()
export async function runExecProcess(opts: { ... }): Promise<ExecProcessHandle> {
  const sessionId = createSessionSlug();
  const supervisor = getProcessSupervisor();

  const session: ProcessSession = {
    id: sessionId,
    command: opts.command,
    backgrounded: false,   // ← 一次性调用，非后台模式
    // ...
  };
  addSession(session);     // 注册到 runningSessions

  // 选择 spawn 模式
  const spawnSpec = opts.usePty
    ? { mode: "pty", ptyCommand: execCommand, ... }
    : { mode: "child", argv: [shell, ...shellArgs, execCommand],
        stdinMode: "pipe-closed" };  // ← 一次性调用不开放 stdin

  // 启动进程
  managedRun = await supervisor.spawn({
    runId: sessionId,
    mode: spawnSpec.mode,
    argv: spawnSpec.mode === "child" ? spawnSpec.argv : undefined,
    ptyCommand: spawnSpec.mode === "pty" ? spawnSpec.ptyCommand : undefined,
    timeoutMs,           // ← 超时生效
    captureOutput: false,
    onStdout: handleStdout,
    onStderr: handleStderr,
  });

  // 返回句柄（调用方等待 promise）
  return {
    session, startedAt, pid: session.pid,
    promise: managedRun.wait().then(exit => { /* 构建 ExecProcessOutcome */ }),
    kill: () => managedRun?.cancel("manual-cancel"),
  };
}
```

### 2.3 涉及的关键类/文件

| 类/模块 | 文件 | 职责 |
|---------|------|------|
| `createExecTool` | [bash-tools.exec.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts) | exec 工具定义，参数验证，安全策略解析，host 路由 |
| `runExecProcess` | [bash-tools.exec-runtime.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts) | 进程启动核心，spawn 模式选择，输出回调绑定 |
| `ProcessSession` | [bash-process-registry.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts) | 进程会话数据结构（id, command, aggregated, tail, exitCode...） |
| `ProcessSupervisor` | [process/supervisor/supervisor.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/supervisor.ts) | 进程生命周期管理（spawn/cancel/cancelScope） |
| `ChildAdapter` | [process/supervisor/adapters/child.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/adapters/child.ts) | 子进程适配器（child_process.spawn） |
| `PtyAdapter` | [process/supervisor/adapters/pty.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/adapters/pty.ts) | 伪终端适配器（node-pty） |
| `ManagedRun` | [process/supervisor/types.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/types.ts) | 托管运行句柄（wait/cancel/stdin） |
| `RunRecord` | [process/supervisor/types.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/types.ts) | 运行状态记录（RunState + TerminationReason） |

## 三、长时 Shell 执行 完整流程

### 3.1 流程图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ★ 第1轮：Agent 启动后台进程                                                  │
│                                                                             │
│  模型调用 exec 工具：                                                         │
│  { command: "npm run dev", background: true }                                │
│  { command: "python train.py", yieldMs: 5000 }                               │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  createExecTool().execute()                                                  │
│  src/agents/bash-tools.exec.ts                                              │
│                                                                             │
│  yieldWindow 计算：                                                          │
│    - background=true  → yieldWindow = 0（立即后台）                           │
│    - yieldMs=5000     → yieldWindow = 5000（5秒后自动后台）                   │
│    - 默认             → yieldWindow = defaultBackgroundMs（10000ms）          │
│                                                                             │
│  超时处理：                                                                  │
│    - background=true && timeout=null → backgroundTimeoutBypass=true          │
│    - → effectiveTimeout = null（绕过超时，长时运行）                           │
│    - 如果显式传了 timeout → effectiveTimeout = timeoutSec                    │
│                                                                             │
│  stdin 模式：                                                                │
│    - mode: "pty" 或 mode: "child" + stdinMode: "pipe-open"                  │
│    - 进程启动时 stdin 保持开放                                               │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  runExecProcess() → ProcessSupervisor.spawn()                                │
│  （与一次性调用路径相同，但 stdinMode="pipe-open"，timeout=null）              │
│                                                                             │
│  ProcessSession 创建：                                                       │
│    - backgrounded: false（初始未后台）                                        │
│    - stdin: managedRun.stdin（保持开放）                                     │
│    - 注册到 runningSessions                                                  │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  ★ yield 阶段：工具立即返回（不等进程结束）                                    │
│                                                                             │
│  // src/agents/bash-tools.exec.ts L698-L730                                 │
│                                                                             │
│  yieldWindow=0 时：立即 onYieldNow()                                         │
│  yieldWindow>0 时：setTimeout → onYieldNow()                                 │
│                                                                             │
│  onYieldNow():                                                              │
│    1. yielded = true                                                        │
│    2. markBackgrounded(run.session)  // session.backgrounded = true          │
│    3. resolve({                                                             │
│         content: [{ type: "text",                                           │
│           text: "Command still running (session abc12345, pid 12345).       │
│                  Use process (list/poll/log/write/kill/clear/remove)         │
│                  for follow-up." }],                                        │
│         details: { status: "running", sessionId, pid, ... }                 │
│       })                                                                    │
│                                                                             │
│  → Agent 得到了 sessionId，工具调用结束                                       │
│  → 后台进程继续运行！                                                        │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  ★ 第2轮：Agent 轮询进程输出                                                  │
│                                                                             │
│  模型调用 process 工具：                                                      │
│  { action: "poll", sessionId: "abc12345", timeout: 30000 }                   │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  createProcessTool().execute()                                               │
│  src/agents/bash-tools.process.ts                                           │
│                                                                             │
│  case "poll":                                                               │
│    1. getSession(sessionId) → 获取运行中的 ProcessSession                    │
│    2. 检查 backgrounded 标志（非后台返回错误）                                 │
│    3. 阻塞等待指定 timeout（轮询间隔 250ms）                                  │
│    4. drainSession(session) → 排空 pendingStdout/pendingStderr               │
│    5. 返回增量输出 + running/completed 状态                                  │
│                                                                             │
│  → 返回: { content: "Server running on port 3000...",                       │
│            details: { status: "running", sessionId } }                       │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  ★ 第N轮：Agent 与后台进程交互                                                │
│                                                                             │
│  process 工具支持的操作：                                                     │
│                                                                             │
│  ┌───────────────┬──────────────────────────────────────────────────────┐   │
│  │ list          │ 列出所有运行中/已完成的会话                            │   │
│  │ poll          │ 轮询增量输出（支持 timeout 等待）                      │   │
│  │ log           │ 查看聚合日志（支持 offset/limit 分页）                 │   │
│  │ write         │ 写入数据到 stdin                                      │   │
│  │ submit        │ 发送回车（CR），提交当前输入行                         │   │
│  │ send-keys     │ 发送按键序列（支持 token/hex/literal 三种格式）         │   │
│  │ paste         │ 粘贴文本（支持 bracketed paste 模式）                  │   │
│  │ kill          │ 终止后台会话                                           │   │
│  │ clear         │ 清除已完成会话记录                                     │   │
│  │ remove        │ 强制移除（先 cancel，失败则 kill 进程树）               │   │
│  └───────────────┴──────────────────────────────────────────────────────┘   │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  ★ 进程退出                                                                  │
│                                                                             │
│  ProcessSupervisor.wait() → 进程自然退出或超时/信号终止                       │
│                                                                             │
│  markExited(session, exitCode, exitSignal, status)                           │
│    → runningSessions.delete(id)                                             │
│    → finishedSessions.set(id, finishedRecord)                               │
│    → 清理 child process stdio，防止 FD 泄漏                                  │
│                                                                             │
│  maybeNotifyOnExit(session, status)                                         │
│    → session.backgrounded=true 时发送通知                                    │
│    → enqueueSystemEvent(summary, { sessionKey })                             │
│    → requestHeartbeatNow()                                                  │
│                                                                             │
│  Agent 下次 poll 时：                                                        │
│    → "Process exited with code 0."                                          │
│    → details: { status: "completed" }                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 后台化（Yield）机制关键代码

**exec 工具中 yield/background 逻辑** — [bash-tools.exec.ts L698-L730](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts#L698-L730):

```typescript
// src/agents/bash-tools.exec.ts → 后台化回调
const onYieldNow = () => {
  if (yieldTimer) { clearTimeout(yieldTimer); }
  if (yielded) { return; }
  yielded = true;
  markBackgrounded(run.session);  // session.backgrounded = true
  resolveRunning();               // 工具调用返回 "Command still running"
};

// 设置 yield 计时器
if (allowBackground && yieldWindow !== null) {
  if (yieldWindow === 0) {
    onYieldNow();  // 立即后台
  } else {
    yieldTimer = setTimeout(() => {
      if (yielded) return;
      yielded = true;
      markBackgrounded(run.session);
      resolveRunning();
    }, yieldWindow);  // 等待指定时间后自动后台
  }
}
```

**resolveRunning 返回的格式** — [bash-tools.exec.ts L702-L710](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts#L702-L710):

```typescript
const resolveRunning = () =>
  resolve({
    content: [{
      type: "text",
      text: `Command still running (session ${run.session.id}, pid ${
        run.session.pid ?? "n/a"
      }). Use process (list/poll/log/write/kill/clear/remove) for follow-up.`,
    }],
    details: {
      status: "running",
      sessionId: run.session.id,
      pid: run.session.pid ?? undefined,
      startedAt: run.startedAt,
      cwd: run.session.cwd,
      tail: run.session.tail,
    },
  });
```

**超时绕过逻辑** — [bash-tools.exec.ts L654-L657](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts#L654-L657):

```typescript
// 如果显式允许后台且未传 timeout，则绕过超时（支持长时运行）
const backgroundTimeoutBypass =
  allowBackground && explicitTimeoutSec === null && (backgroundRequested || yieldRequested);
const effectiveTimeout = backgroundTimeoutBypass
  ? null                           // ← 长时运行，无超时限制
  : (explicitTimeoutSec ?? defaultTimeoutSec);
```

### 3.3 stdin 交互机制关键代码

**write 操作** — [bash-tools.process.ts L534-L557](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L534-L557):

```typescript
case "write": {
  const resolved = resolveBackgroundedWritableStdin();  // 验证 backgrounded + stdin 可用
  if (!resolved.ok) return resolved.result;
  await writeToStdin(resolved.stdin, params.data ?? "");
  if (params.eof) resolved.stdin.end();  // 可选：发送 EOF
  return runningSessionResult(resolved.session, `Wrote ${...} bytes`);
}
```

**submit 操作（发送回车）** — [bash-tools.process.ts L588-L596](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L588-L596):

```typescript
case "submit": {
  const resolved = resolveBackgroundedWritableStdin();
  if (!resolved.ok) return resolved.result;
  await writeToStdin(resolved.stdin, "\r");  // 写入 \r （回车）
  return runningSessionResult(resolved.session, `Submitted session ${...} (sent CR).`);
}
```

**send-keys 操作（支持 key token/hex/literal）** — [bash-tools.process.ts L559-L587](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L559-L587):

```typescript
case "send-keys": {
  const { data, warnings } = encodeKeySequence({
    keys: params.keys,    // 如: ["ctrl+c", "enter"]
    hex: params.hex,      // 如: ["03"] (Ctrl+C)
    literal: params.literal, // 字面字符串
  });
  await writeToStdin(resolved.stdin, data);
}
```

### 3.4 进程会话注册表

[src/agents/bash-process-registry.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts) 维护两层 Map：

```typescript
// 运行中的会话
const runningSessions = new Map<string, ProcessSession>();

// 已完成的会话（仅 backgrounded=true 的会话在退出后移入此表）
const finishedSessions = new Map<string, FinishedSession>();

// ProcessSession 核心字段
interface ProcessSession {
  id: string;           // 唯一会话标识
  command: string;      // 原始命令
  pid?: number;         // 进程 ID
  startedAt: number;    // 启动时间
  aggregated: string;   // 累积输出（限制 maxOutputChars 200K）
  tail: string;         // 尾部输出（最后 2000 字符）
  exited: boolean;      // 是否已退出
  backgrounded: boolean; // ← 核心标志：是否转为后台
  stdin?: SessionStdin; // 可写 stdin
  pendingStdout: string[]; // 待排空的 stdout 缓冲
  pendingStderr: string[]; // 待排空的 stderr 缓冲
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  truncated: boolean;   // 输出是否被截断
}
```

### 3.5 长时执行多轮交互完整时序

```
时间轴 →

Agent LLM Turn 1:
  调用 exec({ command: "npm run build", background: true })
  → 启动进程，立即返回 { status: "running", sessionId: "abc123" }

Agent LLM Turn 2:
  调用 process({ action: "poll", sessionId: "abc123", timeout: 15000 })
  → 等待 15 秒或到有新输出
  → 返回: "Compiling...\n  Module A ✓\n  Module B ✓\n"

Agent LLM Turn 3:
  调用 process({ action: "poll", sessionId: "abc123", timeout: 30000 })
  → 返回: "  Module C ✓\n  Module D ✗ Error: ...\n\n"
  调用 process({ action: "write", sessionId: "abc123", data: "n\n" })
  → stdin 输入选择继续
  调用 process({ action: "submit", sessionId: "abc123" })
  → 发送回车确认

Agent LLM Turn 4:
  调用 process({ action: "poll", sessionId: "abc123", timeout: 60000 })
  → 阻塞等待直到进程退出或超时
  → 返回: "... Build complete.\n\nProcess exited with code 0."
  → details: { status: "completed", exitCode: 0 }
```

## 四、核心区别总结

```
                        一次性 Shell 调用                    长时 Shell 执行
                       ════════════════                    ════════════════

  exec 参数   │  { command: "ls", timeout: 30 }  │  { command: "npm run dev",       │
             │                                   │    background: true }            │
             │                                   │  或 { yieldMs: 5000 }            │
  ───────────┼──────────────────────────────────┼──────────────────────────────────│
  stdin      │  pipe-closed（不可交互）           │  pipe-open（可 write/submit/     │
             │                                   │  send-keys/paste）               │
  ───────────┼──────────────────────────────────┼──────────────────────────────────│
  工具返回   │  等待进程退出后返回完整结果         │  立即返回 "Command still running" │
             │  resolve(aggregated)              │  resolve(status: "running")       │
  ───────────┼──────────────────────────────────┼──────────────────────────────────│
  session    │  backgrounded = false             │  backgrounded = true              │
             │  退出后移入 finishedSessions       │  退出后移入 finishedSessions       │
             │  但不会被 process 工具管理         │  全程被 process 工具管理           │
  ───────────┼──────────────────────────────────┼──────────────────────────────────│
  超时       │  timeout 参数生效                  │  background=true && timeout=null  │
             │  默认 1800 秒                     │  → 绕过超时（长时运行）           │
             │  overall-timeout / no-output      │  若显式传 timeout，仍然生效        │
  ───────────┼──────────────────────────────────┼──────────────────────────────────│
  PTY        │  支持 pty=true                    │  支持 pty=true                    │
             │  失败自动回退 child 模式           │  用于交互式 TUI/编码代理           │
  ───────────┼──────────────────────────────────┼──────────────────────────────────│
  退出通知   │  非后台模式，不发送通知            │  maybeNotifyOnExit() →            │
             │                                   │  systemEvent + heartbeat 唤醒    │
  ───────────┼──────────────────────────────────┼──────────────────────────────────│
  模型交互   │  1 轮工具调用                     │  N 轮工具调用                     │
             │  exec → 结果                      │  exec → process(poll/write/...)   │
  ───────────┼──────────────────────────────────┼──────────────────────────────────│
  进程管理   │  ProcessSupervisor (spawn→wait)   │  ProcessSupervisor +              │
             │                                   │  ProcessSession 注册表            │
             │                                   │  (runningSessions/finished)       │
  ───────────┴──────────────────────────────────┴──────────────────────────────────│
```

## 五、关键类/文件速查

| 类/模块 | 文件路径 | 职责 |
|---------|----------|------|
| `createExecTool` | [bash-tools.exec.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts) | exec 工具定义，含前台/后台双模式 |
| `runExecProcess` | [bash-tools.exec-runtime.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts) | 进程启动核心，child/pty 模式选择，输出回调绑定 |
| `createProcessTool` | [bash-tools.process.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts) | 后台进程管理工具（list/poll/log/write/send-keys/submit/paste/kill/clear/remove） |
| `ProcessSession` | [bash-process-registry.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts) | 进程会话数据结构和内存注册表 |
| `ProcessSupervisor` | [process/supervisor/supervisor.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/supervisor.ts) | 进程生命周期管理器，双超时控制 |
| `ManagedRun` | [process/supervisor/types.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/types.ts) | 托管运行句柄（wait/cancel/stdin） |
| `ChildAdapter` | [process/supervisor/adapters/child.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/adapters/child.ts) | 子进程适配器 |
| `PtyAdapter` | [process/supervisor/adapters/pty.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/adapters/pty.ts) | PTY 伪终端适配器 |
| `ExecToolDefaults` | [bash-tools.exec-types.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-types.ts) | exec 工具默认配置类型 |
| `ExecToolDetails` | [bash-tools.exec-types.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-types.ts) | exec 工具返回详情联合类型 |
| `pty-keys.ts` | [pty-keys.ts](file:///d:/prj/openclaw_analyze/src/agents/pty-keys.ts) | PTY 按键编码/粘贴编码 |
| `pty-dsr.ts` | [pty-dsr.ts](file:///d:/prj/openclaw_analyze/src/agents/pty-dsr.ts) | PTY DSR 请求处理 |