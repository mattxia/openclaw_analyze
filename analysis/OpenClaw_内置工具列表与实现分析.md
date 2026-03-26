# OpenClaw 内置工具列表与实现分析

OpenClaw内置工具分为**基础编码工具**和**系统扩展工具**两大类，所有工具都通过`createOpenClawCodingTools()`函数统一创建和初始化。

---

## 📋 完整工具列表

### 一、基础编码工具（来自pi-coding-agent）
| 工具名称 | 功能描述 | 实现文件 | 核心代码 |
|----------|----------|----------|----------|
| **`read`** | 读取文件内容，支持文本、图片等多种格式，自动处理大小限制和编码 | [src/agents/pi-tools.read.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-tools.read.ts) | ```typescript
const readTool = createReadTool(workspaceRoot);
const wrapped = createOpenClawReadTool(freshReadTool, {
  modelContextWindowTokens: options?.modelContextWindowTokens,
  imageSanitization,
});
```
|
| **`write`** | 写入文件内容，支持路径校验和工作区安全隔离 | [src/agents/pi-tools.read.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-tools.read.ts) | ```typescript
const wrapped = createHostWorkspaceWriteTool(workspaceRoot, { workspaceOnly });
```
|
| **`edit`** | 编辑文件内容，支持差异补丁修改，避免全量覆盖 | [src/agents/pi-tools.read.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-tools.read.ts) | ```typescript
const wrapped = createHostWorkspaceEditTool(workspaceRoot, { workspaceOnly });
```
|
| **`apply_patch`** | 应用Git格式的补丁文件，高效修改代码 | [src/agents/apply-patch.ts](file:///d:/prj/openclaw_analyze/src/agents/apply-patch.ts) | ```typescript
const applyPatchTool = createApplyPatchTool({
  cwd: workspaceRoot,
  workspaceOnly: applyPatchWorkspaceOnly,
});
```
|
| **`exec`** / **`bash`** | 执行系统命令和Shell脚本，支持权限控制和沙箱隔离 | [src/agents/bash-tools.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.ts) | ```typescript
const execTool = createExecTool({
  cwd: workspaceRoot,
  allowBackground,
  timeoutSec: execConfig.timeoutSec,
  sandbox: sandbox ? { /* 沙箱配置 */ } : undefined,
});
```
|
| **`process`** | 管理后台运行的进程，支持查看、终止后台命令 | [src/agents/bash-tools.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.ts) | ```typescript
const processTool = createProcessTool({
  scopeKey: options?.sessionKey,
  cleanupMs: execConfig.cleanupMs,
});
```
|

---

### 二、系统扩展工具（OpenClaw自定义）
#### 1. 设备与浏览器类
| 工具名称 | 功能描述 | 实现文件 | 核心代码 |
|----------|----------|----------|----------|
| **`browser`** | 控制浏览器操作，支持导航、截图、点击、输入、JS执行等 | [src/agents/tools/browser-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/browser-tool.ts) | ```typescript
createBrowserTool({
  sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
  allowHostControl: options?.allowHostBrowserControl,
});
```
|
| **`nodes`** | 管理和调用连接的设备节点能力，如相机、位置、通知等 | [src/agents/tools/nodes-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/nodes-tool.ts) | ```typescript
createNodesTool({
  agentSessionKey: options?.agentSessionKey,
  config: options?.config,
  allowMediaInvokeCommands: options?.allowMediaInvokeCommands,
});
```
|

#### 2. 会话与协程类
| 工具名称 | 功能描述 | 实现文件 | 核心代码 |
|----------|----------|----------|----------|
| **`sessions_spawn`** | 派生新的子Agent会话，实现多Agent协同 | [src/agents/tools/sessions-spawn-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/sessions-spawn-tool.ts) | ```typescript
createSessionsSpawnTool({
  agentSessionKey: options?.agentSessionKey,
  workspaceDir: spawnWorkspaceDir,
});
```
|
| **`sessions_send`** | 向其他会话发送消息，实现Agent间通信 | [src/agents/tools/sessions-send-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/sessions-send-tool.ts) | ```typescript
createSessionsSendTool({
  agentSessionKey: options?.agentSessionKey,
  agentChannel: options?.agentChannel,
});
```
|
| **`sessions_yield`** | 主动让步当前会话执行，等待后续事件触发 | [src/agents/tools/sessions-yield-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/sessions-yield-tool.ts) | ```typescript
createSessionsYieldTool({
  sessionId: options?.sessionId,
  onYield: options?.onYield,
});
```
|
| **`sessions_list`** | 列出当前所有可用会话 | [src/agents/tools/sessions-list-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/sessions-list-tool.ts) | ```typescript
createSessionsListTool({
  agentSessionKey: options?.agentSessionKey,
  sandboxed: options?.sandboxed,
  config: options?.config,
});
```
|
| **`sessions_history`** | 查看会话历史记录 | [src/agents/tools/sessions-history-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/sessions-history-tool.ts) | ```typescript
createSessionsHistoryTool({
  agentSessionKey: options?.agentSessionKey,
  config: options?.config,
});
```
|
| **`subagents`** | 管理子Agent生命周期 | [src/agents/tools/subagents-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/subagents-tool.ts) | ```typescript
createSubagentsTool({
  agentSessionKey: options?.agentSessionKey,
});
```
|
| **`session_status`** | 获取当前会话状态信息 | [src/agents/tools/session-status-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/session-status-tool.ts) | ```typescript
createSessionStatusTool({
  agentSessionKey: options?.agentSessionKey,
  config: options?.config,
});
```
|
| **`agents_list`** | 列出所有可用的Agent配置 | [src/agents/tools/agents-list-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/agents-list-tool.ts) | ```typescript
createAgentsListTool({
  agentSessionKey: options?.agentSessionKey,
});
```
|

#### 3. 消息与通知类
| 工具名称 | 功能描述 | 实现文件 | 核心代码 |
|----------|----------|----------|----------|
| **`message`** | 发送消息到当前或其他渠道/联系人 | [src/agents/tools/message-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/message-tool.ts) | ```typescript
createMessageTool({
  agentAccountId: options?.agentAccountId,
  currentChannelId: options?.currentChannelId,
  currentThreadTs: options?.currentThreadTs,
});
```
|
| **`tts`** | 文本转语音，生成语音回复 | [src/agents/tools/tts-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/tts-tool.ts) | ```typescript
createTtsTool({
  agentChannel: options?.agentChannel,
  config: options?.config,
});
```
|

#### 4. 内容处理类
| 工具名称 | 功能描述 | 实现文件 | 核心代码 |
|----------|----------|----------|----------|
| **`web_search`** | 网页搜索，获取互联网信息 | [src/agents/tools/web-tools.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/web-tools.ts) | ```typescript
const webSearchTool = createWebSearchTool({
  config: options?.config,
  runtimeWebSearch: runtimeWebTools?.search,
});
```
|
| **`web_fetch`** | 网页内容抓取，支持markdown转换 | [src/agents/tools/web-tools.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/web-tools.ts) | ```typescript
const webFetchTool = createWebFetchTool({
  config: options?.config,
  runtimeFirecrawl: runtimeWebTools?.fetch.firecrawl,
});
```
|
| **`image`** | 图像处理工具，支持识别、描述、格式转换等 | [src/agents/tools/image-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/image-tool.ts) | ```typescript
const imageTool = createImageTool({
  config: options?.config,
  agentDir: options?.agentDir,
  workspaceDir,
  modelHasVision: options?.modelHasVision,
});
```
|
| **`pdf`** | PDF文档处理，支持内容提取、解析等 | [src/agents/tools/pdf-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/pdf-tool.ts) | ```typescript
const pdfTool = createPdfTool({
  config: options?.config,
  agentDir: options?.agentDir,
  workspaceDir,
});
```
|
| **`canvas`** | Canvas工作区操作，支持可视化内容生成 | [src/agents/tools/canvas-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/canvas-tool.ts) | ```typescript
createCanvasTool({
  config: options?.config,
});
```
|

#### 5. 系统管理类
| 工具名称 | 功能描述 | 实现文件 | 核心代码 |
|----------|----------|----------|----------|
| **`cron`** | 定时任务管理，支持创建、查看、删除定时任务 | [src/agents/tools/cron-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/cron-tool.ts) | ```typescript
createCronTool({
  agentSessionKey: options?.agentSessionKey,
});
```
|
| **`gateway`** | Gateway网关管理，支持配置查询、状态查看等 | [src/agents/tools/gateway-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/gateway-tool.ts) | ```typescript
createGatewayTool({
  agentSessionKey: options?.agentSessionKey,
  config: options?.config,
});
```
|

---

## 🔧 工具创建入口
所有工具统一通过`createOpenClawCodingTools()`函数创建和管理：
```typescript
// 核心工具创建入口
export function createOpenClawCodingTools(options?: OpenClawCodingToolsOpts): AnyAgentTool[] {
  // 1. 加载基础编码工具
  const baseTools = codingTools.flatMap(/* 基础工具初始化 */);
  
  // 2. 加载系统扩展工具
  const systemTools = createOpenClawTools({ /* 系统工具配置 */ });
  
  // 3. 应用安全策略和包装
  return applyToolPolicyPipeline([...baseTools, ...systemTools], policies);
}
```

---

## 🛡️ 工具安全机制
1. **工作区隔离**：默认仅允许访问当前工作区目录，防止越权访问系统文件
2. **沙箱隔离**：在沙箱模式下运行的工具会被限制访问系统资源
3. **权限控制**：通过`tools.allow`/`tools.deny`配置可以灵活控制工具访问权限
4. **参数校验**：所有工具参数都会经过schema校验，防止恶意输入
5. **审计日志**：工具调用会被记录到审计日志，便于追溯和调试
