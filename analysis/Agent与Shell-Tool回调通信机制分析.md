# Agent 与 Shell/Tool 回调通信机制分析

## 结论：完全支持，多层回调机制贯穿整个调用链

OpenClaw 的 Agent 与 Shell/Tool 之间通过**多层回调机制**实现双向通信。从 Pi-Agent SDK 发起工具调用开始，经过 exec 工具、进程运行时（runExecProcess）、进程监督器（ProcessSupervisor）、Shell 适配器（ChildAdapter/PtyAdapter），最终到达操作系统子进程，**每一层都通过回调进行数据传递和状态通知**。同时支持 AbortSignal 回调实现取消控制。

---

## 一、核心概念

| 概念 | 定义 | 文件 |
|------|------|------|
| **Pi-Agent SDK** | 外部依赖，负责 LLM 推理循环 + 工具调用 | `@mariozechner/pi-coding-agent` |
| **AgentTool** | Agent 可调用的工具接口，execute 方法接收 `onUpdate` 回调 | `@mariozechner/pi-agent-core` |
| **exec Tool** | 执行 Shell 命令的核心工具 | [bash-tools.exec.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts) |
| **process Tool** | 管理后台进程的辅助工具（poll/log/write/kill） | [bash-tools.process.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts) |
| **runExecProcess** | 命令执行的运行时，管理进程会话+输出捕获 | [bash-tools.exec-runtime.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts) |
| **ProcessSupervisor** | 进程监督器（全局单例），管理进程生命周期 | [process/supervisor/supervisor.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/supervisor.ts) |
| **ChildAdapter** | 普通子进程适配器，封装 Node.js `spawn` | [process/supervisor/adapters/child.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/adapters/child.ts) |
| **PtyAdapter** | PTY 伪终端适配器，用于交互式终端程序 | [process/supervisor/adapters/pty.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/adapters/pty.ts) |
| **ProcessSession** | 进程运行时的会话状态对象 | [bash-process-registry.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts) |
| **ManagedRun** | Supervisor 返回的托管运行句柄 | [process/supervisor/types.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/types.ts) |

---

## 二、回调机制的全链路分析

### 2.1 流程序列图

```mermaid
sequenceDiagram
    participant LLM as LLM 模型
    participant SDK as Pi-Agent SDK<br/>(AgentSession)
    participant Exec as exec Tool<br/>(createExecTool)
    participant Runtime as runExecProcess<br/>(exec-runtime)
    participant Supervisor as ProcessSupervisor<br/>(全局单例)
    participant Adapter as Child/Pty Adapter
    participant OS as 操作系统 Shell<br/>(子进程)

    Note over LLM,OS: ═══ Phase 1: LLM 决定调用 exec 工具 ═══

    LLM->>SDK: 返回 tool_use: exec(command="ls -la", pty=true...)
    SDK->>Exec: tool.execute(toolCallId, params, signal, onUpdate)
    Note over Exec: 接收 4 个参数：<br/>1. toolCallId: 工具调用标识<br/>2. params: 命令参数<br/>3. signal: AbortSignal<br/>4. onUpdate: 进度回调 ★

    Note over Exec,OS: ═══ Phase 2: exec 工具处理参数与安全检查 ═══

    Exec->>Exec: 解析 command/workdir/env/pty/host 参数
    Exec->>Exec: 安全策略检查 (security/ask/safeBins)
    Exec->>Exec: 环境变量处理 (sanitizeHostBaseEnv)
    Exec->>Exec: preflight 脚本安全检查

    Exec->>Runtime: runExecProcess({<br/>  command, workdir, env,<br/>  usePty, timeoutSec,<br/>  onUpdate ★ → 透传给进程运行时<br/>})

    Note over Runtime,OS: ═══ Phase 3: 进程运行时启动 ═══

    Runtime->>Runtime: createSessionSlug()<br/>addSession(session) → ProcessRegistry
    Runtime->>Runtime: 创建 emitUpdate() 函数:<br/>读取 session.tail/aggregated<br/>调用 opts.onUpdate({content, details: {status:"running"}})

    Runtime->>Runtime: 创建 handleStdout/handleStderr:<br/>sanitizeBinaryOutput(chunk)<br/>chunkString(str) 分块<br/>appendOutput(session, "stdout"/"stderr", chunk)<br/>emitUpdate() ★ → 实时通知 onUpdate

    Runtime->>Supervisor: supervisor.spawn({<br/>  mode: "child"/"pty",<br/>  argv/ptyCommand, cwd, env,<br/>  timeoutMs, captureOutput: false,<br/>  onStdout ★: (chunk) => handleStdout,<br/>  onStderr ★: (chunk) => handleStderr<br/>})

    Note over Supervisor,OS: ═══ Phase 4: 监督器创建适配器 ═══

    Supervisor->>Supervisor: registry.add(record)<br/>state: "starting"

    alt mode = "pty"
        Supervisor->>Adapter: createPtyAdapter({<br/>  shell, args, cwd, env<br/>})
        Adapter->>OS: node-pty.spawn(shell, args, {<br/>  name: "xterm-256color",<br/>  cols: 120, rows: 30<br/>})
    else mode = "child"
        Supervisor->>Adapter: createChildAdapter({<br/>  argv, cwd, env, stdinMode<br/>})
        Adapter->>OS: child_process.spawn(cmd, args, {<br/>  stdio: ["pipe","pipe","pipe"],<br/>  detached, windowsHide<br/>})
    end

    OS-->>Adapter: pid = 12345
    Adapter-->>Supervisor: adapter { pid, stdin, onStdout ★, onStderr ★, wait, kill }

    Supervisor->>Supervisor: registry.updateState("running", pid)<br/>启动超时定时器 (timeoutMs)<br/>启动无输出超时定时器 (noOutputTimeoutMs)

    Note over Supervisor,OS: ═══ Phase 5: 注册输出监听器 ═══

    Supervisor->>Adapter: adapter.onStdout((chunk) => {<br/>  stdout += chunk;<br/>  input.onStdout(chunk) ★ → Runtime.handleStdout<br/>  touchOutput()<br/>})
    Supervisor->>Adapter: adapter.onStderr((chunk) => {<br/>  stderr += chunk;<br/>  input.onStderr(chunk) ★ → Runtime.handleStderr<br/>  touchOutput()<br/>})

    Supervisor-->>Runtime: ManagedRun { runId, pid, stdin, wait, cancel }

    Runtime-->>Exec: ExecProcessHandle { session, pid, promise, kill }

    Note over OS,Runtime: ═══ Phase 6: 实时输出回调循环 ═══

    loop Shell 持续产生输出
        OS-->>Adapter: stdout/stderr 数据块
        Adapter->>Supervisor: onStdout(chunk) / onStderr(chunk)
        Supervisor->>Runtime: input.onStdout(chunk) ★
        Runtime->>Runtime: sanitizeBinaryOutput → chunkString<br/>appendOutput(session, stream, chunk)<br/>emitUpdate() ★
        Runtime->>Exec: onUpdate({content: [{text: "..."}],<br/>  details: {status: "running", sessionId, pid, tail}})
        Exec->>SDK: onUpdate(result) ★ → SDK 记录进度
    end

    Note over OS,Runtime: ═══ Phase 7: 命令执行完成 ═══

    OS-->>Adapter: exit(code=0)
    Adapter->>Supervisor: wait() resolve → {code:0, signal:null}
    Supervisor->>Runtime: managedRun.wait() resolve → RunExit

    Runtime->>Runtime: markExited(session, exitCode, signal, status)<br/>maybeNotifyOnExit → enqueueSystemEvent

    Runtime->>Exec: promise resolve → ExecProcessOutcome

    alt yieldWindow到期 / background=true
        Exec->>Exec: markBackgrounded(session)<br/>resolveRunning() → { status: "running" }
        Exec->>SDK: resolve({details: {status:"running", sessionId, pid}})
        SDK->>LLM: 工具结果: 命令仍在运行
        Note over LLM,Exec: 后续通过 process 工具 poll/log 管理
    else 等待完成 (foreground)
        Exec->>Exec: resolve({content, details: {status:"completed", exitCode, ...}})
        Exec->>SDK: resolve(result) ★
        SDK->>LLM: 工具结果: 命令输出文本
    end

    Note over LLM,OS: ═══ Phase 8: AbortSignal 回调（取消执行） ═══

    opt 用户/系统取消执行
        Exec->>Exec: signal.addEventListener("abort", () => {<br/>  if (!yielded && !session.backgrounded)<br/>    run.kill() ★<br/>})

        Exec->>Runtime: run.kill()
        Runtime->>Supervisor: managedRun.cancel("manual-cancel")
        Supervisor->>Supervisor: setForcedReason → registry.updateState<br/>cancelAdapter(reason)
        Supervisor->>Adapter: adapter.kill("SIGKILL")
        Adapter->>OS: killProcessTree(pid) / child.kill("SIGKILL")
    end

    Note over LLM,OS: ═══ Phase 9: 后台进程后续管理 (process 工具) ═══

    LLM->>SDK: tool_use: process(action="poll", sessionId)
    SDK->>Exec: processTool.execute(...)
    Exec->>Runtime: drainSession(scopedSession) ★<br/>读取累积的 stdout/stderr<br/>检查 exited 状态
    Runtime-->>Exec: { stdout, stderr, exited, exitCode }
    Exec->>SDK: resolve(result)
    SDK->>LLM: 工具结果: 进程输出/状态
```

### 2.2 回调链逐层代码分析

#### 第 1 层：Pi-Agent SDK → exec Tool 的 execute 方法

SDK 调用工具时，传入 4 个参数的 `execute` 方法签名：

**文件:** [bash-tools.exec.ts#L295-L310](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts#L295-L310)

```typescript
return {
  name: "exec",
  description: "Execute shell commands with background continuation...",
  parameters: execSchema,

  execute: async (_toolCallId, args, signal, onUpdate) => {
    // _toolCallId: 工具调用 ID（用于追踪）
    // args: { command, workdir, env, yieldMs, background, timeout, pty, elevated, host, ... }
    // signal: AbortSignal（用于取消执行）
    // onUpdate: (partialResult: AgentToolResult<ExecToolDetails>) => void（进度回调 ★）
    const params = args as {
      command: string;
      workdir?: string;
      env?: Record<string, string>;
      // ...
    };
```

#### 第 2 层：exec 工具 → runExecProcess 透传 onUpdate

exec 工具将 `onUpdate` 回调透传给 `runExecProcess`：

**文件:** [bash-tools.exec.ts#L637-L650](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts#L637-L650)

```typescript
const run = await runExecProcess({
  command: params.command,
  execCommand: execCommandOverride,
  workdir,
  env,
  sandbox,
  containerWorkdir,
  usePty,
  warnings,
  maxOutput,
  pendingMaxOutput,
  notifyOnExit,
  notifyOnExitEmptySuccess,
  scopeKey: defaults?.scopeKey,
  sessionKey: notifySessionKey,
  timeoutSec: effectiveTimeout,
  onUpdate,   // ★ 透传进度回调
});
```

#### 第 3 层：runExecProcess → 创建 emitUpdate 回调

`runExecProcess` 内部创建 `emitUpdate` 函数，每次收到 stdout/stderr 输出时调用：

**文件:** [bash-tools.exec-runtime.ts#L470-L490](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts#L470-L490)

```typescript
// 发出更新回调的辅助函数
const emitUpdate = () => {
  if (!opts.onUpdate) {
    return;
  }
  const tailText = session.tail || session.aggregated;
  const warningText = opts.warnings.length ? `${opts.warnings.join("\n")}\n\n` : "";
  opts.onUpdate({
    content: [{ type: "text", text: warningText + (tailText || "") }],
    details: {
      status: "running",
      sessionId,
      pid: session.pid ?? undefined,
      startedAt,
      cwd: session.cwd,
      tail: session.tail,
    },
  });
};

// 处理标准输出
const handleStdout = (data: string) => {
  const str = sanitizeBinaryOutput(data.toString());
  for (const chunk of chunkString(str)) {
    appendOutput(session, "stdout", chunk);
    emitUpdate();  // ★ 每次输出块到达时回调
  }
};

// 处理标准错误输出
const handleStderr = (data: string) => {
  const str = sanitizeBinaryOutput(data.toString());
  for (const chunk of chunkString(str)) {
    appendOutput(session, "stderr", chunk);
    emitUpdate();  // ★ 每次错误输出块到达时回调
  }
};
```

#### 第 4 层：runExecProcess → ProcessSupervisor.spawn 注册输出回调

**文件:** [bash-tools.exec-runtime.ts#L593-L630](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts#L593-L630)

```typescript
const onSupervisorStdout = (chunk: string) => {
  if (usingPty) {
    // PTY 模式：剥离 DSR（设备状态请求）并响应光标查询
    const { cleaned, requests } = stripDsrRequests(chunk);
    if (requests > 0 && managedRun?.stdin) {
      for (let i = 0; i < requests; i += 1) {
        managedRun.stdin.write(cursorResponse);
      }
    }
    handleStdout(cleaned);
    return;
  }
  handleStdout(chunk);
};

managedRun = await supervisor.spawn({
  runId: sessionId,
  sessionId: opts.sessionKey?.trim() || sessionId,
  backendId: opts.sandbox ? "exec-sandbox" : "exec-host",
  scopeKey: opts.scopeKey,
  cwd: opts.workdir,
  env: spawnSpec.env,
  timeoutMs,
  captureOutput: false,
  onStdout: onSupervisorStdout,   // ★ stdout 回调
  onStderr: handleStderr,         // ★ stderr 回调
});
```

#### 第 5 层：ProcessSupervisor.spawn → 适配器输出监听

**文件:** [process/supervisor/supervisor.ts#L45-L80](file:///d:/prj/openclaw_analyze/src/process/supervisor/supervisor.ts#L45-L80)

```typescript
const spawn = async (input: SpawnInput): Promise<ManagedRun> => {
  // 1. 创建适配器（child 或 pty）
  const adapter =
    input.mode === "pty"
      ? await createPtyAdapter({
          shell, args: [...shellArgs, ptyCommand], cwd, env
        })
      : await createChildAdapter({
          argv, cwd, env, stdinMode: input.stdinMode
        });

  registry.updateState(runId, "running", { pid: adapter.pid });

  // 2. 设置超时回调
  if (overallTimeoutMs) {
    timeoutTimer = setTimeout(() => requestCancel("overall-timeout"), overallTimeoutMs);
  }
  if (noOutputTimeoutMs) {
    noOutputTimer = setTimeout(() => requestCancel("no-output-timeout"), noOutputTimeoutMs);
  }

  // 3. ★ 注册输出监听器，将 adapter 的输出桥接到 input 的回调
  adapter.onStdout((chunk) => {
    if (captureOutput) stdout += chunk;
    input.onStdout?.(chunk);    // → Runtime.handleStdout → emitUpdate → onUpdate
    touchOutput();               // 刷新无输出超时定时器
  });
  adapter.onStderr((chunk) => {
    if (captureOutput) stderr += chunk;
    input.onStderr?.(chunk);    // → Runtime.handleStderr → emitUpdate → onUpdate
    touchOutput();
  });

  // 3. 返回 ManagedRun 句柄
  return {
    runId, pid: adapter.pid,
    stdin: adapter.stdin,
    wait: async () => await waitPromise,
    cancel: (reason) => { adapter.kill("SIGKILL"); }
  };
};
```

#### 第 6 层：ChildAdapter → Node.js 子进程事件监听

**文件:** [process/supervisor/adapters/child.ts#L100-L130](file:///d:/prj/openclaw_analyze/src/process/supervisor/adapters/child.ts#L100-L130)

```typescript
// 注册 stdout 监听器
const onStdout = (listener: (chunk: string) => void) => {
  child.stdout.on("data", (chunk) => {
    listener(chunk.toString());  // ★ Node.js EventEmitter 回调 → adapter listener
  });
};

// 注册 stderr 监听器
const onStderr = (listener: (chunk: string) => void) => {
  child.stderr.on("data", (chunk) => {
    listener(chunk.toString());  // ★ Node.js EventEmitter 回调 → adapter listener
  });
};

// 等待进程退出
const wait = async () =>
  await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {   // ★ close 事件回调
        resolve({ code, signal });
      });
    }
  );

// 终止进程
const kill = (signal?: NodeJS.Signals) => {
  const pid = child.pid ?? undefined;
  if (signal === undefined || signal === "SIGKILL") {
    if (pid) killProcessTree(pid);   // 杀死整个进程树
    else child.kill("SIGKILL");
  }
  // ...
};
```

### 2.3 AbortSignal 回调机制

exec 工具通过 `AbortSignal` 实现取消控制：

**文件:** [bash-tools.exec.ts#L658-L675](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts#L658-L675)

```typescript
let yielded = false;
let yieldTimer: NodeJS.Timeout | null = null;

// Tool-call abort should not kill backgrounded sessions; timeouts still must.
const onAbortSignal = () => {
  if (yielded || run.session.backgrounded) {
    return;  // 后台进程不受 abort 影响
  }
  run.kill();  // ★ 通过 ManagedRun.cancel 终止进程
};

if (signal?.aborted) {
  onAbortSignal();  // 立即处理已中止的信号
} else if (signal) {
  signal.addEventListener("abort", onAbortSignal, { once: true });  // ★ 注册 abort 回调
}
```

### 2.4 后台进程退出通知回调

当后台进程退出时，通过系统事件回调通知用户：

**文件:** [bash-tools.exec-runtime.ts#L285-L320](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts#L285-L320)

```typescript
function maybeNotifyOnExit(session: ProcessSession, status: "completed" | "failed") {
  if (!session.backgrounded || !session.notifyOnExit || session.exitNotified) {
    return;
  }
  const sessionKey = session.sessionKey?.trim();
  if (!sessionKey) return;

  session.exitNotified = true;
  const exitLabel = session.exitSignal
    ? `signal ${session.exitSignal}` : `code ${session.exitCode ?? 0}`;

  const output = compactNotifyOutput(
    tail(session.tail || session.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
  );
  if (status === "completed" && !output && session.notifyOnExitEmptySuccess !== true) {
    return;
  }

  const summary = output
    ? `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}`
    : `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel})`;

  enqueueSystemEvent(summary, { sessionKey });           // ★ 发送系统事件
  requestHeartbeatNow(
    scopedHeartbeatWakeOptions(sessionKey, { reason: `exec:${session.id}:exit` })  // ★ 触发心跳
  );
}
```

### 2.5 process 工具的回调通信

process 工具管理后台进程，通过 ProcessSession 注册表获取实时状态：

**文件:** [bash-tools.process.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts)

```typescript
// poll 操作：带超时的轮询等待
case "poll": {
  if (pollWaitMs > 0 && !scopedSession.exited) {
    const deadline = Date.now() + pollWaitMs;
    while (!scopedSession.exited && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, Math.max(0, Math.min(250, deadline - Date.now()))));
    }
  }
  const { stdout, stderr } = drainSession(scopedSession);  // ★ 读取累积输出
  const exited = scopedSession.exited;
  return { /* 返回输出 + 退出状态 */ };
}

// log 操作：读取聚合输出
case "log": {
  const aggregated = scopedSession.aggregated;
  const lines = aggregated.split(/\r?\n/);
  // offset/limit 分页读取
  return { /* 返回日志行 */ };
}

// write 操作：向 stdin 写入（通过 supervisor）
case "write": {
  const supervisor = getProcessSupervisor();
  const active = supervisor.getRecord(sessionId);
  if (active) {
    // 通过 supervisor 管理的 stdin 写入
  } else {
    // 直接向 session.stdin 写入
    session.stdin?.write(data);
  }
}
```

---

## 三、涉及的核心类型/接口

### 3.1 类型汇总表

| 类型/接口 | 文件 | 行号 | 作用 |
|-----------|------|------|------|
| `AgentToolResult<T>` | `@mariozechner/pi-agent-core` | - | 工具执行结果，`onUpdate` 回调参数类型 |
| `ExecToolDefaults` | [bash-tools.exec-types.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-types.ts) | L12-L36 | exec 工具的默认配置 |
| `ExecToolDetails` | [bash-tools.exec-types.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-types.ts) | L50-L78 | 区分 `running`/`completed`/`failed`/`approval-pending` 状态 |
| `ExecProcessOutcome` | [bash-tools.exec-runtime.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts) | L190-L200 | 命令执行结果（completed/failed） |
| `ExecProcessHandle` | [bash-tools.exec-runtime.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts) | L203-L213 | 进程句柄（session + promise + kill） |
| `ProcessSupervisor` | [process/supervisor/types.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/types.ts) | L100-L110 | 监督器接口（spawn/cancel/cancelScope） |
| `ManagedRun` | [process/supervisor/types.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/types.ts) | L47-L54 | 托管运行句柄（runId/pid/stdin/wait/cancel） |
| `SpawnProcessAdapter` | [process/supervisor/types.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/types.ts) | L63-L70 | 进程适配器接口（onStdout/onStderr/wait/kill/dispose） |
| `SpawnInput` | [process/supervisor/types.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/types.ts) | L72-L99 | Spawn 参数（可辨识联合：child/pty），包含 onStdout/onStderr 回调 |
| `RunExit` | [process/supervisor/types.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/types.ts) | L34-L43 | 进程退出信息（code/signal/stdout/stderr/duration） |
| `ProcessSession` | [bash-process-registry.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts) | - | 运行时进程会话状态（output/exit/backgrounded） |
| `ChildAdapter` | [process/supervisor/adapters/child.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/adapters/child.ts) | L17 | 子进程适配器类型别名 |
| `ManagedRunStdin` | [process/supervisor/types.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/types.ts) | L57-L61 | stdin 操作接口（write/end/destroy） |

---

## 四、回调类型总览

OpenClaw 中 Agent 与 Shell/Tool 之间的回调可分为以下几类：

| 回调类型 | 方向 | 触发时机 | 参 |
|----------|------|----------|------|
| **onUpdate** | Tool → Agent SDK | 每次 stdout/stderr 输出到达 | `AgentToolResult<ExecToolDetails>` |
| **onStdout** | Supervisor → Runtime | 子进程 stdout 数据到达 | `(chunk: string) => void` |
| **onStderr** | Supervisor → Runtime | 子进程 stderr 数据到达 | `(chunk: string) => void` |
| **onStdout/onStderr** (Adapter) | Node.js child_process → Adapter | `child.stdout.on("data")` / `child.stderr.on("data")` 事件 | `(chunk: string) => void` |
| **wait** (exit) | Adapter → Supervisor → Runtime → Tool | 子进程退出 (`close` 事件) | `() => Promise<RunExit>` |
| **AbortSignal "abort"** | 外部 → Tool | 用户/系统请求取消执行 | `() => void`（调用 `run.kill()`） |
| **maybeNotifyOnExit** | Runtime → System Events | 后台进程退出 | `enqueueSystemEvent + requestHeartbeatNow` |
| **process.poll** | LLM → ProcessSession | LLM 主动查询后台进程状态 | `drainSession(session)` → `{stdout, stderr, exited}` |
| **setTimeout** | Supervisor 内部 | 超时/无输出超时触发 | `() => requestCancel("overall-timeout" / "no-output-timeout")` |
| **touchOutput** | Supervisor 内部 | 每次输出到达时 | 重置 `noOutputTimer` 定时器 |

---

## 五、涉及的文件汇总

| 文件路径 | 核心功能 | 关键回调 |
|----------|----------|----------|
| [src/agents/bash-tools.exec.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts) | exec 工具定义 + execute 方法 | `onUpdate` 入口接收 + `signal.addEventListener("abort")` |
| [src/agents/bash-tools.exec-runtime.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts) | `runExecProcess()` 进程运行时 | `emitUpdate()` → `onUpdate`; `handleStdout/Stderr`; `onSupervisorStdout`; `maybeNotifyOnExit` |
| [src/agents/bash-tools.exec-types.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-types.ts) | exec 工具类型定义 | `ExecToolDefaults`, `ExecToolDetails`（running/completed/failed/approval-pending） |
| [src/agents/bash-tools.process.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts) | process 工具（poll/log/write/kill） | `drainSession()`; `supervisor.getRecord()` |
| [src/agents/bash-process-registry.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts) | ProcessSession 注册表 + appendOutput | 输出累积、截断、尾部查看 |
| [src/process/supervisor/supervisor.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/supervisor.ts) | ProcessSupervisor 实现 | `adapter.onStdout/Stderr` → `input.onStdout/Stderr`; timeout 回调; `cancelAdapter` |
| [src/process/supervisor/types.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/types.ts) | 监督器类型定义 | `SpawnInput`（含 onStdout/onStderr）; `ManagedRun`; `SpawnProcessAdapter` |
| [src/process/supervisor/adapters/child.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/adapters/child.ts) | 子进程适配器 | `child.stdout.on("data")` / `child.stderr.on("data")` → listener; `child.once("close")` |
| [src/process/supervisor/adapters/pty.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/adapters/pty.ts) | PTY 伪终端适配器 | `pty.onData(chunk)` → listener; `pty.onExit(event)`; `killProcessTree` |

---

## 六、回调链完整路径图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           回调链完整路径                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  操作系统 Shell 子进程                                                        │
│       │                                                                      │
│       │ stdout/stderr 数据流 (EventEmitter "data" 事件)                       │
│       ▼                                                                      │
│  ┌─────────────────┐                                                         │
│  │  ChildAdapter    │  child.stdout.on("data", chunk => listener(chunk))     │
│  │  / PtyAdapter    │  child.stderr.on("data", chunk => listener(chunk))     │
│  └────────┬────────┘                                                         │
│           │                                                                  │
│           │ adapter.onStdout(listener) / adapter.onStderr(listener)          │
│           ▼                                                                  │
│  ┌─────────────────┐                                                         │
│  │ ProcessSupervisor│  input.onStdout(chunk) → handleStdout(chunk)           │
│  │   supervisor.ts  │  input.onStderr(chunk) → handleStderr(chunk)           │
│  └────────┬────────┘                                                         │
│           │                                                                  │
│           │ onSupervisorStdout(chunk) / handleStderr(chunk)                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                         │
│  │  runExecProcess  │  appendOutput(session, stream, chunk)                  │
│  │  exec-runtime.ts │  emitUpdate() → opts.onUpdate({content, details})      │
│  └────────┬────────┘                                                         │
│           │                                                                  │
│           │ onUpdate(AgentToolResult<ExecToolDetails>)                       │
│           ▼                                                                  │
│  ┌─────────────────┐                                                         │
│  │    exec Tool     │  (透传 onUpdate 到 Pi-Agent SDK)                       │
│  │  bash-tools.exec │                                                        │
│  └────────┬────────┘                                                         │
│           │                                                                  │
│           │ onUpdate(partialResult)  ← Pi-Agent SDK 内部处理                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                         │
│  │  Pi-Agent SDK   │  记录工具执行进度                                       │
│  │  AgentSession   │  通过事件系统通知 subscribeEmbeddedPiSession            │
│  └────────┬────────┘                                                         │
│           │                                                                  │
│           │ emitAgentEvent({stream: "tool", data: {...}})                    │
│           ▼                                                                  │
│  ┌─────────────────┐                                                         │
│  │   Agent Events  │  广播到 WebSocket 客户端 (TUI/WebChat)                  │
│  │  agent-events.ts│                                                        │
│  └─────────────────┘                                                         │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────┐           │
│  │                    反向控制链 (AbortSignal)                    │           │
│  ├──────────────────────────────────────────────────────────────┤           │
│  │  外部 AbortController.abort()                                │           │
│  │    → signal.addEventListener("abort", onAbortSignal)         │           │
│  │    → run.kill()                                              │           │
│  │    → managedRun.cancel("manual-cancel")                      │           │
│  │    → adapter.kill("SIGKILL")                                 │           │
│  │    → killProcessTree(pid) / child.kill("SIGKILL")            │           │
│  └──────────────────────────────────────────────────────────────┘           │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 七、总结

1. **完全支持回调通信**：OpenClaw 的 Agent 与 Shell/Tool 之间通过**多层回调机制**实现完整的双向异步通信，覆盖数据流（stdout/stderr 实时输出）和控制流（AbortSignal 取消）。

2. **6 层回调链**：
   - **第 1 层**：Pi-Agent SDK → exec.execute(toolCallId, params, signal, **onUpdate**)
   - **第 2 层**：exec → runExecProcess({...**onUpdate**}) 透传
   - **第 3 层**：runExecProcess → 创建 **emitUpdate()** 调用 onUpdate，通过 **handleStdout/Stderr** 捕获输出
   - **第 4 层**：runExecProcess → supervisor.spawn({**onStdout**, **onStderr**}) 注册输出回调
   - **第 5 层**：ProcessSupervisor → adapter.**onStdout/onStderr**(listener) 桥接适配器
   - **第 6 层**：ChildAdapter → child.stdout.**on("data")** / child.stderr.**on("data")** Node.js 原生回调

3. **两种执行模式**：
   - **foreground 模式**：等待命令完成后 resolve，返回完整输出
   - **background 模式**：yieldWindow 到期后通过 `onUpdate` notify SDK，后续通过 `process` 工具的 poll/log 回调交互

4. **AbortSignal 取消链**：`AbortController.abort()` → `signal "abort"` 事件 → `run.kill()` → `managedRun.cancel()` → `adapter.kill("SIGKILL")` → `killProcessTree(pid)`，完整的反向控制链

5. **进程退出通知**：后台进程退出时通过 `maybeNotifyOnExit` → `enqueueSystemEvent` + `requestHeartbeatNow` 回调通知用户

6. **超时回调**：`setTimeout` → `requestCancel("overall-timeout"/"no-output-timeout")` → `cancelAdapter(reason)` → `adapter.kill("SIGKILL")`，通过定时器回调实现超时终止