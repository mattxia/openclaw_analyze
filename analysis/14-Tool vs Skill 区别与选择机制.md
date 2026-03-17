# Tool vs Skill：区别与选择机制分析

## 一、核心概念对比

### 1.1 什么是 Tool（工具）？

**定义**：Tool 是 Agent 可以调用的**底层能力接口**，是 Agent 与外部世界交互的"手和脚"。

**特点**：
- ✅ **系统级能力**：由 Gateway 或插件直接提供
- ✅ **类型化接口**：有严格的参数 Schema 定义
- ✅ **直接执行**：调用后立即返回结果
- ✅ **无状态**：每次调用独立执行
- ✅ **编程式访问**：通过工具调用 API 执行

**示例**：
```typescript
// 文件：src/agents/tools/sessions-spawn-tool.ts
{
  name: "sessions_spawn",
  description: "Spawn an isolated session...",
  parameters: {
    task: "任务描述（必需）",
    label: "标签（可选）",
    agentId: "目标 Agent ID（可选）",
    model: "模型覆盖（可选）",
    ...
  },
  execute: async (toolCallId, args) => {
    // 直接执行逻辑
    const result = await spawnSubagentDirect(params, ctx);
    return jsonResult(result);
  }
}
```

**常见 Tools**：
| Tool | 功能 | 类型 |
|------|------|------|
| `read` | 读取文件 | 文件系统 |
| `write` | 写入文件 | 文件系统 |
| `exec` | 执行 shell 命令 | 运行时 |
| `web_search` | 搜索网络 | Web |
| `sessions_spawn` | 派生子 Agent | 会话管理 |
| `message` | 发送消息 | 消息传递 |
| `browser` | 浏览器操作 | 自动化 |

---

### 1.2 什么是 Skill（技能）？

**定义**：Skill 是**教 Agent 如何使用 Tools 的说明书**，是高层的任务执行指南。

**特点**：
- ✅ **知识封装**：包含任务场景、最佳实践、注意事项
- ✅ **自然语言**：用 Markdown 编写，Agent 可读
- ✅ **场景化**：告诉 Agent"什么时候用、怎么用、何时不用"
- ✅ **可组合**：一个 Skill 可以调用多个 Tools
- ✅ **声明式**：通过 YAML frontmatter 声明依赖和配置

**示例**：
```markdown
<!-- 文件：skills/github/SKILL.md -->
---
name: github
description: "GitHub operations via `gh` CLI"
metadata:
  {
    "openclaw": {
      "requires": { "bins": ["gh"] },
      "install": [
        { "id": "brew", "kind": "brew", "formula": "gh" }
      ]
    }
  }
---

# GitHub Skill

## When to Use（何时使用）

✅ **USE this skill when:**
- Checking PR status, reviews, or merge readiness
- Viewing CI/workflow run status and logs
- Creating, closing, or commenting on issues
- Creating or merging pull requests

❌ **DON'T use this skill when:**
- Local git operations (commit, push, pull, branch) → use `git` directly
- Non-GitHub repos (GitLab, Bitbucket, self-hosted) → different CLIs
- Cloning repositories → use `git clone`

## Setup

```bash
# Authenticate (one-time)
gh auth login

# Verify
gh auth status
```

## Common Commands

### Pull Requests
```bash
# List PRs
gh pr list --repo owner/repo

# Check CI status
gh pr checks 55 --repo owner/repo
```

### Issues
```bash
# List issues
gh issue list --repo owner/repo --state open
```
```

**关键点**：
- Skill **本身不执行任何操作**
- Skill **教 Agent 使用 Tools**（如 `exec` 工具执行 `gh` 命令）
- Skill 包含**领域知识**和**最佳实践**

---

## 二、本质区别对比表

| 维度 | Tool（工具） | Skill（技能） |
|------|-------------|--------------|
| **本质** | **能力接口**（API） | **知识封装**（说明书） |
| **形式** | TypeScript 代码 | Markdown 文档 |
| **执行** | 系统直接执行 | 指导 Agent 调用 Tools |
| **位置** | 系统代码中 | `skills/` 目录 |
| **依赖** | 无（或系统级依赖） | 可能依赖 Tools + 外部 CLI |
| **状态** | 无状态 | 无状态（但包含知识） |
| **类型** | 有类型 Schema | 自然语言 + YAML |
| **发现** | 系统注册 | 目录扫描 |
| **优先级** | 系统定义 | 工作区 > 托管 > 内置 |
| **示例** | `exec`, `read`, `web_search` | `github`, `discord`, `weather` |

---

## 三、形象比喻

```
┌─────────────────────────────────────────────────────────────┐
│                    工具箱 vs 使用手册                        │
└─────────────────────────────────────────────────────────────┘

Tool（工具） = 工具箱里的工具
┌─────────────────────────────────────────────────────────────┐
│  🔨 锤子（exec 工具）                                        │
│  🔧 扳手（read 工具）                                        │
│  🪚 锯子（write 工具）                                       │
│  📏 尺子（web_search 工具）                                  │
│                                                             │
│  特点：                                                      │
│  - 直接用来干活                                              │
│  - 每个工具有特定功能                                        │
│  - 需要知道怎么用                                            │
└─────────────────────────────────────────────────────────────┘

Skill（技能） = 使用手册/教程
┌─────────────────────────────────────────────────────────────┐
│  📖《GitHub 操作指南》                                        │
│  内容：                                                      │
│  - 什么时候用锤子（exec）敲击 gh 命令                        │
│  - 什么时候用尺子（web_search）搜索问题                      │
│  - 最佳实践和注意事项                                        │
│  - 常见命令模板                                              │
│                                                             │
│  特点：                                                      │
│  - 教你如何使用工具                                          │
│  - 包含领域知识和经验                                        │
│  - 告诉你"做什么"而不是"怎么做"                              │
└─────────────────────────────────────────────────────────────┘

用户任务："帮我检查这个 PR 的 CI 状态"

Agent 思考过程：
1. 阅读《GitHub 操作指南》（Skill）
   → "Check CI status: gh pr checks <number>"
   
2. 选择工具：
   → 需要使用 🔨 锤子（exec 工具）
   
3. 执行：
   → 调用 exec("gh pr checks 55 --repo owner/repo")
   
4. 返回结果给用户
```

---

## 四、系统如何加载和暴露

### 4.1 Tool 的加载机制

```typescript
// 文件：src/agents/tool-catalog.ts

// 1. 核心 Tools 预定义
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
  // ... 更多核心工具
];

// 2. 按 Profile 组织
export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

// 3. 系统启动时注册
// 文件：src/gateway/server.ts
const tools = createToolCatalog(cfg);
// → 创建所有启用的 Tools
// → 注册到 Gateway
// → 对 Agent 可见
```

**加载流程**：
```
系统启动
   ↓
加载配置 (openclaw.json)
   ↓
读取 tools.profile 设置
   ↓
根据 Profile 过滤 Tools
   ↓
应用 tools.allow / tools.deny
   ↓
注册到 Gateway
   ↓
Agent 启动时可用的 Tools 列表确定
```

---

### 4.2 Skill 的加载机制

```typescript
// 文件：src/agents/skills/workspace.ts

export function loadSkillEntries(
  workspaceDir: string,
  opts?: { config?: OpenClawConfig }
): SkillEntry[] {
  
  // 1. 从三个位置加载 Skills
  const bundledSkills = loadSkills({
    dir: bundledSkillsDir,
    source: "openclaw-bundled"  // 内置 Skills
  });
  
  const managedSkills = loadSkills({
    dir: managedSkillsDir,      // ~/.openclaw/skills
    source: "openclaw-managed"
  });
  
  const workspaceSkills = loadSkills({
    dir: workspaceSkillsDir,    // <workspace>/skills
    source: "openclaw-workspace"
  });
  
  // 2. 合并（优先级：workspace > managed > bundled）
  const allSkills = mergeSkills([
    bundledSkills,
    managedSkills,
    workspaceSkills
  ]);
  
  // 3. 门控过滤（加载时）
  const eligibleSkills = filterSkillEntries(
    allSkills,
    opts?.config,
    envVars,
    binaryPaths
  );
  
  // 4. 生成提示词
  const skillsPrompt = formatSkillsForPrompt(eligibleSkills);
  
  return { skills: eligibleSkills, prompt: skillsPrompt };
}
```

**加载流程**：
```
系统启动
   ↓
扫描 Skills 目录（3 个位置）
   ↓
解析 SKILL.md（YAML frontmatter + Markdown）
   ↓
门控检查（加载时过滤）：
  ├─ 检查二进制文件（requires.bins）
  ├─ 检查环境变量（requires.env）
  ├─ 检查配置项（requires.config）
  ├─ 检查操作系统（os）
  └─ 检查 API 密钥（apiKey）
   ↓
过滤不符合条件的 Skills
   ↓
生成 Skills 提示词
   ↓
注入到 Agent 系统提示词
```

---

### 4.3 门控机制详解

```typescript
// 文件：src/agents/skills/workspace.ts

// 门控配置示例（SKILL.md frontmatter）
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw": {
      "requires": {
        "bins": ["uv"],                      // 必需的二进制文件
        "env": ["GEMINI_API_KEY"],           // 必需的环境变量
        "config": ["browser.enabled"]        // 必需的配置项
      },
      "primaryEnv": "GEMINI_API_KEY",        // 主要环境变量
      "os": ["darwin", "linux"],             // 支持的操作系统
      "install": [                           // 安装器
        {
          "id": "brew",
          "kind": "brew",
          "formula": "uv",
          "bins": ["uv"]
        }
      ]
    }
  }
---

// 门控检查逻辑
function isSkillEligible(skill: Skill, config: OpenClawConfig): boolean {
  // 1. 检查 always 标志
  if (skill.metadata.openclaw.always) {
    return true;  // 始终可用
  }
  
  // 2. 检查操作系统
  if (skill.metadata.openclaw.os) {
    if (!skill.metadata.openclaw.os.includes(process.platform)) {
      return false;  // 当前 OS 不支持
    }
  }
  
  // 3. 检查二进制文件
  if (skill.metadata.openclaw.requires?.bins) {
    for (const bin of skill.metadata.openclaw.requires.bins) {
      if (!which(bin)) {
        return false;  // 二进制文件不存在
      }
    }
  }
  
  // 4. 检查环境变量
  if (skill.metadata.openclaw.requires?.env) {
    for (const env of skill.metadata.openclaw.requires.env) {
      if (!process.env[env] && !config.skills?.entries?.[skill.name]?.env?.[env]) {
        return false;  // 环境变量未设置
      }
    }
  }
  
  // 5. 检查配置项
  if (skill.metadata.openclaw.requires?.config) {
    for (const configPath of skill.metadata.openclaw.requires.config) {
      if (!getConfigValue(config, configPath)) {
        return false;  // 配置项未启用
      }
    }
  }
  
  return true;  // 所有检查通过
}
```

**门控结果**：
```
加载时检查：
├─ github Skill
│  ├─ requires.bins: ["gh"]
│  ├─ 检查：gh 是否在 PATH 中
│  └─ 结果：如果 gh 不存在 → 过滤掉（不可用）
│
├─ weather Skill
│  ├─ requires.env: ["WEATHER_API_KEY"]
│  ├─ 检查：环境变量或配置中是否有 API 密钥
│  └─ 结果：如果没有密钥 → 过滤掉（不可用）
│
└─ discord Skill
   ├─ requires.config: ["discord.enabled"]
   ├─ 检查：openclaw.json 中是否启用 Discord
   └─ 结果：如果未启用 → 过滤掉（不可用）
```

---

## 五、系统如何选择使用 Tool 还是 Skill

### 5.1 关键结论

**核心机制**：
> **Skill 教 Agent 何时使用哪些 Tools**

**选择流程**：
```
1. 系统启动
   ↓
2. 加载所有可用的 Tools（系统注册）
   ↓
3. 加载所有可用的 Skills（目录扫描 + 门控过滤）
   ↓
4. 构建系统提示词
   ├─ 注入 Tools 列表和描述
   └─ 注入 Skills 提示词（包含使用指南）
   ↓
5. Agent（LLM）接收提示词
   ↓
6. LLM 根据 Skills 的指南决定使用哪些 Tools
   ↓
7. LLM 调用选定的 Tools
```

---

### 5.2 实际示例：GitHub PR 检查

**场景**：用户问"帮我检查 PR #55 的 CI 状态"

**步骤 1：系统提示词构建**

```typescript
// 系统注入的 Tools 描述
TOOLS:
- exec: Run shell commands
- read: Read file contents
- web_search: Search the web
- ...

// 系统注入的 Skills 提示词
SKILLS:

## github
Use the `gh` CLI to interact with GitHub repositories, issues, PRs, and CI.

### When to Use
✅ USE this skill when:
- Checking PR status, reviews, or merge readiness
- Viewing CI/workflow run status and logs

### Common Commands
#### Pull Requests
```bash
# Check CI status
gh pr checks 55 --repo owner/repo
```
```

---

**步骤 2：LLM 思考过程**

```
LLM 接收提示词后思考：

用户："帮我检查 PR #55 的 CI 状态"

1. 检索 Skills 知识
   → 看到 github Skill 的说明
   → "Checking PR status, viewing CI status → 使用 github Skill"
   
2. 查找对应命令
   → github Skill 中说：
     "Check CI status: gh pr checks <number> --repo <repo>"
   
3. 选择 Tools
   → 需要执行 shell 命令
   → 选择 exec 工具
   
4. 构建工具调用
   → exec("gh pr checks 55 --repo owner/repo")
```

---

**步骤 3：执行流程**

```
LLM 决策：
[调用 exec 工具，command: "gh pr checks 55 --repo owner/repo"]
   ↓
Gateway 执行 exec 工具
   ↓
运行 shell 命令：gh pr checks 55 --repo owner/repo
   ↓
返回命令输出
   ↓
LLM 解析输出
   ↓
LLM 生成自然语言回复
   ↓
用户看到："PR #55 的 CI 状态：✅ 所有检查通过（3/3）"
```

---

### 5.3 对比：有 Skill vs 无 Skill

#### 场景 A：有 github Skill

```
系统提示词包含：
## github Skill
- 何时使用：Checking PR status, CI status
- 命令模板：gh pr checks <number>

LLM 决策：
→ 快速识别任务类型
→ 直接应用 Skill 中的命令模板
→ 调用 exec("gh pr checks 55 --repo owner/repo")
→ 准确、高效
```

#### 场景 B：无 github Skill

```
系统提示词只有：
TOOLS:
- exec: Run shell commands
- web_search: Search the web
- ...

LLM 决策：
→ 知道可以用 exec 工具
→ 但不知道具体命令格式
→ 可能尝试：
   - web_search("GitHub PR CI status API")
   - exec("curl https://api.github.com/...")
   - exec("gh pr checks 55")（可能缺少参数）
→ 效率低，可能出错
```

**Skill 的价值**：
- ✅ **加速决策**：LLM 不需要猜测
- ✅ **提高准确性**：提供经过验证的命令
- ✅ **最佳实践**：包含注意事项和边界情况
- ✅ **知识传承**：专家经验可以共享

---

## 六、进阶：Skill 如何调用多个 Tools

### 6.1 复杂 Skill 示例

```markdown
<!-- skills/coding-agent/SKILL.md -->
---
name: coding-agent
description: Complex coding tasks with sub-agent orchestration
---

# Coding Agent Skill

## Workflow

### 1. 分析任务
当用户提出复杂编码任务时：

1. 使用 `read` 工具读取相关文件
2. 理解代码结构和需求

### 2. 派生子 Agent
对于可以并行化的工作：

```
调用 sessions_spawn 工具：
{
  "task": "实现用户认证模块",
  "label": "auth-implementation",
  "model": "anthropic/claude-sonnet-4-20250514"
}
```

### 3. 执行代码
在子 Agent 中：

1. 使用 `write` 工具创建新文件
2. 使用 `exec` 工具运行测试
3. 使用 `read` 工具验证结果

### 4. 综合结果
主 Agent 收集所有子 Agent 结果，向用户汇报
```

**这个 Skill 调用的 Tools**：
1. `read` - 读取文件
2. `sessions_spawn` - 派生子 Agent
3. `write` - 写入文件
4. `exec` - 执行命令

**Skill 的作用**：
- 教 Agent **何时**调用每个 Tool
- 教 Agent **按什么顺序**调用
- 教 Agent **传递什么参数**

---

### 6.2 Skill 组合使用

```markdown
<!-- skills/dev-workflow/SKILL.md -->
---
name: dev-workflow
description: Complete development workflow from issue to deployment
---

# Dev Workflow Skill

## 完整流程

### 阶段 1: 需求分析
1. 使用 `github` Skill 读取 Issue 详情
2. 使用 `read` 工具查看相关代码

### 阶段 2: 开发实现
1. 使用 `coding-agent` Skill 实现功能
2. 使用 `exec` 运行测试

### 阶段 3: 代码审查
1. 使用 `diffs` Skill 生成 diff
2. 使用 `github` Skill 创建 PR

### 阶段 4: 部署
1. 使用 `exec` 部署到 staging
2. 使用 `web_search` 验证部署
```

**Skill 组合**：
- `github` Skill → 调用 `exec` 工具（gh 命令）
- `coding-agent` Skill → 调用 `sessions_spawn`, `read`, `write`, `exec`
- `diffs` Skill → 调用 `diffs` 工具
- `dev-workflow` Skill → 组合以上所有 Skills

**层级关系**：
```
dev-workflow Skill（高层流程）
   ├─ github Skill（GitHub 操作）
   │  └─ exec Tool（gh 命令）
   ├─ coding-agent Skill（编码实现）
   │  ├─ sessions_spawn Tool（派生子 Agent）
   │  ├─ read Tool（读取文件）
   │  ├─ write Tool（写入文件）
   │  └─ exec Tool（运行测试）
   └─ diffs Skill（生成 diff）
      └─ diffs Tool（diff 工具）
```

---

## 七、配置与覆盖

### 7.1 Tool 配置

```json5
// ~/.openclaw/openclaw.json
{
  "tools": {
    // 1. 设置 Tool Profile
    "profile": "coding",  // minimal | coding | messaging | full
    
    // 2. 全局允许/拒绝
    "allow": ["*"],       // 允许所有
    "deny": ["exec"],     // 但拒绝 exec
    
    // 3. 按 Provider 限制
    "byProvider": {
      "google-antigravity": {
        "profile": "minimal"  // Google 模型只能用 minimal
      }
    },
    
    // 4. 子 Agent 工具策略
    "subagents": {
      "tools": {
        "deny": ["gateway", "cron"],  // 子 Agent 不能用这些
        "allow": ["read", "exec"]     // 只能用这些（白名单）
      }
    }
  }
}
```

---

### 7.2 Skill 配置

```json5
// ~/.openclaw/openclaw.json
{
  "skills": {
    // 1. 启用/禁用特定 Skill
    "entries": {
      "github": {
        "enabled": true,
        "env": {
          "GH_TOKEN": "ghp_xxx"  // 注入环境变量
        }
      },
      "weather": {
        "enabled": false  // 禁用
      }
    },
    
    // 2. 额外 Skills 目录
    "load": {
      "extraDirs": [
        "~/my-skills",      // 自定义 Skills
        "/shared/skills"
      ]
    },
    
    // 3. API 密钥管理
    "apiKey": {
      "github": "ghp_xxx",  // 注入到 github Skill
      "weather": "wx_xxx"
    }
  }
}
```

---

### 7.3 优先级对比

| 配置项 | Tool | Skill |
|--------|------|-------|
| **启用/禁用** | `tools.allow` / `tools.deny` | `skills.entries.<name>.enabled` |
| **Profile** | `tools.profile` | 无（通过门控过滤） |
| **Provider 限制** | `tools.byProvider` | 无 |
| **环境变量** | 无 | `skills.entries.<name>.env` |
| **API 密钥** | 无 | `skills.apiKey` / `skills.entries.<name>.apiKey` |
| **额外目录** | 无 | `skills.load.extraDirs` |
| **优先级** | 系统定义 | workspace > managed > bundled |

---

## 八、调试与查看

### 8.1 查看可用的 Tools

```bash
# 查看当前会话可用的 Tools
# （通过系统提示词间接查看）

# 或在代码中查看
# 文件：src/agents/tool-catalog.ts
export const CORE_TOOL_DEFINITIONS: CoreToolDefinition[] = [...]
```

---

### 8.2 查看可用的 Skills

```bash
# 列出所有 Skills（包括状态）
openclaw skills list

# 只列出符合条件的 Skills
openclaw skills list --eligible

# 查看特定 Skill 详情
openclaw skills info github

# 检查 Skills 依赖
openclaw skills check
```

**输出示例**：
```
$ openclaw skills list

Skills:
  ✅ github          - GitHub operations via gh CLI
     Status: eligible
     Requires: gh (installed)
     
  ⚠️  weather         - Weather forecast
     Status: missing env
     Requires: WEATHER_API_KEY (not set)
     
  ❌ mac-notes       - Apple Notes integration
     Status: missing binary
     Requires: notes (not found in PATH)
```

---

## 九、总结

### 9.1 核心要点

| 问题 | 答案 |
|------|------|
| **Tool 是什么？** | **底层能力接口**（API），Agent 的"手和脚" |
| **Skill 是什么？** | **知识封装**（说明书），教 Agent 如何使用 Tools |
| **谁决定使用哪个？** | **LLM（Agent）**根据 Skills 的指南决定 |
| **系统如何暴露？** | Tools 系统注册，Skills 目录扫描 + 门控过滤 |
| **可以没有 Skill 吗？** | 可以，但 LLM 需要自己猜测如何使用 Tools |
| **可以没有 Tool 吗？** | 不可以，Tools 是执行的基础设施 |
| **优先级如何？** | Skills: workspace > managed > bundled |

---

### 9.2 关系图

```
┌─────────────────────────────────────────────────────────────┐
│                    完整的能力栈                              │
└─────────────────────────────────────────────────────────────┘

用户任务
   ↓
┌─────────────────────────────────────────────────────────────┐
│ Skill 层（知识/指南）                                        │
│ ┌─────────────┬─────────────┬─────────────┐                │
│ │ github      │ weather     │ coding-     │ ...            │
│ │ Skill       │ Skill       │ agent Skill │                │
│ │             │             │             │                │
│ │ 何时使用    │ 何时使用    │ 何时使用    │                │
│ │ 命令模板    │ API 调用    │ 工作流程    │                │
│ │ 注意事项    │ 参数说明    │ 最佳实践    │                │
│ └─────────────┴─────────────┴─────────────┘                │
│           │              │              │                   │
│           │ 指导         │ 指导         │ 指导              │
└───────────┼──────────────┼──────────────┼───────────────────┘
            │              │              │
            ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────┐
│ Tool 层（能力/接口）                                         │
│ ┌─────────┬─────────┬─────────┬─────────┬─────────┐        │
│ │ exec    │ read    │ write   │ web_    │ sessions│ ...    │
│ │         │         │         │ search  │ _spawn  │        │
│ │ 执行命令 │ 读文件  │ 写文件  │ 搜索    │ 派生子  │        │
│ │         │         │         │         │ Agent   │        │
│ └─────────┴─────────┴─────────┴─────────┴─────────┘        │
│           │              │              │                   │
│           │ 调用         │ 调用         │ 调用              │
└───────────┼──────────────┼──────────────┼───────────────────┘
            │              │              │
            ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────┐
│ 执行层（系统/基础设施）                                      │
│ - Shell 解释器                                               │
│ - 文件系统                                                   │
│ - HTTP 客户端                                                │
│ - Gateway 服务                                               │
└─────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│ 结果返回给用户                                               │
└─────────────────────────────────────────────────────────────┘
```

---

### 9.3 一句话总结

> **Tool 是 Agent 的"手和脚"（执行能力），Skill 是 Agent 的"大脑皮层"（知识经验），LLM 是"大脑"（决策中心）。**

- **Tool**：提供执行能力
- **Skill**：提供领域知识和最佳实践
- **LLM**：根据 Skill 的指南，决定使用哪些 Tools 来完成任务

**系统设计哲学**：
> "让专业的 Skill 教 LLM 如何正确地使用 Tools"
