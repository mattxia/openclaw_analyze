# 长时 Shell 任务：Agent 如何获取结果 & 如何判断执行完毕

## 一、概述

本文档分析 OpenClaw 项目中，Agent 在启动一个长时后台 Shell 进程后，如何通过 `process` 工具轮询获取进程输出结果，以及如何判定进程执行完毕。核心围绕 **数据缓冲机制**、**增量排空机制**、**退出信号传播链**、**状态转换** 四个维度展开。

## 二、完整序列图

```
 Agent (LLM)              process Tool         ProcessSession       ProcessSupervisor     OS Process
     │                         │                     │                     │                   │
     │                         │                     │                     │                   │
     │  ★ 第1步：启动后台进程    │                     │                     │                   │
     │  exec({                 │                     │                     │                   │
     │    command:"npm run",   │                     │                     │                   │
     │    background:true      │                     │                     │                   │
     │  })                     │                     │                     │                   │
     │─────────────────────────│──────────────────────────────────────────────────────────│
     │                         │  runExecProcess()   │                     │                   │
     │                         │─────────────────────│                     │                   │
     │                         │  addSession(session)│                     │                   │
     │                         │  (注册到runningSessions)                   │                   │
     │                         │─────────────────────│─────────────────────────────────────│
     │                         │                     │  spawn()             │                   │
     │                         │                     │─────────────────────│                   │
     │                         │                     │  创建 ChildAdapter   │                   │
     │                         │                     │─────────────────────│                   │
     │                         │                     │  onStdout: handler   │   child_process   │
     │                         │                     │  onStderr: handler   │──────spawn()─────▶│
     │                         │                     │  stdin: "pipe-open"  │                   │
     │                         │                     │                     │                   │
     │                         │ onYieldNow()  ← 立即触发 (yieldWindow=0)                      │
     │                         │ markBackgrounded(session)                                    │
     │                         │   → session.backgrounded = true                              │
     │  { status:"running",   │                     │                     │                   │
     │    sessionId:"abc123", │                     │                     │                   │
     │    pid: 12345 }        │                     │                     │                   │
     │◀────────────────────────│                     │                     │                   │
     │                         │                     │                     │                   │
     │                         │                     │  ╔═══════════════════════════════════╗  │
     │                         │                     │  ║  后台进程继续运行                 ║  │
     │                         │                     │  ║  stdout → appendOutput(session)   ║  │
     │                         │                     │  ║  写入 pendingStdout 缓冲           ║  │
     │                         │                     │  ║  写入 aggregated / tail            ║  │
     │                         │                     │  ╚═══════════════════════════════════╝  │
     │                         │                     │                     │                   │
     │                         │                     │                     │                   │
     │  ★ 第2步：轮询获取结果    │                     │                     │                   │
     │  process({              │                     │                     │                   │
     │    action:"poll",       │                     │                     │                   │
     │    sessionId:"abc123",  │                     │                     │                   │
     │    timeout: 30000       │                     │                     │                   │
     │  })                     │                     │                     │                   │
     │─────────────────────────▶                     │                     │                   │
     │                         │                     │                     │                   │
     │                         │  ① getSession(id)  │                     │                   │
     │                         │────────────────────▶│                     │                   │
     │                         │  返回 ProcessSession│                     │                   │
     │                         │◀────────────────────│                     │                   │
     │                         │                     │                     │                   │
     │                         │  ② 检查 backgrounded │                     │                   │
     │                         │  if (!backgrounded) → fail              │                   │
     │                         │                     │                     │                   │
     │                         │  ③ 阻塞等待 (如果 !exited)               │                   │
     │                         │  while(!exited &&    │                   │                   │
     │                         │    Date.now()<deadline){                │                   │
     │                         │    await sleep(250ms)│                   │                   │
     │                         │  }                  │                   │                   │
     │                         │                     │                   │                   │
     │  ... (最多等待30秒，每250ms检查 exited 标志)    │                   │                   │
     │                         │                     │                   │                   │
     │                         │  ④ drainSession()   │                   │                   │
     │                         │────────────────────▶│                   │                   │
     │                         │  pendingStdout → join("")               │                   │
     │                         │  pendingStderr → join("")               │                   │
     │                         │  清空 pending 缓冲    │                   │                   │
     │                         │◀────────────────────│                   │                   │
     │                         │  返回 { stdout, stderr }               │                   │
     │                         │                     │                     │                   │
     │                         │  ⑤ 检查 exited 标志  │                     │                   │
     │                         │  if(exited) {                            │                   │
     │                         │    exitCode===0 → "completed"           │                   │
     │                         │    exitCode!==0 → "failed"              │                   │
     │                         │  } else {                               │                   │
     │                         │    → "running"                          │                   │
     │                         │  }                                      │                   │
     │                         │                     │                     │                   │
     │  { status:"running",   │                     │                     │                   │
     │    text: "Compiling... │                     │                     │                   │
     │           Module A ✓\n │                     │                     │                   │
     │           Process still│                     │                     │                   │
     │           running.",   │                     │                     │                   │
     │    retryInMs: 5000 }   │                     │                     │                   │
     │◀────────────────────────│                     │                     │                   │
     │                         │                     │                     │                   │
     │  ... 继续多轮交互 ...      │                     │                     │                   │
     │                         │                     │                     │                   │
     │                         │                     │                     │                   │
     │  ★ 第N步：最终轮询，进程已退出                                   │                   │
     │  process({              │                     │                     │                   │
     │    action:"poll",       │                     │                     │                   │
     │    sessionId:"abc123"   │                     │                     │                   │
     │  })                     │                     │                     │                   │
     │─────────────────────────▶                     │                     │                   │
     │                         │                     │                     │                   │
     │                         │                     │  ╔═══════════════════════════════════╗
     │                         │                     │  ║  进程自然退出                    ║
     │                         │                     │  ║  child.once("close") →          ║
     │                         │                     │  ║  adapter.wait()  resolve         ║
     │                         │                     │  ║  → managedRun.wait() resolve     ║
     │                         │                     │  ║  → markExited(session, 0, null,  ║
     │                         │                     │  ║      "completed")               ║
     │                         │                     │  ║  → session.exited = true         ║
     │                         │                     │  ║  → runningSessions.delete()      ║
     │                         │                     │  ║  → finishedSessions.set()        ║
     │                         │                     │  ╚═══════════════════════════════════╝
     │                         │                     │                     │                   │
     │                         │  检查 exited = true  │                     │                   │
     │                         │  drainSession()     │                     │                   │
     │                         │  exitted → "completed"                    │                   │
     │                         │                     │                     │                   │
     │  { status:"completed", │  Process exited with code 0.                  │                   │
     │    exitCode: 0,        │                     │                     │                   │
     │    text: "...Build     │                     │                     │                   │
     │     complete.\n        │                     │                     │                   │
     │     Process exited     │                     │                     │                   │
     │     with code 0." }    │                     │                     │                   │
     │◀────────────────────────│                     │                     │                   │
```

## 三、Agent 如何从 Shell 获取结果

Agent 获取结果依赖**两个层面**，互为冗余：

### 3.1 实时输出捕获层（进程运行时）

无论进程是前台还是后台，一旦启动，`ProcessSession` 就是接收输出的**唯一汇聚点**：

```
 OS Process                     ProcessSession (内存)                    Agent (LLM)
 ──────────────────────────────────────────────────────────────────────────────────
        │                            │                                       │
        │  stdout "line 1\n"        │                                       │
        │ ──────────────────────────▶                                       │
        │                            │  handleStdout(chunk)                  │
        │                            │    → appendOutput("stdout", chunk)    │
        │                            │      → pendingStdout.push(chunk)       │
        │                            │      → pendingStdoutChars += len      │
        │                            │      → aggregated += chunk            │
        │                            │      → tail = last 2000 chars         │
        │                            │      → totalOutputChars += len        │
        │                            │                                       │
        │                            │  emitUpdate()  ← 仅 subscriber 可见   │
        │                            │    → onUpdate({ tail })  ~实时预览    │
```

**关键代码** — [bash-process-registry.ts L107-L130](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts#L107-L130)：

```typescript
export function appendOutput(
  session: ProcessSession,
  stream: "stdout" | "stderr",
  chunk: string
) {
  // 1. 写入对应 pending 缓冲区
  const buffer = stream === "stdout" ? session.pendingStdout : session.pendingStderr;
  buffer.push(chunk);
  let pendingChars = bufferChars + chunk.length;

  // 2. 容量控制：pending 上限 30K → 超出则标 truncated
  if (pendingChars > pendingCap) {
    session.truncated = true;
    pendingChars = capPendingBuffer(buffer, pendingChars, pendingCap);
  }

  // 3. 累积到 aggregated（上限 200K）
  session.aggregated = trimWithCap(session.aggregated + chunk, session.maxOutputChars);

  // 4. 保留尾部 2000 字符供快速预览
  session.tail = tail(session.aggregated, 2000);
}
```

### 3.2 ProcessSession 缓冲区设计

| 缓冲区 | 容量 | 用途 |
|--------|------|------|
| `pendingStdout/pendingStderr` | 30K（每个 buffer） | 增量缓冲区，`drainSession()` 读取并清空 |
| `aggregated` | 200K | 全量累积输出，不会被清空 |
| `tail` | 最后 2000 字符 | 快速预览，供 poll/log/onUpdate 使用 |
| `totalOutputChars` | 无上限 | 统计总输出字符数 |

### 3.3 增量排空层（Agent poll 时）

当 Agent 调用 `process({ action: "poll", sessionId })` 时，系统通过 `drainSession()` **排空并清空 pending 缓冲区**，实现增量输出：

**关键代码** — [bash-process-registry.ts L135-L143](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts#L135-L143)：

```typescript
export function drainSession(session: ProcessSession) {
  const stdout = session.pendingStdout.join("");   // 拼接所有 stdout 片段
  const stderr = session.pendingStderr.join("");   // 拼接所有 stderr 片段
  session.pendingStdout = [];    // 清空！（下次 poll 只拿新输出）
  session.pendingStderr = [];    // 清空！
  session.pendingStdoutChars = 0;
  session.pendingStderrChars = 0;
  return { stdout, stderr };
}
```

**这就是"增量"的关键**：每次 poll 只返回**上次 poll 之后**产生的新输出。Agent 可以连续多轮 poll，每轮拿到的是进程自上次 poll 以来的增量输出。

### 3.4 poll 阻塞等待机制

**关键代码** — [bash-tools.process.ts L402-L415](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L402-L415)：

```typescript
// process poll 中的阻塞等待循环
const pollWaitMs = resolvePollWaitMs(params.timeout);  // 默认 0，最大 120_000
if (pollWaitMs > 0 && !scopedSession.exited) {
  const deadline = Date.now() + pollWaitMs;
  while (!scopedSession.exited && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(250, deadline - Date.now()))),
    );
  }
}
// 阻塞结束后再 drainSession → 拿到截止目前累积的所有新输出
const { stdout, stderr } = drainSession(scopedSession);
```

这个设计意味着：
- **不传 timeout** → 立即 drain，只拿已有输出（零等待）
- **传 timeout=30000** → 最多阻塞 30 秒，每 250ms 检查一次 `exited` 标志

### 3.5 轮询退避策略

当连续 poll 都没有新输出时，系统通过退避算法建议模型增加等待间隔，避免无效频繁轮询：

**关键代码** — [command-poll-backoff.ts L4-L42](file:///d:/prj/openclaw_analyze/src/agents/command-poll-backoff.ts#L4-L42)：

```typescript
// 退避时间表
const BACKOFF_SCHEDULE_MS = [5000, 10000, 30000, 60000];

export function recordCommandPoll(
  state: SessionState,
  commandId: string,
  hasNewOutput: boolean,
): number {
  if (hasNewOutput) {
    // 有新输出 → 重置计数器 → 建议 5 秒后再 poll
    state.commandPollCounts.set(commandId, { count: 0, lastPollAt: now });
    return 5000;
  }
  // 无新输出 → 递增计数器 → 按退避表建议
  const newCount = (existing?.count ?? -1) + 1;
  return calculateBackoffMs(newCount);  // 5s→10s→30s→60s
}
```

返回结果中携带 `retryInMs`：

```typescript
// bash-tools.process.ts L458
details: {
  status, sessionId, exitCode, aggregated,
  ...(typeof retryInMs === "number" ? { retryInMs } : {}),  // ← 告诉模型下次多久再 poll
}
```

### 3.6 全量日志查看（process log）

除了增量 poll，Agent 还可以通过 `process({ action: "log", sessionId })` 查看完整的 `aggregated` 输出，支持 `offset`/`limit` 分页：

**代码** — [bash-tools.process.ts L467-L525](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L467-L525)：

```typescript
case "log": {
  // 从 scopedSession.aggregated 中按 offset/limit 切片
  const window = resolveLogSliceWindow(params.offset, params.limit);
  const { slice, totalLines, totalChars } = sliceLogLines(
    scopedSession.aggregated,
    window.effectiveOffset,
    window.effectiveLimit,
  );
  return {
    content: [{ type: "text", text: (slice || "(no output yet)") + logDefaultTailNote }],
    details: { status, sessionId, totalLines, totalChars, truncated, ... },
  };
}
```

---

## 四、Agent 如何判断任务执行完毕

### 4.1 退出信号传播链：从 OS 到 ProcessSession

```
 OS 进程退出
     │
     │  child_process "close" 事件
     ▼
 ChildAdapter.wait() resolve
     │  adapter.wait() → { code: 0, signal: null }
     ▼
 ProcessSupervisor waitPromise resolve
     │  adapter.wait() 结果 → 构建 RunExit
     │  registry.finalize(runId, ...)
     │  active.delete(runId)
     │  → managedRun.wait() resolve
     ▼
 runExecProcess → managedRun.wait().then(...)
     │  exit.reason === "exit" 且 exitCode 不是 126/127
     │  → status: "completed"
     │  → 调用 markExited(session, exitCode, exitSignal, status)
     ▼
 ProcessSession.exited = true
     │  session.exitCode = 0
     │  runningSessions.delete(id)
     │  finishedSessions.set(id, finishedRecord)
     ▼
 Agent 下次 poll 发现 session.exited === true
     │
     └─ 返回: "Process exited with code 0."
```

### 4.2 第一步：ChildAdapter 监听 OS 进程 "close" 事件

**关键代码** — [child.ts L112-L117](file:///d:/prj/openclaw_analyze/src/process/supervisor/adapters/child.ts#L112-L117)：

```typescript
const wait = async () =>
  await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal });   // ← OS 进程退出时触发
      });
    },
  );
```

### 4.3 第二步：ProcessSupervisor 等待 + 构建 RunExit

**关键代码** — [supervisor.ts L268-L303](file:///d:/prj/openclaw_analyze/src/process/supervisor/supervisor.ts#L268-L303)：

```typescript
const waitPromise = (async (): Promise<RunExit> => {
  const result = await adapter.wait();  // ← 阻塞直到进程退出

  if (settled) { /* 被外部提前终止 */ }

  settled = true;
  clearTimers();           // 清理超时定时器
  adapter.dispose();        // 释放 adapter 资源
  active.delete(runId);    // 从活跃运行列表移除

  const reason: TerminationReason =
    forcedReason ??
    (result.signal != null ? "signal" : "exit");

  // 在 RunRegistry 中记录最终状态
  registry.finalize(runId, {
    reason: exit.reason,
    exitCode: exit.exitCode,
    exitSignal: exit.exitSignal,
  });

  return exit;
})();
```

`managedRun.wait()` 就是上面这个 Promise。`RunRegistry.finalize()` 将记录状态更新为 `"exited"`，并写入 exitCode/exitSignal。

### 4.4 第三步：runExecProcess 消费退出事件 → markExited

**关键代码** — [bash-tools.exec-runtime.ts L662-L696](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts#L662-L696)：

```typescript
const promise = managedRun.wait().then((exit): ExecProcessOutcome => {
  const isNormalExit = exit.reason === "exit";
  const exitCode = exit.exitCode ?? 0;
  const isShellFailure = exitCode === 126 || exitCode === 127;

  // ★ 状态判定 ★
  const status: "completed" | "failed" =
    isNormalExit && !isShellFailure ? "completed" : "failed";

  // ★★ 核心：设置 exited 标志 + 从 runningSessions 移到 finishedSessions ★★
  markExited(session, exit.exitCode, exit.exitSignal, status);
  // ...
});
```

状态判定逻辑：

| 条件 | status | 说明 |
|------|--------|------|
| `exit.reason === "exit"` 且 exitCode 不是 126/127 | `"completed"` | 正常退出 |
| `exitCode === 126` | `"failed"` | 命令不可执行（权限问题） |
| `exitCode === 127` | `"failed"` | 命令未找到 |
| `exit.reason === "overall-timeout"` | `"failed"` | 超时被杀死 |
| `exit.reason === "no-output-timeout"` | `"failed"` | 无输出超时 |
| `exit.reason === "signal"` 或 `exitSignal != null` | `"failed"` | 被信号终止 |

### 4.5 第四步：markExited → 数据结构状态转换

**关键代码** — [bash-process-registry.ts L145-L155](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts#L145-L155)：

```typescript
export function markExited(
  session: ProcessSession,
  exitCode: number | null,
  exitSignal: NodeJS.Signals | number | null,
  status: ProcessStatus,
) {
  session.exited = true;        // ★ Agent poll 时检查的标志位 ★
  session.exitCode = exitCode;  // ★ 退出码 ★
  session.exitSignal = exitSignal;
  session.tail = tail(session.aggregated, 2000);
  moveToFinished(session, status); // 从 runningSessions → finishedSessions
}

function moveToFinished(session: ProcessSession, status: ProcessStatus) {
  runningSessions.delete(session.id);  // 从运行中移除

  // 清理 child process IO 资源
  if (session.child) { /* destroy stdio, remove listeners */ }
  if (session.stdin) { /* destroy/end stdin */ }

  if (!session.backgrounded) return;  // 非后台的不进 completed 表

  // ★ 后台进程退出后移入 finishedSessions ★
  finishedSessions.set(session.id, {
    id: session.id, command: session.command,
    startedAt, endedAt, status,
    exitCode, exitSignal,
    aggregated: session.aggregated, tail: session.tail,
    truncated: session.truncated, totalOutputChars,
  });
}
```

### 4.6 第五步：Agent poll 检测 exited 标志

**关键代码** — [bash-tools.process.ts L416-L460](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L416-L460)：

```typescript
// 阻塞等待结束后
const { stdout, stderr } = drainSession(scopedSession);
const exited = scopedSession.exited;   // ★ 检查标志位 ★
const exitCode = scopedSession.exitCode ?? 0;
const exitSignal = scopedSession.exitSignal ?? undefined;

if (exited) {
  const status = exitCode === 0 && exitSignal == null ? "completed" : "failed";
  markExited(scopedSession, exitCode, exitSignal, status); // 再次确保 moveToFinished
}

// ★ 返回给模型的状态 ★
const status = exited
  ? exitCode === 0 && exitSignal == null ? "completed" : "failed"
  : "running";

return {
  content: [{
    type: "text",
    text: (output || "(no new output)") +
      (exited
        ? `\n\nProcess exited with ${
            exitSignal ? `signal ${exitSignal}` : `code ${exitCode}`
          }.`
        : "\n\nProcess still running."),
  }],
  details: {
    status,               // "completed" | "failed" | "running"
    sessionId, exitCode, aggregated,
    ...(retryInMs ? { retryInMs } : {}),  // 退避建议（仅 running 时返回）
  },
};
```

### 4.7 补充：已退出进程的后续 poll

如果进程已经退出且移入了 `finishedSessions`，下次 poll 会走另一条路径，直接从 `finishedSessions` 中读取结果：

**关键代码** — [bash-tools.process.ts L365-L393](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L365-L393)：

```typescript
case "poll": {
  if (!scopedSession) {
    if (scopedFinished) {
      // ★ 从 finishedSessions 中读取已完成的结果 ★
      return {
        content: [{
          type: "text",
          text: scopedFinished.tail +
            `\n\nProcess exited with ${
              scopedFinished.exitSignal
                ? `signal ${scopedFinished.exitSignal}`
                : `code ${scopedFinished.exitCode ?? 0}`
            }.`,
        }],
        details: {
          status: scopedFinished.status === "completed" ? "completed" : "failed",
          exitCode: scopedFinished.exitCode,
          aggregated: scopedFinished.aggregated,
        },
      };
    }
  }
  // ...正常 poll 路径...
}
```

---

## 五、两类"完成"判定对比

```
                    一次性 Shell 调用                         长时 Shell 执行
                   ═══════════════                         ═══════════════

  谁等进程退出？   exec 工具调用自身阻塞等待                   process poll 轮询检查
                   managedRun.wait() → .then()               scopedSession.exited 标志位

  何时返回结果？   进程退出后一次性返回所有 aggregated         每次 poll 返回增量 pending 输出
                                                            进程退出后返回 "Process exited with code N."

  退出检测点       同一个 managedRun.wait()                    同一个 managedRun.wait()
                    → markExited(session)                     → markExited(session)
                                                              → session.exited = true
                                                              → Agent 下一次 poll 感知

  输出获取方式      promise.then 中直接读                      每次调用 drainSession()
                   session.aggregated                        排空 pending buffers
                                                            也可以通过 process log 读 aggregated

  状态最终位置      finishedSessions（backgrounded=false      finishedSessions（backgrounded=true
                   时仅清理不进 finishedSessions）             时进入 finishedSessions）
```

---

## 六、通知机制：后台进程退出主动通知

后台进程退出后，除了通过 poll 被动感知，系统还通过 `maybeNotifyOnExit` 主动发送通知：

**关键代码** — [bash-tools.exec-runtime.ts L284-L307](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts#L284-L307)：

```typescript
function maybeNotifyOnExit(session: ProcessSession, status: "completed" | "failed") {
  if (!session.backgrounded || !session.notifyOnExit || session.exitNotified) {
    return;  // 非后台 / 未启用通知 / 已通知过 → 跳过
  }
  session.exitNotified = true;

  const summary = output
    ? `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}`
    : `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel})`;

  // 发送系统事件
  enqueueSystemEvent(summary, { sessionKey });

  // 触发心跳以确保通知被发送
  requestHeartbeatNow(
    scopedHeartbeatWakeOptions(sessionKey, { reason: `exec:${session.id}:exit` }),
  );
}
```

通知流程：
1. 检查 `backgrounded`、`notifyOnExit`、`exitNotified` 三重条件
2. 构建通知摘要（含退出码/信号 + 尾部输出）
3. 调用 `enqueueSystemEvent` 将通知写入系统事件队列
4. 调用 `requestHeartbeatNow` 唤醒心跳，确保通知在下一次心跳中送达用户

---

## 七、关键类/函数速查

| 类/函数 | 文件 | 职责 |
|---------|------|------|
| `processTool.execute("poll")` | [bash-tools.process.ts L362-L460](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L362-L460) | Agent 轮询入口，阻塞等待 + drain + 状态返回 |
| `processTool.execute("log")` | [bash-tools.process.ts L467-L525](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L467-L525) | 全量日志查看，支持 offset/limit 分页 |
| `processTool.execute("write")` | [bash-tools.process.ts L540-L557](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L540-L557) | 向后台进程 stdin 写入数据 |
| `processTool.execute("submit")` | [bash-tools.process.ts L588-L596](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L588-L596) | 发送回车（CR），提交当前输入行 |
| `processTool.execute("send-keys")` | [bash-tools.process.ts L559-L587](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L559-L587) | 发送按键序列（token/hex/literal） |
| `processTool.execute("kill")` | [bash-tools.process.ts L630-L661](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L630-L661) | 终止后台会话 |
| `drainSession()` | [bash-process-registry.ts L135-L143](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts#L135-L143) | 排空 pending 缓冲区，返回增量输出 |
| `appendOutput()` | [bash-process-registry.ts L107-L130](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts#L107-L130) | 实时累积 stdout/stderr 到 ProcessSession |
| `markExited()` | [bash-process-registry.ts L145-L155](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts#L145-L155) | 设置 `exited=true` + 移入 finishedSessions |
| `markBackgrounded()` | [bash-process-registry.ts L157-L159](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts#L157-L159) | 设置 `backgrounded=true`（yield 时调用） |
| `moveToFinished()` | [bash-process-registry.ts L161-L204](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts#L161-L204) | 从 runningSessions → finishedSessions，清理资源 |
| `managedRun.wait()` | [supervisor.ts L268-L303](file:///d:/prj/openclaw_analyze/src/process/supervisor/supervisor.ts#L268-L303) | 等待进程退出，返回 RunExit |
| `ChildAdapter.wait()` | [child.ts L112-L117](file:///d:/prj/openclaw_analyze/src/process/supervisor/adapters/child.ts#L112-L117) | 监听 child_process "close" 事件 |
| `recordCommandPoll()` | [command-poll-backoff.ts L22-L42](file:///d:/prj/openclaw_analyze/src/agents/command-poll-backoff.ts#L22-L42) | 退避策略：根据有无新输出返回建议重试间隔 |
| `maybeNotifyOnExit()` | [bash-tools.exec-runtime.ts L284-L307](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts#L284-L307) | 后台进程退出时发送系统通知 + 触发 heartbeat |
| `ProcessSession` | [bash-process-registry.ts L30-L66](file:///d:/prj/openclaw_analyze/src/agents/bash-process-registry.ts#L30-L66) | 进程会话数据结构 |
| `RunRegistry` | [supervisor/registry.ts L17-L36](file:///d:/prj/openclaw_analyze/src/process/supervisor/registry.ts#L17-L36) | 运行状态记录（starting→running→exiting→exited） |
| `ProcessSupervisor` | [supervisor.ts](file:///d:/prj/openclaw_analyze/src/process/supervisor/supervisor.ts) | 进程生命周期管理器（spawn/cancel/cancelScope） |
| `ManagedRun` | [supervisor/types.ts L33-L39](file:///d:/prj/openclaw_analyze/src/process/supervisor/types.ts#L33-L39) | 托管运行句柄（wait/cancel/stdin） |
| `RunExit` | [supervisor/types.ts L20-L29](file:///d:/prj/openclaw_analyze/src/process/supervisor/types.ts#L20-L29) | 进程退出结果（reason/exitCode/exitSignal/stdout/stderr） |