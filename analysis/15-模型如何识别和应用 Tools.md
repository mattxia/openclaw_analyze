# 模型如何识别和应用 Tools：系统提示词与学习机制分析

## 一、核心机制概述

### 1.1 问题的本质

**问题**：LLM（如 Claude、GPT）本身并不知道 OpenClaw 有哪些 Tools，也不知道如何使用它们。

**解决方案**：通过**系统提示词（System Prompt）**将 Tools 的信息注入到 LLM 的上下文中。

### 1.2 关键流程

```
┌─────────────────────────────────────────────────────────────┐
│ 系统启动阶段                                                 │
└─────────────────────────────────────────────────────────────┘
   ↓
1. 加载所有可用的 Tools（系统注册）
   - 核心 Tools：read, write, exec, web_search, ...
   - 插件 Tools：browser, canvas, message, ...
   - 自定义 Tools：通过插件扩展
   
   ↓
2. 过滤 Tools（根据配置策略）
   - tools.profile: minimal | coding | messaging | full
   - tools.allow / tools.deny
   - tools.byProvider (按模型提供商限制)
   
   ↓
3. 生成 Tool 描述和 Schema
   - 名称、标签、简短描述
   - 参数定义（JSON Schema）
   
   ↓
4. 构建系统提示词
   - 注入 Tooling 部分（工具列表 + 描述）
   - 注入 Skills 部分（使用指南）
   - 注入其他上下文（环境、配置、规则）
   
   ↓
5. 创建 Agent 会话
   - 将系统提示词设置到会话
   - 注册 Tools 到会话（供执行时使用）
   
   ↓
┌─────────────────────────────────────────────────────────────┐
│ Agent 运行阶段                                               │
└─────────────────────────────────────────────────────────────┘
   ↓
6. 用户发送任务
   - "帮我检查 PR #55 的 CI 状态"
   
   ↓
7. LLM 接收提示词 + 用户消息
   - 阅读系统提示词中的 Tools 描述
   - 阅读 Skills 中的使用指南
   - 理解用户意图
   
   ↓
8. LLM 决策调用哪个 Tool
   - 基于 Tools 描述判断功能
   - 基于 Skills 指南判断场景
   - 生成 Tool Call
   
   ↓
9. 系统执行 Tool
   - 匹配 Tool 名称
   - 验证参数 Schema
   - 执行 Tool 逻辑
   - 返回结果给 LLM
   
   ↓
10. LLM 生成回复
    - 解析 Tool 结果
    - 生成自然语言回复
    - 发送给用户
```

---

## 二、系统提示词中的 Tooling 部分

### 2.1 Tool 描述格式

系统提示词中的 **Tooling** 部分以结构化方式列出所有可用 Tools：

```markdown
## Tooling

You have access to the following tools:

### Files
- `read` - Read file contents
- `write` - Create or overwrite files
- `edit` - Make precise edits (search/replace blocks)

### Runtime
- `exec` - Run shell commands
- `process` - Manage background processes

### Web
- `web_search` - Search the web
- `web_fetch` - Fetch web content

### Sessions
- `sessions_list` - List active sessions
- `sessions_history` - Get session history
- `sessions_send` - Send message to session
- `sessions_spawn` - Spawn a sub-agent session
- `sessions_yield` - Yield turn to receive sub-agent results

### Messaging
- `message` - Send messages via configured channels
  - Current channel (telegram) supports: send, react, edit, delete
  - Other configured channels: slack, discord

### UI
- `browser` - Control web browser (navigate, screenshot, interact)
- `canvas` - Control canvas panels (create, update, present)

... (更多工具)
```

**关键点**：
- ✅ **分类组织**：按功能分组（Files, Runtime, Web, Sessions, Messaging, UI）
- ✅ **简短描述**：每个工具一行，说明核心功能
- ✅ **动态信息**：如 Messaging 工具会显示当前渠道支持的操作

---

### 2.2 Tool Schema 注入

除了文字描述，Tools 的**参数 Schema**也会注入到提示词中（通过 SDK 的工具注册机制）：

```typescript
// 文件：src/agents/tools/sessions-spawn-tool.ts
{
  name: "sessions_spawn",
  description: "Spawn an isolated session (runtime='subagent' or runtime='acp')...",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Task description for the sub-agent"
      },
      label: {
        type: "string",
        description: "Optional label for the spawned session"
      },
      agentId: {
        type: "string",
        description: "Target agent ID (default: current agent)"
      },
      model: {
        type: "string",
        description: "Override model for sub-agent"
      },
      runtime: {
        type: "string",
        enum: ["subagent", "acp"],
        description: "Runtime type"
      },
      // ... 更多参数
    },
    required: ["task"]
  }
}
```

**LLM 看到的完整 Tool 信息**：
```
Tool: sessions_spawn
Description: Spawn an isolated session (runtime='subagent' or runtime='acp')...
Parameters:
{
  "task": "任务描述（必需，字符串）",
  "label": "标签（可选，字符串）",
  "agentId": "目标 Agent ID（可选，字符串）",
  "model": "模型覆盖（可选，字符串）",
  "runtime": "运行时类型：subagent | acp（可选）",
  ...
}
```

---

### 2.3 代码实现：Tool 描述生成

```typescript
// 文件：src/agents/tool-catalog.ts

// 1. 核心工具定义
const CORE_TOOL_DEFINITIONS: CoreToolDefinition[] = [
  {
    id: "read",
    label: "read",
    description: "Read file contents",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "exec",
    label: "exec",
    description: "Run shell commands",
    sectionId: "runtime",
    profiles: ["coding"],
  },
  // ... 更多工具
];

// 2. 按 Section 组织
const CORE_TOOL_SECTION_ORDER: Array<{ id: string; label: string }> = [
  { id: "fs", label: "Files" },
  { id: "runtime", label: "Runtime" },
  { id: "web", label: "Web" },
  { id: "memory", label: "Memory" },
  { id: "sessions", label: "Sessions" },
  { id: "ui", label: "UI" },
  { id: "messaging", label: "Messaging" },
  // ...
];

// 3. 生成 Tool 摘要映射
// 文件：src/agents/tool-summaries.ts
export function buildToolSummaryMap(tools: AgentTool[]): Record<string, string> {
  const summaryMap: Record<string, string> = {};
  
  for (const tool of tools) {
    // 生成简短描述
    summaryMap[tool.name] = generateShortDescription(tool);
  }
  
  return summaryMap;
}
```

---

### 2.4 代码实现：系统提示词构建

```typescript
// 文件：src/agents/pi-embedded-runner/system-prompt.ts

export function buildEmbeddedSystemPrompt(params: {
  workspaceDir: string;
  tools: AgentTool[];  // ← 所有可用的 Tools
  skillsPrompt?: string;
  runtimeInfo: {
    host: string;
    os: string;
    model: string;
    // ...
  };
  // ... 其他参数
}): string {
  return buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir,
    toolNames: params.tools.map((tool) => tool.name),  // ← 工具名称列表
    toolSummaries: buildToolSummaryMap(params.tools),  // ← 工具描述映射
    skillsPrompt: params.skillsPrompt,  // ← Skills 提示词
    runtimeInfo: params.runtimeInfo,
    // ... 其他参数
  });
}
```

---

### 2.5 代码实现：系统提示词组装

```typescript
// 文件：src/agents/system-prompt.ts

export function buildAgentSystemPrompt(params: {
  toolNames: string[];
  toolSummaries: Record<string, string>;
  skillsPrompt?: string;
  workspaceDir: string;
  runtimeInfo: RuntimeInfo;
  // ...
}): string {
  const sections: string[] = [];
  
  // 1. Tooling 部分
  sections.push(buildToolingSection(params.toolNames, params.toolSummaries));
  
  // 2. Safety 部分
  sections.push(buildSafetySection());
  
  // 3. Skills 部分（如果有）
  if (params.skillsPrompt) {
    sections.push(params.skillsPrompt);
  }
  
  // 4. Workspace 部分
  sections.push(buildWorkspaceSection(params.workspaceDir));
  
  // 5. Runtime 部分
  sections.push(buildRuntimeSection(params.runtimeInfo));
  
  // ... 其他部分
  
  return sections.join("\n\n");
}

function buildToolingSection(
  toolNames: string[],
  toolSummaries: Record<string, string>
): string {
  // 按类别分组工具
  const grouped = groupToolsByCategory(toolNames);
  
  const lines: string[] = ["## Tooling\n\nYou have access to the following tools:\n"];
  
  for (const [category, tools] of Object.entries(grouped)) {
    lines.push(`### ${category}`);
    for (const toolName of tools) {
      const summary = toolSummaries[toolName] || "No description";
      lines.push(`- \`${toolName}\` - ${summary}`);
    }
    lines.push("");
  }
  
  return lines.join("\n");
}
```

---

## 三、Skills 如何教 LLM 使用 Tools

### 3.1 Skills 提示词注入

Skills 不是直接注入代码，而是注入**自然语言指南**：

```typescript
// 文件：src/agents/skills/workspace.ts

export function loadSkillEntries(...): SkillEntry[] {
  // 1. 扫描 Skills 目录
  const skills = scanSkillsDirectories([...]);
  
  // 2. 门控过滤（检查依赖）
  const eligibleSkills = filterSkillEntries(skills, config, env, binaries);
  
  // 3. 生成提示词
  const skillsPrompt = formatSkillsForPrompt(eligibleSkills);
  
  return { skills: eligibleSkills, prompt: skillsPrompt };
}

// 文件：@mariozechner/pi-coding-agent (外部库)
export function formatSkillsForPrompt(skills: Skill[]): string {
  const lines: string[] = ["## Available Skills\n"];
  
  for (const skill of skills) {
    lines.push(`### ${skill.name}`);
    lines.push(`**Description**: ${skill.description}`);
    lines.push(`**Location**: ${skill.filePath}`);
    lines.push("");
    lines.push("**Usage Guidelines**:");
    lines.push("Read the SKILL.md file at the location above for detailed instructions.");
    lines.push("");
  }
  
  return lines.join("\n");
}
```

---

### 3.2 LLM 如何学习使用 Skills

**步骤 1：系统提示词告知 Skills 存在**

```markdown
## Skills

You have access to the following skills:

### github
**Description**: GitHub operations via `gh` CLI
**Location**: ~/.openclaw/skills/github/SKILL.md

### weather
**Description**: Weather forecast via API
**Location**: ~/.openclaw/skills/weather/SKILL.md

**How to Use Skills**:
When a task matches a skill's description, read the SKILL.md file at the 
listed location using the `read` tool to learn detailed usage instructions.
```

---

**步骤 2：LLM 决定读取 Skill 文档**

```
用户："帮我检查 PR #55 的 CI 状态"

LLM 思考：
1. 检索系统提示词中的 Skills 列表
   → 看到 "github: GitHub operations via gh CLI"
   
2. 判断任务匹配 github Skill
   → 需要读取 SKILL.md 了解具体用法
   
3. 调用 read 工具
   → read("~/.openclaw/skills/github/SKILL.md")
```

---

**步骤 3：LLM 读取 Skill 文档**

```markdown
<!-- 文件：~/.openclaw/skills/github/SKILL.md -->

# GitHub Skill

## When to Use

✅ **USE this skill when:**
- Checking PR status, reviews, or merge readiness
- Viewing CI/workflow run status and logs
- Creating, closing, or commenting on issues

## Common Commands

### Pull Requests
```bash
# Check CI status
gh pr checks 55 --repo owner/repo
```
```

---

**步骤 4：LLM 应用 Skill 知识**

```
LLM 思考：
1. 读取了 github Skill 文档
   → 学到了 "Check CI status: gh pr checks <number> --repo <repo>"
   
2. 选择使用 exec 工具
   → 因为 Skill 说使用 gh CLI
   
3. 调用 exec 工具
   → exec("gh pr checks 55 --repo owner/repo")
```

---

### 3.3 直接注入 Skill 内容（可选）

某些系统会直接将 Skill 的关键内容注入到提示词，而不是让 LLM 动态读取：

```typescript
// 文件：src/agents/skills/workspace.ts

export function formatSkillsForPrompt(skills: Skill[]): string {
  const lines: string[] = ["## Skills Instructions\n"];
  
  for (const skill of skills) {
    lines.push(`### ${skill.name}`);
    lines.push(`**Description**: ${skill.description}`);
    
    // 直接注入关键内容（当 Skill 较小时）
    if (skill.content.length < 2000) {
      lines.push("**Instructions**:");
      lines.push(skill.content);  // ← 直接注入完整内容
    } else {
      // 大 Skill 只注入摘要，让 LLM 按需读取
      lines.push("**Location**: " + skill.filePath);
      lines.push("Read the full SKILL.md when needed.");
    }
    lines.push("");
  }
  
  return lines.join("\n");
}
```

---

## 四、Tool 调用执行流程

### 4.1 完整流程图解

```
┌─────────────────────────────────────────────────────────────┐
│ 阶段 1: 系统提示词注入                                        │
└─────────────────────────────────────────────────────────────┘
   ↓
系统提示词包含：
┌─────────────────────────────────────────────────────────────┐
│ ## Tooling                                                   │
│ - exec - Run shell commands                                  │
│   Parameters: { command: string }                            │
│                                                              │
│ ## Skills                                                    │
│ ### github                                                   │
│ - Location: ~/.openclaw/skills/github/SKILL.md              │
│ - Read this file for detailed instructions                   │
└─────────────────────────────────────────────────────────────┘
   ↓
注入到 Agent 会话
   ↓
┌─────────────────────────────────────────────────────────────┐
│ 阶段 2: LLM 决策                                              │
└─────────────────────────────────────────────────────────────┘
   ↓
用户："帮我检查 PR #55 的 CI 状态"
   ↓
LLM 思考过程：
1. 阅读系统提示词
   → 看到有 exec 工具
   → 看到有 github Skill
   
2. 决定读取 Skill 文档
   → 调用 read("~/.openclaw/skills/github/SKILL.md")
   
3. 学习 Skill 内容
   → "Check CI status: gh pr checks <number>"
   
4. 决定使用 exec 工具
   → 生成 Tool Call:
     {
       "name": "exec",
       "arguments": {
         "command": "gh pr checks 55 --repo owner/repo"
       }
     }
   ↓
┌─────────────────────────────────────────────────────────────┐
│ 阶段 3: 工具执行                                              │
└─────────────────────────────────────────────────────────────┘
   ↓
系统接收到 Tool Call
   ↓
1. 匹配工具名称
   → 查找名为 "exec" 的工具
   
2. 验证参数 Schema
   → 检查是否有必需的 "command" 参数
   → 验证参数类型正确
   
3. 执行工具逻辑
   → 调用 exec 工具的 execute 函数
   → 在 shell 中运行命令
   
4. 捕获输出
   → stdout: "✅ All checks passed (3/3)"
   → stderr: ""
   → exitCode: 0
   
5. 返回结果给 LLM
   → { status: "success", output: "✅ All checks passed (3/3)" }
   ↓
┌─────────────────────────────────────────────────────────────┐
│ 阶段 4: LLM 生成回复                                          │
└─────────────────────────────────────────────────────────────┘
   ↓
LLM 接收工具结果
   ↓
生成自然语言回复：
"PR #55 的 CI 状态：✅ 所有检查通过（3/3）"
   ↓
发送给用户
```

---

### 4.2 代码实现：Tool Call 处理

```typescript
// 文件：@mariozechner/pi-agent-core (简化版)

export class AgentSession {
  private tools: Map<string, AgentTool> = new Map();
  
  // 注册工具
  registerTool(tool: AgentTool) {
    this.tools.set(tool.name, tool);
  }
  
  // 处理 LLM 的 Tool Call
  async handleToolCall(toolCall: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }) {
    // 1. 查找工具
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      throw new Error(`Tool not found: ${toolCall.name}`);
    }
    
    // 2. 验证参数
    const validatedArgs = validateParameters(
      tool.parameters,
      toolCall.arguments
    );
    
    // 3. 执行工具
    const result = await tool.execute(
      toolCall.id,
      validatedArgs,
      this.abortSignal
    );
    
    // 4. 返回结果
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: result
    };
  }
}
```

---

### 4.3 代码实现：Tool 执行示例

```typescript
// 文件：src/agents/tools/sessions-spawn-tool.ts

export function createSessionsSpawnTool(...): AnyAgentTool {
  return {
    name: "sessions_spawn",
    description: "Spawn an isolated session...",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description" },
        label: { type: "string", description: "Optional label" },
        // ...
      },
      required: ["task"]
    },
    
    execute: async (toolCallId, args, signal) => {
      // 1. 参数验证
      if (!args.task) {
        throw new Error("task is required");
      }
      
      // 2. 检查深度限制
      const depth = getSubagentDepthFromSession(sessionKey);
      if (depth >= MAX_DEPTH) {
        throw new Error("Max subagent depth reached");
      }
      
      // 3. 派生子 Agent
      const result = await spawnSubagentDirect({
        task: args.task,
        label: args.label,
        // ...
      }, ctx);
      
      // 4. 返回结果
      return {
        status: "success",
        sessionId: result.sessionId,
        details: result
      };
    }
  };
}
```

---

## 五、Tool 描述优化技巧

### 5.1 动态描述生成

某些工具的描述会根据上下文动态调整：

```typescript
// 文件：src/agents/tools/message-tool.ts

export function createMessageTool(params: {
  currentChannelProvider?: string;
  currentChannelId?: string;
  config: OpenClawConfig;
}): AnyAgentTool {
  // 获取当前渠道支持的操作
  const channelActions = getChannelActions(params.currentChannelProvider);
  
  // 生成动态描述
  const descriptionParts = [
    "Send messages via configured channels.",
  ];
  
  if (params.currentChannelProvider) {
    descriptionParts.push(
      `\n- Current channel (${params.currentChannelProvider}) supports: ${channelActions.join(", ")}.`
    );
  }
  
  // 列出其他配置的渠道
  const otherChannels = getOtherConfiguredChannels(params.config);
  if (otherChannels.length > 0) {
    descriptionParts.push(
      `\n- Other configured channels: ${otherChannels.join(", ")}.`
    );
  }
  
  return {
    name: "message",
    description: descriptionParts.join("\n"),
    // ...
  };
}
```

**LLM 看到的描述**：
```
message - Send messages via configured channels.
- Current channel (telegram) supports: send, react, edit, delete.
- Other configured channels: slack, discord.
```

---

### 5.2 条件性描述

根据模型能力调整描述：

```typescript
// 文件：src/agents/tools/image-tool.ts

export function createImageTool(params: {
  modelHasVision: boolean;  // 模型是否支持视觉
}): AnyAgentTool {
  let description = "Generate images from text descriptions.";
  
  if (params.modelHasVision) {
    // 如果模型本身支持视觉，调整描述避免重复使用
    description += 
      " Only use this tool when images were NOT already provided by the model.";
  }
  
  return {
    name: "image",
    description: description,
    // ...
  };
}
```

---

### 5.3 安全相关描述

在描述中包含安全提示：

```typescript
// 文件：src/agents/tools/tts-tool.ts

export function createTtsTool(): AnyAgentTool {
  return {
    name: "tts",
    description: 
      "Convert text to speech. " +
      "IMPORTANT: Use QUIET_TOKEN to suppress follow-up responses. " +
      "Do not use for sensitive information.",
    // ...
  };
}
```

---

## 六、多轮对话中的 Tool 学习

### 6.1 上下文学习（In-Context Learning）

LLM 通过多轮对话的反馈学习 Tool 的正确用法：

```
第 1 轮：
用户："检查 PR 状态"
LLM：（不确定）调用 web_search("GitHub PR API")
结果：返回通用 API 文档，不是具体 PR

第 2 轮：
用户："不对，我是说用 gh 命令"
LLM：（学习）哦，应该用 exec 工具调用 gh
调用 exec("gh pr checks")
结果：✅ 成功

第 3 轮：
用户："检查 PR #55"
LLM：（应用学习）直接调用 exec("gh pr checks 55")
结果：✅ 正确
```

**系统提示词强化**：
```markdown
## Tooling Tips

- Use `gh` CLI via `exec` for GitHub operations
- Use `read` to load skill documentation before using skills
- When unsure, ask the user for clarification
```

---

### 6.2 错误恢复

当 Tool 调用失败时，LLM 从错误信息中学习：

```
LLM 调用：exec("gh pr checks 55")
错误：gh: command not found

LLM 思考：
- gh 命令不存在
- 可能需要安装或配置
- 询问用户或建议使用其他方式

回复用户：
"看起来 gh CLI 没有安装。你可以：
1. 安装 gh: brew install gh
2. 或者使用 GitHub API 直接查询"
```

---

## 七、高级：Tool 组合与编排

### 7.1 多 Tool 组合任务

复杂任务需要组合多个 Tools：

```
用户："分析这个仓库的 CI 健康度"

LLM 规划：
1. 使用 read 读取 .github/workflows/*.yml
2. 使用 exec 运行 gh run list 获取历史运行
3. 使用 web_search 查找最佳实践
4. 使用 write 生成分析报告

执行流程：
read(".github/workflows/ci.yml")
  → 返回 CI 配置
exec("gh run list --limit 50")
  → 返回运行历史
web_search("GitHub Actions best practices")
  → 返回最佳实践
write("ci-health-report.md", report)
  → 生成报告
```

---

### 7.2 条件性 Tool 调用

根据前一个 Tool 的结果决定下一步：

```typescript
// LLM 的隐式逻辑

if (exec("gh pr checks").status === "failed") {
  // CI 失败，查看详细日志
  exec("gh run view <run-id> --log");
} else {
  // CI 成功，继续下一步
  exec("gh pr merge <number>");
}
```

---

## 八、总结

### 8.1 核心要点

| 问题 | 答案 |
|------|------|
| **LLM 如何知道有哪些 Tools？** | 系统提示词中的 **Tooling** 部分注入工具列表和描述 |
| **LLM 如何知道何时使用哪个 Tool？** | 通过 **Skills** 的使用指南 + 工具描述中的功能说明 |
| **LLM 如何知道如何调用 Tool？** | 工具参数 Schema 注入 + Skills 文档中的示例 |
| **系统如何执行 Tool？** | 匹配工具名称 → 验证参数 → 执行逻辑 → 返回结果 |
| **LLM 如何学习改进？** | 多轮对话的反馈 + 错误信息 + 用户指导 |

---

### 8.2 关键机制

```
┌─────────────────────────────────────────────────────────────┐
│ LLM 识别和应用 Tools 的三层机制                              │
└─────────────────────────────────────────────────────────────┘

第 1 层：系统提示词注入
├─ Tooling 部分：工具列表 + 描述 + 参数 Schema
├─ Skills 部分：使用指南 + 最佳实践
└─ 其他上下文：环境信息、配置、规则

第 2 层：动态学习
├─ 读取 Skill 文档（按需）
├─ 多轮对话反馈
└─ 错误恢复

第 3 层：执行与验证
├─ 工具名称匹配
├─ 参数 Schema 验证
├─ 执行逻辑
└─ 结果返回

```

---

### 8.3 一句话总结

> **系统提示词是 LLM 的"使用手册"，Skills 是"专家指南"，Tool Schema 是"操作说明"，多轮对话是"实践学习"。**

- **系统提示词**：告诉 LLM 有哪些 Tools 可用
- **Skills**：教 LLM 何时、如何使用 Tools
- **Tool Schema**：定义如何正确调用 Tools
- **执行反馈**：帮助 LLM 学习和改进

**系统设计哲学**：
> "通过结构化的提示词工程，让 LLM 在无需训练的情况下学会使用新工具"
