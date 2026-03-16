# OpenClaw LLM 上下文窗口管理分析

## 一、概述

OpenClaw 项目对 LLM 上下文窗口进行了全面的管理，主要包括以下几个核心机制：

1. **上下文窗口发现与配置** - 动态发现和配置模型的上下文窗口限制
2. **上下文压缩 (Compaction)** - 自动和手动的上下文压缩机制
3. **上下文修剪 (Pruning)** - 工具结果的智能裁剪
4. **溢出处理** - 上下文溢出时的自动恢复机制
5. **内存刷新** - 压缩前的状态持久化

## 二、核心架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    LLM 上下文窗口管理体系                                 │
└─────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  上下文窗口发现   │     │  上下文压缩      │     │  上下文修剪      │
│                  │     │  (Compaction)    │     │  (Pruning)       │
│ • 模型发现        │     │                  │     │                  │
│ • 配置覆盖        │     │ • 自动压缩       │     │ • 工具结果裁剪   │
│ • 缓存管理        │     │ • 手动压缩       │     │ • TTL 控制        │
│ • 提供者限定      │     │ • 分阶段总结     │     │ • 软裁剪/硬清除  │
└────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                        │                        │
         └────────────────────────┼────────────────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │    上下文窗口监控          │
                    │                            │
                    │  - 实时 token 统计          │
                    │  - 阈值检测                │
                    │  - 溢出预防                │
                    └─────────────┬──────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │    Pi-Agent 运行时          │
                    │                            │
                    │  - 上下文构建              │
                    │  - 工具调用                │
                    │  - 错误处理                │
                    └─────────────┬──────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │    溢出恢复机制            │
                    │                            │
                    │  - 溢出检测                │
                    │  - 压缩重试                │
                    │  - 故障转移                │
                    └────────────────────────────┘
```

## 三、关键实现模块

### 3.1 上下文窗口发现与配置

**核心文件**: [`src/agents/context.ts`](file:///d:/prj/openclaw_analyze/src/agents/context.ts)

**主要功能**:
- 从模型发现服务加载上下文窗口信息
- 支持配置文件覆盖
- 维护内存缓存避免重复加载
- 支持提供者限定的上下文窗口查询

**关键类和函数**:

```typescript
// 上下文窗口缓存
const MODEL_CACHE = new Map<string, number>();

// 应用发现的模型上下文窗口
export function applyDiscoveredContextWindows(params: {
  cache: Map<string, number>;
  models: ModelEntry[];
}) {
  for (const model of params.models) {
    if (!model?.id) continue;
    const contextWindow = typeof model.contextWindow === "number" 
      ? Math.trunc(model.contextWindow) 
      : undefined;
    if (!contextWindow || contextWindow <= 0) continue;
    
    // 当同一模型 ID 出现在多个提供者下时，保留较小的窗口限制
    const existing = params.cache.get(model.id);
    if (existing === undefined || contextWindow < existing) {
      params.cache.set(model.id, contextWindow);
    }
  }
}

// 应用配置文件中的上下文窗口设置
export function applyConfiguredContextWindows(params: {
  cache: Map<string, number>;
  modelsConfig: ModelsConfig | undefined;
}) {
  const providers = params.modelsConfig?.providers;
  if (!providers || typeof providers !== "object") return;
  
  for (const provider of Object.values(providers)) {
    if (!Array.isArray(provider?.models)) continue;
    for (const model of provider.models) {
      const modelId = typeof model?.id === "string" ? model.id : undefined;
      const contextWindow = typeof model?.contextWindow === "number" 
        ? model.contextWindow 
        : undefined;
      if (!modelId || !contextWindow || contextWindow <= 0) continue;
      params.cache.set(modelId, contextWindow);
    }
  }
}

// 查询模型的上下文窗口（非阻塞）
export function lookupContextTokens(modelId?: string): number | undefined {
  if (!modelId) return undefined;
  void ensureContextWindowCacheLoaded(); // 异步加载
  return MODEL_CACHE.get(modelId);
}
```

**上下文窗口解析流程**:

```typescript
// 解析上下文窗口信息的完整流程
export function resolveContextWindowInfo(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  modelContextWindow?: number;
  defaultTokens: number;
}): ContextWindowInfo {
  // 1. 从 modelsConfig 中查找
  const fromModelsConfig = (() => {
    const providers = params.cfg?.models?.providers as Record<...>;
    const providerEntry = providers?.[params.provider];
    const models = Array.isArray(providerEntry?.models) ? providerEntry.models : [];
    const match = models.find((m) => m?.id === params.modelId);
    return normalizePositiveInt(match?.contextWindow);
  })();
  
  // 2. 从模型元数据中获取
  const fromModel = normalizePositiveInt(params.modelContextWindow);
  
  // 3. 确定基础信息
  const baseInfo = fromModelsConfig
    ? { tokens: fromModelsConfig, source: "modelsConfig" }
    : fromModel
      ? { tokens: fromModel, source: "model" }
      : { tokens: Math.floor(params.defaultTokens), source: "default" };

  // 4. 应用 agents.defaults.contextTokens 限制
  const capTokens = normalizePositiveInt(params.cfg?.agents?.defaults?.contextTokens);
  if (capTokens && capTokens < baseInfo.tokens) {
    return { tokens: capTokens, source: "agentContextTokens" };
  }

  return baseInfo;
}
```

**配置示例**:

```json5
{
  "models": {
    "providers": {
      "anthropic": {
        "models": [
          {
            "id": "claude-sonnet-4-20250514",
            "contextWindow": 200000
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "contextTokens": 100000  // 可选：限制所有代理的上下文窗口
    }
  }
}
```

### 3.2 上下文压缩 (Compaction)

**核心文件**: 
- [`src/agents/compaction.ts`](file:///d:/prj/openclaw_analyze/src/agents/compaction.ts) - 压缩核心逻辑
- [`src/agents/pi-extensions/compaction-safeguard.ts`](file:///d:/prj/openclaw_analyze/src/agents/pi-extensions/compaction-safeguard.ts) - 压缩保护机制
- [`src/agents/pi-embedded-runner/run/compaction-timeout.ts`](file:///d:/prj/openclaw_analyze/src/agents/pi-embedded-runner/run/compaction-timeout.ts) - 压缩超时处理

**主要功能**:
- 自动压缩：当上下文接近模型限制时自动触发
- 手动压缩：用户通过 `/compact` 命令触发
- 分阶段总结：将大上下文分块总结后合并
- 标识符保护：保护 UUID、哈希等关键标识符
- 工具结果安全处理：避免将未信任的工具详情送入总结

**压缩触发条件**:

```typescript
// 自动压缩触发的两种情况：
// 1. 溢出恢复：模型返回上下文溢出错误 → 压缩 → 重试
// 2. 阈值维护：成功运行后，当 contextTokens > contextWindow - reserveTokens

// 压缩安全保护机制
export async function runCompactionSafeguard(params: {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  signal: AbortSignal;
  reserveTokens: number;
  contextWindow: number;
  customInstructions?: string;
  summarizationInstructions?: CompactionSummarizationInstructions;
}): Promise<CompactionSafeguardResult> {
  // 1. 计算自适应块比例
  const adaptiveRatio = computeAdaptiveChunkRatio(messages, contextWindow);
  
  // 2. 剪枝历史以共享上下文
  const pruneResult = pruneHistoryForContextShare({
    messages,
    maxContextTokens: contextWindow,
    maxHistoryShare: adaptiveRatio,
  });
  
  // 3. 分阶段总结
  const summary = await summarizeInStages({
    messages: pruneResult.messages,
    model: params.model,
    apiKey: params.apiKey,
    signal: params.signal,
    reserveTokens: params.reserveTokens,
    maxChunkTokens: params.maxChunkTokens,
    contextWindow: contextWindow,
    customInstructions: params.customInstructions,
    summarizationInstructions: params.summarizationInstructions,
  });
  
  return { summary, ...pruneResult };
}
```

**压缩流程**:

```
┌──────────────────────────────────────────────────────────────────┐
│                    上下文压缩流程                                 │
└──────────────────────────────────────────────────────────────────┘

1. 触发检测
   ├─ 溢出恢复：捕获上下文溢出错误
   ├─ 阈值维护：contextTokens > contextWindow - reserveTokens
   └─ 用户命令：/compact

2. 准备阶段
   ├─ 收集会话消息
   ├─ 应用工具结果安全过滤 (stripToolResultDetails)
   ├─ 计算自适应块比例 (computeAdaptiveChunkRatio)
   └─ 确定压缩参数

3. 分块处理
   ├─ 按 token 份额分割消息 (splitMessagesByTokenShare)
   ├─ 按最大 token 限制分块 (chunkMessagesByMaxTokens)
   └─ 处理超大消息

4. 分阶段总结
   ├─ 对每个块调用 generateSummary()
   ├─ 合并部分总结 (mergeSummaries)
   ├─ 应用标识符保护策略
   └─ 应用自定义指令

5. 持久化
   ├─ 写入 compaction 记录到 transcript
   ├─ 记录 firstKeptEntryId 和 tokensBefore
   └─ 更新会话存储的 compactionCount

6. 后压缩处理
   ├─ 读取 AGENTS.md 关键章节注入
   ├─ 更新会话上下文
   └─ 通知相关组件
```

**关键参数**:

```typescript
// 压缩核心参数
export const BASE_CHUNK_RATIO = 0.4;        // 基础块比例
export const MIN_CHUNK_RATIO = 0.15;        // 最小块比例
export const SAFETY_MARGIN = 1.2;           // 20% 缓冲用于 estimateTokens() 误差
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;  // 总结提示词开销

// 默认压缩设置（Pi runtime）
const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,      // 保留 token 用于提示词和输出
  keepRecentTokens: 20000,   // 保留最近的 token
};

// 压缩安全保护参数
const COMPACTION_SAFEGUARD_PARAMS = {
  maxToolFailures: 8,
  maxToolFailureChars: 240,
  recentTurnsPreserve: 3,    // 保留最近的轮次
  qualityGuardMaxRetries: 1, // 质量保护重试次数
};
```

**标识符保护策略**:

```typescript
// 标识符保护指令
const IDENTIFIER_PRESERVATION_INSTRUCTIONS =
  "Preserve all opaque identifiers exactly as written " +
  "(no shortening or reconstruction), including UUIDs, hashes, IDs, " +
  "tokens, API keys, hostnames, IPs, ports, URLs, and file names.";

// 构建压缩总结指令
export function buildCompactionSummarizationInstructions(
  customInstructions?: string,
  instructions?: CompactionSummarizationInstructions,
): string | undefined {
  const policy = instructions?.identifierPolicy ?? "strict";
  
  if (policy === "off") {
    return undefined; // 不应用标识符保护
  }
  
  if (policy === "custom") {
    const custom = instructions?.identifierInstructions?.trim();
    return custom && custom.length > 0 ? custom : IDENTIFIER_PRESERVATION_INSTRUCTIONS;
  }
  
  // strict 模式：应用标准标识符保护
  return IDENTIFIER_PRESERVATION_INSTRUCTIONS;
}
```

### 3.3 上下文修剪 (Context Pruning)

**核心文件**: 
- [`src/agents/pi-extensions/context-pruning.ts`](file:///d:/prj/openclaw_analyze/src/agents/pi-extensions/context-pruning.ts)
- [`src/agents/pi-extensions/context-pruning/extension.js`](file:///d:/prj/openclaw_analyze/src/agents/pi-extensions/context-pruning/extension.js)
- [`src/agents/pi-extensions/context-pruning/pruner.js`](file:///d:/prj/openclaw_analyze/src/agents/pi-extensions/context-pruning/pruner.js)

**主要功能**:
- 修剪旧工具结果从内存上下文（不修改磁盘历史）
- 基于 TTL 的缓存感知修剪
- 软裁剪（保留头尾）和硬清除（替换为占位符）
- 仅针对 Anthropic API 调用和 OpenRouter Anthropic 模型

**配置示例**:

```json5
{
  "agents": {
    "defaults": {
      "contextPruning": {
        "mode": "cache-ttl",           // off | cache-ttl
        "ttl": "1h",                   // 持续时间 (ms/s/m/h)，默认单位：分钟
        "keepLastAssistants": 3,       // 保留最后 N 条助手消息
        "softTrimRatio": 0.3,          // 软裁剪触发阈值
        "hardClearRatio": 0.5,         // 硬清除触发阈值
        "minPrunableToolChars": 50000, // 最小可修剪工具结果字符数
        "softTrim": {
          "maxChars": 4000,            // 软裁剪最大字符数
          "headChars": 1500,           // 保留头部字符数
          "tailChars": 1500            // 保留尾部字符数
        },
        "hardClear": {
          "enabled": true,
          "placeholder": "[Old tool result content cleared]"
        },
        "tools": {
          "deny": ["browser", "canvas"] // 不修剪的工具
        }
      }
    }
  }
}
```

**修剪流程**:

```typescript
// cache-ttl 模式行为
// 1. 仅当上次 Anthropic 调用超过 TTL 时启用修剪
// 2. 仅影响发送给模型的内存消息
// 3. 不修改磁盘上的会话历史 (*.jsonl)
// 4. 保护最后 keepLastAssistants 条助手消息
// 5. 保护引导前缀（第一条用户消息之前的内容）

// 软裁剪 vs 硬裁剪
// 软裁剪：保留开头 + 结尾，中间插入 "..."
// 之前：toolResult("…很长的输出…")
// 之后：toolResult("HEAD…\n...\n…TAIL\n\n[Tool result trimmed: …]")

// 硬清除：用占位符替换整个工具结果
// 之前：toolResult("…很长的输出…")
// 之后：toolResult("[Old tool result content cleared]")
```

**智能默认值 (Anthropic)**:

```typescript
// OAuth 或 setup-token 配置文件：
// - 启用 cache-ttl 修剪
// - 设置心跳为 1h

// API key 配置文件：
// - 启用 cache-ttl 修剪
// - 设置心跳为 30m
// - 默认 cacheRetention: "short" 在 Anthropic 模型上

// 注意：如果显式设置了这些值，OpenClaw 不会覆盖
```

### 3.4 溢出处理与恢复

**核心文件**: 
- [`src/agents/pi-embedded-runner/run.ts`](file:///d:/prj/openclaw_analyze/src/agents/pi-embedded-runner/run.ts) - 运行时主逻辑
- [`src/agents/pi-embedded-runner/run/attempt.ts`](file:///d:/prj/openclaw_analyze/src/agents/pi-embedded-runner/run/attempt.ts) - 运行尝试
- [`src/agents/pi-embedded-runner/run/overflow-compaction.fixture.ts`](file:///d:/prj/openclaw_analyze/src/agents/pi-embedded-runner/run/overflow-compaction.fixture.ts) - 溢出压缩测试夹具

**主要功能**:
- 检测上下文溢出错误
- 自动触发压缩并重试
- 故障转移机制
- 超时保护

**溢出检测**:

```typescript
// 检测可能的上下文溢出错误
export function isLikelyContextOverflowError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  
  const message = error.message.toLowerCase();
  return (
    message.includes("context length") ||
    message.includes("maximum context length") ||
    message.includes("context window") ||
    message.includes("too many tokens") ||
    message.includes("context_overflow")
  );
}

// 从错误中提取观察到的溢出 token 数量
export function extractObservedOverflowTokenCount(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  
  const match = error.message.match(/(\d+)\s*(?:tokens?|token)/i);
  return match ? parseInt(match[1], 10) : undefined;
}
```

**溢出恢复流程**:

```typescript
// 运行时溢出处理主循环
export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  const usageAccumulator = createUsageAccumulator();
  let lastError: unknown;
  
  // 最大重试迭代次数
  const maxIterations = resolveMaxRunRetryIterations(profileCandidateCount);
  
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    try {
      // 执行单次运行尝试
      const result = await runEmbeddedAttempt({
        ...params,
        // 传递累积的使用情况
        usageAccumulator,
      });
      
      // 成功后检查是否需要自动压缩
      if (shouldAutoCompact(result)) {
        await triggerAutoCompaction(result);
      }
      
      return result;
    } catch (error) {
      lastError = error;
      
      // 检查是否为上下文溢出
      if (isLikelyContextOverflowError(error)) {
        // 触发压缩并重试
        await handleOverflowCompaction(params, error);
        continue;
      }
      
      // 检查是否为故障转移错误
      if (error instanceof FailoverError) {
        // 应用故障转移策略
        await handleFailover(error);
        continue;
      }
      
      // 其他错误：可能重试或抛出
      if (!shouldRetry(error)) {
        throw error;
      }
    }
  }
  
  // 所有重试失败
  throw lastError;
}
```

**压缩超时处理**:

```typescript
// 压缩超时信号类型
export type CompactionTimeoutSignal = {
  isTimeout: boolean;
  isCompactionPendingOrRetrying: boolean;
  isCompactionInFlight: boolean;
};

// 判断是否应该标记压缩超时
export function shouldFlagCompactionTimeout(signal: CompactionTimeoutSignal): boolean {
  if (!signal.isTimeout) return false;
  return signal.isCompactionPendingOrRetrying || signal.isCompactionInFlight;
}

// 解析运行超时期间的压缩宽限期
export function resolveRunTimeoutDuringCompaction(params: {
  isCompactionPendingOrRetrying: boolean;
  isCompactionInFlight: boolean;
  graceAlreadyUsed: boolean;
}): "extend" | "abort" {
  if (!params.isCompactionPendingOrRetrying && !params.isCompactionInFlight) {
    return "abort";
  }
  return params.graceAlreadyUsed ? "abort" : "extend";
}

// 选择压缩超时快照
export function selectCompactionTimeoutSnapshot(
  params: SnapshotSelectionParams,
): SnapshotSelection {
  if (!params.timedOutDuringCompaction) {
    return {
      messagesSnapshot: params.currentSnapshot,
      sessionIdUsed: params.currentSessionId,
      source: "current",
    };
  }

  // 超时发生在压缩期间：优先使用预压缩快照
  if (params.preCompactionSnapshot) {
    return {
      messagesSnapshot: params.preCompactionSnapshot,
      sessionIdUsed: params.preCompactionSessionId,
      source: "pre-compaction",
    };
  }

  // 回退到当前快照
  return {
    messagesSnapshot: params.currentSnapshot,
    sessionIdUsed: params.currentSessionId,
    source: "current",
  };
}
```

### 3.5 压缩前内存刷新 (Pre-compaction Memory Flush)

**核心文件**: 
- [`src/agents/pi-settings.ts`](file:///d:/prj/openclaw_analyze/src/agents/pi-settings.ts) - Pi 设置
- [`docs/reference/session-management-compaction.md`](file:///d:/prj/openclaw_analyze/docs/reference/session-management-compaction.md) - 会话管理深入文档

**主要功能**:
- 在自动压缩前运行静默的 agentic 轮次
- 将关键状态写入磁盘（如 memory/YYYY-MM-DD.md）
- 使用 NO_REPLY 标记避免用户可见输出
- 防止压缩擦除关键上下文

**配置**:

```json5
{
  "agents": {
    "defaults": {
      "compaction": {
        "memoryFlush": {
          "enabled": true,              // 默认启用
          "softThresholdTokens": 4000,  // 软阈值（低于 Pi 的压缩阈值）
          "prompt": "Write a detailed memory update...",
          "systemPrompt": "Use NO_REPLY to suppress output..."
        }
      }
    }
  }
}
```

**工作流程**:

```
1. 监控会话上下文使用情况
   ↓
2. 当超过软阈值（softThresholdTokens）
   ↓
3. 运行静默的 "write memory now" 指令
   ├─ 使用 NO_REPLY 提示抑制输出
   ├─ 写入 memory/YYYY-MM-DD.md
   └─ 更新 sessions.json 的 memoryFlushAt
   ↓
4. 继续正常操作直到触发压缩
   ↓
5. 压缩后，关键状态已持久化
```

**实现细节**:

```typescript
// 确保 Pi 压缩保留 token 的安全下限
export function ensurePiCompactionReserveTokens(params: {
  compactionSettings: CompactionSettings;
  config: OpenClawConfig;
}): CompactionSettings {
  const floor = params.config?.agents?.defaults?.compaction?.reserveTokensFloor ?? 20000;
  
  if (params.compactionSettings.reserveTokens < floor) {
    // 提升到安全下限
    return {
      ...params.compactionSettings,
      reserveTokens: floor,
    };
  }
  
  // 已经高于下限，保持不变
  return params.compactionSettings;
}

// 为什么需要安全下限：
// 为多轮"housekeeping"（如内存写入）留出足够的空间
// 避免在压缩前就耗尽上下文
```

## 四、主要场景与实现流程

### 场景 1: 正常对话中的上下文管理

```
用户消息
  ↓
1. 消息预处理
   ├─ 解析消息内容
   ├─ 识别发送者
   └─ 确定会话上下文
  ↓
2. 上下文加载
   ├─ 从 transcript 加载历史消息
   ├─ 应用最近的 compaction 总结
   └─ 保留 keepRecentTokens 条消息
  ↓
3. 上下文修剪（如果启用）
   ├─ 检查 TTL 是否过期
   ├─ 软裁剪过大的工具结果
   └─ 硬清除旧工具结果
  ↓
4. 构建请求上下文
   ├─ 添加系统提示词
   ├─ 添加工具定义
   ├─ 添加历史消息
   └─ 添加当前用户消息
  ↓
5. 发送到 LLM
   ├─ 检查上下文窗口限制
   ├─ 应用故障转移策略
   └─ 执行 API 调用
  ↓
6. 处理响应
   ├─ 累积 token 使用情况
   ├─ 更新会话存储
   └─ 检查是否需要自动压缩
  ↓
7. 自动压缩检查
   ├─ 如果 contextTokens > contextWindow - reserveTokens
   ├─ 触发后台压缩
   └─ 继续正常流程
```

### 场景 2: 上下文溢出自动恢复

```
LLM API 调用
  ↓
1. 捕获上下文溢出错误
   ├─ isLikelyContextOverflowError(error)
   ├─ 提取溢出 token 数量
   └─ 记录诊断信息
  ↓
2. 触发溢出压缩
   ├─ 创建压缩诊断 ID
   ├─ 标记会话为压缩中
   └─ 停止当前运行尝试
  ↓
3. 执行压缩
   ├─ 收集会话消息
   ├─ 应用工具结果安全过滤
   ├─ 分阶段总结（summarizeInStages）
   ├─ 写入 compaction 记录
   └─ 更新 compactionCount
  ↓
4. 重试运行
   ├─ 使用压缩后的上下文
   ├─ 重置运行参数
   └─ 重新执行 runEmbeddedAttempt
  ↓
5. 成功或失败
   ├─ 成功：返回结果
   └─ 失败：继续故障转移或抛出错误
```

### 场景 3: 手动压缩 (/compact)

```
用户发送 /compact
  ↓
1. 命令解析
   ├─ 识别为压缩命令
   ├─ 验证权限
   └─ 获取会话上下文
  ↓
2. 准备压缩
   ├─ 加载完整会话历史
   ├─ 计算当前 token 使用
   └─ 确定压缩参数
  ↓
3. 执行压缩
   ├─ 调用 runCompactionSafeguard
   ├─ 生成总结
   └─ 持久化 compaction 记录
  ↓
4. 后压缩处理
   ├─ 读取 AGENTS.md 关键章节
   ├─ 注入后压缩上下文
   └─ 更新会话状态
  ↓
5. 返回结果
   ├─ 显示压缩统计
   ├─ 显示新的 token 使用
   └─ 提示压缩完成
```

### 场景 4: 工具结果导致的上下文膨胀

```
工具执行返回大结果
  ↓
1. 工具结果处理
   ├─ 估计 token 大小
   ├─ 检查是否超过阈值
   └─ 应用安全过滤
  ↓
2. 上下文膨胀检测
   ├─ 计算总 contextTokens
   ├─ 与阈值比较
   └─ 判断是否需要修剪
  ↓
3. 上下文修剪（如果启用）
   ├─ 识别可修剪的工具结果
   ├─ 应用软裁剪（保留头尾）
   └─ 或应用硬清除（替换为占位符）
  ↓
4. 如果仍然超过限制
   ├─ 触发自动压缩
   ├─ 总结旧消息
   └─ 保留最近的消息
  ↓
5. 继续处理
   ├─ 使用修剪/压缩后的上下文
   └─ 发送到 LLM
```

## 五、关键数据结构

### 5.1 会话存储 (sessions.json)

```typescript
interface SessionEntry {
  sessionId: string;                      // 当前 transcript ID
  updatedAt: number;                      // 最后活动时间戳
  sessionFile?: string;                   // 可选的 transcript 路径覆盖
  chatType: "direct" | "group" | "room";  // 聊天类型
  
  // 元数据
  provider?: string;
  subject?: string;
  room?: string;
  space?: string;
  displayName?: string;
  
  // 会话切换
  thinkingLevel?: ThinkLevel;
  verboseLevel?: boolean;
  reasoningLevel?: ReasoningLevel;
  elevatedLevel?: ElevatedLevel;
  sendPolicy?: SendPolicy;
  
  // 模型选择
  providerOverride?: string;
  modelOverride?: string;
  authProfileOverride?: string;
  
  // Token 计数器（尽力而为/依赖提供者）
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  
  // 压缩统计
  compactionCount: number;                // 自动压缩完成次数
  
  // 内存刷新
  memoryFlushAt?: number;                 // 上次压缩前内存刷新时间戳
  memoryFlushCompactionCount?: number;    // 上次刷新时的压缩次数
}
```

### 5.2 Transcript 结构 (*.jsonl)

```typescript
// JSONL 格式：每行一个 JSON 对象

// 第一行：会话头
{
  type: "session",
  id: string,
  cwd: string,
  timestamp: number,
  parentSession?: string
}

// 后续行：会话条目（带有 id + parentId 的树结构）
{
  id: string,
  parentId: string,
  type: "message" | "custom_message" | "custom" | "compaction" | "branch_summary",
  // ... 其他字段取决于类型
}

// Compaction 条目
{
  type: "compaction",
  summary: string,                      // 压缩总结
  firstKeptEntryId: string,             // 第一个保留的条目 ID
  tokensBefore: number,                 // 压缩前的 token 数
  timestamp: number
}
```

### 5.3 消息类型

```typescript
interface AgentMessage {
  role: "user" | "assistant" | "toolResult" | "system";
  content: string | unknown;
  timestamp?: number;
  toolCallId?: string;        // toolResult 类型需要
  toolName?: string;          // toolResult 类型需要
  details?: unknown;          // 工具执行详情（可能被过滤）
  isError?: boolean;          // toolResult 是否为错误
}
```

## 六、配置参考

### 6.1 压缩配置

```json5
{
  "agents": {
    "defaults": {
      "compaction": {
        // 压缩模式
        "mode": "auto",                    // auto | manual | off
        
        // 目标 token 数（压缩后保留）
        "targetTokens": 50000,
        
        // 保留 token（用于提示词和输出）
        "reserveTokens": 16384,
        
        // 保留最近的 token
        "keepRecentTokens": 20000,
        
        // 压缩安全下限
        "reserveTokensFloor": 20000,
        
        // 内存刷新
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 4000,
          "prompt": "Write a detailed memory update...",
          "systemPrompt": "Use NO_REPLY..."
        },
        
        // 压缩模型覆盖
        "model": "anthropic/claude-sonnet-4-20250514",
        
        // 后压缩章节注入
        "postCompactionSections": ["Session Startup", "Red Lines"],
        
        // 标识符保护
        "identifierPolicy": "strict",      // strict | off | custom
        "identifierInstructions": "..."    // custom 模式使用
      }
    }
  }
}
```

### 6.2 上下文修剪配置

```json5
{
  "agents": {
    "defaults": {
      "contextPruning": {
        // 模式
        "mode": "cache-ttl",               // off | cache-ttl
        
        // TTL 控制
        "ttl": "1h",                       // 持续时间
        
        // 保留设置
        "keepLastAssistants": 3,
        
        // 阈值
        "softTrimRatio": 0.3,
        "hardClearRatio": 0.5,
        "minPrunableToolChars": 50000,
        
        // 软裁剪设置
        "softTrim": {
          "maxChars": 4000,
          "headChars": 1500,
          "tailChars": 1500
        },
        
        // 硬清除设置
        "hardClear": {
          "enabled": true,
          "placeholder": "[Old tool result content cleared]"
        },
        
        // 工具排除
        "tools": {
          "deny": ["browser", "canvas"]
        }
      }
    }
  }
}
```

### 6.3 上下文窗口限制

```json5
{
  // 全局上下文窗口限制
  "agents": {
    "defaults": {
      "contextTokens": 100000  // 限制所有代理
    }
  },
  
  // 模型特定配置
  "models": {
    "providers": {
      "anthropic": {
        "models": [
          {
            "id": "claude-sonnet-4-20250514",
            "contextWindow": 200000
          }
        ]
      }
    }
  }
}
```

## 七、监控与调试

### 7.1 查看上下文状态

```bash
# 查看会话状态（包含 token 使用）
openclaw status

# 查看会话列表（JSON 格式）
openclaw sessions --json

# 在聊天中查看状态
/status

# 查看详细上下文报告
/context
```

### 7.2 压缩统计

```typescript
// 从 sessions.json 中读取
{
  "compactionCount": 5,              // 自动压缩次数
  "memoryFlushAt": 1234567890,       // 上次内存刷新时间
  "memoryFlushCompactionCount": 3,   // 刷新时的压缩次数
  "contextTokens": 85000,            // 当前上下文 token
  "totalTokens": 150000              // 累计 token
}
```

### 7.3 调试技巧

```typescript
// 1. 启用详细日志
openclaw gateway --verbose

// 2. 查看压缩日志
// 在日志中搜索 "compaction" 或 "🧹"

// 3. 检查 transcript 文件
// ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl

// 4. 检查 sessions.json
// ~/.openclaw/agents/<agentId>/sessions/sessions.json

// 5. 手动触发压缩测试
/compact

// 6. 重置会话（如果上下文问题严重）
/new 或 /reset
```

### 7.4 常见问题排查

**问题 1: 压缩过于频繁**

```
可能原因:
- 模型上下文窗口太小
- reserveTokens 设置太高
- 工具结果过于庞大

解决方案:
1. 检查模型上下文窗口配置
2. 降低 reserveTokens（但不要太低）
3. 启用 contextPruning 减少工具结果膨胀
4. 使用更大的上下文窗口模型
```

**问题 2: 上下文仍然溢出**

```
可能原因:
- 压缩阈值设置不当
- 工具结果没有被正确修剪
- 消息估计不准确

解决方案:
1. 检查 compaction.reserveTokens 设置
2. 启用 contextPruning.mode: "cache-ttl"
3. 检查 SAFETY_MARGIN (1.2) 是否足够
4. 考虑使用 contextTokens 限制
```

**问题 3: 压缩后丢失重要信息**

```
可能原因:
- 标识符保护未启用
- 内存刷新未配置
- 自定义指令不足

解决方案:
1. 设置 identifierPolicy: "strict"
2. 启用 memoryFlush.enabled: true
3. 添加自定义压缩指令
4. 使用 /compact 手动控制压缩时机
```

## 八、性能优化建议

### 8.1 减少上下文增长

1. **启用上下文修剪**
   ```json5
   {
     "contextPruning": {
       "mode": "cache-ttl",
       "ttl": "30m"
     }
   }
   ```

2. **优化工具结果**
   - 避免返回过大的工具结果
   - 使用流式处理大文件
   - 对工具结果进行摘要

3. **合理使用会话**
   - 为新任务使用 `/new` 创建新会话
   - 定期使用 `/compact` 手动压缩
   - 使用子代理处理长期任务

### 8.2 提高压缩效率

1. **使用专用压缩模型**
   ```json5
   {
     "compaction": {
       "model": "anthropic/claude-sonnet-4-20250514"
     }
   }
   ```

2. **优化压缩参数**
   ```json5
   {
     "compaction": {
       "reserveTokens": 16384,      // 不要太高
       "keepRecentTokens": 20000,   // 根据需求调整
       "targetTokens": 50000        // 压缩后目标
     }
   }
   ```

3. **启用内存刷新**
   ```json5
   {
     "memoryFlush": {
       "enabled": true,
       "softThresholdTokens": 4000
     }
   }
   ```

### 8.3 监控和告警

```typescript
// 上下文窗口守卫
export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
}): ContextWindowGuardResult {
  const warnBelow = Math.max(1, Math.floor(
    params.warnBelowTokens ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS
  )); // 默认 32000
  const hardMin = Math.max(1, Math.floor(
    params.hardMinTokens ?? CONTEXT_WINDOW_HARD_MIN_TOKENS
  )); // 默认 16000
  
  return {
    ...params.info,
    shouldWarn: params.info.tokens > 0 && 
                params.info.tokens < warnBelow,
    shouldBlock: params.info.tokens > 0 && 
                 params.info.tokens < hardMin,
  };
}
```

## 九、总结

OpenClaw 的 LLM 上下文窗口管理系统具有以下特点：

### 核心优势

1. **多层次保护**
   - 上下文窗口发现和配置
   - 自动压缩和手动压缩
   - 上下文修剪
   - 溢出恢复机制

2. **智能优化**
   - 自适应块比例计算
   - 分阶段总结
   - 标识符保护
   - 工具结果安全处理

3. **灵活配置**
   - 支持多种压缩模式
   - 可配置的修剪策略
   - 模型特定的上下文窗口
   - 自定义压缩指令

4. **可靠性保障**
   - 压缩超时保护
   - 故障转移机制
   - 内存刷新持久化
   - 详细的错误处理和重试

### 最佳实践

1. **根据使用场景选择合适的模型**（上下文窗口大小）
2. **启用自动压缩和上下文修剪**
3. **配置内存刷新防止重要信息丢失**
4. **定期监控上下文使用情况**
5. **为新任务使用新会话避免上下文污染**

通过这套完整的上下文窗口管理体系，OpenClaw 能够有效地管理 LLM 上下文，平衡性能、成本和用户体验。
