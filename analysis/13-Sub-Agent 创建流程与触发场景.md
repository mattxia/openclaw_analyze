# Sub-Agent 创建流程与触发场景分析

## 一、默认配置下的创建场景

### 1.1 核心触发机制

OpenClaw 中 Sub-Agent 的创建**只有一个入口**：通过 `sessions_spawn` 工具调用。

```typescript
// 文件：src/agents/tools/sessions-spawn-tool.ts
export function createSessionsSpawnTool(...): AnyAgentTool {
  return {
    name: "sessions_spawn",
    description: "Spawn an isolated session (runtime='subagent' or runtime='acp')...",
    execute: async (_toolCallId, args) => {
      // 1. 参数验证
      // 2. 检查运行时类型 (subagent 或 acp)
      // 3. 调用 spawnSubagentDirect()
      
      const result = await spawnSubagentDirect(params, ctx);
      return jsonResult(result);
    }
  };
}
```

**关键结论**：
- ✅ **唯一入口**：`sessions_spawn` 工具
- ✅ **两种运行时**：`runtime="subagent"` (默认) 或 `runtime="acp"`
- ✅ **触发者**：只能是 Agent (通过工具调用)，不能是用户直接命令

---

### 1.2 触发 Sub-Agent 的三种方式

虽然只有一个入口，但用户可以通过以下**三种方式**间接触发：

```
┌────────────────────────────────────────────────────────────┐
│              用户触发 Sub-Agent 的三种方式                  │
└────────────────────────────────────────────────────────────┘

方式 1: 用户直接请求 → Agent 自主决定派生
┌────────────────────────────────────────────────────────────┐
│ 用户："分析一下 2024 年 AI 领域的重大进展"                  │
│   ↓                                                         │
│ Agent 自主决策：                                            │
│   "这个任务可以并行处理，我派生 3 个子 Agent 分别研究..."     │
│   ↓                                                         │
│ Agent 调用 sessions_spawn (3 次)                            │
│   ├─ task: "研究 2024 年大语言模型进展"                     │
│   ├─ task: "研究 2024 年计算机视觉进展"                     │
│   └─ task: "研究 2024 年强化学习进展"                       │
└────────────────────────────────────────────────────────────┘

方式 2: 用户使用 /subagents spawn 命令
┌────────────────────────────────────────────────────────────┐
│ 用户："/subagents spawn researcher 分析这份财报"            │
│   ↓                                                         │
│ 命令处理器：handleSubagentsSpawnAction()                   │
│   ↓                                                         │
│ 调用 spawnSubagentDirect()                                  │
│   ↓                                                         │
│ 创建 Sub-Agent (agentId: researcher)                        │
└────────────────────────────────────────────────────────────┘

方式 3: 用户通过 Prose 等编排语言
┌────────────────────────────────────────────────────────────┐
│ 用户编写 prose 文件：                                       │
│                                                             │
│ parallel:                                                   │
│   security = session "Review security"                      │
│   performance = session "Review performance"                │
│   style = session "Review style"                            │
│                                                             │
│   ↓                                                         │
│ Prose 编译器 → 生成 sessions_spawn 工具调用                 │
│   ↓                                                         │
│ Gateway 执行 → 创建多个 Sub-Agent                           │
└────────────────────────────────────────────────────────────┘
```

---

## 二、完整的 Sub-Agent 创建流程

### 2.1 流程图（含关键类和代码位置）

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Sub-Agent 创建完整流程                                │
└─────────────────────────────────────────────────────────────────────────┘

阶段 1: 工具调用触发
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Agent 决定派生子 Agent                                               │
│    场景：                                                              │
│    - 需要并行化独立任务                                                │
│    - 需要长任务后台执行                                                │
│    - 需要上下文隔离                                                    │
│                                                                        │
│ 2. Agent 调用 sessions_spawn 工具                                      │
│    文件：src/agents/tools/sessions-spawn-tool.ts                      │
│    方法：createSessionsSpawnTool().execute()                          │
│                                                                        │
│    参数验证：                                                          │
│    ├─ task (必需): 任务描述                                            │
│    ├─ label (可选): 标签                                               │
│    ├─ agentId (可选): 目标 Agent ID                                    │
│    ├─ model (可选): 模型覆盖                                           │
│    ├─ thinking (可选): 思考级别                                        │
│    ├─ runTimeoutSeconds (可选): 超时时间                              │
│    ├─ thread (可选): 是否绑定线程                                      │
│    ├─ mode (可选): "run" 或 "session"                                  │
│    ├─ cleanup (可选): "delete" 或 "keep"                              │
│    └─ sandbox (可选): "inherit" 或 "require"                          │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
阶段 2: 前置检查与验证
┌────────────────────────────────────────────────────────────────────────┐
│ 文件：src/agents/subagent-spawn.ts                                    │
│ 方法：spawnSubagentDirect()                                           │
│                                                                        │
│ 2.1 验证 agentId 格式                                                   │
│     代码：                                                             │
│     if (!isValidAgentId(requestedAgentId)) {                          │
│       return { status: "error", error: "Invalid agentId..." };        │
│     }                                                                  │
│                                                                        │
│ 2.2 解析运行模式                                                        │
│     代码：                                                             │
│     const spawnMode = resolveSpawnMode({                               │
│       requestedMode: params.mode,                                      │
│       threadRequested: requestThreadBinding                            │
│     });                                                                │
│                                                                        │
│ 2.3 加载配置文件                                                        │
│     文件：src/config/config.ts                                         │
│     方法：loadConfig()                                                 │
│                                                                        │
│ 2.4 计算当前深度                                                        │
│     文件：src/agents/subagent-depth.ts                                 │
│     方法：getSubagentDepthFromSessionStore()                          │
│     逻辑：                                                             │
│     - 从会话存储中读取 spawnDepth                                      │
│     - 通过 spawnedBy 追溯父链                                          │
│     - 返回当前深度 (0=Main, 1=Sub, 2=Sub-Sub)                         │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
阶段 3: 权限与限制检查
┌────────────────────────────────────────────────────────────────────────┐
│ 3.1 深度限制检查                                                       │
│     文件：src/config/agent-limits.ts                                   │
│     默认值：DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1                      │
│     代码：                                                             │
│     if (callerDepth >= maxSpawnDepth) {                               │
│       return { status: "forbidden",                                   │
│                error: "sessions_spawn is not allowed at this depth" };│
│     }                                                                  │
│                                                                        │
│ 3.2 并发限制检查                                                       │
│     默认值：maxChildrenPerAgent = 5                                   │
│     方法：countActiveRunsForSession()                                 │
│     代码：                                                             │
│     if (activeChildren >= maxChildren) {                              │
│       return { status: "forbidden",                                   │
│                error: "reached max active children" };                │
│     }                                                                  │
│                                                                        │
│ 3.3 Agent 允许列表检查                                                 │
│     配置：agents.list[].subagents.allowAgents                         │
│     代码：                                                             │
│     const allowAgents = cfg.subagents?.allowAgents ?? [];             │
│     if (!allowAny && !allowSet.has(normalizedTargetId)) {            │
│       return { status: "forbidden", error: "agentId not allowed" };  │
│     }                                                                  │
│                                                                        │
│ 3.4 沙箱隔离检查                                                       │
│     文件：src/agents/sandbox/runtime-status.ts                        │
│     逻辑：                                                             │
│     - 检查请求者会话是否沙箱化                                         │
│     - 检查目标会话是否沙箱化                                           │
│     - 沙箱会话不能派生非沙箱子 Agent                                  │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
阶段 4: 会话创建与初始化
┌────────────────────────────────────────────────────────────────────────┐
│ 4.1 生成子会话 Key                                                      │
│     代码：                                                             │
│     const childSessionKey = `agent:${targetAgentId}:subagent:${uuid}` │
│                                                                        │
│ 4.2 解析目标 Agent 配置                                                 │
│     文件：src/agents/agent-scope.ts                                    │
│     方法：resolveAgentConfig()                                        │
│                                                                        │
│ 4.3 解析模型配置                                                        │
│     文件：src/agents/model-selection.ts                                │
│     方法：resolveSubagentSpawnModelSelection()                        │
│     优先级：                                                           │
│     1. sessions_spawn.model (最高)                                    │
│     2. agents.list[].subagents.model                                  │
│     3. agents.defaults.subagents.model                                │
│     4. 继承主 Agent 模型 (默认)                                        │
│                                                                        │
│ 4.4 解析思考级别                                                        │
│     文件：src/auto-reply/thinking.js                                   │
│     方法：normalizeThinkLevel()                                       │
│     优先级：同模型配置                                                 │
│                                                                        │
│ 4.5 应用会话补丁                                                        │
│     文件：src/gateway/server.ts                                        │
│     方法：sessions.patch                                              │
│     补丁内容：                                                         │
│     ├─ spawnDepth: childDepth                                         │
│     ├─ subagentRole: "worker" | "orchestrator" | null                │
│     ├─ subagentControlScope: "controlled"                             │
│     ├─ model: resolvedModel (如果有)                                  │
│     └─ thinkingLevel: thinkingOverride (如果有)                       │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
阶段 5: 线程绑定（可选）
┌────────────────────────────────────────────────────────────────────────┐
│ 条件：thread=true 时执行                                               │
│                                                                        │
│ 5.1 检查插件支持                                                        │
│     文件：src/plugins/hook-runner-global.ts                            │
│     方法：hasHooks("subagent_spawning")                               │
│     要求：必须有插件注册 subagent_spawning 钩子                        │
│                                                                        │
│ 5.2 执行线程绑定钩子                                                    │
│     文件：extensions/discord/src/subagent-hooks.ts                    │
│     方法：on("subagent_spawning", ...)                                │
│     逻辑：                                                             │
│     ├─ 检查 Discord 线程绑定配置                                       │
│     ├─ 调用 autoBindSpawnedDiscordSubagent()                          │
│     ├─ 创建或绑定线程到子会话                                          │
│     └─ 后续消息路由到该子会话                                          │
│                                                                        │
│ 5.3 绑定失败处理                                                        │
│     - 删除已创建的子会话                                               │
│     - 返回错误                                                         │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
阶段 6: 附件处理（可选）
┌────────────────────────────────────────────────────────────────────────┐
│ 条件：attachments 参数存在时                                           │
│                                                                        │
│ 6.1 材料化附件                                                          │
│     文件：src/agents/subagent-attachments.ts                          │
│     方法：materializeSubagentAttachments()                            │
│     逻辑：                                                             │
│     ├─ 创建临时目录                                                    │
│     ├─ 解码 Base64 内容                                                 │
│     ├─ 写入文件                                                        │
│     └─ 生成 SHA256 哈希                                                 │
│                                                                        │
│ 6.2 挂载到子工作区                                                      │
│     代码：                                                             │
│     const attachmentAbsDir = await materialize...                     │
│     await callGateway({                                               │
│       method: "workspace.attach",                                      │
│       params: { sessionKey: childSessionKey, path: attachmentAbsDir } │
│     });                                                                │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
阶段 7: 注册与启动
┌────────────────────────────────────────────────────────────────────────┐
│ 7.1 注册子 Agent 运行记录                                               │
│     文件：src/agents/subagent-registry.ts                             │
│     方法：registerSubagentRun()                                       │
│     记录内容：                                                         │
│     ├─ runId: uuid                                                    │
│     ├─ childSessionKey: agent:...:subagent:...                        │
│     ├─ requesterSessionKey: 请求者会话 Key                            │
│     ├─ label: 可选标签                                                │
│     ├─ task: 任务描述                                                 │
│     ├─ startedAt: 时间戳                                              │
│     └─ cleanupHandled: false                                          │
│                                                                        │
│ 7.2 持久化到磁盘                                                        │
│     文件：src/agents/subagent-registry-store.ts                       │
│     路径：~/.openclaw/agents/<agentId>/subagents.jsonl                │
│                                                                        │
│ 7.3 构建系统提示词                                                      │
│     文件：src/agents/subagent-announce.ts                             │
│     方法：buildSubagentSystemPrompt()                                 │
│     注入内容：                                                         │
│     ├─ AGENTS.md (目标 Agent)                                         │
│     ├─ TOOLS.md (过滤后的工具集)                                      │
│     └─ 任务描述                                                       │
│     不注入：SOUL.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md│
│                                                                        │
│ 7.4 启动嵌入式运行                                                      │
│     文件：src/agents/pi-embedded-runner/run.ts                        │
│     方法：runEmbeddedAttempt()                                        │
│     队列：subagent (专用队列，并发数默认 8)                            │
│     参数：                                                             │
│     ├─ sessionKey: childSessionKey                                    │
│     ├─ task: 任务描述                                                 │
│     ├─ systemPrompt: 构建的系统提示词                                 │
│     ├─ model: 解析的模型                                              │
│     └─ thinkingLevel: 解析的思考级别                                  │
└────────────────────────────────────────────────────────────────────────┘
   │
   ▼
阶段 8: 返回结果
┌────────────────────────────────────────────────────────────────────────┐
│ 8.1 构建返回结果                                                        │
│     代码：                                                             │
│     return {                                                           │
│       status: "accepted",                                              │
│       childSessionKey,                                                 │
│       runId,                                                           │
│       mode: spawnMode,                                                 │
│       modelApplied,                                                    │
│       attachments: { ... } // 如果有附件                              │
│     };                                                                 │
│                                                                        │
│ 8.2 Agent 接收结果                                                      │
│     - 获取 childSessionKey (可用于后续查询)                            │
│     - 获取 runId (用于日志追踪)                                        │
│     - 等待完成通告 (非阻塞)                                            │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 2.2 关键代码片段详解

#### 代码 1：深度计算逻辑

```typescript
// 文件：src/agents/subagent-depth.ts
export function getSubagentDepthFromSessionStore(
  sessionKey: string | undefined | null,
  opts?: { cfg?: OpenClawConfig; store?: Record<string, SessionDepthEntry> }
): number {
  const cache = new Map<string, Record<string, SessionDepthEntry>>();
  const visited = new Set<string>();

  const depthFromStore = (key: string): number | undefined => {
    // 1. 从会话存储读取 spawnDepth
    const entry = resolveEntryForSessionKey({ sessionKey: key, cfg: opts?.cfg, cache });
    const storedDepth = normalizeSpawnDepth(entry?.spawnDepth);
    
    if (storedDepth !== undefined) {
      return storedDepth; // 直接返回存储的深度
    }

    // 2. 通过 spawnedBy 追溯父链
    const spawnedBy = normalizeSessionKey(entry?.spawnedBy);
    if (!spawnedBy) {
      return undefined;
    }

    const parentDepth = depthFromStore(spawnedBy);
    if (parentDepth !== undefined) {
      return parentDepth + 1; // 父深度 + 1
    }

    return getSubagentDepth(spawnedBy) + 1;
  };

  return depthFromStore(raw) ?? fallbackDepth;
}

// 深度示例：
// Main Agent (depth=0)
//   └─ Sub-Agent A (depth=1, spawnedBy=Main)
//      └─ Sub-Sub-Agent A.1 (depth=2, spawnedBy=Sub-Agent A)
```

#### 代码 2：权限检查逻辑

```typescript
// 文件：src/agents/subagent-spawn.ts
export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext
): Promise<SpawnSubagentResult> {
  
  // 1. 深度限制检查
  const callerDepth = getSubagentDepthFromSessionStore(requesterInternalKey, { cfg });
  const maxSpawnDepth = cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? 1;
  
  if (callerDepth >= maxSpawnDepth) {
    return {
      status: "forbidden",
      error: `sessions_spawn is not allowed at this depth (current: ${callerDepth}, max: ${maxSpawnDepth})`
    };
  }

  // 2. 并发限制检查
  const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
  const activeChildren = countActiveRunsForSession(requesterInternalKey);
  
  if (activeChildren >= maxChildren) {
    return {
      status: "forbidden",
      error: `sessions_spawn has reached max active children (${activeChildren}/${maxChildren})`
    };
  }

  // 3. Agent 允许列表检查
  const targetAgentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : requesterAgentId;
  
  if (targetAgentId !== requesterAgentId) {
    const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
    const allowAny = allowAgents.some(v => v.trim() === "*");
    const allowSet = new Set(allowAgents.filter(v => v.trim() && v.trim() !== "*"));
    
    if (!allowAny && !allowSet.has(normalizedTargetId)) {
      return {
        status: "forbidden",
        error: `agentId is not allowed (allowed: ${Array.from(allowSet).join(", ") || "none"})`
      };
    }
  }

  // 4. 沙箱隔离检查
  const requesterRuntime = resolveSandboxRuntimeStatus({ cfg, sessionKey: requesterInternalKey });
  const childRuntime = resolveSandboxRuntimeStatus({ cfg, sessionKey: childSessionKey });
  
  if (!childRuntime.sandboxed && (requesterRuntime.sandboxed || sandboxMode === "require")) {
    return {
      status: "forbidden",
      error: "Sandboxed sessions cannot spawn unsandboxed subagents"
    };
  }

  // 所有检查通过，继续创建...
}
```

#### 代码 3：模型选择逻辑

```typescript
// 文件：src/agents/model-selection.ts
export function resolveSubagentSpawnModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelOverride?: string;
}): string | undefined {
  
  // 优先级 1: 运行时覆盖 (最高)
  if (params.modelOverride) {
    return params.modelOverride;
  }

  // 优先级 2: Agent 级配置
  const agentSubagentsConfig = params.cfg.agents?.list?.find(
    a => a.id === params.agentId
  )?.subagents?.model;
  
  if (agentSubagentsConfig) {
    return agentSubagentsConfig;
  }

  // 优先级 3: 全局默认
  const globalDefault = params.cfg.agents?.defaults?.subagents?.model;
  
  if (globalDefault) {
    return globalDefault;
  }

  // 优先级 4: 继承主 Agent 模型 (默认行为，返回 undefined)
  return undefined;
}

// 配置示例：
{
  "agents": {
    "defaults": {
      "subagents": {
        "model": "anthropic/claude-sonnet-4-20250514"  // 全局默认
      }
    },
    "list": [
      {
        "id": "researcher",
        "subagents": {
          "model": "anthropic/claude-opus-4-20250514"  // Agent 级覆盖
        }
      }
    ]
  }
}

// 调用示例：
sessions_spawn({
  task: "研究 AI 进展",
  model: "anthropic/claude-haiku-4-20250514"  // 运行时覆盖 (最高优先级)
})
```

---

## 三、默认配置值与限制

### 3.1 默认配置值

| 配置项 | 默认值 | 文件位置 | 说明 |
|--------|--------|---------|------|
| `maxSpawnDepth` | **1** | `src/config/agent-limits.ts` | 最大嵌套深度 (0=Main, 1=Sub) |
| `maxChildrenPerAgent` | **5** | `~/.openclaw/openclaw.json` | 每个 Agent 最大活跃子代数 |
| `maxConcurrent` | **8** | `src/config/agent-limits.ts` | 全局 Sub-Agent 并发数 |
| `runTimeoutSeconds` | **0** (无限制) | `~/.openclaw/openclaw.json` | 默认运行超时 (秒) |
| `archiveAfterMinutes` | **60** | `~/.openclaw/openclaw.json` | 自动归档时间 (分钟) |
| `cleanup` | **keep** | `sessions-spawn-tool.ts` | 默认清理策略 |
| `sandbox` | **inherit** | `sessions-spawn-tool.ts` | 默认沙箱模式 |
| `thread` | **false** | `sessions-spawn-tool.ts` | 默认不绑定线程 |
| `mode` | **run** | `sessions-spawn-tool.ts` | 默认单次运行模式 |

### 3.2 深度限制详解

```
默认配置：maxSpawnDepth = 1

层级关系：
┌─────────────────────────────────────────┐
│ Depth 0: Main Agent                     │
│  - 可以直接调用 sessions_spawn          │
│  - 派生的子 Agent 深度为 1               │
└─────────────────────────────────────────┘
         │
         │ spawn
         ▼
┌─────────────────────────────────────────┐
│ Depth 1: Sub-Agent (Worker)             │
│  - 默认不能调用 sessions_spawn          │
│  - 达到深度限制                          │
│  - 只能执行任务，不能再派生             │
└─────────────────────────────────────────┘

配置为 maxSpawnDepth = 2 时：
┌─────────────────────────────────────────┐
│ Depth 0: Main Agent (Orchestrator)      │
│  - 派生深度 1 的 Sub-Agent               │
└─────────────────────────────────────────┘
         │
         │ spawn
         ▼
┌─────────────────────────────────────────┐
│ Depth 1: Sub-Agent (Orchestrator)       │
│  - 可以调用 sessions_spawn              │
│  - 派生深度 2 的 Sub-Sub-Agent          │
│  - 角色：协调多个 Worker                 │
└─────────────────────────────────────────┘
         │
         │ spawn
         ▼
┌─────────────────────────────────────────┐
│ Depth 2: Sub-Sub-Agent (Worker)         │
│  - 不能调用 sessions_spawn              │
│  - 达到深度限制                          │
│  - 专注执行具体任务                      │
└─────────────────────────────────────────┘
```

### 3.3 并发限制详解

```
配置：maxChildrenPerAgent = 5, maxConcurrent = 8

场景 1: 单个 Agent 派生多个子 Agent
Main Agent 尝试派生 6 个子 Agent：
├─ Sub-Agent 1 ✓ (active: 1/5)
├─ Sub-Agent 2 ✓ (active: 2/5)
├─ Sub-Agent 3 ✓ (active: 3/5)
├─ Sub-Agent 4 ✓ (active: 4/5)
├─ Sub-Agent 5 ✓ (active: 5/5) ← 达到限制
└─ Sub-Agent 6 ✗ (错误：reached max active children)

场景 2: 全局并发限制
系统中有多个 Main Agent 同时派生子 Agent：
├─ Main Agent A 的子 Agent 1-4 (4 个)
├─ Main Agent B 的子 Agent 1-3 (3 个)
├─ Main Agent C 的子 Agent 1 (1 个)
└─ 总计：8 个 (达到 maxConcurrent)
    → 新的 Sub-Agent 需要等待队列
```

---

## 四、触发场景示例

### 4.1 场景 1：用户直接请求 → Agent 自主派生

```
用户消息：
"请研究一下 2024 年 AI 领域的重大进展，包括大语言模型、计算机视觉和强化学习三个方向"

Agent 思考过程：
1. 识别任务可以并行化 (3 个独立方向)
2. 决定派生 3 个 Sub-Agent
3. 调用 sessions_spawn 工具

工具调用序列：
┌─────────────────────────────────────────────────────────────┐
│ Tool Call 1: sessions_spawn                                 │
│ {                                                           │
│   "task": "研究 2024 年大语言模型的重大进展",               │
│   "label": "llm-research",                                  │
│   "model": "anthropic/claude-sonnet-4-20250514"            │
│ }                                                           │
│                                                             │
│ 返回：{ status: "accepted", childSessionKey: "...", ... }  │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ Tool Call 2: sessions_spawn                                 │
│ {                                                           │
│   "task": "研究 2024 年计算机视觉的重大进展",               │
│   "label": "cv-research",                                   │
│   "model": "anthropic/claude-sonnet-4-20250514"            │
│ }                                                           │
│ 返回：{ status: "accepted", childSessionKey: "...", ... }  │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ Tool Call 3: sessions_spawn                                 │
│ {                                                           │
│   "task": "研究 2024 年强化学习的重大进展",                 │
│   "label": "rl-research",                                   │
│   "model": "anthropic/claude-sonnet-4-20250514"            │
│ }                                                           │
│ 返回：{ status: "accepted", childSessionKey: "...", ... }  │
└─────────────────────────────────────────────────────────────┘

后续流程：
1. 3 个 Sub-Agent 并行执行 (在 subagent 队列中)
2. 每个 Sub-Agent 完成后触发通告
3. 通告注入到主对话
4. Main Agent 综合 3 个结果
5. 向用户返回综合报告
```

**涉及文件**：
- [`src/agents/tools/sessions-spawn-tool.ts`](file:///d:/prj/openclaw_analyze/src/agents/tools/sessions-spawn-tool.ts) - 工具实现
- [`src/agents/subagent-spawn.ts`](file:///d:/prj/openclaw_analyze/src/agents/subagent-spawn.ts) - 派生逻辑
- [`src/agents/subagent-announce.ts`](file:///d:/prj/openclaw_analyze/src/agents/subagent-announce.ts) - 通告机制

---

### 4.2 场景 2：用户使用 /subagents spawn 命令

```
用户命令：
"/subagents spawn researcher 分析这份 2024 年 Q4 财报"

命令处理流程：
┌─────────────────────────────────────────────────────────────┐
│ 1. 解析命令                                                 │
│    文件：src/auto-reply/reply/commands-subagents/action-spawn.ts │
│    方法：handleSubagentsSpawnAction()                      │
│                                                             │
│    解析结果：                                                │
│    - agentId: "researcher"                                 │
│    - task: "分析这份 2024 年 Q4 财报"                       │
│    - model: undefined                                      │
│    - thinking: undefined                                   │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. 调用 spawnSubagentDirect()                               │
│    参数：                                                    │
│    {                                                        │
│      task: "分析这份 2024 年 Q4 财报",                      │
│      agentId: "researcher",                                │
│      mode: "run",                                          │
│      cleanup: "keep",                                      │
│      expectsCompletionMessage: true                        │
│    }                                                        │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. 执行标准派生流程 (见流程图)                             │
│    - 验证 agentId 格式                                      │
│    - 检查深度限制                                           │
│    - 检查并发限制                                           │
│    - 检查 allowAgents 列表                                  │
│    - 创建子会话                                             │
│    - 应用模型配置                                           │
│    - 注册运行记录                                           │
│    - 启动嵌入式运行                                         │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. 返回结果                                                 │
│    {                                                        │
│      status: "accepted",                                    │
│      childSessionKey: "agent:researcher:subagent:uuid",    │
│      runId: "uuid"                                          │
│    }                                                        │
│                                                             │
│ 用户看到：                                                  │
│ "Spawned subagent researcher (session agent:..., run abc123)" │
└─────────────────────────────────────────────────────────────┘
```

**涉及文件**：
- [`src/auto-reply/reply/commands-subagents/action-spawn.ts`](file:///d:/prj/openclaw_analyze/src/auto-reply/reply/commands-subagents/action-spawn.ts) - 命令处理器
- [`src/agents/subagent-spawn.ts`](file:///d:/prj/openclaw_analyze/src/agents/subagent-spawn.ts) - 派生逻辑

---

### 4.3 场景 3：Prose 编排语言触发

```
Prose 文件 (examples/roadmap/parallel-review.prose)：
┌─────────────────────────────────────────────────────────────┐
│ # Parallel Review Example                                   │
│ # Three reviewers analyze code in parallel, then synthesize │
│                                                             │
│ agent reviewer:                                             │
│   model: sonnet                                             │
│                                                             │
│ parallel:                                                   │
│   security = session: reviewer                              │
│     prompt: "Review this code for security issues"          │
│   performance = session: reviewer                           │
│     prompt: "Review this code for performance issues"       │
│   style = session: reviewer                                 │
│     prompt: "Review this code for style and readability"    │
│                                                             │
│ session synthesizer:                                        │
│   model: opus                                               │
│   prompt: "Synthesize the reviews into a unified report"    │
│   context: { security, performance, style }                 │
└─────────────────────────────────────────────────────────────┘

Prose 编译过程：
1. Prose 编译器解析 parallel 块
2. 识别 3 个独立的 session
3. 为每个 session 生成 sessions_spawn 工具调用

生成的工具调用：
┌─────────────────────────────────────────────────────────────┐
│ Tool Call 1: sessions_spawn                                 │
│ {                                                           │
│   "task": "Review this code for security issues",          │
│   "agentId": "reviewer",                                    │
│   "model": "anthropic/claude-sonnet-4-20250514"            │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ Tool Call 2: sessions_spawn                                 │
│ {                                                           │
│   "task": "Review this code for performance issues",       │
│   "agentId": "reviewer",                                    │
│   "model": "anthropic/claude-sonnet-4-20250514"            │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ Tool Call 3: sessions_spawn                                 │
│ {                                                           │
│   "task": "Review this code for style and readability",    │
│   "agentId": "reviewer",                                    │
│   "model": "anthropic/claude-sonnet-4-20250514"            │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘

执行流程：
1. 3 个 Sub-Agent 并行启动
2. 等待所有 Sub-Agent 完成
3. 收集 3 份审查报告
4. 调用 synthesizer session 综合结果
5. 返回综合报告
```

**涉及文件**：
- [`extensions/open-prose/skills/prose/prose.md`](file:///d:/prj/openclaw_analyze/extensions/open-prose/skills/prose/prose.md) - Prose 语法
- [`extensions/open-prose/skills/prose/guidance/patterns.md`](file:///d:/prj/openclaw_analyze/extensions/open-prose/skills/prose/guidance/patterns.md) - parallel 模式

---

## 五、关键数据模型

### 5.1 SubagentRunRecord

```typescript
// 文件：src/agents/subagent-registry.ts
export type SubagentRunRecord = {
  runId: string;                    // 运行 ID (UUID)
  childSessionKey: string;          // 子会话 Key
  requesterSessionKey: string;      // 请求者会话 Key
  label?: string;                   // 可选标签
  task: string;                     // 任务描述
  startedAt: number;                // 开始时间戳
  endedAt?: number;                 // 结束时间戳 (可选)
  outcome?: SubagentRunOutcome;     // 结果状态
  cleanupHandled?: boolean;         // 清理是否已处理
  steerRestart?: boolean;           // 是否通过 steer 重启
};

// 存储格式 (JSONL)：
// ~/.openclaw/agents/<agentId>/subagents.jsonl
{"runId":"uuid1","childSessionKey":"agent:main:subagent:uuid1","requesterSessionKey":"agent:main:session:xyz","label":"llm-research","task":"研究 LLM 进展","startedAt":1234567890}
{"runId":"uuid2","childSessionKey":"agent:main:subagent:uuid2","requesterSessionKey":"agent:main:session:xyz","label":"cv-research","task":"研究 CV 进展","startedAt":1234567891}
```

### 5.2 会话 Key 格式

```typescript
// 主 Agent 会话：
agent:<agentId>:session:<mainKey>
示例：agent:main:session:abc123

// Sub-Agent 会话：
agent:<agentId>:subagent:<uuid>
示例：agent:main:subagent:550e8400-e29b-41d4-a716-446655440000

// 深度信息存储：
{
  "agent:main:subagent:uuid": {
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "spawnDepth": 1,
    "spawnedBy": "agent:main:session:abc123"
  }
}
```

### 5.3 系统提示词结构

```typescript
// 文件：src/agents/subagent-announce.ts
export function buildSubagentSystemPrompt(params: {
  task: string;
  agentConfig?: AgentConfig;
  capabilities: SubagentCapabilities;
}): string {
  return `
# Role
${params.capabilities.role === "worker" ? "Worker Agent" : "Main Agent"}

# Capabilities
- spawnDepth: ${params.capabilities.depth}
- maxSpawnDepth: ${params.capabilities.maxSpawnDepth}
- controlScope: ${params.capabilities.controlScope}
${params.capabilities.role === "orchestrator" ? "- Can spawn child agents" : "- Cannot spawn child agents"}

# Task
${params.task}

# Context
Only AGENTS.md and TOOLS.md are injected.
No SOUL.md, IDENTITY.md, USER.md, HEARTBEAT.md, or BOOTSTRAP.md.

# Announcement
After completing the task, announce the result back to the requester chat.
`.trim();
}
```

---

## 六、总结

### 6.1 核心要点

1. **唯一入口**：`sessions_spawn` 工具是创建 Sub-Agent 的唯一入口
2. **三种触发方式**：
   - Agent 自主决策派生
   - 用户 `/subagents spawn` 命令
   - Prose 等编排语言编译生成
3. **严格限制**：
   - 深度限制 (默认 1)
   - 并发限制 (每个 Agent 5 个，全局 8 个)
   - Agent 允许列表
   - 沙箱隔离
4. **完整流程**：8 个阶段，从工具调用到最终启动
5. **隔离设计**：
   - 独立会话
   - 独立上下文
   - 专用队列
   - 自动通告

### 6.2 关键文件索引

| 文件 | 作用 | 关键函数 |
|------|------|---------|
| [`sessions-spawn-tool.ts`](file:///d:/prj/openclaw_analyze/src/agents/tools/sessions-spawn-tool.ts) | 工具实现 | `createSessionsSpawnTool()` |
| [`subagent-spawn.ts`](file:///d:/prj/openclaw_analyze/src/agents/subagent-spawn.ts) | 派生逻辑 | `spawnSubagentDirect()` |
| [`subagent-depth.ts`](file:///d:/prj/openclaw_analyze/src/agents/subagent-depth.ts) | 深度计算 | `getSubagentDepthFromSessionStore()` |
| [`subagent-registry.ts`](file:///d:/prj/openclaw_analyze/src/agents/subagent-registry.ts) | 运行注册 | `registerSubagentRun()` |
| [`subagent-announce.ts`](file:///d:/prj/openclaw_analyze/src/agents/subagent-announce.ts) | 通告机制 | `buildSubagentSystemPrompt()` |
| [`action-spawn.ts`](file:///d:/prj/openclaw_analyze/src/auto-reply/reply/commands-subagents/action-spawn.ts) | 命令处理 | `handleSubagentsSpawnAction()` |
| [`agent-limits.ts`](file:///d:/prj/openclaw_analyze/src/config/agent-limits.ts) | 限制配置 | `DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH` |
| [`subagent-hooks.ts`](file:///d:/prj/openclaw_analyze/extensions/discord/src/subagent-hooks.ts) | 线程绑定 | `on("subagent_spawning")` |
