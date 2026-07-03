# SubAgent 任务发现与分解机制分析

## 一、整体架构概览

OpenClaw 是一个多通道 AI Agent 平台。系统中的 **任务分解** 不是由某个"调度器"主动发现并分发给 SubAgent，而是通过 **两级机制** 实现：

1. **第一级（消息路由）**：入站消息通过 Session Key 路由到对应的 Agent
2. **第二级（Agent 自行分解）**：AI Agent 在思考过程中，通过调用 `sessions_spawn` 工具主动将子任务分派给 SubAgent

---

## 二、核心流程（流程图）

```
┌─────────────────────────────────────────────────────────────────────┐
│                        消息入口（各Channel）                          │
│  Telegram / WhatsApp / Discord / Slack / Signal / iMessage / IRC... │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ MsgContext
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  dispatchInboundMessage()                  [dispatch.ts]            │
│  └─ dispatchReplyFromConfig()             [dispatch-from-config.ts] │
│       │                                                             │
│       ├─ 1. 去重检查 (shouldSkipDuplicateInbound)                   │
│       ├─ 2. 解析 SessionKey → 确定 AgentId                          │
│       ├─ 3. 触发 Plugin Hooks (message_received)                    │
│       ├─ 4. 尝试快速中止 (tryFastAbortFromMessage)                   │
│       ├─ 5. 检查发送策略 (resolveSendPolicy)                         │
│       ├─ 6. 尝试 ACP 分发 (tryDispatchAcpReply)                      │
│       └─ 7. 常规Agent回复 (getReplyFromConfig)                       │
│              │                                                      │
│              ▼                                                      │
│  getReplyFromConfig()                      [get-reply.ts]           │
│  └─ runPreparedReply()                    [get-reply-run.ts]        │
│       └─ runReplyAgent()                  [agent-runner.ts]         │
│            └─ runAgentTurnWithFallback()                            │
│                 └─ runEmbeddedPiAgent()    [pi-embedded-runner/run.ts]│
│                      │                                              │
│                      │  AI Agent 在对话中决定调用 sessions_spawn    │
│                      ▼                                              │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │  sessions_spawn 工具调用                                  │       │
│  │  [sessions-spawn-tool.ts]                                 │       │
│  │                                                           │       │
│  │  runtime="subagent"          runtime="acp"                │       │
│  │  ┌──────────────────┐       ┌──────────────────┐         │       │
│  │  │ spawnSubagentDirect│       │ spawnAcpDirect    │         │       │
│  │  │ [subagent-spawn.ts]│       │ [acp-spawn.ts]    │         │       │
│  │  └────────┬──────────┘       └────────┬──────────┘         │       │
│  │           │                           │                     │       │
│  │           ▼                           ▼                     │       │
│  │  ┌──────────────────┐       ┌──────────────────┐         │       │
│  │  │ 通过Gateway API    │       │ 通过ACP Session    │         │       │
│  │  │ 启动子Agent运行    │       │ Manager启动       │         │       │
│  │  └────────┬──────────┘       └────────┬──────────┘         │       │
│  │           │                           │                     │       │
│  │           ▼                           ▼                     │       │
│  │  ┌──────────────────────────────────────────────┐         │       │
│  │  │        enqueueCommandInLane()                │         │       │
│  │  │        [command-queue.ts]                    │         │       │
│  │  │                                              │         │       │
│  │  │  lane: "subagent" / "acp" / "main" / "cron" │         │       │
│  │  └──────────────────┬───────────────────────────┘         │       │
│  │                     │                                      │       │
│  │                     ▼                                      │       │
│  │  ┌──────────────────────────────────────────────┐         │       │
│  │  │  SubAgent 独立运行                             │         │       │
│  │  │  runEmbeddedPiAgent() / ACP Session           │         │       │
│  │  │  (独立的workspace、独立的session、独立context) │         │       │
│  │  └──────────────────┬───────────────────────────┘         │       │
│  │                     │                                      │       │
│  │                     ▼                                      │       │
│  │  ┌──────────────────────────────────────────────┐         │       │
│  │  │  结果回传 (Announce)                          │         │       │
│  │  │  subagent-registry.ts → subagent-announce.ts │         │       │
│  │  │  通过 Plugin Hook 或 Gateway API 通知父进程    │         │       │
│  │  └──────────────────────────────────────────────┘         │       │
│  └──────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 三、关键类与文件

### 1. 消息入口与路由层

| 文件 | 关键类/函数 | 职责 |
|------|------------|------|
| `src/auto-reply/dispatch.ts` | `dispatchInboundMessage()` | 入站消息的统一入口，创建 ReplyDispatcher 并调用 dispatchReplyFromConfig |
| `src/auto-reply/reply/dispatch-from-config.ts` | `dispatchReplyFromConfig()` | **核心调度函数**：去重→策略检查→ACP分发→常规Agent回复 |
| `src/auto-reply/reply/dispatch-acp.ts` | `tryDispatchAcpReply()` | 尝试通过 ACP (Agent Communication Protocol) 会话处理消息 |
| `src/routing/session-key.ts` | `resolveAgentIdFromSessionKey()` / `parseAgentSessionKey()` | 解析 `agent:<agentId>:<key>` 格式的 SessionKey，路由到正确的 Agent |

**Session Key 路由机制**（`src/routing/session-key.ts`）：
```
格式: agent:<agentId>:<rest>
例如: agent:main:telegram:direct:user123
      agent:coding:subagent:uuid-xxx
```

### 2. Agent 回复执行层

| 文件 | 关键类/函数 | 职责 |
|------|------------|------|
| `src/auto-reply/reply/get-reply.ts` | `getReplyFromConfig()` | 加载配置、初始化Session、处理指令、调用 Agent Runner |
| `src/auto-reply/reply/get-reply-run.ts` | `runPreparedReply()` | 组装前置上下文后调用 `runReplyAgent()` |
| `src/auto-reply/reply/agent-runner.ts` | `runReplyAgent()` | 最终调用 `runAgentTurnWithFallback()` → `runEmbeddedPiAgent()` 执行 AI 推理 |

### 3. SubAgent 分解与生成层（核心）

| 文件 | 关键类/函数 | 职责 |
|------|------------|------|
| `src/agents/tools/sessions-spawn-tool.ts` | `createSessionsSpawnTool()` | **核心工具**：创建 `sessions_spawn` 工具供 AI Agent 调用，支持 `runtime="subagent"` 和 `runtime="acp"` 两种模式 |
| `src/agents/subagent-spawn.ts` | `spawnSubagentDirect()` | **核心生成逻辑**：校验深度限制、Agent白名单、并发限制、沙箱模式，创建子Session并发起 Agent 运行 |
| `src/agents/acp-spawn.ts` | `spawnAcpDirect()` | ACP 运行时子进程生成：通过 ACP Session Manager 启动独立会话 |
| `src/agents/agent-scope.ts` | `resolveAgentConfig()` / `resolveSessionAgentId()` | 根据 SessionKey/AgentId 解析对应的 Agent 配置（模型、工作区、技能、子Agent策略等） |

### 4. 并发控制与排队层

| 文件 | 关键类/函数 | 职责 |
|------|------------|------|
| `src/process/lanes.ts` | `CommandLane` 枚举 | 定义四个并发通道：`main`, `cron`, `subagent`, `nested` |
| `src/process/command-queue.ts` | `enqueueCommandInLane()` | **并发控制核心**：按 Lane 将命令排队，每个 Lane 支持配置最大并发数，防止资源冲突 |
| `src/agents/lanes.ts` | `AGENT_LANE_SUBAGENT` / `resolveNestedAgentLane()` | 将 Agent 类型映射到对应的 CommandLane |

```typescript
// src/process/lanes.ts - 并发通道定义
export const enum CommandLane {
  Main = "main",         // 主Agent通道
  Cron = "cron",         // 定时任务通道
  Subagent = "subagent", // 子Agent通道（独立队列）
  Nested = "nested",     // 嵌套通道（cron内部操作）
}
```

### 5. SubAgent 生命周期管理层

| 文件 | 关键类/函数 | 职责 |
|------|------------|------|
| `src/agents/subagent-registry.ts` | `registerSubagentRun()` / SubagentRunRecord管理 | **子进程注册中心**：跟踪所有活跃子Agent的运行状态、清理策略、结果回传 |
| `src/agents/subagent-registry.types.ts` | `SubagentRunRecord` | 子Agent运行的完整状态记录（sessionKey、任务、模型、清理策略、结果等） |
| `src/agents/subagent-announce.ts` | `runSubagentAnnounceFlow()` | **结果回传**：子Agent完成后通过 Plugin Hook 或 Gateway API 将结果通知父Agent |

### 6. 执行引擎层

| 文件 | 关键类/函数 | 职责 |
|------|------------|------|
| `src/agents/pi-embedded.ts` | `runEmbeddedPiAgent()` / `queueEmbeddedPiMessage()` | 内嵌 PI (Prompt Injection) Agent 的执行入口 |
| `src/agents/pi-embedded-runner/run.ts` | 主执行循环 | 包含模型选择、认证配置、Failover重试、上下文窗口管理、Compaction等完整执行流程 |
| `src/agents/sandbox/runtime-status.ts` | `resolveSandboxRuntimeStatus()` | 根据 SessionKey 判断当前运行是否在沙箱中，决定工具策略 |
| `src/agents/cli-runner.ts` | `runCliAgent()` | CLI 模式下的 Agent 运行（用于部分provider如Claude CLI） |

---

## 四、SubAgent 任务分解的完整代码流程

### 阶段1：AI Agent 决定分派任务 → 调用 `sessions_spawn`

AI Agent 在推理过程中，通过工具调用发起子任务分派。工具实现在 `src/agents/tools/sessions-spawn-tool.ts`：

```typescript
// sessions_spawn 工具的参数定义
const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),                          // 子任务描述
  label: Type.Optional(Type.String()),           // 标签
  runtime: optionalStringEnum(["subagent", "acp"]), // 运行时类型
  agentId: Type.Optional(Type.String()),         // 目标Agent ID
  model: Type.Optional(Type.String()),           // 模型覆盖
  thinking: Type.Optional(Type.String()),        // 思考级别
  runTimeoutSeconds: Type.Optional(Type.Number()),
  thread: Type.Optional(Type.Boolean()),         // 是否绑定线程
  mode: optionalStringEnum(["run", "session"]),  // run=一次性, session=持久
  cleanup: optionalStringEnum(["delete", "keep"]),
  sandbox: optionalStringEnum(["inherit", "require"]),
  // ... attachments 等
});
```

**工具分发逻辑**（`src/agents/tools/sessions-spawn-tool.ts` L179-L211）：

```typescript
if (runtime === "acp") {
  // ACP 模式：通过 ACP Session Manager 启动独立会话
  const result = await spawnAcpDirect({ task, label, agentId, ... }, ctx);
  return jsonResult(result);
}

// SubAgent 模式：嵌入在当前进程中
const result = await spawnSubagentDirect({ task, label, agentId, ... }, ctx);
return jsonResult(result);
```

### 阶段2：`spawnSubagentDirect()` — 校验与准备

在 `src/agents/subagent-spawn.ts` L260-L500 中：

```typescript
export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  // ──── 第1步：校验 AgentId 格式 ────
  if (requestedAgentId && !isValidAgentId(requestedAgentId)) {
    return { status: "error", error: `Invalid agentId "${requestedAgentId}"...` };
  }

  // ──── 第2步：检查深度限制（防止无限递归）───
  const callerDepth = getSubagentDepthFromSessionStore(requesterInternalKey, { cfg });
  const maxSpawnDepth =
    cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  if (callerDepth >= maxSpawnDepth) {
    return {
      status: "forbidden",
      error: `sessions_spawn is not allowed at this depth (current depth: ${callerDepth}, max: ${maxSpawnDepth})`,
    };
  }

  // ──── 第3步：检查并发子Agent数量限制 ────
  const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
  const activeChildren = countActiveRunsForSession(requesterInternalKey);
  if (activeChildren >= maxChildren) {
    return {
      status: "forbidden",
      error: `sessions_spawn has reached max active children for this session (${activeChildren}/${maxChildren})`,
    };
  }

  // ──── 第4步：检查 Agent 白名单（跨Agent分派时）───
  if (targetAgentId !== requesterAgentId) {
    const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
    const allowAny = allowAgents.some((value) => value.trim() === "*");
    const allowSet = new Set(allowAgents...);
    if (!allowAny && !allowSet.has(normalizedTargetId)) {
      return { status: "forbidden", error: `agentId is not allowed...` };
    }
  }

  // ──── 第5步：生成子SessionKey ────
  const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;

  // ──── 第6步：检查沙箱策略 ────
  const requesterRuntime = resolveSandboxRuntimeStatus({ cfg, sessionKey: requesterInternalKey });
  const childRuntime = resolveSandboxRuntimeStatus({ cfg, sessionKey: childSessionKey });
  if (!childRuntime.sandboxed && requesterRuntime.sandboxed) {
    return { status: "forbidden", error: "Sandboxed sessions cannot spawn unsandboxed subagents." };
  }

  // ──── 第7步：构建子Agent System Prompt ────
  let childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey, requesterOrigin, childSessionKey,
    label, task, acpEnabled, childDepth, maxSpawnDepth,
  });

  // ──── 第8步：处理附件 ────
  const materializedAttachments = await materializeSubagentAttachments({...});
  if (materializedAttachments?.status === "ok") {
    childSystemPrompt = `${childSystemPrompt}\n\n${materializedAttachments.systemPromptSuffix}`;
  }

  // ──── 第9步：通过 Gateway API 发起 Agent 运行 ────
  const response = await callGateway({
    method: "agent",
    params: {
      message: childTaskMessage,
      sessionKey: childSessionKey,
      lane: AGENT_LANE_SUBAGENT,   // 使用 subagent 通道
      deliver: false,
      thinking: thinkingOverride,
      timeout: runTimeoutSeconds,
      label: label || undefined,
      ...
    },
  });

  // ──── 第10步：注册到 SubagentRegistry ────
  registerSubagentRun({
    runId: childRunId,
    childSessionKey,
    controllerSessionKey: requesterInternalKey,
    requesterSessionKey: requesterInternalKey,
    requesterOrigin, requesterDisplayKey,
    task, cleanup, label, model: resolvedModel, ...
  });
}
```

### 阶段3：子Agent 在独立 Lane 中执行

通过 `enqueueCommandInLane()` （`src/process/command-queue.ts` L158-L192）将子Agent放入 `subagent` 通道的队列：

```typescript
export function enqueueCommandInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: { warnAfterMs?: number; onWait?: (...) => void },
): Promise<T> {
  if (queueState.gatewayDraining) {
    return Promise.reject(new GatewayDrainingError());
  }
  const cleaned = lane.trim() || CommandLane.Main;
  const state = getLaneState(cleaned);  // 每个Lane独立队列
  return new Promise((resolve, reject) => {
    state.queue.push({
      task: () => task(),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs: opts?.warnAfterMs ?? 2_000,
      onWait: opts?.onWait,
    });
    drainLane(cleaned);  // 触发队列消费
  });
}
```

**Lane 消费机制**（`drainLane` 函数）：

```typescript
function drainLane(lane: string) {
  const state = getLaneState(lane);
  // ...
  const pump = () => {
    while (state.activeTaskIds.size < state.maxConcurrent && state.queue.length > 0) {
      const entry = state.queue.shift() as QueueEntry;
      const taskId = queueState.nextTaskId++;
      state.activeTaskIds.add(taskId);
      // 异步执行任务
      void (async () => {
        try {
          const result = await entry.task();
          completeTask(state, taskId, taskGeneration);
          pump();  // 触发下一个任务
          entry.resolve(result);
        } catch (err) {
          completeTask(state, taskId, taskGeneration);
          pump();
          entry.reject(err);
        }
      })();
    }
  };
  pump();
}
```

每个 Lane 维护独立队列，默认 `maxConcurrent=1`（串行），可通过 `setCommandLaneConcurrency()` 调整并行度。

### 阶段4：结果回传

子Agent完成后，`src/agents/subagent-announce.ts` 通过以下路径通知父Agent：

1. **Plugin Hook 路径**：通过 `subagent_spawned` / `subagent_ended` hooks 通知频道插件
2. **Gateway API 路径**：直接通过 `callGateway({ method: "agent", ... })` 发送结果消息到父Session
3. **队列消息路径**：通过 `queueEmbeddedPiMessage()` 注入到父Agent的消息队列

---

## 五、关键设计特点

### 1. Agent 自主决策

任务分解不是由中央调度器决定，而是由 AI Agent 在推理过程中自行判断并调用 `sessions_spawn` 工具。这是一种 **Agent-driven decomposition** 模式。

### 2. Lane 并发隔离

通过 `CommandLane` 枚举实现不同来源命令的并发隔离：

```typescript
// src/process/lanes.ts
export const enum CommandLane {
  Main = "main",         // 主Agent通道
  Cron = "cron",         // 定时任务通道
  Subagent = "subagent", // 子Agent通道（独立队列）
  Nested = "nested",     // 嵌套通道（cron内部操作避免死锁）
}
```

避免主Agent和子Agent的 stdin/stdout 交叉污染。

### 3. 深度与并发限制

- **`maxSpawnDepth`**：防止无限递归子Agent（默认值 `DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH`）
- **`maxChildrenPerAgent`**：限制每个Session的活跃子Agent数量（默认 `5`）
- **`maxConcurrent`**：每个Lane的并行度限制（可配置）

### 4. 双运行时支持

| 运行时 | 特点 | 适用场景 |
|--------|------|----------|
| `subagent` | 嵌入在进程内的子Agent，继承父进程工作区 | 轻量级子任务，同Agent内分解 |
| `acp` | 通过 ACP 协议运行的独立会话，支持外部 Codex 等 | 重量级任务，需要独立会话管理 |

### 5. 结果回传机制

通过 `SubagentRunRecord` 跟踪每个子Agent状态：

```typescript
// src/agents/subagent-registry.types.ts
export type SubagentRunRecord = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  spawnMode?: SpawnSubagentMode;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  frozenResultText?: string | null;  // 冻结的完成输出
  endedReason?: SubagentLifecycleEndedReason;
  wakeOnDescendantSettle?: boolean;  // 等待后代完成后唤醒
  // ...
};
```

完成后通过 announce 机制将结果异步推送到父Agent的消息流中。

### 6. 沙箱策略

子Agent可以运行在沙箱中，`resolveSandboxRuntimeStatus()` 根据 config 中的 `sandbox.mode` 配置判断：
- `off`：所有Session不在沙箱中
- `all`：所有Session都在沙箱中
- `non-main`：非主Session在沙箱中

沙箱Session不能生成非沙箱子Agent，确保安全隔离。

### 7. Agent 配置隔离

每个 Agent 可以通过配置独立设置：
- **model**：独立模型选择
- **workspace**：独立工作区目录
- **skills**：独立技能筛选
- **subagents**：子Agent策略（包括 `allowAgents` 白名单）
- **sandbox**：沙箱配置

---

## 六、关键数据流总结

```
┌──────────────┐    MsgContext     ┌──────────────────┐
│  Channel     │ ───────────────→  │ dispatchFromConfig│
│ (Telegram等) │                   │                    │
└──────────────┘                   │ 去重→策略→路由      │
                                   └────────┬─────────┘
                                            │
                                   ┌────────▼─────────┐
                                   │ getReplyFromConfig│
                                   │                    │
                                   │ 加载配置→初始化     │
                                   │ Session→准备回复   │
                                   └────────┬─────────┘
                                            │
                                   ┌────────▼─────────┐
                                   │ runReplyAgent     │
                                   │                    │
                                   │ 调用LLM推理        │
                                   │ → AI决定调用       │
                                   │   sessions_spawn   │
                                   └────────┬─────────┘
                                            │
                              ┌─────────────┼─────────────┐
                              │             │             │
                     ┌────────▼────┐ ┌─────▼──────┐ ┌────▼──────┐
                     │ SubAgent #1 │ │ SubAgent#2 │ │ SubAgent#N │
                     │ lane:subagt │ │ lane:subagt│ │ lane:subagt│
                     │ workspace_1 │ │ workspace_2│ │ workspace_N│
                     └──────┬──────┘ └─────┬──────┘ └────┬──────┘
                            │              │             │
                            ▼              ▼             ▼
                     ┌──────────────────────────────────────────┐
                     │      SubagentRegistry + Announce          │
                     │  结果回传 → 父Agent消息流                  │
                     └──────────────────────────────────────────┘
```