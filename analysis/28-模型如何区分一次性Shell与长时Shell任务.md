# 模型如何区分一次性 Shell 与长时 Shell 任务

## 一、概述

模型通过 **三个层次** 的"信息注入"来区分一次性 Shell 调用和长时 Shell 执行，全部由系统侧在每次 Agent 启动时通过 **系统提示词 + 工具 Schema** 告知模型。模型做出决策不需要任何"猜测"，系统已经通过工具描述和参数 Schema 明确告诉了模型该怎么做。

## 二、整体架构：三层信息注入

```
┌──────────────────────────────────────────────────────────────┐
│  每次 Agent Run 启动时，系统向模型注入:                         │
│                                                              │
│  Layer 1: System Prompt（系统提示词）                          │
│           buildSystemPrompt() in src/agents/system-prompt.ts │
│           - 告诉模型有哪些工具可用                             │
│           - 告诉模型如何正确使用 yieldMs/background/process   │
│           - "For long waits, avoid rapid poll loops..."      │
│                                                              │
│  Layer 2: Tool Description（工具描述）                         │
│           exec 工具的 description 字段                        │
│           createExecTool() in src/agents/bash-tools.exec.ts  │
│           - "Execute shell commands with background           │
│              continuation. Use yieldMs/background to          │
│              continue later via process tool."               │
│                                                              │
│  Layer 3: Tool Schema（参数 Schema / JSON Schema）             │
│           execSchema in bash-tools.exec-runtime.ts           │
│           processSchema in bash-tools.process.ts             │
│           - background: "Run in background immediately"      │
│           - yieldMs: "Milliseconds to wait before             │
│              backgrounding (default 10000)"                  │
│           → 通过 Pi-Agent SDK 转为 function calling JSON     │
└──────────────────────────────────────────────────────────────┘
```

## 三、Layer 1：系统提示词

**文件**：[src/agents/system-prompt.ts](file:///d:/prj/openclaw_analyze/src/agents/system-prompt.ts)

### 3.1 工具概览表（coreToolSummaries）

模型看到的系统提示词中包含一个完整的工具概览表，明确区分了两个工具的角色：

```typescript
// src/agents/system-prompt.ts L248-L249
const coreToolSummaries: Record<string, string> = {
  exec: "Run shell commands (pty available for TTY-required CLIs)",
  process: "Manage background exec sessions",
  // ...
};
```

### 3.2 长时执行的关键提示行

在系统提示词的 **"Tooling"** 段中，有多条直接指导模型何时使用长时执行：

```typescript
// src/agents/system-prompt.ts L436-L449
const lines = [
  "## Tooling",
  "Tool availability (filtered by policy):",
  "Tool names are case-sensitive. Call tools exactly as listed.",
  // ...
  `- ${execToolName}: run shell commands (supports background via yieldMs/background)`,
  `- ${processToolName}: manage background exec sessions`,

  // ★★★ 核心指导行 ★★★
  `For long waits, avoid rapid poll loops: use ${execToolName} with enough yieldMs
   or ${processToolName}(action=poll, timeout=<ms>).`,
  // ...
];
```

模型实际看到的系统提示词（展开后）：

```
## Tooling
Tool availability (filtered by policy):
- exec: run shell commands (supports background via yieldMs/background)
- process: manage background exec sessions
...
For long waits, avoid rapid poll loops: use exec with enough yieldMs
or process(action=poll, timeout=<ms>).
```

### 3.3 完整数据流：从代码到模型的眼睛

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Step 1: 工具定义                                                        │
│                                                                         │
│  createExecTool()                     createProcessTool()                │
│  src/agents/bash-tools.exec.ts       src/agents/bash-tools.process.ts  │
│                                                                         │
│  产物:                                  产物:                            │
│  { name: "exec",                        { name: "process",              │
│    description: "Execute shell          description: "Manage running    │
│      commands with background             exec sessions: list, poll,    │
│      continuation...",                    log, write...",               │
│    parameters: execSchema               parameters: processSchema       │
│  }                                     }                                │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Step 2: 工具注册 & Schema 转换                                          │
│                                                                         │
│  createOpenClawTools() in src/agents/pi-tools.ts                        │
│    → 合并 execTool, processTool 等所有工具                               │
│                                                                         │
│  toToolDefinitions() in src/agents/pi-tool-definition-adapter.ts        │
│    → 将 AgentTool[] 转为 ToolDefinition[]                               │
│    → 保留 name, description, parameters (TypeBox→JSON Schema)           │
│                                                                         │
│  splitSdkTools() in src/agents/pi-embedded-runner/tool-split.ts         │
│    → builtInTools: [], customTools: [ToolDefinition...]                 │
│    → 传给 Pi-Agent SDK → 转为 LLM function call definitions             │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Step 3: 系统提示词注入                                                  │
│                                                                         │
│  buildSystemPrompt() in src/agents/system-prompt.ts                     │
│    → 生成 "## Tooling" 段                                               │
│    → 列出: exec: ... (supports background via yieldMs/background)       │
│    → 列出: process: manage background exec sessions                     │
│    → 强调: For long waits, avoid rapid poll loops...                    │
│                                                                         │
│  runEmbeddedPiAgent() 将 systemPrompt 传给 Pi-Agent SDK                 │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Step 4: 模型收到的最终视图                                               │
│                                                                         │
│  System Message:                                                        │
│    ..."## Tooling" section...                                           │
│    - exec: run shell commands (supports background via yieldMs/background)│
│    - process: manage background exec sessions                           │
│    For long waits, avoid rapid poll loops...                            │
│                                                                         │
│  Available Functions:                                                   │
│    exec:                                                                 │
│      description: "Execute shell commands with background continuation. │
│        Use yieldMs/background to continue later via process tool..."    │
│      parameters:                                                        │
│        command, yieldMs, background, timeout, pty, ...                  │
│                                                                         │
│    process:                                                             │
│      description: "Manage running exec sessions: list, poll, log..."   │
│      parameters:                                                        │
│        action, sessionId, timeout, data, keys, ...                      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 四、Layer 2：工具描述

**文件**：[src/agents/bash-tools.exec.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts#L275-L279)

`exec` 工具的 `description` 字段是模型收到的第一手信息：

```typescript
return {
  name: "exec",
  label: "exec",
  description:
    "Execute shell commands with background continuation. " +   // ← 明确说"支持后台延续"
    "Use yieldMs/background to continue later via process tool. " +  // ← 告诉模型用哪个参数 + 后续用什么工具
    "Use pty=true for TTY-required commands (terminal UIs, coding agents).",
  parameters: execSchema,
  // ...
};
```

这个 description 会被 `toToolDefinitions()` 转换为 `ToolDefinition` 结构：

```typescript
// src/agents/pi-tool-definition-adapter.ts L137-L145
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => {
    return {
      name: tool.name,                    // "exec"
      label: tool.label ?? name,          // "exec"
      description: tool.description ?? "", // ← 上面那段文字原样传给模型
      parameters: tool.parameters,        // ← execSchema（TypeBox → JSON Schema）
      execute: async (...args) => { ... },
    };
  });
}
```

最终通过 [src/agents/pi-embedded-runner/tool-split.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-embedded-runner/tool-split.ts) 合并发给 Pi-Agent SDK：

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [],
    customTools: toToolDefinitions(tools),  // ← exec + process 等都在这里
  };
}
```

---

## 五、Layer 3：参数 Schema

### 5.1 exec 工具的参数 Schema

**文件**：[src/agents/bash-tools.exec-runtime.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts#L136-L195)

```typescript
export const execSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),

  // ★ 长时执行的关键参数 ★
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait before backgrounding (default 10000)",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: "Run in background immediately",
    }),
  ),

  // 一次性调用的关键参数
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, kills process on expiry)",
    }),
  ),

  pty: Type.Optional(
    Type.Boolean({
      description: "Run in a pseudo-terminal (PTY) when available...",
    }),
  ),
  // ...
});
```

模型收到的 function definition 类似（TypeBox Schema 被 Pi-Agent SDK 转为标准 JSON Schema）：

```json
{
  "name": "exec",
  "description": "Execute shell commands with background continuation. Use yieldMs/background to continue later via process tool...",
  "parameters": {
    "type": "object",
    "properties": {
      "command": { "type": "string", "description": "Shell command to execute" },
      "yieldMs": { "type": "number", "description": "Milliseconds to wait before backgrounding (default 10000)" },
      "background": { "type": "boolean", "description": "Run in background immediately" },
      "timeout": { "type": "number", "description": "Timeout in seconds (optional, kills process on expiry)" },
      "pty": { "type": "boolean", "description": "Run in a pseudo-terminal (PTY) when available..." }
    },
    "required": ["command"]
  }
}
```

### 5.2 process 工具的参数 Schema

**文件**：[src/agents/bash-tools.process.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L81-L104)

```typescript
const processSchema = Type.Object({
  action: Type.String({ description: "Process action" }),
  sessionId: Type.Optional(
    Type.String({ description: "Session id for actions other than list" }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description: "For poll: wait up to this many milliseconds before returning",
      minimum: 0,
    }),
  ),
  data: Type.Optional(Type.String({ description: "Data to write for write" })),
  keys: Type.Optional(
    Type.Array(Type.String(), { description: "Key tokens to send for send-keys" }),
  ),
  // ... 其他参数
});
```

process 工具描述：

```typescript
description:
  "Manage running exec sessions: list, poll, log, write, send-keys, submit, paste, kill.",
```

---

## 六、模型的决策逻辑

基于以上三个层次的信息，模型做出如下推理：

```
模型收到用户请求："帮我编译这个项目"
  │
  ├─ 模型检查系统提示词：
  │   ├─ "exec: supports background via yieldMs/background"  ← 知道可以后台
  │   └─ "For long waits, avoid rapid poll loops"            ← 知道长等待不要快速轮询
  │
  ├─ 模型检查 exec 工具 Schema：
  │   ├─ background: true → 立即后台，马上拿 sessionId
  │   ├─ yieldMs: 5000 → 等5秒看有没有输出，然后自动后台
  │   └─ timeout: 300 → 30秒超时
  │
  ├─ 模型决策树：
  │   │
  │   ├─ 预计命令很快完成（<5秒）
  │   │   → exec({ command: "ls -la", timeout: 30 })
  │   │   → 不传 background/yieldMs
  │   │   → 工具调用阻塞等待结果，一次性返回
  │   │
  │   ├─ 预计命令较慢但可预测（编译、安装）
  │   │   → exec({ command: "npm install", yieldMs: 10000, timeout: 120 })
  │   │   → 等10秒→自动后台→模型拿到 sessionId
  │   │   → 后续用 process({ action: "poll", sessionId, timeout: 30000 }) 轮询
  │   │
  │   └─ 预计长时间运行或需要交互（dev server、训练脚本）
  │       → exec({ command: "npm run dev", background: true })
  │       → 立即后台→模型拿到 sessionId
  │       → 后续: process poll / write / send-keys / submit / kill
```

---

## 七、总结：模型区分两种模式的关键信息点

| 信息源 | 一次性调用怎么知道 | 长时执行怎么知道 |
|--------|-------------------|------------------|
| **System Prompt** | `exec: run shell commands` | `supports background via yieldMs/background`、`For long waits, avoid rapid poll loops` |
| **exec description** | "Execute shell commands" | "with background continuation...Use yieldMs/background to continue later via process tool" |
| **exec schema: background** | 不传 = 默认前台阻塞 | `true` = 立即后台 |
| **exec schema: yieldMs** | 不传 = 默认等 10 秒自动后台 | `5000` = 等 5 秒自动后台 |
| **exec schema: timeout** | 传 timeout 限制执行时间 | 不传 + background=true → 绕过超时 |
| **process tool** | 模型看到但不需要用 | 模型看到：`poll/write/send-keys/submit/kill` 是管理后台会话的手段 |

**核心结论**：模型不需要"猜测"，系统侧通过 **工具 description + 参数 Schema + 系统提示词** 三管齐下，明确告知模型 `exec` 工具有前台/后台两种模式，`process` 工具是用来管理后台会话的。模型根据任务特征（预计耗时、是否需要交互）自主选择传 `background`/`yieldMs` 还是不传。

---

## 八、工具显示配置（tool-display）

模型执行时，Per-Agent 的工具显示信息由以下 JSON 配置驱动：

**文件**：[src/agents/tool-display-overrides.json](file:///d:/prj/openclaw_analyze/src/agents/tool-display-overrides.json)

```json
{
  "version": 1,
  "tools": {
    "exec": {
      "emoji": "🛠️",
      "title": "Exec",
      "detailKeys": ["command"]
    }
    // process 等工具的 display 配置也有对应条目
  }
}
```

**文件**：[src/agents/tool-display.ts](file:///d:/prj/openclaw_analyze/src/agents/tool-display.ts)

```typescript
export function resolveToolDisplay(params: {
  name?: string;
  args?: unknown;
  meta?: string;
}): ToolDisplay {
  const name = normalizeToolName(params.name);
  const key = name.toLowerCase();
  const spec = TOOL_MAP[key];
  const emoji = spec?.emoji ?? FALLBACK.emoji ?? "🧩";
  const title = spec?.title ?? defaultTitle(name);
  // ... 解析 verb, detail 等
}
```

---

## 九、关键类/文件速查

| 类/模块 | 文件 | 职责 |
|---------|------|------|
| `buildSystemPrompt` | [system-prompt.ts](file:///d:/prj/openclaw_analyze/src/agents/system-prompt.ts) | 构建系统提示词，含工具概览和长时执行指导 |
| `createExecTool` | [bash-tools.exec.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts) | exec 工具定义，含 description 描述两种模式 |
| `execSchema` | [bash-tools.exec-runtime.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts) | exec 参数 Schema（background/yieldMs/timeout） |
| `createProcessTool` | [bash-tools.process.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts) | process 工具定义（poll/log/write/send-keys...） |
| `processSchema` | [bash-tools.process.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.process.ts#L81) | process 参数 Schema |
| `toToolDefinitions` | [pi-tool-definition-adapter.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-tool-definition-adapter.ts) | TypeBox Schema → LLM function call JSON |
| `splitSdkTools` | [pi-embedded-runner/tool-split.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-embedded-runner/tool-split.ts) | 工具定义传给 Pi-Agent SDK |
| `resolveToolDisplay` | [tool-display.ts](file:///d:/prj/openclaw_analyze/src/agents/tool-display.ts) | 工具显示信息（emoji/title/detail） |
| `tool-display-overrides.json` | [tool-display-overrides.json](file:///d:/prj/openclaw_analyze/src/agents/tool-display-overrides.json) | exec/process 等工具的显示配置 |