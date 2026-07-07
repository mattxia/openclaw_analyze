# OpenClaw Skill 与内置 Tool 调用关系分析

## 概述

本文档分析 OpenClaw 中 Skill 系统与内置 Tool 系统之间的调用关系，回答以下核心问题：

1. OpenClaw 当前内置了哪些 Tool？
2. Skill 能否调用这些内置 Tool？以何种方式调用？
3. Skill 中的 bash/python 脚本能否调用内置 Tool？

---

## 一、OpenClaw 内置 Tool 完整清单

通过源码追踪 `createOpenClawCodingTools()`（`src/agents/pi-tools.ts:593-675`）的最终工具组装，内置 Tool 分为 4 层，共 **25 个**。

### 第一层：文件系统工具（来自 pi-coding-agent，经 OpenClaw 增强）

| Tool 名 | 功能                                 | 源码位置                                                     |
| ------- | ------------------------------------ | ------------------------------------------------------------ |
| `read`  | 读取文件内容（支持图片、自适应分页） | pi-coding-agent `codingTools`，经 `pi-tools.ts:476-501` 包装 |
| `write` | 写入文件                             | pi-coding-agent `codingTools`，经 `pi-tools.ts:509-518` 包装 |
| `edit`  | 编辑文件（增量替换）                 | pi-coding-agent `codingTools`，经 `pi-tools.ts:520-529` 包装 |

> **注意**：pi-coding-agent 的 `codingTools` 原始包含 `bash` 工具，但在 `pi-tools.ts:504-507` 被过滤掉，由 OpenClaw 自己的 `exec` 工具替代。
>
> ```typescript
> // 过滤掉上游的bash/exec工具，后面单独创建OpenClaw专属的exec工具
> if (tool.name === "bash" || tool.name === execToolName) {
>   return [];
> }
> ```

### 第二层：运行时工具（OpenClaw 原生）

| Tool 名       | 功能                                                  | 源码位置                                                       |
| ------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `exec`        | 执行 shell 命令（支持沙箱、后台、审批、节点远程执行） | `src/agents/bash-tools.exec.ts:276`                            |
| `process`     | 管理后台 exec 会话（list/poll/log/write/kill/clear）  | `src/agents/bash-tools.process.ts:203`                         |
| `apply_patch` | 结构化多文件补丁（实验性，仅 OpenAI 模型）            | `src/agents/apply-patch.ts`，经 `pi-tools.ts:580-591` 条件创建 |

### 第三层：OpenClaw 扩展工具（`createOpenClawTools`）

这是 `src/agents/openclaw-tools.ts:139-217` 中组装的核心工具集：

| Tool 名            | 功能                                                                    | 源码文件                                    |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------------- |
| `browser`          | 浏览器自动化（start/stop/snapshot/act/screenshot/navigate...）          | `src/agents/tools/browser-tool.ts`          |
| `canvas`           | 驱动 node Canvas（present/eval/snapshot/a2ui）                          | `src/agents/tools/canvas-tool.ts`           |
| `nodes`            | 节点发现与控制（status/run/camera/screen/notify/location...）           | `src/agents/tools/nodes-tool.ts`            |
| `cron`             | 定时任务管理（add/list/run/update/remove/wake）                         | `src/agents/tools/cron-tool.ts`             |
| `message`          | 跨渠道消息（send/poll/react/pin/thread/search/timeout...）              | `src/agents/tools/message-tool.ts`          |
| `tts`              | 文本转语音                                                              | `src/agents/tools/tts-tool.ts`              |
| `gateway`          | Gateway 管理（restart/config.get/config.apply/config.patch/update.run） | `src/agents/tools/gateway-tool.ts`          |
| `agents_list`      | 列出可被 spawn 的 agent                                                 | `src/agents/tools/agents-list-tool.ts`      |
| `sessions_list`    | 列出会话                                                                | `src/agents/tools/sessions-list-tool.ts`    |
| `sessions_history` | 查看会话历史记录                                                        | `src/agents/tools/sessions-history-tool.ts` |
| `sessions_send`    | 向另一会话发消息（ping-pong）                                           | `src/agents/tools/sessions-send-tool.ts`    |
| `sessions_yield`   | 让出控制权（交回给调用方）                                              | `src/agents/tools/sessions-yield-tool.ts`   |
| `sessions_spawn`   | 启动子 agent 运行                                                       | `src/agents/tools/sessions-spawn-tool.ts`   |
| `subagents`        | 子 agent 管理                                                           | `src/agents/tools/subagents-tool.ts`        |
| `session_status`   | 查看/设置会话状态与模型                                                 | `src/agents/tools/session-status-tool.ts`   |
| `web_search`       | 网页搜索（Perplexity/Brave/Gemini/Grok/Kimi）                           | `src/agents/tools/web-search.ts`            |
| `web_fetch`        | 抓取 URL 内容转 markdown/text                                           | `src/agents/tools/web-fetch.ts`             |
| `image`            | 用图像模型分析图片                                                      | `src/agents/tools/image-tool.ts`            |
| `pdf`              | 分析 PDF 文档                                                           | `src/agents/tools/pdf-tool.ts`              |

### 第四层：插件槽位工具（通过 `resolvePluginTools` 注入）

这些 Tool 不在 `createOpenClawTools` 的硬编码列表中，而是通过插件 slot 机制在 `openclaw-tools.ts:219-238` 动态注入：

| Tool 名         | 功能                                     | 源码文件                              |
| --------------- | ---------------------------------------- | ------------------------------------- |
| `memory_search` | 语义搜索记忆（MEMORY.md + memory/\*.md） | `src/agents/tools/memory-tool.ts:86`  |
| `memory_get`    | 获取指定记忆条目                         | `src/agents/tools/memory-tool.ts:139` |

### 汇总

```
文件系统(3):  read, write, edit
运行时(3):    exec, process, apply_patch(实验性)
扩展工具(19): browser, canvas, nodes, cron, message, tts, gateway,
              agents_list, sessions_list, sessions_history, sessions_send,
              sessions_yield, sessions_spawn, subagents, session_status,
              web_search, web_fetch, image, pdf
插件槽位(2):  memory_search, memory_get
──────────────────────────────────
合计: 25 个内置 Tool
```

### 工具分组（用于 `tools.allow`/`tools.deny` 策略）

| 分组               | 包含的 Tool                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `group:runtime`    | `exec`, `bash`(已过滤,仅策略兼容), `process`                                             |
| `group:fs`         | `read`, `write`, `edit`, `apply_patch`                                                   |
| `group:sessions`   | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status` |
| `group:memory`     | `memory_search`, `memory_get`                                                            |
| `group:web`        | `web_search`, `web_fetch`                                                                |
| `group:ui`         | `browser`, `canvas`                                                                      |
| `group:automation` | `cron`, `gateway`                                                                        |
| `group:messaging`  | `message`                                                                                |
| `group:nodes`      | `nodes`                                                                                  |

### 不属于内置的 Tool（需额外安装插件）

- **Lobster**：可恢复审批的工作流运行时（需 Lobster CLI）
- **LLM Task**：JSON-only LLM 结构化输出步骤
- **Diffs**：只读 diff 查看器/PNG/PDF 渲染器
- 各消息渠道插件自带的 Tool

---

## 二、Skill 能否调用内置 Tool？

需要区分两个层面来回答。

### 层面一：Agent 在使用 skill 时直接调用内置 Tool（主要方式）

**能，且是直接调用。** Skill 的 `SKILL.md` 指令注入 system prompt 后，agent 可以直接调用全部 25 个内置 Tool——走的是模型原生的 function calling 机制，直接 `tool.execute()`，不需要经过任何 CLI/HTTP/RPC 中转。

```
用户消息 → Agent 加载 skill 指令 → Agent 决定调用哪个 tool → 直接 tool.execute() → 返回结果
```

Skill 只是告诉 agent "该用哪个 tool、怎么用"，不改变 tool 的调用方式。例如 skill 里写：

```markdown
## 使用方式

1. 用 `web_search` 搜索相关内容
2. 用 `browser` 打开搜索结果
3. 用 `read` 读取本地文件对比
4. 用 `message` 将结果发送到 Telegram
```

Agent 会直接发起这些 tool call，跟没有 skill 时调用 tool 的路径完全一样。

### 层面二：Skill 中的 bash/python 脚本调用内置 Tool（间接方式）

Skill 可以包含 `scripts/` 目录，但其中的 bash/python 脚本就是普通脚本，没有特权 API。它们只能通过外部接口回调用内置 Tool。

#### 通道 1：Shell 调用 Tool 专属 CLI 命令（最常见）

许多内置 Tool 都有对应的 CLI 子命令，脚本可直接 shell 调用：

| 内置 Tool                   | 等价 CLI 命令                                | 代码位置                                             |
| --------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| `message`                   | `openclaw message send/poll/react...`        | `src/cli/program/message/register.send.ts`           |
| `cron`                      | `openclaw cron add/list/run/status`          | `src/cli/cron-cli/register.ts`                       |
| `nodes` / `exec` / `canvas` | `openclaw nodes invoke/run/canvas/camera...` | `src/cli/nodes-cli/register.ts`                      |
| `browser`                   | `openclaw browser start/snapshot/act...`     | `src/cli/browser-cli.ts`                             |
| `sessions`（部分）          | `openclaw sessions` / `sessions cleanup`     | `src/cli/program/register.status-health-sessions.ts` |

已有 skill 实践：

- `skills/healthcheck/SKILL.md` 指导 agent 跑 `openclaw security audit`、`openclaw cron add`
- `skills/node-connect/SKILL.md` 跑 `openclaw nodes status`、`openclaw qr`

#### 通道 2：通用 Gateway RPC 桥（`openclaw gateway call`）

`src/cli/gateway-cli/register.ts:114-137` 注册了通用 RPC 调用命令：

```bash
openclaw gateway call cron.list --json
openclaw gateway call node.invoke --params '{"nodeId":"...","command":"system.run","params":{...}}' --json
openclaw gateway call sessions.list --params '{"agentId":"main"}' --json
```

允许脚本调用任意 gateway RPC 方法（`cron.*`、`node.*`、`sessions.*`、`browser.request`、`tools.catalog` 等）。

#### 通道 3：HTTP `/tools/invoke` 端点（唯一"按 tool 名直接调用"的通用接口）

这是脚本里最直接调用任意内置 Tool 的方式，见 `src/gateway/tools-invoke-http.ts:136-359`：

```bash
curl -X POST http://127.0.0.1:18789/tools/invoke \
  -H "Authorization: Bearer <gateway-token>" \
  -H "Content-Type: application/json" \
  -d '{"tool":"web_search","args":{"query":"openclaw ai"}}'
```

工作原理（`tools-invoke-http.ts:251-341`）：

1. Bearer token 鉴权（`authorizeHttpGatewayConnect`）
2. `createOpenClawTools()` 构建完整工具列表（核心 + 插件）
3. 应用 tool policy 过滤（profile/allow/deny/group）
4. 找到 `body.tool` 对应的 tool，调用 `tool.execute(toolCallId, args)`

可调用所有内置 Tool，包括无专属 CLI 的 `web_search`/`web_fetch`/`pdf`/`image`/`sessions_spawn` 等。需 gateway token 和 HTTP 访问。

#### 通道 4：`command-dispatch: tool`（frontmatter，仅限消息渠道斜杠命令）

在 `SKILL.md` frontmatter 写 `command-dispatch: tool` + `command-tool: <name>`（见 `src/agents/skills/types.ts:40-49`），当用户在消息渠道输入 `/<command> <args>` 时，系统绕过 LLM，直接 `tool.execute()`（见 `src/auto-reply/reply/get-reply-inline-actions.ts:206-248`）。

```typescript
// src/agents/skills/types.ts:40-49
export type SkillCommandDispatchSpec = {
  kind: "tool";
  /** Name of the tool to invoke (AnyAgentTool.name). */
  toolName: string;
  argMode?: "raw";
};
```

```typescript
// src/auto-reply/reply/get-reply-inline-actions.ts:206-248
const dispatch = skillInvocation.command.dispatch;
if (dispatch?.kind === "tool") {
  const tools = createOpenClawTools({ ... });
  const tool = authorizedTools.find((c) => c.name === dispatch.toolName);
  const result = await tool.execute(toolCallId, {
    command: rawArgs,
    commandName: skillInvocation.command.name,
    skillName: skillInvocation.command.skillName,
  } as any);
}
```

但这是消息输入触发的，不是脚本可触发的，且仓库现有 skill 没人用它（只有测试覆盖）。

---

## 三、各内置 Tool 的脚本可调用性汇总

| 内置 Tool                 |           专属 CLI？           |  gateway call RPC？  | HTTP /tools/invoke？ |
| ------------------------- | :----------------------------: | :------------------: | :------------------: |
| `read` / `write` / `edit` |               否               |          否          |          是          |
| `exec`（本地）            |               否               |          否          |          是          |
| `exec`（远程节点）        |    是 `openclaw nodes run`     |   是 `node.invoke`   |          是          |
| `process`                 |               否               |          否          |          是          |
| `apply_patch`             |               否               |          否          |          是          |
| `browser`                 |   是 `openclaw browser ...`    | 是 `browser.request` |          是          |
| `canvas`                  | 是 `openclaw nodes canvas ...` |   是 `node.invoke`   |          是          |
| `nodes`                   |    是 `openclaw nodes ...`     |     是 `node.*`      |          是          |
| `cron`                    |     是 `openclaw cron ...`     |     是 `cron.*`      |          是          |
| `message`                 |   是 `openclaw message send`   |      是 `send`       |          是          |
| `tts`                     |               否               |      是 `tts.*`      |          是          |
| `gateway`                 |    是 `openclaw config ...`    |    是 `config.*`     |          是          |
| `sessions_list`           |     是 `openclaw sessions`     |  是 `sessions.list`  |          是          |
| `sessions_history`        |               否               |  是 `sessions.get`   |          是          |
| `sessions_send`           |  部分 `openclaw message send`  |   是 `sessions.*`    |          是          |
| `sessions_spawn`          |               否               |          否          |          是          |
| `sessions_yield`          |               否               |          否          |          是          |
| `session_status`          |               否               |          否          |          是          |
| `agents_list`             |               否               |          否          |          是          |
| `subagents`               |               否               |          否          |          是          |
| `web_search`              |               否               |          否          |          是          |
| `web_fetch`               |               否               |          否          |          是          |
| `image`                   |               否               |          否          |          是          |
| `pdf`                     |               否               |          否          |          是          |
| `memory_search`           |  是 `openclaw memory search`   |          否          |          是          |
| `memory_get`              |    是 `openclaw memory get`    |          否          |          是          |

---

## 四、不成立的调用路径

| 路径                                                  | 原因                                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Skill 运行时特权 API（如 `this.callTool("browser")`） | 不存在。Skill 只是 prompt 指令，无特权 API                                                         |
| Plugin SDK `callTool()`                               | Plugin SDK（`src/plugin-sdk/core.ts`）用于定义新 Tool，不暴露调用已有 Tool 的接口                  |
| ACP 轻量 Tool 调用                                    | ACP（`src/acp/server.ts`）是 IDE/编辑器的全 agent 会话桥接（stdin/stdout NDJSON），非轻量 Tool RPC |
| `openclaw tool call` / `openclaw rpc` 统一命令        | 不存在此 CLI 命令                                                                                  |

---

## 五、两种"调用"的区别

| 场景                                     | 调用方式                                 | 是否直接 | 前提条件                  |
| ---------------------------------------- | ---------------------------------------- | -------- | ------------------------- |
| **Agent 遵循 skill 指令调用 Tool**       | 模型 function calling → `tool.execute()` | 直接     | 无额外前提                |
| **Skill 里的 bash/python 脚本调用 Tool** | 需经 CLI / HTTP / RPC 外部接口           | 间接     | Gateway 在运行 + 鉴权凭据 |

---

## 六、结论

1. **Agent 使用 skill 时可直接调用全部 25 个内置 Tool**——这是最主要的调用方式，走模型原生 function calling，无需任何中转。

2. **Skill 内的 bash/python 脚本**只能通过 3 种外部接口间接调用：
   - `openclaw` CLI 子命令（覆盖部分 Tool）
   - `openclaw gateway call` RPC 桥（覆盖大部分 Tool）
   - HTTP `POST /tools/invoke`（覆盖全部 Tool，唯一通用入口）

3. **不存在** Skill 运行时特权 API、Plugin SDK `callTool()`、或 `openclaw tool call` 统一命令。

4. **`command-dispatch: tool`** frontmatter 可让 skill 的斜杠命令绕过 LLM 直接调用指定 Tool，但仅限消息渠道用户输入触发，非脚本触发。

---

## 关键源码引用

| 文件                                                       | 说明                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| `src/agents/pi-tools.ts:593-675`                           | 最终工具列表组装（`createOpenClawCodingTools`）        |
| `src/agents/pi-tools.ts:504-507`                           | 过滤上游 bash 工具                                     |
| `src/agents/openclaw-tools.ts:30-241`                      | `createOpenClawTools` — OpenClaw 扩展工具集            |
| `src/agents/openclaw-tools.ts:219-238`                     | `resolvePluginTools` — 插件槽位工具注入                |
| `src/agents/skills/types.ts:40-49`                         | `SkillCommandDispatchSpec` — command-dispatch 类型定义 |
| `src/agents/skills/workspace.ts`                           | Skill 加载与 prompt 注入                               |
| `src/auto-reply/reply/get-reply-inline-actions.ts:206-248` | command-dispatch: tool 消费逻辑                        |
| `src/gateway/tools-invoke-http.ts:136-359`                 | HTTP `POST /tools/invoke` 端点                         |
| `src/gateway/call.ts:940-956`                              | `callGateway()` RPC 客户端                             |
| `src/cli/gateway-cli/register.ts:114-137`                  | `openclaw gateway call` CLI 命令注册                   |
| `src/plugin-sdk/core.ts`                                   | Plugin SDK（仅定义 Tool，不暴露 callTool）             |
| `src/acp/server.ts`                                        | ACP 服务（会话级桥接，非 Tool RPC）                    |
