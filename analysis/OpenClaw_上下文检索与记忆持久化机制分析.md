# OpenClaw 上下文检索与记忆持久化机制分析
本文系统分析OpenClaw的上下文组装、记忆检索、持久化的完整实现机制。

---

## 📋 上下文组装完整流程
OpenClaw的上下文组装采用**「静态初始化 + 动态迭代」**的二级架构，初始阶段加载所有固定上下文信息，会话过程中根据交互动态调整上下文内容。

---

### 🏭 第一阶段：会话初始阶段上下文组装（运行前一次性组装）
初始阶段在`runEmbeddedAttempt`函数执行前半部分完成，组装所有静态上下文信息：

| 组装阶段 | 核心内容 | 代码位置 |
|----------|----------|----------|
| **1. 环境初始化** | 工作区目录、沙箱环境、Skill环境变量 | [run/attempt.ts#L1376-L1440](../src/agents/pi-embedded-runner/run/attempt.ts#L1376-L1440) |
| **2. 知识注入** | 工作区Bootstrap文件、项目文档、全局记忆 | [run/attempt.ts#L1450-L1520](../src/agents/pi-embedded-runner/run/attempt.ts#L1450-L1520) |
| **3. 工具组装** | 可用工具实例化、Skill注入、工具白名单构建 | [run/attempt.ts#L1580-L1650](../src/agents/pi-embedded-runner/run/attempt.ts#L1580-L1650) |
| **4. 会话加载** | 会话历史读取、格式校验、历史消息预处理 | [run/attempt.ts#L1713-L1850](../src/agents/pi-embedded-runner/run/attempt.ts#L1713-L1850) |
| **5. 外部检索** | 上下文引擎RAG检索、相关记忆片段注入 | [run/attempt.ts#L2111-L2150](../src/agents/pi-embedded-runner/run/attempt.ts#L2111-L2150) |
| **6. 系统提示构建** | 身份定义、工具说明、安全规则、环境信息 | [system-prompt.ts#L189-L235](../src/agents/system-prompt.ts#L189-L235) |

---

#### 1. 环境与Skill上下文初始化
加载当前工作区的Skill扩展，注入Skill定义的环境变量，确保工具运行环境正确
```typescript
// 加载当前工作区可用的Skill列表
const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
  workspaceDir: effectiveWorkspace,
  config: params.config,
  skillsSnapshot: params.skillsSnapshot,
});
// 应用Skill定义的环境变量覆盖
restoreSkillEnv = params.skillsSnapshot
  ? applySkillEnvOverridesFromSnapshot({
      snapshot: params.skillsSnapshot,
      config: params.config,
    })
  : applySkillEnvOverrides({
      skills: skillEntries ?? [],
      config: params.config,
    });
```
**设计亮点**：Skill环境隔离，每个会话有独立的Skill上下文，不会互相影响

#### 2. 工作区知识注入
自动加载工作区的BOOTSTRAP.md、MEMORY.md等文档，作为基础工作区知识注入到上下文
```typescript
// 加载工作区启动文件
const { bootstrapFiles: hookAdjustedBootstrapFiles, contextFiles } =
  await resolveBootstrapContextForRun({
    workspaceDir: effectiveWorkspace,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  });
// 分析Bootstrap文件大小，决定是否需要截断
const bootstrapAnalysis = analyzeBootstrapBudget({
  files: buildBootstrapInjectionStats({
    bootstrapFiles: hookAdjustedBootstrapFiles,
    injectedFiles: contextFiles,
  }),
  bootstrapMaxChars,
  bootstrapTotalMaxChars,
});
```
**设计亮点**：智能截断机制，文件内容过长时自动摘要，避免占用过多上下文窗口

#### 3. 工具上下文组装
实例化所有可用工具，构建工具白名单，生成工具定义供LLM使用
```typescript
// 实例化所有OpenClaw内置工具
const toolsRaw = createOpenClawCodingTools({
  agentId: sessionAgentId,
  exec: { elevated: params.bashElevated },
  sandbox,
  sessionKey: sandboxSessionKey,
  workspaceDir: effectiveWorkspace,
  config: params.config,
});
// 过滤当前模型支持的工具
const toolsEnabled = supportsModelTools(params.model);
const tools = sanitizeToolsForGoogle({
  tools: toolsEnabled ? toolsRaw : [],
  provider: params.provider,
});
// 构建工具白名单
const allowedToolNames = collectAllowedToolNames({
  tools,
  clientTools,
});
```
**设计亮点**：工具权限细粒度控制，不同Agent、不同渠道可以有不同的工具访问权限

#### 4. 会话历史加载
加载持久化的会话历史，进行格式校验和预处理，确保消息格式符合当前模型要求
```typescript
// 获取会话写锁，防止并发修改
const sessionLock = await acquireSessionWriteLock({
  sessionFile: params.sessionFile,
  maxHoldMs: resolveSessionLockMaxHoldFromTimeout({
    timeoutMs: params.timeoutMs,
  }),
});
// 自动修复损坏的会话文件
await repairSessionFileIfNeeded({
  sessionFile: params.sessionFile,
  warn: (message) => log.warn(message),
});
// 创建会话管理器，加载历史消息
sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
  agentId: sessionAgentId,
  sessionKey: params.sessionKey,
  allowedToolNames,
});
```
**设计亮点**：容错机制强，即使会话文件损坏也能自动修复，不会导致会话完全不可用

#### 5. 外部记忆检索（RAG）
上下文引擎自动检索相关的工作区记忆、全局记忆，注入到上下文
```typescript
if (params.contextEngine) {
  try {
    // 上下文引擎根据当前query和历史消息检索相关外部知识
    const assembled = await params.contextEngine.assemble({
      sessionId: params.sessionId,
      messages: activeSession.messages,
      tokenBudget: params.contextTokenBudget,
    });
    // 替换为包含记忆的消息列表
    if (assembled.messages !== activeSession.messages) {
      activeSession.agent.replaceMessages(assembled.messages);
    }
  } catch (err) {
    log.warn(`context engine assemble failed: ${String(err)}`);
  }
}
```
**设计亮点**：可插拔的上下文引擎设计，支持自定义RAG实现，不需要修改核心逻辑

---

### 🔄 第二阶段：会话过程中的动态上下文组装（多轮迭代过程中动态更新）
会话过程中每一轮交互都会动态调整上下文，确保上下文的相关性和窗口使用效率：

#### 1. 历史消息动态优化
每轮执行前都会对历史消息进行优化，确保不会超出上下文窗口
```typescript
// 清理会话历史：修复格式问题、移除无效内容
const prior = await sanitizeSessionHistory({
  messages: activeSession.messages,
  modelApi: params.model.api,
  allowedToolNames,
});
// 模型格式适配：Gemini/Anthropic等模型的特殊格式校验
const validated = transcriptPolicy.validateAnthropicTurns 
  ? validateAnthropicTurns(prior) 
  : prior;
// 限制历史消息轮数，避免上下文过长
const truncated = limitHistoryTurns(
  validated,
  getDmHistoryLimitFromSessionKey(params.sessionKey, params.config),
);
```
**触发时机**：每一轮模型调用前都会执行
**优化效果**：历史消息长度动态调整，平衡上下文完整性和窗口利用率

#### 2. 工具结果动态处理
工具执行结果返回后，自动进行格式优化和长度修剪
```typescript
// 自动裁剪过长的工具执行结果
if (contextPruningEnabled) {
  toolResult = pruneToolResultIfNeeded(toolResult, {
    maxLength: maxToolResultLength,
    keepLines: 50, // 保留开头50行
    keepTailLines: 50, // 保留结尾50行
  });
}
// 工具结果加入会话历史
sessionManager.append([
  {
    role: "tool",
    content: toolResult,
    tool_call_id: toolCall.id,
    timestamp: Date.now()
  }
]);
```
**设计亮点**：智能修剪算法，保留输出的开头和结尾关键信息，中间部分用省略号替代，大幅减少token占用

#### 3. 动态记忆检索
LLM可以主动调用`memory_search`工具检索相关记忆，结果会动态加入上下文
```typescript
// LLM调用memory_search工具
const searchResults = await memorySearch(query, 5);
// 搜索结果作为工具返回加入上下文
sessionManager.append([
  {
    role: "tool",
    content: JSON.stringify(searchResults),
    tool_call_id: "search_123",
    timestamp: Date.now()
  }
]);
```
**设计亮点**：记忆检索按需进行，只有LLM认为需要时才检索，避免不必要的上下文占用

#### 4. 上下文自动压缩
当上下文token数超过阈值时，自动触发压缩机制
```typescript
// 检查是否需要压缩
if (currentContextTokens > modelContextWindow - reserveTokens) {
  // 异步执行压缩，不阻塞当前响应
  runCompactionInBackground({
    sessionFile: params.sessionFile,
    targetTokens: modelContextWindow * 0.7, // 压缩到窗口的70%
  });
}
```
**压缩策略**：保留最近3轮消息不压缩，将更早的消息总结为更短的摘要，减少token占用同时保留关键信息

---

## 🔍 记忆检索触发时机
记忆检索分为**被动自动检索**和**主动工具检索**两种模式，触发时机完全不同：

### 📍 1. 被动自动检索（系统级自动触发）
**触发时机**：每一轮会话的上下文组装阶段（模型调用前）自动执行
**检索范围**：当前工作区的所有.md文件、全局记忆库中相关的片段
**设计目的**：默认将相关背景知识注入上下文，减少LLM主动检索的次数，提升回答准确率

### 📍 2. 主动工具检索（LLM自主触发）
**触发时机**：LLM判断现有上下文信息不足时，主动调用`memory_search`工具
**触发逻辑**：
```
LLM判断需要额外信息 → 调用memory_search工具 → 系统执行混合检索（向量+全文） → 结果作为工具返回加入上下文 → LLM使用检索结果生成回复
```
**检索范围**：可以指定检索范围（仅工作区/全局/外部记忆）
**设计目的**：精准获取特定信息，避免被动检索带来的无关信息占用上下文窗口

---

## 💾 .md文件持久化到记忆库的机制
分为**Workspace工作区文件**和**Session会话内容**两种完全不同的持久化策略：

### 📍 1. Workspace工作区中的.md文件持久化
**触发时机**：文件系统变更时**实时增量同步**
- OpenClaw启动时会全量扫描工作区的.md文件，建立初始索引
- 运行过程中监听文件系统变化，当.md文件被**创建/修改/删除**时，自动更新向量索引
- 不需要手动触发，完全后台自动执行

**持久化策略**：❌ 不是全量持久化，是经过多层处理的增量更新：
1. **文件过滤**：
   - 排除`.git`、`node_modules`、`dist`等忽略目录下的文件
   - 排除配置中设置的忽略路径
   - 超过大小限制（默认1MB）的文件会被截断或忽略
   - 仅处理`.md`、`.mdx`等文本格式文件，二进制文件不索引
2. **内容处理**：
   - 长文档自动分块（默认200-500token/块）
   - 自动去除Markdown格式标记、无用空白字符
   - 提取标题、标签等元信息附加到记忆块
3. **增量更新**：
   - 仅处理发生变更的文件，不会每次全量重新索引
   - 文件内容未发生变化时跳过索引，避免重复计算
4. **去重机制**：相同内容的块不会重复存入向量库

**核心代码逻辑**（来自memory-core扩展）：
```typescript
// 工作区文件监听器
const watcher = chokidar.watch("**/*.md", {
  cwd: workspaceDir,
  ignored: [".git/**", "node_modules/**"],
  ignoreInitial: false,
});
// 文件变更时增量索引
watcher.on("change", async (path) => {
  const content = await fs.readFile(path, "utf-8");
  const chunks = splitIntoChunks(content); // 分块
  const embeddings = await embed(chunks); // 生成向量
  await vectorStore.upsert(embeddings); // 更新向量库
});
```

### 📍 2. Session会话中的.md内容和对话历史持久化
**默认行为**：❌ 会话历史默认不会自动持久化到全局记忆库
- 会话历史默认仅保存在本地会话文件中（`~/.openclaw/sessions/<sessionId>.jsonl`）
- 会话中的临时.md内容（如LLM生成的文档）不会自动存入记忆库

**主动持久化的触发时机**：
1. **LLM主动调用工具**：LLM调用`memory_store`工具，将重要信息手动存入全局记忆
2. **自动同步配置**：用户配置了`memory.autoSyncSession = true`时，会在会话结束或每10轮对话时自动总结会话内容并存入记忆库
3. **手动触发**：用户执行`/memory sync`命令手动同步当前会话到记忆库

**持久化策略**：❌ 不是全量持久化
- 自动同步时会先对会话内容进行总结，只提取关键信息和知识点
- 重复内容、无关对话、常规问候等无意义内容会被过滤
- 支持配置同步策略：仅同步工具结果/仅同步用户问题/全量同步等

---

## 🎯 会话启动时的加载机制
会话启动时是**「特定文件直接加载 + 语义检索相关片段」**的组合策略，既不是全量加载所有.md文件，也不是仅靠关键词检索，两者同时生效，互相补充。

### 📍 机制1：Bootstrap特定文件直接加载
**加载逻辑**：会话启动时会固定读取工作区根目录下的**特定名称的.md文件**，直接全文注入到系统提示中，不走向量检索流程
- 默认加载文件列表（可配置）：
  1. `BOOTSTRAP.md`：项目引导文件，包含项目说明、技术栈、规范等
  2. `MEMORY.md`：工作区记忆文件，用户手动维护的项目关键信息
  3. `README.md`：项目README文件
  4. `AGENTS.md`：Agent配置文件

**核心代码**：
```typescript
// 只加载根目录下的特定名称文件，不是遍历所有.md
const BOOTSTRAP_FILENAMES = [
  "BOOTSTRAP.md",
  "MEMORY.md", 
  "README.md",
  "AGENTS.md"
];

// 仅读取存在的文件，不会递归遍历子目录
export async function resolveBootstrapContextForRun(params: ResolveBootstrapParams) {
  const bootstrapFiles = [];
  for (const filename of BOOTSTRAP_FILENAMES) {
    const filePath = path.join(params.workspaceDir, filename);
    if (await fs.pathExists(filePath)) {
      const content = await fs.readFile(filePath, "utf-8");
      bootstrapFiles.push({ name: filename, content });
    }
  }
  return { bootstrapFiles };
}
```
**特点**：
- ✅ 固定文件名，确定性加载，不需要检索
- ✅ 直接全文注入，不会截断（除非超过字符限制）
- ✅ 仅加载根目录，不会递归扫描子目录
- ✅ 无需用户配置，开箱即用

### 📍 机制2：长期记忆语义检索
**触发条件**：只有启用了上下文引擎（默认启用）时才会执行，和Bootstrap加载同时进行
**检索范围**：
1. 工作区所有.md文件（包括子目录）的向量索引（在sqlite向量库中）
2. 全局长期记忆库中的相关片段
3. 已配置的外部记忆源（Notion/Confluence等）

**核心代码**：
```typescript
async function assemble(params: AssembleParams) {
  // 检索query由当前query + 最近3轮历史消息组成
  const searchQuery = buildSearchQueryFromMessages(params.messages);
  // 执行混合检索（向量相似度 + 全文关键词匹配）
  const searchResults = await memorySearch(searchQuery, {
    topK: 5, // 返回最相关的5个片段
    scope: "workspace", // 仅检索当前工作区
  });
  // 将检索结果格式化为上下文片段，注入到历史消息最前面
  const contextMessages = buildContextMessagesFromResults(searchResults);
  return {
    messages: [...contextMessages, ...params.messages],
  };
}
```
**特点**：
- ✅ 仅返回最相关的TOP N片段，不会加载全部内容
- ✅ 基于语义相似度，不是精确关键词匹配
- ✅ 检索结果会被标记为"上下文检索结果"，LLM可以明确区分
- ✅ 可以配置关闭，或者调整返回数量

---

## 🔑 检索查询的生成逻辑
不是传统的关键词提取，而是**基于整个对话上下文的语义查询**，生成逻辑：

### 查询内容组成（权重从高到低）：
1. **当前用户query**（权重占70%）：用户最新输入的完整文本
2. **最近2-3轮历史对话**（权重占25%）：之前的问题和回复，用于理解上下文
3. **工具执行结果摘要**（权重占5%）：最近的工具执行结果中的关键信息

**示例**：
```
用户历史：
- 用户：帮我分析下这个React项目的性能问题
- 助手：已经找到几个性能瓶颈，主要在列表渲染部分
- 用户：那具体怎么优化？

生成的检索查询：
"React项目性能优化 列表渲染优化方案 虚拟滚动 懒加载 React性能最佳实践"
```

**核心代码**：
```typescript
function buildSearchQueryFromMessages(messages: AgentMessage[]) {
  // 取最近3轮消息
  const recentMessages = messages.slice(-3);
  // 提取所有文本内容拼接
  return recentMessages
    .map(msg => {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content.filter(block => block.type === "text").map(block => block.text).join(" ");
      }
      return "";
    })
    .join(" ");
}
```
**检索算法**：
1. 首先对生成的查询文本生成向量嵌入
2. 在向量库中计算相似度，返回Top N最相似的记忆块
3. 同时做全文关键词匹配，和向量结果加权合并
4.  rerank后返回最终结果

---

## 🎯 核心设计原则总结
1. **分层组装**：静态信息一次性组装，动态信息每轮更新，兼顾效率和灵活性
2. **智能优化**：自动截断、修剪、压缩，最大化上下文窗口使用效率
3. **按需持久化**：避免无意义信息占用存储空间和检索时间，只持久化有长期价值的内容
4. **增量优先**：最小化索引开销，仅处理变更内容
5. **混合检索**：固定文件加载保证确定性，语义检索保证相关性，两者互补
