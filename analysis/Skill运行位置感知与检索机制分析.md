# OpenClaw Skill 运行位置感知与检索机制分析

> 分析日期：2026-06-23
> 分析范围：skill 运行位置（sandbox vs gateway）的感知机制、availableOn 配置方案、skill 检索能力设计

---

## 目录

1. [现状分析：LLM 是否知道 skill 在哪里跑](#1-现状分析llm-是否知道-skill-在哪里跑)
2. [Skill 本身不携带运行位置信息](#2-skill-本身不携带运行位置信息)
3. [LLM 知道的是全局 sandbox 状态](#3-llm-知道的是全局-sandbox-状态)
4. [真正决定执行位置的是工具配置](#4-真正决定执行位置的是工具配置)
5. [方案设计：通过 openclaw.json 注入 availableOn](#5-方案设计通过-openclawjson-注入-availableon)
6. [Skill 检索问题：找不到合适 skill 怎么办](#6-skill-检索问题找不到合适-skill-怎么办)
7. [LLM 如何知道调用 exec 时传入 host 参数](#7-llm-如何知道调用-exec-时传入-host-参数)
8. [执行层硬阻断：host 切换限制](#8-执行层硬阻断host-切换限制)
9. [总结与建议](#9-总结与建议)

---

## 1. 现状分析：LLM 是否知道 skill 在哪里跑

### 结论

**LLM 不知道哪个 skill 在 sandbox 中跑，哪个在 gateway 进程中跑。**

### 核心发现

Skill 不是可执行代码，而是 SKILL.md 指令文件，指导 LLM 如何使用工具（如 exec、read、write）来完成任务。真正决定执行位置的是**工具的执行配置**，而非 skill 本身。

### 1.1 Skill 元数据中没有执行位置字段

[`src/agents/skills/types.ts`](file:///d:/prj/openclaw_analyze/src/agents/skills/types.ts) 中 `OpenClawSkillMetadata` 只有这些字段：

```typescript
export type OpenClawSkillMetadata = {
  always?: boolean;
  skillKey?: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  os?: string[];
  requires?: { bins?: string[]; anyBins?: string[]; env?: string[]; config?: string[] };
  install?: SkillInstallSpec[];
};
```

没有 `sandbox`、`host`、`runtime` 等执行位置相关的字段。

### 1.2 LLM 看到的 skill 信息只有三要素

[`src/agents/system-prompt.ts`](file:///d:/prj/openclaw_analyze/src/agents/system-prompt.ts) 中 `buildSkillsSection` 注入的格式是：

```xml
<available_skills>
  <skill>
    <name>github</name>
    <description>GitHub operations via gh CLI...</description>
    <location>~/.openclaw/skills/github/SKILL.md</location>
  </skill>
</available_skills>
```

`<location>` 是 SKILL.md 的**文件路径**，不是执行位置。LLM 只知道 skill 的名字、描述、和文件路径。

---

## 2. Skill 本身不携带运行位置信息

### 2.1 SKILL.md frontmatter 格式

SKILL.md 的 frontmatter 中 `metadata.openclaw` 块支持以下字段：

| 字段                 | 用途                   |
| -------------------- | ---------------------- |
| `always`             | 强制包含该 skill       |
| `emoji` / `homepage` | UI 展示                |
| `os`                 | 平台限制               |
| `requires.bins`      | 依赖的二进制           |
| `requires.env`       | 依赖的环境变量         |
| `requires.config`    | 依赖的配置项           |
| `primaryEnv`         | API Key 关联的环境变量 |
| `install`            | 安装器规格             |

**没有任何字段表示"这个 skill 的脚本在 sandbox 还是 gateway 执行"。**

### 2.2 Skill 是"说明书"不是"程序"

Skill 的本质是教 LLM 如何使用工具的文档。例如 `weather` skill 的 SKILL.md 内容是：

```bash
curl "wttr.in/London?format=3"
```

LLM 读到后会调用 `exec` 工具执行这条命令。命令在哪里执行，取决于 `exec` 工具的 `host` 参数和会话配置，与 skill 无关。

---

## 3. LLM 知道的是全局 sandbox 状态

[`src/agents/system-prompt.ts#L516-L561`](file:///d:/prj/openclaw_analyze/src/agents/system-prompt.ts#L516-L561) 中，当 sandbox 启用时，系统提示注入一个全局的 `## Sandbox` 段落：

```
## Sandbox
You are running in a sandboxed runtime (tools execute in Docker).
Some tools may be unavailable due to sandbox policy.
Sub-agents stay sandboxed (no elevated/host access)...
Sandbox container workdir: /workspace
...
```

这是一个**会话级别的全局声明**，告诉 LLM "当前所有工具执行都在 Docker 中"，而不是告诉它哪个 skill 在哪里跑。

### 3.1 LLM 知道的 vs 不知道的

| LLM 知道的                       | LLM 不知道的                      |
| -------------------------------- | --------------------------------- |
| 当前会话是否沙箱化（全局）       | 哪些 skill 适合 sandbox           |
| 当前可用的工具列表（已过滤）     | 某个 skill 的依赖是否在容器内存在 |
| exec 工具有 host 参数            | 某个 skill 会在哪里执行           |
| sandbox 容器工作目录             | skill 是否会因缺少依赖而失败      |
| workspace 访问模式（none/ro/rw） |                                   |

---

## 4. 真正决定执行位置的是工具配置

### 4.1 Sandbox 模式控制会话级隔离

`agents.defaults.sandbox.mode` 控制**何时**沙箱化：

- `"off"`：无沙箱
- `"non-main"`：仅非主会话沙箱化
- `"all"`：所有会话沙箱化

### 4.2 工具策略控制哪些工具能在 sandbox 中用

[`src/agents/sandbox/constants.ts`](file:///d:/prj/openclaw_analyze/src/agents/sandbox/constants.ts) 中：

```typescript
// sandbox 中允许的工具
export const DEFAULT_TOOL_ALLOW = [
  "exec",
  "process",
  "read",
  "write",
  "edit",
  "apply_patch",
  "image",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "session_status",
];

// sandbox 中禁止的工具（只能在 gateway 主机进程运行）
export const DEFAULT_TOOL_DENY = [
  "browser",
  "canvas",
  "nodes",
  "cron",
  "gateway",
  ...CHANNEL_IDS, // whatsapp, telegram, signal 等
];
```

这些工具**只能在 gateway 主机进程上运行**，sandbox 中不可用。LLM 通过"工具列表中看不到这些工具"来间接感知。

### 4.3 exec 工具的 host 参数

[`src/agents/bash-tools.exec-runtime.ts#L191-L194`](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts#L191-L194) 中，exec 工具暴露 `host` 参数给 LLM：

```typescript
host: Type.Optional(Type.String({
  description: "Exec host (sandbox|gateway|node).",
})),
```

但这是**命令执行位置**，不是 skill 执行位置。而且非提权请求不能随意切换 host。

### 4.4 Skill 在 sandbox 中的适配机制

| 机制         | 代码位置                                                                                                                             | 说明                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 二进制检查   | [`docs/tools/skills.md`](file:///d:/prj/openclaw_analyze/docs/tools/skills.md)                                                       | `requires.bins` 在主机上检查；sandbox 还需容器内有该二进制              |
| Skill 同步   | [`src/agents/skills/workspace.ts#L710`](file:///d:/prj/openclaw_analyze/src/agents/skills/workspace.ts#L710) `syncSkillsToWorkspace` | 将符合条件的 skill 镜像到 sandbox 工作区                                |
| API 密钥注入 | [`docs/gateway/sandboxing.md`](file:///d:/prj/openclaw_analyze/docs/gateway/sandboxing.md)                                           | sandbox exec 不继承主机 `process.env`，需通过 `sandbox.docker.env` 注入 |

---

## 5. 方案设计：通过 openclaw.json 注入 availableOn

### 核心原则

**不碰 SKILL.md、不碰 skill 解析逻辑。** `availableOn` 由操作者在 `openclaw.json` 中声明，运行时读取并注入 system prompt。

### 5.1 数据流

```
openclaw.json  (操作者配置)
  skills.entries.<name>.availableOn: "sandbox" | "gateway" | "both"
        │
        ▼
config/types.skills.ts  (SkillConfig 增加字段)
        │
        ▼
workspace.ts  resolveWorkspaceSkillPromptState()
  ├─ 对每个 eligible skill，查 config 中的 availableOn
  └─ 在 formatSkillsForPrompt() 输出后追加 <skill_runtime> XML
        │
        ▼
system-prompt.ts  buildSkillsSection()
  └─ 增加指导文本，告知 LLM 如何使用 <available_on>
        │
        ▼
LLM 看到 <skill_runtime> 后，exec 时选择正确的 host
```

### 5.2 涉及文件与改动点（3 个文件）

#### 文件 1：`src/config/types.skills.ts` — 配置类型

在 `SkillConfig` 中增加字段：

```typescript
export type SkillConfig = {
  enabled?: boolean;
  apiKey?: SecretInput;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
  /** Declares where this skill's scripts/tools execute. Surfaces in the system prompt. */
  availableOn?: "sandbox" | "gateway" | "both";
};
```

操作者配置示例：

```json5
{
  skills: {
    entries: {
      github: { availableOn: "gateway" }, // gh CLI 在主机上
      weather: { availableOn: "sandbox" }, // curl 在容器内
      gemini: { availableOn: "both" }, // 两边都行
    },
  },
}
```

#### 文件 2：`src/agents/skills/workspace.ts` — Prompt 构建

在 `resolveWorkspaceSkillPromptState` 函数中，现有逻辑：

```typescript
const prompt = [
  remoteNote,
  truncationNote,
  formatSkillsForPrompt(compactSkillPaths(skillsForPrompt)),
]
  .filter(Boolean)
  .join("\n");
```

改为追加 `<skill_runtime>` XML 段落：

```typescript
const skillsPromptBlock = formatSkillsForPrompt(compactSkillPaths(skillsForPrompt));
const runtimeBlock = buildSkillRuntimeBlock(promptEntries, opts?.config);
const prompt = [remoteNote, truncationNote, skillsPromptBlock, runtimeBlock]
  .filter(Boolean)
  .join("\n");
```

新增 `buildSkillRuntimeBlock` 函数：

```typescript
function buildSkillRuntimeBlock(entries: SkillEntry[], config?: OpenClawConfig): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const skillKey = resolveSkillKey(entry.skill, entry);
    const skillConfig = resolveSkillConfig(config, skillKey);
    const availableOn = skillConfig?.availableOn;
    if (!availableOn) continue; // 未声明则不列出，节省 token
    lines.push(`<skill name="${entry.skill.name}" available_on="${availableOn}" />`);
  }
  if (lines.length === 0) return "";
  return `<skill_runtime>\n${lines.join("\n")}\n</skill_runtime>`;
}
```

关键点：

- 只列出**配置了 `availableOn` 的 skill**，未配置的不出现（零 token 开销）
- 信息来自 `resolveSkillConfig(config, skillKey)`，与现有 `enabled`/`env` 读取路径一致

#### 文件 3：`src/agents/system-prompt.ts` — 指导文本

在 `buildSkillsSection` 中追加一行：

```typescript
"- <skill_runtime> indicates where each skill's commands execute (sandbox/gateway). When calling exec, set host accordingly; if unavailable, fall back to the session default.",
```

### 5.3 不需要改动的文件

| 文件                               | 原因                                  |
| ---------------------------------- | ------------------------------------- |
| `skills/*/SKILL.md`                | skill 文件本身不改                    |
| `src/agents/skills/types.ts`       | skill 元数据类型不改                  |
| `src/agents/skills/frontmatter.ts` | 解析逻辑不改                          |
| `src/agents/skills/config.ts`      | `resolveSkillConfig` 已存在，直接复用 |

### 5.4 LLM 最终看到的效果

```xml
<available_skills>
  <skill>
    <name>github</name>
    <description>GitHub operations via gh CLI...</description>
    <location>~/.openclaw/skills/github/SKILL.md</location>
  </skill>
  <skill>
    <name>weather</name>
    <description>Get weather via wttr.in...</description>
    <location>~/.openclaw/skills/weather/SKILL.md</location>
  </skill>
</available_skills>

<skill_runtime>
<skill name="github" available_on="gateway" />
<skill name="weather" available_on="sandbox" />
</skill_runtime>
```

### 5.5 需要注意的点

1. **exec 的 host 切换限制**：非提权请求切换 host 会抛错（见第 8 节）。`availableOn` 是提示性信息，实际仍受 `tools.exec.host` 配置约束。

2. **sandbox 工具策略对齐**：`DEFAULT_TOOL_DENY` 禁止 `browser`/`cron`/`gateway` 等工具在 sandbox 中使用。操作者配置 `availableOn` 时应与这些策略对齐。

3. **token 开销**：每个声明了 `availableOn` 的 skill 额外约 50 字符。未声明的 skill 零开销。

---

## 6. Skill 检索问题：找不到合适 skill 怎么办

### 6.1 现状：纯被动注入，无检索能力

OpenClaw **当前没有 `skill_search` 工具**。分析文档中提到的 `skill_search`/`similarity.ts`/`skill-search.ts` 是设计构想，源码中不存在。

现有的完整链路：

```
会话启动
  → loadSkillEntries() 加载全部 skill（bundled + managed + workspace）
  → shouldIncludeSkill() 门控过滤（检查 bins/env/config/os）
  → applySkillsPromptLimits() 截断（默认 max 150 个 / 30K 字符）
  → formatSkillsForPrompt() 生成 <available_skills> XML
  → 注入 system prompt
```

LLM 能做的只有：

1. 扫描 `<available_skills>` 中的 `<description>`，找最匹配的
2. 找到后 `read` SKILL.md，按指引调用工具
3. 找不到时（system-prompt.ts 原文）：`"If none clearly apply: do not read any SKILL.md."` → 直接用已有工具回答

### 6.2 核心瓶颈

| 问题             | 说明                                                      |
| ---------------- | --------------------------------------------------------- |
| 无检索工具       | LLM 无法按关键词搜索 skill，只能扫描注入的列表            |
| 截断盲区         | `maxSkillsInPrompt=150`，超出部分 LLM 完全看不到          |
| description 太短 | 每个 skill 只有 frontmatter 中的 `description` 一行       |
| 无语义匹配       | 纯靠 LLM 读 description 做匹配，没有 embedding/相似度计算 |

### 6.3 三个解决方案

#### 方案 1：不新增工具，优化现有注入（最小改动）

适合 skill 数量 < 150 的场景（当前默认）。

- 在 `<skill_runtime>` 中补充 `availableOn` 信息
- 在 system-prompt 中增加兜底提示
- 本质上承认"找不到就用工具硬干"

#### 方案 2：新增 `skills_list` 工具，让 LLM 主动查询（中等改动）

给 LLM 一个只读工具，列出所有 eligible skill 的完整列表（不受 150 截断限制）。

| 改动文件                       | 内容                                |
| ------------------------------ | ----------------------------------- |
| `src/agents/openclaw-tools.ts` | 新增 `createSkillsListTool()`       |
| `src/agents/system-prompt.ts`  | 提示 LLM 在截断时调用 `skills_list` |

工具 schema：

```typescript
{
  name: "skills_list",
  description: "List all eligible skills with descriptions and runtime location.",
  parameters: { query: Type.Optional(Type.String({ description: "Optional keyword filter" })) }
}
```

#### 方案 3：新增 `skill_search` 工具 + 语义检索（较大改动）

适合 skill 数量上百上千的场景。

| 改动文件                            | 内容                                  |
| ----------------------------------- | ------------------------------------- |
| `src/agents/skills/similarity.ts`   | 新增：用 embedding 模型计算语义相似度 |
| `src/agents/skills/skill-search.ts` | 新增：`skill_search(query)` 工具实现  |
| `src/agents/openclaw-tools.ts`      | 注册 `skill_search` 工具              |
| `src/agents/system-prompt.ts`       | 提示 LLM 调用 `skill_search`          |

**embedding 来源选择：**

- 本地轻量模型（如 `bge-small-zh`）——无需网络，但增加依赖
- 调用 LLM provider 的 embedding API——无新依赖，但增加延迟和成本
- 预计算缓存：会话启动时对所有 skill description 计算 embedding 并缓存

返回示例：

```json
{
  "results": [
    {
      "name": "weather",
      "description": "...",
      "location": "...",
      "availableOn": "sandbox",
      "score": 0.92
    },
    {
      "name": "camsnap",
      "description": "...",
      "location": "...",
      "availableOn": "gateway",
      "score": 0.71
    }
  ]
}
```

### 6.4 推荐路径

| 阶段 | 方案                   | 适用场景                                         |
| ---- | ---------------------- | ------------------------------------------------ |
| 短期 | 方案 1 + `availableOn` | skill < 150，靠截断内 description 足够           |
| 中期 | 方案 2                 | skill 超过截断限制，或 LLM 频繁找不到匹配        |
| 长期 | 方案 3                 | skill 生态大规模增长（ClawHub 上架数百个 skill） |

---

## 7. LLM 如何知道调用 exec 时传入 host 参数

### 7.1 三个信息通道

假设按方案三实施，LLM 通过**三个独立通道**获取信息并完成关联：

#### 通道 1：exec 工具的 JSON Schema（告诉 LLM 参数存在）

[`src/agents/bash-tools.exec-runtime.ts#L191-L194`](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts#L191-L194)：

```typescript
host: Type.Optional(Type.String({
  description: "Exec host (sandbox|gateway|node).",
})),
```

这个 schema 会作为 function definition 发给 LLM。LLM 从 schema 中知道：**exec 有一个 `host` 参数，可选值是 `sandbox`/`gateway`/`node`**。

#### 通道 2：skill_search 返回结果（告诉 LLM 该用哪个值）

```json
{
  "results": [{ "name": "weather", "availableOn": "sandbox", "score": 0.92 }]
}
```

LLM 从返回结果中知道：**weather 这个 skill 应该在 sandbox 中跑**。

#### 通道 3：System Prompt 指导文本（把两者关联起来）

在 `buildSkillsSection` 中需要加的指导文本：

```
- <skill_runtime> / skill_search results include available_on (sandbox|gateway|both).
  When calling exec for a skill, set host to match its available_on.
```

这条文本是**桥梁**——让 LLM 把 `availableOn` 的值和 exec 的 `host` 参数关联起来。

### 7.2 完整决策链

```
用户："查一下北京天气"
       │
       ▼
① LLM 扫描 <available_skills>，没找到匹配
       │
       ▼
② LLM 调用 skill_search("天气")
       │
       ▼  返回 { name: "weather", availableOn: "sandbox" }
       │
       ▼
③ LLM 调用 read("~/.openclaw/skills/weather/SKILL.md")
       │
       ▼  SKILL.md 内容: curl "wttr.in/Beijing?format=3"
       │
       ▼
④ LLM 调用 exec(command: 'curl "wttr.in/Beijing?format=3"', host: "sandbox")
                                                      ▲
                                                      │
                              host="sandbox" 来自三个信息的组合：
                              - exec schema 告诉 LLM 有 host 参数
                              - skill_search 告诉 LLM weather 的 availableOn="sandbox"
                              - system prompt 告诉 LLM 要把 availableOn 映射到 host
```

---

## 8. 执行层硬阻断：host 切换限制

### 8.1 问题

LLM 确实**知道**要传 `host="sandbox"`，也确实会**传**这个值。但 [`src/agents/bash-tools.exec.ts#L432-L441`](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts#L432-L441) 有硬性限制：

```typescript
const configuredHost = defaults?.host ?? "sandbox"; // 配置的默认 host
const requestedHost = normalizeExecHost(params.host) ?? null; // LLM 请求的 host
let host: ExecHost = requestedHost ?? configuredHost;

// 非提权请求不能切换 host
if (!elevatedRequested && requestedHost && requestedHost !== configuredHost) {
  throw new Error(
    `exec host not allowed (requested ${renderExecHostLabel(requestedHost)}; ` +
      `configure tools.exec.host=${renderExecHostLabel(configuredHost)} to allow).`,
  );
}

// 提权请求强制使用 gateway host
if (elevatedRequested) {
  host = "gateway";
}
```

### 8.2 各场景下的执行结果

| 场景           | configuredHost | LLM 传的 host | 结果                            |
| -------------- | -------------- | ------------- | ------------------------------- |
| sandbox 已启用 | `"sandbox"`    | `"sandbox"`   | ✅ 正常执行                     |
| sandbox 已启用 | `"sandbox"`    | `"gateway"`   | ❌ 抛错 `exec host not allowed` |
| sandbox 已启用 | `"sandbox"`    | 不传          | ✅ 用 configuredHost            |
| sandbox 未启用 | `"gateway"`    | `"gateway"`   | ✅ 正常执行                     |
| sandbox 未启用 | `"gateway"`    | `"sandbox"`   | ❌ 抛错 `exec host not allowed` |
| sandbox 未启用 | `"gateway"`    | 不传          | ✅ 用 configuredHost            |

### 8.3 核心矛盾

`availableOn` 告诉 LLM 某个 skill 该在 `gateway` 跑，但如果会话配置了 `tools.exec.host=sandbox`，LLM 传 `host="gateway"` 会被拒绝。

这意味着 `availableOn` 只能是**提示性信息**，不能真正驱动执行位置切换。

### 8.4 要让 availableOn 真正生效的可能方向

要让 `availableOn` 真正生效，需要放宽 host 切换限制——至少允许 LLM 根据 skill 声明的 `availableOn` 切换 host。但这涉及安全性评估，因为 host 切换限制本身就是防止 LLM 逃逸沙箱的安全措施。

可能的折中方案：

1. **配置级白名单**：操作者在 `skills.entries.<name>.availableOn` 中声明的值，自动加入 exec host 允许列表
2. **会话级策略**：sandbox 会话中，仅允许 `availableOn="gateway"` 的 skill 切换到 gateway 执行
3. **审批机制**：LLM 根据 `availableOn` 请求切换 host 时，走现有的 exec approvals 审批流程

---

## 9. 总结与建议

### 9.1 信息感知 vs 执行控制

| 层面         | 现状                               | 方案三实施后                                    |
| ------------ | ---------------------------------- | ----------------------------------------------- |
| **信息感知** | LLM 不知道 skill 运行位置          | ✅ LLM 通过 `availableOn` + `skill_search` 知道 |
| **参数传递** | exec schema 已暴露 host 参数       | ✅ LLM 能正确传递 host 值                       |
| **执行控制** | host 切换被 `tools.exec.host` 锁死 | ❌ 仍受限制，需额外放宽                         |

### 9.2 建议的实施顺序

1. **先做信息层**：`availableOn` 配置 + `<skill_runtime>` 注入 + system prompt 指导文本
2. **再做检索层**：`skill_search` 工具 + embedding 语义匹配
3. **最后做执行层**：评估并放宽 host 切换限制，让 `availableOn` 真正驱动执行位置

### 9.3 设计哲学

OpenClaw 的设计是在**工具层面**控制执行位置，而不是在 skill 层面。`availableOn` 方案的本质是**在操作者配置和 LLM 感知之间架一座桥**，让 LLM 有足够的信息做出正确决策，但最终的安全边界仍由工具配置和 exec 策略守住。

---

## 参考文件

| 文件                                                                                                                             | 职责                                       |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [`src/agents/skills/types.ts`](file:///d:/prj/openclaw_analyze/src/agents/skills/types.ts)                                       | Skill 元数据类型定义                       |
| [`src/agents/skills/frontmatter.ts`](file:///d:/prj/openclaw_analyze/src/agents/skills/frontmatter.ts)                           | SKILL.md frontmatter 解析                  |
| [`src/agents/skills/workspace.ts`](file:///d:/prj/openclaw_analyze/src/agents/skills/workspace.ts)                               | Skill 加载、过滤、prompt 构建              |
| [`src/agents/skills/config.ts`](file:///d:/prj/openclaw_analyze/src/agents/skills/config.ts)                                     | Skill 配置读取与门控                       |
| [`src/agents/system-prompt.ts`](file:///d:/prj/openclaw_analyze/src/agents/system-prompt.ts)                                     | 系统提示构建（Skills 段落 + Sandbox 段落） |
| [`src/agents/sandbox/constants.ts`](file:///d:/prj/openclaw_analyze/src/agents/sandbox/constants.ts)                             | Sandbox 工具允许/禁止列表                  |
| [`src/agents/sandbox/tool-policy.ts`](file:///d:/prj/openclaw_analyze/src/agents/sandbox/tool-policy.ts)                         | Sandbox 工具策略解析                       |
| [`src/agents/sandbox/context.ts`](file:///d:/prj/openclaw_analyze/src/agents/sandbox/context.ts)                                 | Sandbox 上下文创建                         |
| [`src/agents/bash-tools.exec-runtime.ts`](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts)                 | exec 工具 schema 定义                      |
| [`src/agents/bash-tools.exec.ts`](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts)                                 | exec 工具实现（host 路由逻辑）             |
| [`src/config/types.skills.ts`](file:///d:/prj/openclaw_analyze/src/config/types.skills.ts)                                       | SkillConfig 类型定义                       |
| [`src/agents/pi-embedded-runner/sandbox-info.ts`](file:///d:/prj/openclaw_analyze/src/agents/pi-embedded-runner/sandbox-info.ts) | Sandbox 信息构建（注入 system prompt）     |
