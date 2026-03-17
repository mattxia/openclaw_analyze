# OpenClaw 多 Agent 实现分析

## 一、概述

OpenClaw 项目实现了完整的多 Agent 架构，支持两种主要的多 Agent 模式：

1. **多 Agent 路由 (Multi-Agent Routing)** - 多个独立 Agent 共享一个 Gateway 进程
2. **子 Agent 系统 (Sub-Agents)** - 从现有 Agent 运行中派生隔离的子 Agent 运行

这两种模式可以组合使用，形成复杂的 Agent 编排架构。

## 一.1 默认 Agent 模式

### 系统默认配置

OpenClaw 默认运行在 **单 Agent 模式 (Single-Agent Mode)**，无需任何配置即可使用。

**默认设置**:
- **Agent ID**: `main`
- **Session Key 格式**: `agent:main:<mainKey>`
- **工作区**: `~/.openclaw/workspace` (或当 `OPENCLAW_PROFILE` 设置时为 `~/.openclaw/workspace-<profile>`)
- **状态目录**: `~/.openclaw/agents/main/agent`
- **会话存储**: `~/.openclaw/agents/main/sessions`

### 配置位置

配置文件位于：**`~/.openclaw/openclaw.json`** (或通过 `OPENCLAW_CONFIG_PATH` 环境变量指定)

### 配置模式对比

| 模式 | 配置要求 | 使用场景 |
|------|---------|---------|
| **单 Agent 模式** (默认) | 无需配置 | 个人使用、简单场景 |
| **多 Agent 模式** | 需要配置 `agents.list` 和 `bindings` | 多用户共享、不同渠道/场景使用不同 Agent |

### 何时需要配置多 Agent

只有当你需要以下功能时才需要配置多 Agent：
- 多个用户共享一个 Gateway 服务器但保持数据隔离
- 不同渠道（WhatsApp、Telegram、Discord）使用不同的 Agent
- 为不同任务类型使用专用 Agent（如 coding、research、chat）
- 实现复杂的 Agent 编排和路由策略

## 二、核心架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        OpenClaw 多 Agent 架构                            │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  模式 1: 多 Agent 路由 (静态路由)                                         │
│                                                                         │
│  用户消息 → Channel → Gateway → 路由匹配 → Agent (独立工作区 + 认证)      │
│                              ├─ Binding 1 → Agent A                      │
│                              ├─ Binding 2 → Agent B                      │
│                              └─ Binding 3 → Agent C                      │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  模式 2: 子 Agent 系统 (动态派生)                                         │
│                                                                         │
│  Main Agent (深度 0)                                                    │
│      │                                                                  │
│      ├─ Sub-Agent 1 (深度 1, Orchestrator)                              │
│      │     ├─ Sub-Sub-Agent 1.1 (深度 2, Worker)                        │
│      │     └─ Sub-Sub-Agent 1.2 (深度 2, Worker)                        │
│      │                                                                  │
│      ├─ Sub-Agent 2 (深度 1, Worker)                                    │
│      └─ Sub-Agent 3 (深度 1, Worker)                                    │
│                                                                         │
│  结果通告链：Worker → Orchestrator → Main → User                        │
└─────────────────────────────────────────────────────────────────────────┘
```

## 三、主要业务场景

### 场景 1: 多 Agent 路由 - 不同渠道/用户路由到不同 Agent

**业务需求**:
- 多个用户共享一个 Gateway 服务器，但保持 AI"大脑"和数据隔离
- 不同渠道（WhatsApp、Telegram、Discord）使用不同的 Agent
- 同一渠道的不同用户/群组路由到不同的 Agent

**实现流程**:

```
1. 配置阶段
   ├─ 定义多个 Agent (agents.list)
   ├─ 配置每个 Agent 的工作区和 agentDir
   ├─ 设置渠道账户 (channels.<channel>.accounts)
   └─ 定义路由规则 (bindings)

2. 消息路由
   ├─ 入站消息到达 Gateway
   ├─ 提取消息元数据 (channel, accountId, peer, guildId, teamId)
   ├─ 按优先级匹配 bindings
   │   ├─ 1. peer 匹配 (精确 DM/群组/频道 id)
   │   ├─ 2. parentPeer 匹配 (线程继承)
   │   ├─ 3. guildId + roles (Discord 角色路由)
   │   ├─ 4. guildId (Discord)
   │   ├─ 5. teamId (Slack)
   │   ├─ 6. accountId 匹配
   │   ├─ 7. 渠道级匹配 (accountId: "*")
   │   └─ 8. 回退到默认 Agent
   └─ 路由到匹配的 Agent

3. Agent 执行
   ├─ 加载 Agent 配置 (workspace, agentDir)
   ├─ 加载 Agent 认证 (auth-profiles.json)
   ├─ 加载 Agent 会话存储
   └─ 执行消息处理
```

**关键类和方法**:

```typescript
// 文件：src/config/types.agents.ts
export type AgentConfig = {
  id: string;                    // Agent 唯一标识
  default?: boolean;             // 是否为默认 Agent
  name?: string;                 // Agent 名称
  workspace?: string;            // 工作区路径
  agentDir?: string;             // Agent 状态目录
  model?: AgentModelConfig;      // 模型配置
  skills?: string[];             // 技能列表
  subagents?: {
    allowAgents?: string[];      // 允许派生的 Agent ID
    model?: AgentModelConfig;    // 子 Agent 默认模型
  };
  // ... 其他配置
};

// 文件：src/config/types.agents.ts
export type AgentBinding = AgentRouteBinding | AgentAcpBinding;

export type AgentRouteBinding = {
  type?: "route";
  agentId: string;               // 目标 Agent ID
  comment?: string;
  match: AgentBindingMatch;      // 匹配规则
};

export type AgentBindingMatch = {
  channel: string;               // 渠道名称
  accountId?: string;            // 渠道账户 ID
  peer?: {                       // 对等方匹配
    kind: ChatType;
    id: string;
  };
  guildId?: string;              // Discord 服务器 ID
  teamId?: string;               // Slack 团队 ID
  roles?: string[];              // Discord 角色 ID
};

// 文件：src/routing/session-key.ts
export function parseAgentSessionKey(
  sessionKey: string
): ParsedAgentSessionKey | null {
  // 解析 session key 格式：agent:<agentId>:<sessionType>:<id>
  // 例如：agent:main:subagent:abc123
}

// 文件：src/config/agent-dirs.ts
export function resolveAgentDir(
  cfg: OpenClawConfig,
  agentId: string
): string {
  // 解析 Agent 目录路径
  // 默认：~/.openclaw/agents/<agentId>/agent
}
```

**配置文件示例**:

```json5
// ~/.openclaw/openclaw.json
{
  "agents": {
    "list": [
      {
        "id": "alex",
        "workspace": "~/.openclaw/workspace-alex",
        "model": "anthropic/claude-sonnet-4-20250514"
      },
      {
        "id": "mia",
        "workspace": "~/.openclaw/workspace-mia",
        "model": "anthropic/claude-opus-4-20250514"
      }
    ],
    "defaults": {
      "subagents": {
        "maxConcurrent": 8,
        "maxSpawnDepth": 2
      }
    }
  },
  "bindings": [
    {
      "agentId": "alex",
      "match": {
        "channel": "whatsapp",
        "peer": { "kind": "direct", "id": "+15551230001" }
      }
    },
    {
      "agentId": "mia",
      "match": {
        "channel": "whatsapp",
        "peer": { "kind": "direct", "id": "+15551230002" }
      }
    },
    {
      "agentId": "alex",
      "match": { "channel": "telegram" }
    },
    {
      "agentId": "mia",
      "match": { "channel": "discord" }
    }
  ],
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551230001", "+15551230002"]
    }
  }
}
```

### 场景 2: 子 Agent 派生 - 并行化长任务

**业务需求**:
- 并行执行多个独立任务（研究、长任务、慢工具）
- 保持子 Agent 隔离（会话分离 + 可选沙箱隔离）
- 避免阻塞主 Agent 运行

**实现流程**:

```
1. 派生子 Agent (sessions_spawn 工具)
   ├─ 验证权限 (是否允许派生子 Agent)
   ├─ 检查深度限制 (maxSpawnDepth)
   ├─ 检查并发限制 (maxConcurrent, maxChildrenPerAgent)
   ├─ 创建子 Agent 会话
   │   ├─ 生成 session key: agent:<agentId>:subagent:<uuid>
   │   ├─ 创建 transcript 文件
   │   └─ 初始化会话存储
   ├─ 注入上下文
   │   ├─ 系统提示词 (buildSubagentSystemPrompt)
   │   ├─ AGENTS.md + TOOLS.md
   │   └─ 附件 (如果有)
   └─ 启动子 Agent 运行

2. 子 Agent 执行
   ├─ 在独立会话中运行
   ├─ 使用专用队列 (subagent lane)
   ├─ 执行任务
   └─ 完成后触发通告流程

3. 结果通告 (Announce)
   ├─ 捕获子 Agent 完成消息
   ├─ 格式化通告内容
   ├─ 投递到请求者会话
   │   ├─ 直接投递 (内部消息)
   │   └─ 渠道投递 (外部消息)
   └─ 清理子 Agent 会话 (可选)

4. 级联处理 (嵌套子 Agent)
   ├─ 深度 2 Worker 完成 → 通告到深度 1 Orchestrator
   ├─ Orchestrator 合成结果 → 通告到 Main Agent
   └─ Main Agent 接收 → 投递到用户
```

**关键类和方法**:

```typescript
// 文件：src/agents/subagent-spawn.ts
export type SpawnSubagentParams = {
  task: string;                  // 任务描述
  label?: string;                // 可选标签
  agentId?: string;              // 可选的 Agent ID 覆盖
  model?: string;                // 可选的模型覆盖
  thinking?: string;             // 思考级别覆盖
  runTimeoutSeconds?: number;    // 运行超时
  thread?: boolean;              // 是否绑定到线程
  mode?: "run" | "session";      // 运行模式
  cleanup?: "delete" | "keep";   // 完成后清理策略
  sandbox?: "inherit" | "require"; // 沙箱模式
  attachments?: Array<{          // 附件
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
  }>;
};

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext
): Promise<SpawnSubagentResult> {
  // 1. 验证参数
  // 2. 检查深度限制
  // 3. 创建子会话
  // 4. 注入系统提示词
  // 5. 启动运行
  // 6. 返回结果 { status, runId, childSessionKey }
}

// 文件：src/agents/subagent-registry.ts
export type SubagentRunRecord = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  label?: string;
  task: string;
  startedAt: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  cleanupHandled?: boolean;
  steerRestart?: boolean;
};

export function registerSubagentRun(
  record: SubagentRunRecord
): void {
  // 注册子 Agent 运行记录
  // 持久化到磁盘
}

// 文件：src/agents/subagent-announce.ts
export async function runSubagentAnnounceFlow(params: {
  entry: SubagentRunRecord;
  signal?: AbortSignal;
}): Promise<boolean> {
  // 1. 提取子 Agent 结果
  // 2. 格式化通告消息
  // 3. 投递到请求者
  // 4. 处理重试
}

// 文件：src/agents/subagent-control.ts
export function listControlledSubagentRuns(
  controllerSessionKey: string
): SubagentRunRecord[] {
  // 列出控制器管理的所有子 Agent 运行
}

export async function killControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
}): Promise<KillResult> {
  // 停止指定的子 Agent 运行
  // 级联停止其子代
}
```

**深度限制**:

```typescript
// 文件：src/config/agent-limits.ts
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;  // 默认最大深度
export const MAX_SUBAGENT_MAX_SPAWN_DEPTH = 5;      // 最大允许深度
export const DEFAULT_MAX_CHILDREN_PER_AGENT = 5;    // 每个 Agent 最大子代数
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;   // 全局并发限制

// 文件：src/agents/subagent-depth.ts
export function getSubagentDepthFromSessionStore(
  sessionKey: string | undefined | null,
  opts?: { cfg?: OpenClawConfig }
): number {
  // 从会话存储中获取当前深度
  // 深度 0: Main Agent
  // 深度 1: Sub-Agent (可以是 Orchestrator 或 Worker)
  // 深度 2: Sub-Sub-Agent (只能是 Worker)
}
```

**工具权限**:

```typescript
// 文件：src/agents/subagent-capabilities.ts
export type SubagentCapabilities = {
  controlScope: "children" | "none";  // 控制范围
  allowedTools: string[];              // 允许的工具
};

export function resolveStoredSubagentCapabilities(
  sessionKey: string,
  opts?: { cfg?: OpenClawConfig }
): SubagentCapabilities {
  // 深度 1 (maxSpawnDepth >= 2): 获得 sessions_spawn, subagents 等工具
  // 深度 1 (maxSpawnDepth == 1): 无会话工具
  // 深度 2: 始终无会话工具
}
```

### 场景 3: 嵌套子 Agent - 编排器模式

**业务需求**:
- Main Agent 作为协调者，不直接执行任务
- 派生 Orchestrator Sub-Agent 管理多个 Worker Sub-Sub-Agents
- Worker 并行执行具体任务，结果汇总到 Orchestrator

**实现流程**:

```
1. Main Agent 派生 Orchestrator (深度 1)
   ├─ 设置 maxSpawnDepth: 2
   ├─ 派生任务："协调多个 Worker 完成研究任务"
   └─ 授予管理权限 (sessions_spawn, subagents)

2. Orchestrator 派生多个 Workers (深度 2)
   ├─ Worker 1: "研究主题 A"
   ├─ Worker 2: "研究主题 B"
   ├─ Worker 3: "研究主题 C"
   └─ 等待所有 Worker 完成

3. Workers 执行并通告
   ├─ Worker 1 完成 → 通告到 Orchestrator
   ├─ Worker 2 完成 → 通告到 Orchestrator
   ├─ Worker 3 完成 → 通告到 Orchestrator
   └─ Orchestrator 跟踪所有子代

4. Orchestrator 合成结果
   ├─ 收集所有 Worker 结果
   ├─ 综合分析
   ├─ 生成最终报告
   └─ 通告到 Main Agent

5. Main Agent 接收
   └─ 投递到用户
```

**配置示例**:

```json5
{
  "agents": {
    "defaults": {
      "subagents": {
        "maxSpawnDepth": 2,           // 允许嵌套子 Agent
        "maxChildrenPerAgent": 5,     // 每个 Agent 最多 5 个子代
        "maxConcurrent": 8,           // 全局并发 8
        "runTimeoutSeconds": 900,     // 默认超时 15 分钟
        "archiveAfterMinutes": 60     // 60 分钟后自动归档
      }
    }
  }
}
```

**深度级别**:

| 深度 | Session Key 形状 | 角色 | 可以派生 |
|------|-----------------|------|---------|
| 0 | `agent:<id>:main` | Main Agent | 总是 |
| 1 | `agent:<id>:subagent:<uuid>` | Sub-Agent (Orchestrator) | 仅当 `maxSpawnDepth >= 2` |
| 2 | `agent:<id>:subagent:<uuid>:subagent:<uuid>` | Sub-Sub-Agent (Worker) | 从不 |

### 场景 4: 子 Agent 控制 - 列出/停止/引导

**业务需求**:
- 查看当前活跃的子 Agent 运行
- 停止指定的子 Agent 运行
- 向运行中的子 Agent 发送引导消息

**实现流程**:

```
1. 列出子 Agent (subagents list)
   ├─ 查询子 Agent 注册表
   ├─ 过滤活跃/最近运行
   ├─ 格式化显示信息
   └─ 返回列表

2. 停止子 Agent (subagents kill)
   ├─ 解析目标 (ID/#/all)
   ├─ 验证权限
   ├─ 停止运行 (abortEmbeddedPiRun)
   ├─ 级联停止子代
   └─ 清理资源

3. 引导子 Agent (subagents steer)
   ├─ 解析目标
   ├─ 验证消息长度
   ├─ 发送内部消息到子会话
   └─ 标记为 restart 模式
```

**关键代码**:

```typescript
// 文件：src/agents/tools/subagents-tool.ts
export function createSubagentsTool(
  opts?: { agentSessionKey?: string }
): AnyAgentTool {
  return {
    name: "subagents",
    description: "List, kill, or steer spawned sub-agents",
    parameters: Type.Object({
      action: optionalStringEnum(["list", "kill", "steer"]),
      target: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      recentMinutes: Type.Optional(Type.Number())
    }),
    execute: async (_toolCallId, args) => {
      const action = args.action ?? "list";
      
      if (action === "list") {
        const runs = listControlledSubagentRuns(controllerSessionKey);
        const list = buildSubagentList({ cfg, runs, recentMinutes });
        return jsonResult({ status: "ok", action: "list", ...list });
      }
      
      if (action === "kill") {
        const target = args.target;
        if (target === "all") {
          const result = await killAllControlledSubagentRuns({ cfg, controller, runs });
          return jsonResult({ status: "ok", action: "kill", killed: result.killed });
        }
        const resolved = resolveControlledSubagentTarget(runs, target);
        const result = await killControlledSubagentRun({ cfg, controller, entry: resolved.entry });
        return jsonResult({ status: "ok", action: "kill", ...result });
      }
      
      if (action === "steer") {
        const target = args.target;
        const message = args.message;
        const resolved = resolveControlledSubagentTarget(runs, target);
        const result = await steerControlledSubagentRun({ cfg, controller, entry: resolved.entry, message });
        return jsonResult({ status: "ok", action: "steer", ...result });
      }
    }
  };
}

// 文件：src/agents/subagent-control.ts
export async function steerControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  message: string;
}): Promise<SteerResult> {
  // 1. 速率限制检查 (STEER_RATE_LIMIT_MS)
  // 2. 发送内部消息到子会话
  // 3. 标记为 steerRestart 模式
  // 4. 等待子 Agent 重新开始
}
```

**Slash 命令**:

```bash
# 列出子 Agent
/subagents list
/subagents list --recent-minutes 60

# 停止子 Agent
/subagents kill <id|#>
/subagents kill all

# 引导子 Agent
/subagents steer <id|#> <message>

# 查看详细信息
/subagents info <id|#>
/subagents log <id|#> [limit] [tools]

# 发送消息到子会话
/subagents send <id|#> <message>

# 聚焦到子 Agent (线程绑定)
/focus <subagent-label|session-key>
/unfocus
```

## 四、数据模型

### 4.1 Agent 配置

```typescript
// 文件：src/config/types.agents.ts
export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;  // 默认配置
  list?: AgentConfig[];            // Agent 列表
};

export type AgentConfig = {
  id: string;                      // 唯一标识 (必需)
  default?: boolean;               // 是否为默认 Agent
  name?: string;                   // 显示名称
  workspace?: string;              // 工作区路径
  agentDir?: string;               // Agent 状态目录
  model?: AgentModelConfig;        // 模型配置
  skills?: string[];               // 允许的技能
  memorySearch?: MemorySearchConfig;
  humanDelay?: HumanDelayConfig;
  heartbeat?: HeartbeatConfig;
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  subagents?: {
    allowAgents?: string[];        // 允许派生的 Agent ID
    model?: AgentModelConfig;      // 子 Agent 默认模型
  };
  sandbox?: AgentSandboxConfig;
  params?: Record<string, unknown>;
  tools?: AgentToolsConfig;
  runtime?: AgentRuntimeConfig;
};
```

### 4.2 路由绑定

```typescript
// 文件：src/config/types.agents.ts
export type AgentBinding = AgentRouteBinding | AgentAcpBinding;

export type AgentRouteBinding = {
  type?: "route";
  agentId: string;                 // 目标 Agent ID
  comment?: string;
  match: AgentBindingMatch;        // 匹配规则
};

export type AgentAcpBinding = {
  type: "acp";
  agentId: string;
  comment?: string;
  match: AgentBindingMatch;
  acp?: {
    mode?: "persistent" | "oneshot";
    label?: string;
    cwd?: string;
    backend?: string;
  };
};

export type AgentBindingMatch = {
  channel: string;                 // 渠道名称
  accountId?: string;              // 渠道账户 ID
  peer?: {
    kind: ChatType;                // "direct" | "group" | "room"
    id: string;                    // 对等方 ID
  };
  guildId?: string;                // Discord 服务器 ID
  teamId?: string;                 // Slack 团队 ID
  roles?: string[];                // Discord 角色 ID
};
```

### 4.3 子 Agent 运行记录

```typescript
// 文件：src/agents/subagent-registry.types.ts
export type SubagentRunRecord = {
  runId: string;                   // 运行 ID
  childSessionKey: string;         // 子会话 Key
  requesterSessionKey: string;     // 请求者会话 Key
  label?: string;                  // 标签
  task: string;                    // 任务描述
  mode: "run" | "session";         // 运行模式
  startedAt: number;               // 开始时间戳
  endedAt?: number;                // 结束时间戳
  outcome?: SubagentRunOutcome;    // 运行结果
  cleanupHandled?: boolean;        // 清理是否完成
  cleanupCompletedAt?: number;     // 清理完成时间
  announceRetryCount?: number;     // 通告重试次数
  steerRestart?: boolean;          // 是否为引导重启
  frozenCompletion?: {             // 冻结的完成状态
    resultText: string;
    usage?: UsageLike;
  };
};

export type SubagentRunOutcome =
  | { status: "ok" }
  | { status: "error"; error: string };
```

### 4.4 Session Key 结构

```typescript
// 文件：src/routing/session-key.ts
export type ParsedAgentSessionKey = {
  agentId: string;                 // Agent ID
  sessionType: string;             // 会话类型 (main, subagent, etc.)
  sessionId: string;               // 会话 ID
  depth?: number;                  // 子 Agent 深度
};

// Session Key 格式:
// agent:<agentId>:main:<mainKey>
// agent:<agentId>:subagent:<uuid>
// agent:<agentId>:subagent:<uuid>:subagent:<uuid>
```

## 五、关键实现细节

### 5.1 路由匹配算法

```typescript
// 文件：src/routing/bindings.ts (伪代码)
export function matchBinding(
  message: IncomingMessage,
  bindings: AgentBinding[]
): AgentBinding | null {
  // 按优先级排序匹配
  const matchers = [
    // 1. peer 匹配 (最高优先级)
    (b: AgentBinding) => 
      b.match.peer?.id === message.peerId &&
      b.match.peer?.kind === message.peerKind,
    
    // 2. parentPeer 匹配 (线程继承)
    (b: AgentBinding) =>
      b.match.parentPeer?.id === message.parentPeerId,
    
    // 3. guildId + roles 匹配
    (b: AgentBinding) =>
      b.match.guildId === message.guildId &&
      b.match.roles?.some(r => message.roles?.includes(r)),
    
    // 4. guildId 匹配
    (b: AgentBinding) =>
      b.match.guildId === message.guildId,
    
    // 5. teamId 匹配
    (b: AgentBinding) =>
      b.match.teamId === message.teamId,
    
    // 6. accountId 匹配
    (b: AgentBinding) =>
      b.match.accountId === message.accountId,
    
    // 7. 渠道级匹配
    (b: AgentBinding) =>
      b.match.channel === message.channel &&
      b.match.accountId === "*",
    
    // 8. 渠道匹配 (无 accountId)
    (b: AgentBinding) =>
      b.match.channel === message.channel,
  ];
  
  for (const matcher of matchers) {
    const match = bindings.find(matcher);
    if (match) return match;
  }
  
  // 回退到默认 Agent
  return bindings.find(b => b.agentId === "main") ?? bindings[0];
}
```

### 5.2 子 Agent 深度检查

```typescript
// 文件：src/agents/subagent-depth.ts
export function getSubagentDepthFromSessionStore(
  sessionKey: string | undefined | null,
  opts?: { cfg?: OpenClawConfig }
): number {
  const raw = (sessionKey ?? "").trim();
  const fallbackDepth = getSubagentDepth(raw);  // 从 key 格式解析
  
  if (!raw) return fallbackDepth;
  
  // 从会话存储中读取 spawnDepth
  const store = readSessionStore(storePath);
  const entry = store[sessionKey];
  
  if (entry?.spawnDepth !== undefined) {
    return entry.spawnDepth;
  }
  
  // 从 spawnedBy 链推导深度
  if (entry?.spawnedBy) {
    const parentDepth = getSubagentDepthFromSessionStore(
      entry.spawnedBy,
      opts
    );
    return parentDepth + 1;
  }
  
  return fallbackDepth;
}

// 文件：src/sessions/session-key-utils.ts
export function getSubagentDepth(sessionKey: string): number {
  // 计算 session key 中 :subagent: 出现的次数
  const matches = sessionKey.match(/:subagent:/g);
  return matches ? matches.length : 0;
}
```

### 5.3 子 Agent 系统提示词

```typescript
// 文件：src/agents/subagent-announce.ts
export function buildSubagentSystemPrompt(params: {
  task: string;
  label?: string;
  mode: "run" | "session";
  cleanup: "delete" | "keep";
  depth: number;
  canSpawn: boolean;
}): string {
  const parts: string[] = [];
  
  // 任务描述
  parts.push(`Task: ${params.task}`);
  if (params.label) {
    parts.push(`Label: ${params.label}`);
  }
  
  // 运行模式
  if (params.mode === "session") {
    parts.push(
      "You are running in a persistent session bound to a thread. " +
      "Stay in-thread for follow-ups."
    );
  }
  
  // 清理策略
  if (params.cleanup === "delete") {
    parts.push(
      "After you complete and announce your result, your session will be " +
      "archived immediately (transcript preserved with .deleted timestamp)."
    );
  }
  
  // 深度和权限
  if (params.depth === 0) {
    parts.push("You are the main agent.");
  } else if (params.depth === 1 && params.canSpawn) {
    parts.push(
      "You are an orchestrator sub-agent. You can spawn worker sub-sub-agents " +
      "using sessions_spawn. Track their completions and synthesize results."
    );
  } else if (params.depth === 1) {
    parts.push(
      "You are a sub-agent. Complete the task and announce your result."
    );
  } else {
    parts.push(
      "You are a worker sub-sub-agent. Complete the task and announce your result " +
      "to your parent orchestrator."
    );
  }
  
  // 通告说明
  parts.push(
    "When finished, send your final answer. It will be announced back to the " +
    "requester. If you want to skip announcement, reply exactly: ANNOUNCE_SKIP."
  );
  
  return parts.join("\n\n");
}
```

### 5.4 通告投递机制

```typescript
// 文件：src/agents/subagent-announce.ts
async function runSubagentAnnounceFlow(params: {
  entry: SubagentRunRecord;
  signal?: AbortSignal;
}): Promise<boolean> {
  const { entry } = params;
  let retryCount = entry.announceRetryCount ?? 0;
  
  while (retryCount < MAX_ANNOUNCE_RETRY_COUNT) {
    try {
      // 1. 提取子 Agent 结果
      const resultText = await extractSubagentResultText(entry);
      
      // 2. 格式化通告消息
      const announceMessage = formatAnnounceMessage({
        label: entry.label,
        task: entry.task,
        resultText,
        runtime: Date.now() - entry.startedAt,
        outcome: entry.outcome
      });
      
      // 3. 投递到请求者
      await deliverToRequester({
        requesterSessionKey: entry.requesterSessionKey,
        message: announceMessage,
        isCompletion: true
      });
      
      return true;  // 投递成功
    } catch (error) {
      retryCount++;
      
      if (!isTransientError(error)) {
        // 永久错误，放弃重试
        logAnnounceGiveUp(entry, "permanent-error");
        return false;
      }
      
      if (retryCount >= MAX_ANNOUNCE_RETRY_COUNT) {
        logAnnounceGiveUp(entry, "retry-limit");
        return false;
      }
      
      // 指数退避重试
      const delayMs = resolveAnnounceRetryDelayMs(retryCount);
      await sleepWithAbort(delayMs, params.signal);
    }
  }
  
  return false;
}

function isTransientError(error: unknown): boolean {
  const message = summarizeDeliveryError(error);
  const transientPatterns = [
    /\berrorcode=unavailable\b/i,
    /\bUNAVAILABLE\b/,
    /no active .* listener/i,
    /gateway not connected/i,
    /\b(econnreset|econnrefused|etimedout)\b/i
  ];
  
  return transientPatterns.some(pattern => pattern.test(message));
}
```

### 5.5 级联停止机制

```typescript
// 文件：src/agents/subagent-control.ts
export async function killAllControlledSubagentRuns(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  runs: SubagentRunRecord[];
}): Promise<KillAllResult> {
  let killed = 0;
  const labels: string[] = [];
  
  for (const run of params.runs) {
    if (!run.endedAt) {  // 仅停止活跃运行
      const result = await killControlledSubagentRun({
        cfg: params.cfg,
        controller: params.controller,
        entry: run
      });
      
      if (result.status === "ok") {
        killed++;
        if (result.label) labels.push(result.label);
      }
    }
  }
  
  return { status: "ok", killed, labels };
}

export async function killControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
}): Promise<KillResult> {
  // 1. 标记为已终止
  markSubagentRunTerminated(params.entry.runId);
  
  // 2. 停止嵌入式运行
  await abortEmbeddedPiRun(params.entry.childSessionKey);
  
  // 3. 级联停止子代
  const descendants = listDescendantRunsForRequester(
    params.entry.childSessionKey
  );
  const cascadeKilled: string[] = [];
  
  for (const descendant of descendants) {
    await abortEmbeddedPiRun(descendant.childSessionKey);
    markSubagentRunTerminated(descendant.runId);
    cascadeKilled.push(descendant.label ?? descendant.runId);
  }
  
  // 4. 清理资源
  if (params.entry.mode === "run" && params.entry.cleanup === "delete") {
    await callGateway({
      method: "sessions.delete",
      params: { key: params.entry.childSessionKey }
    });
  }
  
  return {
    status: "ok",
    runId: params.entry.runId,
    sessionKey: params.entry.childSessionKey,
    label: params.entry.label,
    cascadeKilled,
    text: `Killed ${params.entry.label ?? params.entry.runId}`
  };
}
```

## 六、配置参考

### 6.1 单 Agent 模式（默认）

**无需配置**，系统自动使用以下默认值：

```json
{
  // 空配置或不存在此文件时使用默认值
}
```

**默认行为**:
- Agent ID: `main`
- 工作区：`~/.openclaw/workspace`
- 状态目录：`~/.openclaw/agents/main/agent`
- 所有消息路由到 `main` Agent

### 6.2 多 Agent 路由配置

```json5
{
  // Agent 列表
  "agents": {
    "list": [
      {
        "id": "main",
        "name": "Main Assistant",
        "workspace": "~/.openclaw/workspace",
        "default": true,
        "model": "anthropic/claude-sonnet-4-20250514"
      },
      {
        "id": "coding",
        "name": "Coding Assistant",
        "workspace": "~/.openclaw/workspace-coding",
        "model": "anthropic/claude-opus-4-20250514",
        "skills": ["coding", "debugging"]
      },
      {
        "id": "research",
        "name": "Research Assistant",
        "workspace": "~/.openclaw/workspace-research",
        "model": "openai/gpt-4o",
        "skills": ["web-search", "analysis"]
      }
    ],
    
    // 默认设置
    "defaults": {
      "subagents": {
        "maxSpawnDepth": 2,
        "maxChildrenPerAgent": 5,
        "maxConcurrent": 8,
        "runTimeoutSeconds": 900,
        "archiveAfterMinutes": 60
      }
    }
  },
  
  // 路由绑定
  "bindings": [
    // 按渠道路由
    {
      "agentId": "coding",
      "match": { "channel": "discord", "guildId": "123456" }
    },
    {
      "agentId": "research",
      "match": { "channel": "telegram" }
    },
    
    // 按用户路由
    {
      "agentId": "main",
      "match": {
        "channel": "whatsapp",
        "peer": { "kind": "direct", "id": "+15551234567" }
      }
    },
    
    // 渠道级路由
    {
      "agentId": "main",
      "match": { "channel": "whatsapp" }
    }
  ],
  
  // 渠道配置
  "channels": {
    "whatsapp": {
      "accounts": {
        "personal": { /* ... */ },
        "business": { /* ... */ }
      },
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567", "+15551234568"]
    }
  }
}
```

### 6.3 子 Agent 配置

```json5
{
  "agents": {
    "defaults": {
      "subagents": {
        // 最大嵌套深度 (1-5)
        "maxSpawnDepth": 2,
        
        // 每个 Agent 最大活跃子代数
        "maxChildrenPerAgent": 5,
        
        // 全局并发限制
        "maxConcurrent": 8,
        
        // 默认运行超时 (秒，0 = 无限制)
        "runTimeoutSeconds": 900,
        
        // 完成后自动归档时间 (分钟)
        "archiveAfterMinutes": 60,
        
        // 通告超时 (毫秒)
        "announceTimeoutMs": 90000,
        
        // 默认模型 (子 Agent 使用)
        "model": "anthropic/claude-sonnet-4-20250514",
        
        // 默认思考级别
        "thinking": "low"
      }
    }
  },
  
  // 工具策略覆盖
  "tools": {
    "subagents": {
      "tools": {
        // 拒绝的工具 (优先级最高)
        "deny": ["gateway", "cron"],
        
        // 允许的工具 (如果设置，则为白名单模式)
        // "allow": ["read", "exec", "process"]
      }
    }
  }
}
```

### 7.2 监控与调试

#### 7.2.1 查看 Agent 状态

```bash
# 列出所有 Agent
openclaw agents list

# 查看绑定关系
openclaw agents list --bindings

# 查看 Agent 详细信息
openclaw agents info <agentId>

# 验证配置
openclaw doctor
```

#### 7.2.2 查看子 Agent 状态

```bash
# 在聊天中查看子 Agent 列表
/subagents list

# 查看详细信息
/subagents info <id|#>

# 查看日志
/subagents log <id|#> [limit] [tools]

# 查看会话状态
/status
```

#### 7.2.3 调试技巧

```typescript
// 1. 启用详细日志
openclaw gateway --verbose

// 2. 查看子 Agent 日志
// 搜索 "subagent" 或 "🤖"

// 3. 检查会话存储
// ~/.openclaw/agents/<agentId>/sessions/sessions.json

// 4. 检查 transcript 文件
// ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl

// 5. 手动测试子 Agent 派生
/sessions_spawn task="测试任务" label="test"

// 6. 测试路由
// 发送消息到不同渠道/用户，观察路由日志
```

#### 7.2.4 常见问题排查

**问题 1: 消息路由到错误的 Agent**

```
可能原因:
- Binding 配置顺序错误 (具体规则应放在前面)
- accountId 不匹配
- peer ID 格式错误

解决方案:
1. 检查 bindings 顺序 (具体 → 通用)
2. 验证 accountId 配置
3. 查看路由日志确认匹配过程
```

**问题 2: 子 Agent 无法派生**

```
可能原因:
- 达到深度限制 (maxSpawnDepth)
- 达到并发限制 (maxConcurrent)
- 达到子代数限制 (maxChildrenPerAgent)
- 权限不足 (不允许使用 sessions_spawn)

解决方案:
1. 检查当前深度：getSubagentDepthFromSessionStore()
2. 查看活跃运行：/subagents list
3. 增加限制配置
4. 停止不需要的子 Agent
```

**问题 3: 子 Agent 结果未通告**

```
可能原因:
- 通告投递失败 (Gateway 断开)
- 重试次数耗尽
- 请求者会话已结束

解决方案:
1. 检查 Gateway 连接状态
2. 查看通告重试日志
3. 确认请求者会话仍然活跃
4. 使用 /subagents info 查看结果
```

## 八、性能优化建议

### 8.1 路由优化

1. **优化 Binding 顺序**
   - 将具体的 peer 匹配放在前面
   - 渠道级匹配放在后面
   - 避免不必要的匹配检查

2. **使用 accountId 隔离**
   - 为不同账户配置不同的 Agent
   - 避免跨账户会话混合

3. **合理设置默认 Agent**
   - 设置 `default: true` 明确指定默认 Agent
   - 避免依赖第一个 Agent 作为默认

### 8.2 子 Agent 优化

1. **控制并发数**
   ```json5
   {
     "subagents": {
       "maxConcurrent": 8,  // 根据系统资源调整
       "maxChildrenPerAgent": 5
     }
   }
   ```

2. **使用合适的模型**
   ```json5
   {
     "subagents": {
       "model": "anthropic/claude-sonnet-4-20250514"  // 快速且便宜
     }
   }
   ```

3. **设置超时限制**
   ```json5
   {
     "subagents": {
       "runTimeoutSeconds": 900  // 15 分钟
     }
   }
   ```

4. **启用自动归档**
   ```json5
   {
     "subagents": {
       "archiveAfterMinutes": 60
     }
   }
   ```

### 8.3 资源监控

```bash
# 监控 Gateway 资源使用
openclaw status

# 查看活跃会话
openclaw sessions list

# 监控子 Agent 队列
/subagents list
```

## 八.4 快速入门指南

### 场景 1: 个人使用（单 Agent 模式）

**适用场景**: 个人日常使用，无需复杂配置

```bash
# 1. 安装后直接启动 Gateway
openclaw gateway

# 2. 登录渠道
openclaw channels login --channel whatsapp

# 3. 开始使用（自动使用 main Agent）
```

**说明**: 无需配置文件，系统自动使用默认的单 Agent 模式。

### 场景 2: 工作与生活分离（双 Agent 模式）

**适用场景**: 希望工作和个人聊天使用不同的 AI 人格

**步骤 1: 创建两个 Agent**

```bash
# 创建工作 Agent
openclaw agents add work

# 创建个人 Agent
openclaw agents add personal
```

**步骤 2: 配置路由**

```bash
# 工作渠道绑定到 work Agent
openclaw agents bind --agent work --bind telegram

# 个人渠道绑定到 personal Agent
openclaw agents bind --agent personal --bind whatsapp
```

**步骤 3: 验证配置**

```bash
openclaw agents list --bindings
```

**预期输出**:
```
Agents:
  - work (default: false)
    Bindings: telegram
  - personal (default: false)
    Bindings: whatsapp
```

### 场景 3: 团队协作（多用户共享 Gateway）

**适用场景**: 团队共享一个 Gateway 服务器，但每个成员有独立的 AI 助手

**配置文件** (`~/.openclaw/openclaw.json`):

```json5
{
  "agents": {
    "list": [
      {
        "id": "alice",
        "name": "Alice's Assistant",
        "workspace": "~/.openclaw/workspace-alice",
        "model": "anthropic/claude-sonnet-4-20250514"
      },
      {
        "id": "bob",
        "name": "Bob's Assistant",
        "workspace": "~/.openclaw/workspace-bob",
        "model": "anthropic/claude-sonnet-4-20250514"
      }
    ]
  },
  "bindings": [
    {
      "agentId": "alice",
      "match": {
        "channel": "whatsapp",
        "peer": { "kind": "direct", "id": "+15551230001" }
      }
    },
    {
      "agentId": "bob",
      "match": {
        "channel": "whatsapp",
        "peer": { "kind": "direct", "id": "+15551230002" }
      }
    }
  ],
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551230001", "+15551230002"]
    }
  }
}
```

### 场景 4: 使用子 Agent 并行化任务

**适用场景**: 需要并行执行多个研究任务或长任务

**步骤 1: 在主 Agent 中派生子 Agent**

```
用户：请研究一下 2024 年 AI 领域的重大进展

主 Agent: 我将派生多个子 Agent 并行研究不同领域...

主 Agent 调用工具:
{
  "tool": "sessions_spawn",
  "params": {
    "task": "研究 2024 年大语言模型的进展",
    "label": "llm-research",
    "model": "anthropic/claude-sonnet-4-20250514"
  }
}

主 Agent 调用工具:
{
  "tool": "sessions_spawn",
  "params": {
    "task": "研究 2024 年计算机视觉的进展",
    "label": "cv-research",
    "model": "anthropic/claude-sonnet-4-20250514"
  }
}
```

**步骤 2: 查看子 Agent 状态**

```bash
# 在聊天中查看
/subagents list
```

**预期输出**:
```
Active subagents:
  #1 [running] llm-research
     Task: 研究 2024 年大语言模型的进展
     Runtime: 2m 15s
     
  #2 [running] cv-research
     Task: 研究 2024 年计算机视觉的进展
     Runtime: 2m 10s
```

**步骤 3: 等待结果通告**

```
子 Agent #1 完成 → 通告到主 Agent
子 Agent #2 完成 → 通告到主 Agent

主 Agent: 综合两个子 Agent 的研究结果：

1. 大语言模型进展：
   - 多模态能力突破
   - 推理能力提升
   - ...

2. 计算机视觉进展：
   - 视频生成模型
   - 3D 重建技术
   - ...
```

## 九、总结

OpenClaw 的多 Agent 实现具有以下特点：

### 核心优势

1. **完全隔离**
   - 每个 Agent 有独立的工作区、认证和会话存储
   - 支持多用户共享 Gateway 而数据隔离

2. **灵活路由**
   - 支持多层级路由规则 (peer → guild → team → channel)
   - 支持渠道账户级别的隔离

3. **强大的子 Agent 系统**
   - 支持嵌套派生 (最大深度 5)
   - 自动结果通告
   - 级联停止机制
   - 灵活的清理策略

4. **编排器模式**
   - 支持深度 2 嵌套，实现 Orchestrator-Worker 模式
   - Worker 并行执行，Orchestrator 合成结果

5. **完善的控制机制**
   - 列出/停止/引导子 Agent
   - 并发和深度限制
   - 超时和自动归档

### 最佳实践

1. **为不同场景使用不同 Agent**
   - 日常聊天使用快速模型
   - 深度工作使用高质量模型
   - 专业任务使用专用 Agent

2. **合理使用子 Agent**
   - 并行化独立任务
   - 使用编排器模式管理复杂任务
   - 设置合适的超时和限制

3. **优化路由配置**
   - 具体规则在前，通用规则在后
   - 使用 accountId 隔离不同账户
   - 明确设置默认 Agent

4. **监控和调试**
   - 定期查看子 Agent 状态
   - 启用详细日志排查问题
   - 使用工具命令控制子 Agent

通过这套完整的多 Agent 架构，OpenClaw 能够支持从简单单 Agent 到复杂多 Agent 编排的各种场景，平衡性能、成本和用户体验。
