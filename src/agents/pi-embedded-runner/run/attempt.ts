// Node.js核心模块
import fs from "node:fs/promises"; // 文件系统操作
import os from "node:os"; // 操作系统信息
// 核心Agent SDK依赖
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core"; // Agent核心类型
import { streamSimple } from "@mariozechner/pi-ai"; // AI模型流处理基础实现
import {
  createAgentSession, // 创建Agent会话
  DefaultResourceLoader, // 默认资源加载器
  SessionManager, // 会话管理器，负责会话历史的持久化
} from "@mariozechner/pi-coding-agent";
// 第三方渠道扩展
import { resolveSignalReactionLevel } from "../../../../extensions/signal/src/reaction-level.js"; // Signal消息反应等级
import { resolveTelegramInlineButtonsScope } from "../../../../extensions/telegram/src/inline-buttons.js"; // Telegram内联按钮
import { resolveTelegramReactionLevel } from "../../../../extensions/telegram/src/reaction-level.js"; // Telegram消息反应等级
// 自动回复模块
import { resolveHeartbeatPrompt } from "../../../auto-reply/heartbeat.js"; // 心跳自动回复提示
// 配置与基础设施
import { resolveChannelCapabilities } from "../../../config/channel-capabilities.js"; // 渠道能力解析
import type { OpenClawConfig } from "../../../config/config.js"; // 全局配置类型
import { getMachineDisplayName } from "../../../infra/machine-name.js"; // 获取机器显示名称
import {
  ensureGlobalUndiciEnvProxyDispatcher, // 配置全局HTTP代理
  ensureGlobalUndiciStreamTimeouts, // 配置全局流超时
} from "../../../infra/net/undici-global-dispatcher.js";
import { MAX_IMAGE_BYTES } from "../../../media/constants.js"; // 图片处理常量
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js"; // 插件Hook运行器
import type {
  PluginHookAgentContext, // Hook上下文类型
  PluginHookBeforeAgentStartResult, // before_agent_start Hook返回类型
  PluginHookBeforePromptBuildResult, // before_prompt_build Hook返回类型
} from "../../../plugins/types.js";
// 路由与会话
import { isCronSessionKey, isSubagentSessionKey } from "../../../routing/session-key.js"; // 会话Key类型判断
// 通用工具
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js"; // 文本片段合并工具
import { buildTtsSystemPromptHint } from "../../../tts/tts.js"; // TTS系统提示构建
import { resolveUserPath } from "../../../utils.js"; // 用户路径解析
import { normalizeMessageChannel } from "../../../utils/message-channel.js"; // 消息渠道标准化
import { isReasoningTagProvider } from "../../../utils/provider-utils.js"; // 推理标签提供者判断
import { resolveOpenClawAgentDir } from "../../agent-paths.js";
import { resolveSessionAgentIds } from "../../agent-scope.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
  buildBootstrapInjectionStats,
} from "../../bootstrap-budget.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../../bootstrap-files.js";
import { createCacheTrace } from "../../cache-trace.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolHints,
} from "../../channel-tools.js";
import { ensureCustomApiRegistered } from "../../custom-api-registry.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { resolveOpenClawDocsPath } from "../../docs-path.js";
import { isTimeoutError } from "../../failover-error.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import { normalizeProviderId, resolveDefaultModelForAgent } from "../../model-selection.js";
import { supportsModelTools } from "../../model-tool-support.js";
import { createConfiguredOllamaStreamFn } from "../../ollama-stream.js";
import { createOpenAIWebSocketStreamFn, releaseWsSession } from "../../openai-ws-stream.js";
import { resolveOwnerDisplaySetting } from "../../owner-display.js";
import {
  downgradeOpenAIFunctionCallReasoningPairs,
  isCloudCodeAssistFormatError,
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../../pi-embedded-helpers.js";
import { subscribeEmbeddedPiSession } from "../../pi-embedded-subscribe.js";
import { createPreparedEmbeddedPiSettingsManager } from "../../pi-project-settings.js";
import { applyPiAutoCompactionGuard } from "../../pi-settings.js";
import { toClientToolDefinitions } from "../../pi-tool-definition-adapter.js";
import { createOpenClawCodingTools, resolveToolLoopDetectionConfig } from "../../pi-tools.js";
import { resolveSandboxContext } from "../../sandbox.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { isXaiProvider } from "../../schema/clean-for-xai.js";
import { repairSessionFileIfNeeded } from "../../session-file-repair.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../../session-transcript-repair.js";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
} from "../../session-write-lock.js";
import { detectRuntimeShell } from "../../shell-utils.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  resolveSkillsPromptForRun,
} from "../../skills.js";
import { buildSystemPromptParams } from "../../system-prompt-params.js";
import { buildSystemPromptReport } from "../../system-prompt-report.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../../tool-call-id.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../../tool-fs-policy.js";
import { normalizeToolName } from "../../tool-policy.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../../workspace.js";
import { isRunnerAbortError } from "../abort.js";
import { appendCacheTtlTimestamp, isCacheTtlEligibleProvider } from "../cache-ttl.js";
import type { CompactEmbeddedPiSessionParams } from "../compact.js";
import { resolveCompactionTimeoutMs } from "../compaction-safety-timeout.js";
import { buildEmbeddedExtensionFactories } from "../extensions.js";
import { applyExtraParamsToAgent } from "../extra-params.js";
import {
  logToolSchemasForGoogle,
  sanitizeSessionHistory,
  sanitizeToolsForGoogle,
} from "../google.js";
import { getDmHistoryLimitFromSessionKey, limitHistoryTurns } from "../history.js";
import { log } from "../logger.js";
import { buildModelAliasLines } from "../model.js";
import {
  clearActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSnapshot,
} from "../runs.js";
import { buildEmbeddedSandboxInfo } from "../sandbox-info.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "../session-manager-cache.js";
import { prepareSessionManagerForRun } from "../session-manager-init.js";
import { resolveEmbeddedRunSkillEntries } from "../skills-runtime.js";
import {
  applySystemPromptOverrideToSession,
  buildEmbeddedSystemPrompt,
  createSystemPromptOverride,
} from "../system-prompt.js";
import { dropThinkingBlocks } from "../thinking.js";
import { collectAllowedToolNames } from "../tool-name-allowlist.js";
import { installToolResultContextGuard } from "../tool-result-context-guard.js";
import { splitSdkTools } from "../tool-split.js";
import { describeUnknownError, mapThinkingLevel } from "../utils.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import { waitForCompactionRetryWithAggregateTimeout } from "./compaction-retry-aggregate-timeout.js";
import {
  resolveRunTimeoutDuringCompaction,
  resolveRunTimeoutWithCompactionGraceMs,
  selectCompactionTimeoutSnapshot,
  shouldFlagCompactionTimeout,
} from "./compaction-timeout.js";
import { pruneProcessedHistoryImages } from "./history-image-prune.js";
import { detectAndLoadPromptImages } from "./images.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/**
 * Prompt构建Hook运行器接口
 * 定义了插件系统中与prompt构建相关的Hook调用方法
 */
type PromptBuildHookRunner = {
  // 检查是否存在指定类型的Hook
  hasHooks: (hookName: "before_prompt_build" | "before_agent_start") => boolean;
  // 执行prompt构建前Hook，允许插件修改系统提示和上下文
  runBeforePromptBuild: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforePromptBuildResult | undefined>;
  // 执行Agent启动前Hook，兼容旧版插件系统
  runBeforeAgentStart: (
    event: { prompt: string; messages: unknown[] },
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforeAgentStartResult | undefined>;
};

// 会话让步中断消息类型，用于中断当前执行流
const SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE = "openclaw.sessions_yield_interrupt";
// 会话让步上下文消息类型，用于记录让步原因
const SESSIONS_YIELD_CONTEXT_CUSTOM_TYPE = "openclaw.sessions_yield";

/**
 * 构建会话让步上下文消息
 * 保存让步原因到会话历史，让下一轮执行知道之前为什么停止
 * @param message 让步原因描述
 * @returns 格式化的上下文消息
 */
function buildSessionsYieldContextMessage(message: string): string {
  return `${message}\n\n[Context: The previous turn ended intentionally via sessions_yield while waiting for a follow-up event.]`;
}

/**
 * 创建让步中止响应
 * 生成一个模拟的中止响应，让pi-agent-core无需实际调用模型就能正常结束当前轮次
 * 用于会话让步场景，避免不必要的模型调用开销
 * @param model 模型信息，用于填充响应元数据
 * @returns 符合StreamFn返回格式的中止响应
 */
function createYieldAbortedResponse(model: { api?: string; provider?: string; id?: string }): {
  [Symbol.asyncIterator]: () => AsyncGenerator<never, void, unknown>;
  result: () => Promise<{
    role: "assistant";
    content: Array<{ type: "text"; text: string }>;
    stopReason: "aborted";
    api: string;
    provider: string;
    model: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    };
    timestamp: number;
  }>;
} {
  // 构造空的assistant消息，标记为aborted状态
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "" }],
    stopReason: "aborted" as const, // 中止状态
    api: model.api ?? "",
    provider: model.provider ?? "",
    model: model.id ?? "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    timestamp: Date.now(),
  };
  return {
    // 空的异步迭代器，模拟流结束
    async *[Symbol.asyncIterator]() {},
    // 直接返回构造的中止消息
    result: async () => message,
  };
}

/**
 * 插入会话让步中断消息
 * 向会话中插入一条隐藏的控制消息，让pi-agent-core跳过剩余的工具调用
 * 用于在让步场景下优雅中断当前执行流
 * @param activeSession 当前活动会话对象
 */
function queueSessionsYieldInterruptMessage(activeSession: {
  agent: { steer: (message: AgentMessage) => void };
}) {
  activeSession.agent.steer({
    role: "custom",
    customType: SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE,
    content: "[sessions_yield interrupt]",
    display: false, // 该消息不会显示给用户
    details: { source: "sessions_yield" },
    timestamp: Date.now(),
  });
}

/**
 * 持久化会话让步上下文消息
 * 将让步原因作为隐藏消息保存到会话历史中，下一轮执行可以读取上下文
 * @param activeSession 当前活动会话对象
 * @param message 让步原因描述
 */
async function persistSessionsYieldContextMessage(
  activeSession: {
    sendCustomMessage: (
      message: {
        customType: string;
        content: string;
        display: boolean;
        details?: Record<string, unknown>;
      },
      options?: { triggerTurn?: boolean },
    ) => Promise<void>;
  },
  message: string,
) {
  await activeSession.sendCustomMessage(
    {
      customType: SESSIONS_YIELD_CONTEXT_CUSTOM_TYPE,
      content: buildSessionsYieldContextMessage(message),
      display: false, // 该消息不会显示给用户
      details: { source: "sessions_yield", message },
    },
    { triggerTurn: false }, // 不触发新的执行轮次
  );
}

/**
 * 清理会话让步产生的临时消息
 * 从会话历史中移除让步机制产生的中断消息和中止响应，避免污染持久化的会话历史
 * @param activeSession 当前活动会话对象
 */
function stripSessionsYieldArtifacts(activeSession: {
  messages: AgentMessage[];
  agent: { replaceMessages: (messages: AgentMessage[]) => void };
  sessionManager?: unknown;
}) {
  const strippedMessages = activeSession.messages.slice();
  while (strippedMessages.length > 0) {
    const last = strippedMessages.at(-1) as
      | AgentMessage
      | { role?: string; customType?: string; stopReason?: string };
    if (last?.role === "assistant" && "stopReason" in last && last.stopReason === "aborted") {
      strippedMessages.pop();
      continue;
    }
    if (
      last?.role === "custom" &&
      "customType" in last &&
      last.customType === SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE
    ) {
      strippedMessages.pop();
      continue;
    }
    break;
  }
  if (strippedMessages.length !== activeSession.messages.length) {
    activeSession.agent.replaceMessages(strippedMessages);
  }

  const sessionManager = activeSession.sessionManager as
    | {
        fileEntries?: Array<{
          type?: string;
          id?: string;
          parentId?: string | null;
          message?: { role?: string; stopReason?: string };
          customType?: string;
        }>;
        byId?: Map<string, { id: string }>;
        leafId?: string | null;
        _rewriteFile?: () => void;
      }
    | undefined;
  const fileEntries = sessionManager?.fileEntries;
  const byId = sessionManager?.byId;
  if (!fileEntries || !byId) {
    return;
  }

  let changed = false;
  while (fileEntries.length > 1) {
    const last = fileEntries.at(-1);
    if (!last || last.type === "session") {
      break;
    }
    const isYieldAbortAssistant =
      last.type === "message" &&
      last.message?.role === "assistant" &&
      last.message?.stopReason === "aborted";
    const isYieldInterruptMessage =
      last.type === "custom_message" && last.customType === SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE;
    if (!isYieldAbortAssistant && !isYieldInterruptMessage) {
      break;
    }
    fileEntries.pop();
    if (last.id) {
      byId.delete(last.id);
    }
    sessionManager.leafId = last.parentId ?? null;
    changed = true;
  }
  if (changed) {
    sessionManager._rewriteFile?.();
  }
}

/**
 * 判断是否为Ollama兼容的模型提供者
 * 支持三种识别方式：
 * 1. 显式配置provider为"ollama"
 * 2. 运行在本地11434端口的OpenAI兼容服务
 * 3. provider名称包含"ollama"且运行在11434端口的远程服务
 * @param model 模型信息
 * @returns 是否为Ollama兼容模型
 */
export function isOllamaCompatProvider(model: {
  provider?: string;
  baseUrl?: string;
  api?: string;
}): boolean {
  const providerId = normalizeProviderId(model.provider ?? "");
  // 1. 显式Ollama提供者直接返回true
  if (providerId === "ollama") {
    return true;
  }
  if (!model.baseUrl) {
    return false;
  }
  try {
    const parsed = new URL(model.baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    // 检查是否为本地地址
    const isLocalhost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]";
    // 2. 本地运行在默认端口11434的服务自动识别为Ollama
    if (isLocalhost && parsed.port === "11434") {
      return true;
    }

    // 3. 远程/LAN服务：provider名称包含ollama、端口是11434、路径兼容OpenAI格式
    const providerHintsOllama = providerId.includes("ollama");
    const isOllamaPort = parsed.port === "11434";
    const isOllamaCompatPath = parsed.pathname === "/" || /^\/v1\/?$/i.test(parsed.pathname);
    return providerHintsOllama && isOllamaPort && isOllamaCompatPath;
  } catch {
    // URL解析失败则不是Ollama服务
    return false;
  }
}

/**
 * 解析是否启用Ollama兼容的num_ctx参数注入
 * 可以通过配置文件针对不同provider启用/禁用该功能
 * @param params 配置参数
 * @returns 是否启用num_ctx注入
 */
export function resolveOllamaCompatNumCtxEnabled(params: {
  config?: OpenClawConfig;
  providerId?: string;
}): boolean {
  const providerId = params.providerId?.trim();
  if (!providerId) {
    return true; // 默认启用
  }
  const providers = params.config?.models?.providers;
  if (!providers) {
    return true; // 无配置时默认启用
  }
  // 精确匹配provider配置
  const direct = providers[providerId];
  if (direct) {
    return direct.injectNumCtxForOpenAICompat ?? true;
  }
  // 标准化后匹配provider配置（大小写不敏感等）
  const normalized = normalizeProviderId(providerId);
  for (const [candidateId, candidate] of Object.entries(providers)) {
    if (normalizeProviderId(candidateId) === normalized) {
      return candidate.injectNumCtxForOpenAICompat ?? true;
    }
  }
  return true; // 未找到配置时默认启用
}

/**
 * 判断是否需要为当前模型注入Ollama兼容的num_ctx参数
 * 注入条件：
 * 1. 使用OpenAI兼容API
 * 2. 是Ollama兼容模型
 * 3. 配置中启用了num_ctx注入
 * @param params 参数
 * @returns 是否需要注入num_ctx
 */
export function shouldInjectOllamaCompatNumCtx(params: {
  model: { api?: string; provider?: string; baseUrl?: string };
  config?: OpenClawConfig;
  providerId?: string;
}): boolean {
  // 仅适用于OpenAI兼容接口的模型
  if (params.model.api !== "openai-completions") {
    return false;
  }
  // 必须是Ollama兼容模型
  if (!isOllamaCompatProvider(params.model)) {
    return false;
  }
  // 检查配置是否启用
  return resolveOllamaCompatNumCtxEnabled({
    config: params.config,
    providerId: params.providerId,
  });
}

/**
 * 包装流函数，为Ollama模型注入num_ctx参数
 * Ollama需要显式指定上下文窗口大小(num_ctx)，否则会使用默认值，无法充分利用模型的上下文能力
 * @param baseFn 原始流函数
 * @param numCtx 上下文窗口大小，通常等于模型的最大上下文token数
 * @returns 包装后的流函数，会自动注入num_ctx参数
 */
export function wrapOllamaCompatNumCtx(baseFn: StreamFn | undefined, numCtx: number): StreamFn {
  const streamFn = baseFn ?? streamSimple;
  return (model, context, options) =>
    streamFn(model, context, {
      ...options,
      onPayload: (payload: unknown) => {
        if (!payload || typeof payload !== "object") {
          return options?.onPayload?.(payload, model);
        }
        const payloadRecord = payload as Record<string, unknown>;
        // 确保options对象存在
        if (!payloadRecord.options || typeof payloadRecord.options !== "object") {
          payloadRecord.options = {};
        }
        // 注入num_ctx参数到请求负载
        (payloadRecord.options as Record<string, unknown>).num_ctx = numCtx;
        return options?.onPayload?.(payload, model);
      },
    });
}

/**
 * 大小写不敏感的工具名称匹配
 * 容忍模型返回的工具名称大小写错误，提高工具调用成功率
 * @param rawName 模型返回的原始工具名称
 * @param allowedToolNames 允许使用的工具名称集合
 * @returns 匹配到的标准工具名称，匹配冲突或无匹配时返回null
 */
function resolveCaseInsensitiveAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  // 转换为小写进行匹配
  const folded = rawName.toLowerCase();
  let caseInsensitiveMatch: string | null = null;
  for (const name of allowedToolNames) {
    if (name.toLowerCase() !== folded) {
      continue;
    }
    // 如果有多个大小写不同的匹配项，说明有冲突，返回null
    if (caseInsensitiveMatch && caseInsensitiveMatch !== name) {
      return null;
    }
    caseInsensitiveMatch = name;
  }
  return caseInsensitiveMatch;
}

/**
 * 精确匹配允许使用的工具名称
 * 匹配优先级：
 * 1. 原始名称精确匹配
 * 2. 标准化后名称匹配（去除特殊字符、统一格式）
 * 3. 大小写不敏感匹配
 * @param rawName 模型返回的原始工具名称
 * @param allowedToolNames 允许使用的工具名称集合
 * @returns 匹配到的标准工具名称，无匹配时返回null
 */
function resolveExactAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  // 1. 原始名称精确匹配
  if (allowedToolNames.has(rawName)) {
    return rawName;
  }
  // 2. 标准化后名称匹配（去除特殊字符、统一格式）
  const normalized = normalizeToolName(rawName);
  if (allowedToolNames.has(normalized)) {
    return normalized;
  }
  // 3. 大小写不敏感匹配，作为兜底
  return (
    resolveCaseInsensitiveAllowedToolName(rawName, allowedToolNames) ??
    resolveCaseInsensitiveAllowedToolName(normalized, allowedToolNames)
  );
}

/**
 * 生成结构化工具名称的候选列表
 * 处理带路径/命名空间的工具名，生成各种可能的匹配形式，提高匹配成功率
 * 支持：路径分隔符转换、后缀匹配、标准化处理等
 * @param rawName 原始工具名称
 * @returns 所有可能的工具名候选列表
 */
function buildStructuredToolNameCandidates(rawName: string): string[] {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return [];
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  // 添加候选，自动去重
  const addCandidate = (value: string) => {
    const candidate = value.trim();
    if (!candidate || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    candidates.push(candidate);
  };

  // 候选1：原始名称、标准化后的原始名称
  addCandidate(trimmed);
  addCandidate(normalizeToolName(trimmed));

  // 候选2：将路径分隔符/替换为.后的名称（如github/getRepo → github.getRepo）
  const normalizedDelimiter = trimmed.replace(/\//g, ".");
  addCandidate(normalizedDelimiter);
  addCandidate(normalizeToolName(normalizedDelimiter));

  // 候选3：后缀匹配（如github.getRepo → getRepo，处理模型丢失前缀的情况）
  const segments = normalizedDelimiter
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length > 1) {
    for (let index = 1; index < segments.length; index += 1) {
      const suffix = segments.slice(index).join(".");
      addCandidate(suffix);
      addCandidate(normalizeToolName(suffix));
    }
  }

  return candidates;
}

/**
 * 结构化工具名称匹配
 * 使用生成的候选列表进行多级匹配，处理带命名空间/路径的复杂工具名
 * 匹配优先级：精确匹配 > 大小写不敏感匹配
 * @param rawName 原始工具名称
 * @param allowedToolNames 允许使用的工具名称集合
 * @returns 匹配到的标准工具名称，无匹配时返回null
 */
function resolveStructuredAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }

  // 生成所有可能的候选名称
  const candidateNames = buildStructuredToolNameCandidates(rawName);
  // 第一优先级：精确匹配
  for (const candidate of candidateNames) {
    if (allowedToolNames.has(candidate)) {
      return candidate;
    }
  }
  // 第二优先级：大小写不敏感匹配
  for (const candidate of candidateNames) {
    const caseInsensitiveMatch = resolveCaseInsensitiveAllowedToolName(candidate, allowedToolNames);
    if (caseInsensitiveMatch) {
      return caseInsensitiveMatch;
    }
  }
  // 无匹配
  return null;
}

/**
 * 从工具调用ID中推断工具名称
 * 用于修复模型返回的工具名称缺失、格式错误等情况
 * 通过分析工具调用ID中的特征片段，尝试匹配到正确的工具名称
 * @param rawId 原始工具调用ID
 * @param allowedToolNames 允许使用的工具名称集合
 * @returns 推断出的工具名称，无匹配或匹配冲突时返回null
 */
function inferToolNameFromToolCallId(
  rawId: string | undefined,
  allowedToolNames?: Set<string>,
): string | null {
  if (!rawId || !allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  const id = rawId.trim();
  if (!id) {
    return null;
  }

  const candidateTokens = new Set<string>();
  // 生成候选token，处理各种常见的ID格式
  const addToken = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    candidateTokens.add(trimmed);
    // 移除末尾的数字后缀（如read_file_1 → read_file）
    candidateTokens.add(trimmed.replace(/[:._/-]\d+$/, ""));
    candidateTokens.add(trimmed.replace(/\d+$/, ""));

    // 路径分隔符标准化
    const normalizedDelimiter = trimmed.replace(/\//g, ".");
    candidateTokens.add(normalizedDelimiter);
    candidateTokens.add(normalizedDelimiter.replace(/[:._-]\d+$/, ""));
    candidateTokens.add(normalizedDelimiter.replace(/\d+$/, ""));

    // 移除function/tool前缀（如function_readFile → readFile）
    for (const prefixPattern of [/^functions?[._-]?/i, /^tools?[._-]?/i]) {
      const stripped = normalizedDelimiter.replace(prefixPattern, "");
      if (stripped !== normalizedDelimiter) {
        candidateTokens.add(stripped);
        candidateTokens.add(stripped.replace(/[:._-]\d+$/, ""));
        candidateTokens.add(stripped.replace(/\d+$/, ""));
      }
    }
  };

  // 处理ID中的冒号前缀（如tool:read_file:123 → 取"tool:read_file"和"read_file"）
  const preColon = id.split(":")[0] ?? id;
  for (const seed of [id, preColon]) {
    addToken(seed);
  }

  // 匹配候选token，确保只有唯一匹配
  let singleMatch: string | null = null;
  for (const candidate of candidateTokens) {
    const matched = resolveStructuredAllowedToolName(candidate, allowedToolNames);
    if (!matched) {
      continue;
    }
    // 有多个不同匹配项时返回null，避免歧义
    if (singleMatch && singleMatch !== matched) {
      return null;
    }
    singleMatch = matched;
  }

  return singleMatch;
}

function looksLikeMalformedToolNameCounter(rawName: string): boolean {
  const normalizedDelimiter = rawName.trim().replace(/\//g, ".");
  return (
    /^(?:functions?|tools?)[._-]?/i.test(normalizedDelimiter) &&
    /(?:[:._-]\d+|\d+)$/.test(normalizedDelimiter)
  );
}

function normalizeToolCallNameForDispatch(
  rawName: string,
  allowedToolNames?: Set<string>,
  rawToolCallId?: string,
): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    // Keep whitespace-only placeholders unchanged unless we can safely infer
    // a canonical name from toolCallId and allowlist.
    return inferToolNameFromToolCallId(rawToolCallId, allowedToolNames) ?? rawName;
  }
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return trimmed;
  }

  const exact = resolveExactAllowedToolName(trimmed, allowedToolNames);
  if (exact) {
    return exact;
  }
  // Some providers put malformed toolCallId-like strings into `name`
  // itself (for example `functionsread3`). Recover conservatively from the
  // name token before consulting the separate id so explicit names like
  // `someOtherTool` are preserved.
  const inferredFromName = inferToolNameFromToolCallId(trimmed, allowedToolNames);
  if (inferredFromName) {
    return inferredFromName;
  }

  // If the explicit name looks like a provider-mangled tool-call id with a
  // numeric suffix, fail closed when inference is ambiguous instead of routing
  // to whichever structured candidate happens to match.
  if (looksLikeMalformedToolNameCounter(trimmed)) {
    return trimmed;
  }

  return resolveStructuredAllowedToolName(trimmed, allowedToolNames) ?? trimmed;
}

/**
 * 判断内容块是否为工具调用类型
 * 兼容不同模型的工具调用字段命名（OpenAI用toolCall，Anthropic用toolUse，其他模型用functionCall）
 * @param type 内容块类型字段
 * @returns 是否为工具调用类型
 */
function isToolCallBlockType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

/**
 * 标准化消息中的工具调用ID
 * 处理工具调用ID的重复、空值、前后空格等问题，确保每个工具调用都有唯一的ID
 * 工具调用ID用于关联工具调用和对应的工具执行结果，必须唯一
 * @param message 要处理的消息对象
 */
function normalizeToolCallIdsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }

  // 第一步：收集所有已存在的有效ID，避免冲突
  const usedIds = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") {
      continue;
    }
    const trimmedId = typedBlock.id.trim();
    if (!trimmedId) {
      continue;
    }
    usedIds.add(trimmedId);
  }

  // 第二步：为每个工具调用分配唯一ID
  let fallbackIndex = 1;
  const assignedIds = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) {
      continue;
    }
    // 处理已有ID的情况
    if (typeof typedBlock.id === "string") {
      const trimmedId = typedBlock.id.trim();
      if (trimmedId) {
        if (!assignedIds.has(trimmedId)) {
          // ID有效且未被使用，直接使用
          if (typedBlock.id !== trimmedId) {
            typedBlock.id = trimmedId;
          }
          assignedIds.add(trimmedId);
          continue;
        }
      }
    }

    // ID无效或重复，生成自动分配的ID
    let fallbackId = "";
    while (!fallbackId || usedIds.has(fallbackId) || assignedIds.has(fallbackId)) {
      fallbackId = `call_auto_${fallbackIndex++}`;
    }
    typedBlock.id = fallbackId;
    usedIds.add(fallbackId);
    assignedIds.add(fallbackId);
  }
}

/**
 * 修剪并标准化消息中的工具调用名称
 * 处理工具名称的前后空格、格式错误，自动补全缺失的工具名称，最后标准化工具调用ID
 * 解决模型返回工具名称格式不规范、名称缺失等问题，提高工具调用匹配成功率
 * @param message 要处理的消息对象
 * @param allowedToolNames 允许使用的工具名称集合
 */
function trimWhitespaceFromToolCallNamesInMessage(
  message: unknown,
  allowedToolNames?: Set<string>,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; name?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) {
      continue;
    }
    const rawId = typeof typedBlock.id === "string" ? typedBlock.id : undefined;
    // 如果有工具名称，进行标准化处理
    if (typeof typedBlock.name === "string") {
      const normalized = normalizeToolCallNameForDispatch(typedBlock.name, allowedToolNames, rawId);
      if (normalized !== typedBlock.name) {
        typedBlock.name = normalized;
      }
      continue;
    }
    // 如果工具名称缺失，尝试从工具调用ID中推断名称
    const inferred = inferToolNameFromToolCallId(rawId, allowedToolNames);
    if (inferred) {
      typedBlock.name = inferred;
    }
  }
  // 最后标准化所有工具调用的ID
  normalizeToolCallIdsInMessage(message);
}

/**
 * 包装模型响应流，实时修剪工具调用名称
 * 在流式响应的每个增量块和最终结果中都进行工具调用名称标准化处理
 * 确保流式输出过程中工具调用格式的正确性
 * @param stream 原始模型响应流
 * @param allowedToolNames 允许使用的工具名称集合
 * @returns 包装后的响应流
 */
function wrapStreamTrimToolCallNames(
  stream: ReturnType<typeof streamSimple>,
  allowedToolNames?: Set<string>,
): ReturnType<typeof streamSimple> {
  // 包装最终结果获取方法
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    trimWhitespaceFromToolCallNamesInMessage(message, allowedToolNames);
    return message;
  };

  // 包装流式迭代器，处理每个响应增量
  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as {
              partial?: unknown;
              message?: unknown;
            };
            // 对部分响应和完整消息都进行处理
            trimWhitespaceFromToolCallNamesInMessage(event.partial, allowedToolNames);
            trimWhitespaceFromToolCallNamesInMessage(event.message, allowedToolNames);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };

  return stream;
}

/**
 * 流函数包装器，为所有模型响应添加工具调用名称修剪功能
 * 高阶函数，接收原始流函数返回包装后的流函数
 * @param baseFn 原始流函数
 * @param allowedToolNames 允许使用的工具名称集合
 * @returns 包装后的流函数
 */
export function wrapStreamFnTrimToolCallNames(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    // 处理返回Promise的异步流
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamTrimToolCallNames(stream, allowedToolNames),
      );
    }
    // 处理直接返回流的同步情况
    return wrapStreamTrimToolCallNames(maybeStream, allowedToolNames);
  };
}

/**
 * 提取字符串中平衡的JSON前缀
 * 从可能不完整的JSON字符串中提取出语法完整的JSON部分，用于修复模型返回的不完整工具调用参数
 * 能够处理字符串转义、嵌套结构等复杂情况
 * @param raw 原始JSON字符串（可能不完整）
 * @returns 完整的JSON前缀，提取失败返回null
 */
function extractBalancedJsonPrefix(raw: string): string | null {
  // 跳过开头的空白字符
  let start = 0;
  while (start < raw.length && /\s/.test(raw[start] ?? "")) {
    start += 1;
  }
  // 必须以{或[开头才是有效的JSON
  const startChar = raw[start];
  if (startChar !== "{" && startChar !== "[") {
    return null;
  }

  // 括号深度计数，处理嵌套结构
  let depth = 0;
  // 是否在字符串内部
  let inString = false;
  // 是否是转义字符（前面有\）
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === undefined) {
      break;
    }
    // 处理字符串内部的转义和引号
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    // 遇到字符串开头引号
    if (char === '"') {
      inString = true;
      continue;
    }
    // 遇到左括号，深度加1
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    // 遇到右括号，深度减1
    if (char === "}" || char === "]") {
      depth -= 1;
      // 深度回到0，说明找到了完整的闭合JSON
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  // 没有找到完整的闭合结构
  return null;
}

const MAX_TOOLCALL_REPAIR_BUFFER_CHARS = 64_000;
const MAX_TOOLCALL_REPAIR_TRAILING_CHARS = 3;
const TOOLCALL_REPAIR_ALLOWED_TRAILING_RE = /^[^\s{}[\]":,\\]{1,3}$/;
const MAX_BTW_SNAPSHOT_MESSAGES = 100;

/**
 * 判断是否应该尝试修复格式错误的工具调用参数
 * 避免无意义的修复尝试，只在收到闭合括号等关键字符时才进行修复
 * @param partialJson 当前累积的部分JSON
 * @param delta 新收到的增量内容
 * @returns 是否应该尝试修复
 */
function shouldAttemptMalformedToolCallRepair(partialJson: string, delta: string): boolean {
  // 新收到的内容包含闭合括号，可能JSON已经完整
  if (/[}\]]/.test(delta)) {
    return true;
  }
  const trimmedDelta = delta.trim();
  return (
    trimmedDelta.length > 0 &&
    // 增量内容很短（最多3个字符），有可能是结尾的多余字符
    trimmedDelta.length <= MAX_TOOLCALL_REPAIR_TRAILING_CHARS &&
    // 已经收到过闭合括号，可能JSON已经完整
    /[}\]]/.test(partialJson)
  );
}

/** 工具调用参数修复结果类型 */
type ToolCallArgumentRepair = {
  args: Record<string, unknown>; // 修复后的参数对象
  trailingSuffix: string; // JSON后面的尾部多余字符
};

/**
 * 尝试解析并修复格式错误的工具调用参数
 * 处理模型返回的JSON不完整、尾部有多余字符等常见错误
 * @param raw 原始JSON字符串（可能格式错误）
 * @returns 修复结果，修复失败返回undefined
 */
function tryParseMalformedToolCallArguments(raw: string): ToolCallArgumentRepair | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  try {
    // JSON本身合法，无需修复
    JSON.parse(raw);
    return undefined;
  } catch {
    // 提取完整的JSON前缀
    const jsonPrefix = extractBalancedJsonPrefix(raw);
    if (!jsonPrefix) {
      return undefined;
    }
    // 提取JSON后面的尾部字符
    const suffix = raw.slice(raw.indexOf(jsonPrefix) + jsonPrefix.length).trim();
    // 尾部字符必须很短（最多3个）且符合允许的尾部字符规则
    if (
      suffix.length === 0 ||
      suffix.length > MAX_TOOLCALL_REPAIR_TRAILING_CHARS ||
      !TOOLCALL_REPAIR_ALLOWED_TRAILING_RE.test(suffix)
    ) {
      return undefined;
    }
    try {
      // 尝试解析提取到的完整JSON前缀
      const parsed = JSON.parse(jsonPrefix) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { args: parsed as Record<string, unknown>, trailingSuffix: suffix }
        : undefined;
    } catch {
      // 解析失败，返回undefined
      return undefined;
    }
  }
}

/**
 * 将修复后的工具调用参数写入消息中
 * @param message 要修改的消息对象
 * @param contentIndex 工具调用在内容数组中的索引
 * @param repairedArgs 修复后的参数对象
 */
function repairToolCallArgumentsInMessage(
  message: unknown,
  contentIndex: number,
  repairedArgs: Record<string, unknown>,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  const block = content[contentIndex];
  if (!block || typeof block !== "object") {
    return;
  }
  const typedBlock = block as { type?: unknown; arguments?: unknown };
  if (!isToolCallBlockType(typedBlock.type)) {
    return;
  }
  // 替换为修复后的参数
  typedBlock.arguments = repairedArgs;
}

/**
 * 清空工具调用参数，用于修复失败的情况
 * @param message 要修改的消息对象
 * @param contentIndex 工具调用在内容数组中的索引
 */
function clearToolCallArgumentsInMessage(message: unknown, contentIndex: number): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  const block = content[contentIndex];
  if (!block || typeof block !== "object") {
    return;
  }
  const typedBlock = block as { type?: unknown; arguments?: unknown };
  if (!isToolCallBlockType(typedBlock.type)) {
    return;
  }
  // 设置为空对象，避免格式错误导致后续处理失败
  typedBlock.arguments = {};
}

/**
 * 批量修复消息中所有格式错误的工具调用参数
 * @param message 要修改的消息对象
 * @param repairedArgsByIndex 按索引存储的修复后的参数映射
 */
function repairMalformedToolCallArgumentsInMessage(
  message: unknown,
  repairedArgsByIndex: Map<number, Record<string, unknown>>,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  // 遍历所有修复好的参数，逐个更新到消息中
  for (const [index, repairedArgs] of repairedArgsByIndex.entries()) {
    repairToolCallArgumentsInMessage(message, index, repairedArgs);
  }
}

/**
 * 包装模型响应流，实时修复格式错误的工具调用参数
 * 针对Kimi等模型返回的工具调用参数JSON不完整、尾部有多余字符等问题进行实时修复
 * 在流式响应过程中累积JSON内容，检测到完整结构时自动修复
 * @param stream 原始模型响应流
 * @returns 包装后的响应流
 */
function wrapStreamRepairMalformedToolCallArguments(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  // 按索引存储每个工具调用的部分JSON内容
  const partialJsonByIndex = new Map<number, string>();
  // 按索引存储每个工具调用修复后的参数
  const repairedArgsByIndex = new Map<number, Record<string, unknown>>();
  // 禁用修复的工具调用索引（内容过长等原因）
  const disabledIndices = new Set<number>();
  // 已记录过修复日志的索引，避免重复打日志
  const loggedRepairIndices = new Set<number>();

  // 包装最终结果获取方法，最后统一应用修复
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    // 应用所有修复好的参数到最终消息
    repairMalformedToolCallArgumentsInMessage(message, repairedArgsByIndex);
    // 清理状态
    partialJsonByIndex.clear();
    repairedArgsByIndex.clear();
    disabledIndices.clear();
    loggedRepairIndices.clear();
    return message;
  };

  // 包装流式迭代器，处理每个响应增量
  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as {
              type?: unknown;
              contentIndex?: unknown;
              delta?: unknown;
              partial?: unknown;
              message?: unknown;
              toolCall?: unknown;
            };
            // 处理工具调用参数增量事件
            if (
              typeof event.contentIndex === "number" &&
              Number.isInteger(event.contentIndex) &&
              event.type === "toolcall_delta" &&
              typeof event.delta === "string"
            ) {
              // 该工具调用已被禁用修复，直接跳过
              if (disabledIndices.has(event.contentIndex)) {
                return result;
              }
              // 累积该工具调用的JSON内容
              const nextPartialJson =
                (partialJsonByIndex.get(event.contentIndex) ?? "") + event.delta;
              // 内容过长，超过最大修复缓冲区，禁用修复
              if (nextPartialJson.length > MAX_TOOLCALL_REPAIR_BUFFER_CHARS) {
                partialJsonByIndex.delete(event.contentIndex);
                repairedArgsByIndex.delete(event.contentIndex);
                disabledIndices.add(event.contentIndex);
                return result;
              }
              // 保存累积的JSON内容
              partialJsonByIndex.set(event.contentIndex, nextPartialJson);
              // 判断是否需要尝试修复
              if (shouldAttemptMalformedToolCallRepair(nextPartialJson, event.delta)) {
                const repair = tryParseMalformedToolCallArguments(nextPartialJson);
                if (repair) {
                  // 修复成功，保存修复结果并更新消息
                  repairedArgsByIndex.set(event.contentIndex, repair.args);
                  repairToolCallArgumentsInMessage(event.partial, event.contentIndex, repair.args);
                  repairToolCallArgumentsInMessage(event.message, event.contentIndex, repair.args);
                  // 只打一次修复日志
                  if (!loggedRepairIndices.has(event.contentIndex)) {
                    loggedRepairIndices.add(event.contentIndex);
                    log.warn(
                      `repairing kimi-coding tool call arguments after ${repair.trailingSuffix.length} trailing chars`,
                    );
                  }
                } else {
                  // 修复失败，清空参数避免格式错误
                  repairedArgsByIndex.delete(event.contentIndex);
                  clearToolCallArgumentsInMessage(event.partial, event.contentIndex);
                  clearToolCallArgumentsInMessage(event.message, event.contentIndex);
                }
              }
            }
            // 处理工具调用结束事件
            if (
              typeof event.contentIndex === "number" &&
              Number.isInteger(event.contentIndex) &&
              event.type === "toolcall_end"
            ) {
              const repairedArgs = repairedArgsByIndex.get(event.contentIndex);
              if (repairedArgs) {
                // 将修复后的参数写入工具调用对象
                if (event.toolCall && typeof event.toolCall === "object") {
                  (event.toolCall as { arguments?: unknown }).arguments = repairedArgs;
                }
                // 应用修复到部分响应和完整消息
                repairToolCallArgumentsInMessage(event.partial, event.contentIndex, repairedArgs);
                repairToolCallArgumentsInMessage(event.message, event.contentIndex, repairedArgs);
              }
              // 清理该工具调用的状态
              partialJsonByIndex.delete(event.contentIndex);
              disabledIndices.delete(event.contentIndex);
              loggedRepairIndices.delete(event.contentIndex);
            }
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };

  return stream;
}

/**
 * 流函数包装器，为所有模型响应添加工具调用参数修复功能
 * 高阶函数，接收原始流函数返回包装后的流函数
 * @param baseFn 原始流函数
 * @returns 包装后的流函数
 */
export function wrapStreamFnRepairMalformedToolCallArguments(baseFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    // 处理返回Promise的异步流
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamRepairMalformedToolCallArguments(stream),
      );
    }
    // 处理直接返回流的同步情况
    return wrapStreamRepairMalformedToolCallArguments(maybeStream);
  };
}

/**
 * 判断是否需要修复Anthropic格式的工具调用参数
 * 目前仅针对Kimi Coding模型启用该修复
 * @param provider 模型提供者ID
 * @returns 是否需要修复
 */
function shouldRepairMalformedAnthropicToolCallArguments(provider?: string): boolean {
  return normalizeProviderId(provider ?? "") === "kimi-coding";
}

// ---------------------------------------------------------------------------
// xAI / Grok: decode HTML entities in tool call arguments
// xAI/Grok模型会将工具调用参数中的特殊字符转义为HTML实体，需要解码才能正确使用
// ---------------------------------------------------------------------------

/** 匹配HTML实体的正则表达式，支持命名实体、十进制、十六进制编码 */
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#39|#x[0-9a-f]+|#\d+);/i;

/**
 * 解码字符串中的HTML实体
 * 支持&amp; &lt; &gt; &quot; &apos;以及十进制/十六进制编码的实体
 * @param value 包含HTML实体的字符串
 * @returns 解码后的字符串
 */
function decodeHtmlEntities(value: string): string {
  return (
    value
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      // 处理十六进制编码实体（如&#x4F60;&#x597D;）
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      // 处理十进制编码实体（如&#20320;&#22909;）
      .replace(/&#(\d+);/gi, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
  );
}

/**
 * 递归解码对象中所有字符串的HTML实体
 * 深度遍历对象和数组，对其中所有字符串进行HTML实体解码
 * @param obj 要解码的对象（可以是任意类型）
 * @returns 解码后的对象
 */
export function decodeHtmlEntitiesInObject(obj: unknown): unknown {
  // 字符串类型直接解码
  if (typeof obj === "string") {
    return HTML_ENTITY_RE.test(obj) ? decodeHtmlEntities(obj) : obj;
  }
  // 数组类型递归解码每个元素
  if (Array.isArray(obj)) {
    return obj.map(decodeHtmlEntitiesInObject);
  }
  // 对象类型递归解码每个属性值
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = decodeHtmlEntitiesInObject(val);
    }
    return result;
  }
  // 其他类型直接返回
  return obj;
}

/**
 * 解码xAI/Grok模型工具调用参数中的HTML实体
 * 遍历消息中的所有工具调用块，对参数对象进行HTML实体解码
 * @param message 要处理的消息对象
 */
function decodeXaiToolCallArgumentsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; arguments?: unknown };
    // 只处理toolCall类型的块，并且参数是对象类型
    if (typedBlock.type !== "toolCall" || !typedBlock.arguments) {
      continue;
    }
    if (typeof typedBlock.arguments === "object") {
      typedBlock.arguments = decodeHtmlEntitiesInObject(typedBlock.arguments);
    }
  }
}

/**
 * 包装模型响应流，解码xAI/Grok模型工具调用参数中的HTML实体
 * 在流式响应的每个增量块和最终结果中都进行解码
 * @param stream 原始模型响应流
 * @returns 包装后的响应流
 */
function wrapStreamDecodeXaiToolCallArguments(
  stream: ReturnType<typeof streamSimple>,
): ReturnType<typeof streamSimple> {
  // 包装最终结果获取方法
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    decodeXaiToolCallArgumentsInMessage(message);
    return message;
  };

  // 包装流式迭代器，处理每个响应增量
  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  (stream as { [Symbol.asyncIterator]: typeof originalAsyncIterator })[Symbol.asyncIterator] =
    function () {
      const iterator = originalAsyncIterator();
      return {
        async next() {
          const result = await iterator.next();
          if (!result.done && result.value && typeof result.value === "object") {
            const event = result.value as { partial?: unknown; message?: unknown };
            // 对部分响应和完整消息都进行解码
            decodeXaiToolCallArgumentsInMessage(event.partial);
            decodeXaiToolCallArgumentsInMessage(event.message);
          }
          return result;
        },
        async return(value?: unknown) {
          return iterator.return?.(value) ?? { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          return iterator.throw?.(error) ?? { done: true as const, value: undefined };
        },
      };
    };
  return stream;
}

/**
 * 流函数包装器，为xAI/Grok模型响应添加HTML实体解码功能
 * 高阶函数，接收原始流函数返回包装后的流函数
 * @param baseFn 原始流函数
 * @returns 包装后的流函数
 */
function wrapStreamFnDecodeXaiToolCallArguments(baseFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const maybeStream = baseFn(model, context, options);
    // 处理返回Promise的异步流
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamDecodeXaiToolCallArguments(stream),
      );
    }
    // 处理直接返回流的同步情况
    return wrapStreamDecodeXaiToolCallArguments(maybeStream);
  };
}

export async function resolvePromptBuildHookResult(params: {
  prompt: string;
  messages: unknown[];
  hookCtx: PluginHookAgentContext;
  hookRunner?: PromptBuildHookRunner | null;
  legacyBeforeAgentStartResult?: PluginHookBeforeAgentStartResult;
}): Promise<PluginHookBeforePromptBuildResult> {
  const promptBuildResult = params.hookRunner?.hasHooks("before_prompt_build")
    ? await params.hookRunner
        .runBeforePromptBuild(
          {
            prompt: params.prompt,
            messages: params.messages,
          },
          params.hookCtx,
        )
        .catch((hookErr: unknown) => {
          log.warn(`before_prompt_build hook failed: ${String(hookErr)}`);
          return undefined;
        })
    : undefined;
  const legacyResult =
    params.legacyBeforeAgentStartResult ??
    (params.hookRunner?.hasHooks("before_agent_start")
      ? await params.hookRunner
          .runBeforeAgentStart(
            {
              prompt: params.prompt,
              messages: params.messages,
            },
            params.hookCtx,
          )
          .catch((hookErr: unknown) => {
            log.warn(
              `before_agent_start hook (legacy prompt build path) failed: ${String(hookErr)}`,
            );
            return undefined;
          })
      : undefined);
  return {
    systemPrompt: promptBuildResult?.systemPrompt ?? legacyResult?.systemPrompt,
    prependContext: joinPresentTextSegments([
      promptBuildResult?.prependContext,
      legacyResult?.prependContext,
    ]),
    prependSystemContext: joinPresentTextSegments([
      promptBuildResult?.prependSystemContext,
      legacyResult?.prependSystemContext,
    ]),
    appendSystemContext: joinPresentTextSegments([
      promptBuildResult?.appendSystemContext,
      legacyResult?.appendSystemContext,
    ]),
  };
}

export function composeSystemPromptWithHookContext(params: {
  baseSystemPrompt?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}): string | undefined {
  const prependSystem = params.prependSystemContext?.trim();
  const appendSystem = params.appendSystemContext?.trim();
  if (!prependSystem && !appendSystem) {
    return undefined;
  }
  return joinPresentTextSegments(
    [params.prependSystemContext, params.baseSystemPrompt, params.appendSystemContext],
    { trim: true },
  );
}

export function resolvePromptModeForSession(sessionKey?: string): "minimal" | "full" {
  if (!sessionKey) {
    return "full";
  }
  return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) ? "minimal" : "full";
}

export function resolveAttemptFsWorkspaceOnly(params: {
  config?: OpenClawConfig;
  sessionAgentId: string;
}): boolean {
  return resolveEffectiveToolFsWorkspaceOnly({
    cfg: params.config,
    agentId: params.sessionAgentId,
  });
}

export function prependSystemPromptAddition(params: {
  systemPrompt: string;
  systemPromptAddition?: string;
}): string {
  if (!params.systemPromptAddition) {
    return params.systemPrompt;
  }
  return `${params.systemPromptAddition}\n\n${params.systemPrompt}`;
}

/** Build runtime context passed into context-engine afterTurn hooks. */
export function buildAfterTurnRuntimeContext(params: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "sessionKey"
    | "messageChannel"
    | "messageProvider"
    | "agentAccountId"
    | "config"
    | "skillsSnapshot"
    | "senderIsOwner"
    | "provider"
    | "modelId"
    | "thinkLevel"
    | "reasoningLevel"
    | "bashElevated"
    | "extraSystemPrompt"
    | "ownerNumbers"
    | "authProfileId"
  >;
  workspaceDir: string;
  agentDir: string;
}): Partial<CompactEmbeddedPiSessionParams> {
  return {
    sessionKey: params.attempt.sessionKey,
    messageChannel: params.attempt.messageChannel,
    messageProvider: params.attempt.messageProvider,
    agentAccountId: params.attempt.agentAccountId,
    authProfileId: params.attempt.authProfileId,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    config: params.attempt.config,
    skillsSnapshot: params.attempt.skillsSnapshot,
    senderIsOwner: params.attempt.senderIsOwner,
    provider: params.attempt.provider,
    model: params.attempt.modelId,
    thinkLevel: params.attempt.thinkLevel,
    reasoningLevel: params.attempt.reasoningLevel,
    bashElevated: params.attempt.bashElevated,
    extraSystemPrompt: params.attempt.extraSystemPrompt,
    ownerNumbers: params.attempt.ownerNumbers,
  };
}

function summarizeMessagePayload(msg: AgentMessage): { textChars: number; imageBlocks: number } {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return { textChars: content.length, imageBlocks: 0 };
  }
  if (!Array.isArray(content)) {
    return { textChars: 0, imageBlocks: 0 };
  }

  let textChars = 0;
  let imageBlocks = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type === "image") {
      imageBlocks++;
      continue;
    }
    if (typeof typedBlock.text === "string") {
      textChars += typedBlock.text.length;
    }
  }

  return { textChars, imageBlocks };
}

function summarizeSessionContext(messages: AgentMessage[]): {
  roleCounts: string;
  totalTextChars: number;
  totalImageBlocks: number;
  maxMessageTextChars: number;
} {
  const roleCounts = new Map<string, number>();
  let totalTextChars = 0;
  let totalImageBlocks = 0;
  let maxMessageTextChars = 0;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);

    const payload = summarizeMessagePayload(msg);
    totalTextChars += payload.textChars;
    totalImageBlocks += payload.imageBlocks;
    if (payload.textChars > maxMessageTextChars) {
      maxMessageTextChars = payload.textChars;
    }
  }

  return {
    roleCounts:
      [...roleCounts.entries()]
        .toSorted((a, b) => a[0].localeCompare(b[0]))
        .map(([role, count]) => `${role}:${count}`)
        .join(",") || "none",
    totalTextChars,
    totalImageBlocks,
    maxMessageTextChars,
  };
}

/**
 * 嵌入式Agent单次运行尝试的核心入口函数 关键核心类!!
 * 负责从初始化环境、组装上下文、调用模型、执行工具到返回结果的完整生命周期
 * @param params 运行参数，包含会话信息、模型配置、工具配置等所有上下文
 * 嵌入式Agent单次执行入口函数
 * 负责协调Agent运行的完整生命周期：环境准备、上下文加载、工具初始化、会话管理、模型调用、结果处理
 * @param params 执行参数，包含会话信息、模型配置、工作区路径等
 * @returns 执行结果，包含响应内容、使用统计、状态信息等
 */
export async function runEmbeddedAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  // 解析用户提供的工作区路径为绝对路径
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  // 保存当前工作目录，执行完成后恢复
  const prevCwd = process.cwd();
  // 运行终止控制器，用于主动中止本次运行（如超时、让步、用户取消等场景）
  const runAbortController = new AbortController();
  // 全局HTTP代理和超时配置必须最先初始化
  // 确保后续所有HTTP请求都使用正确的代理配置和超时设置
  ensureGlobalUndiciEnvProxyDispatcher();
  ensureGlobalUndiciStreamTimeouts();

  // 记录运行启动日志，包含关键标识信息便于排查问题
  log.debug(
    `embedded run start: runId=${params.runId} sessionId=${params.sessionId} provider=${params.provider} model=${params.modelId} thinking=${params.thinkLevel} messageChannel=${params.messageChannel ?? params.messageProvider ?? "unknown"}`,
  );

  // 确保工作区目录存在，递归创建多级目录
  await fs.mkdir(resolvedWorkspace, { recursive: true });

  // 构建沙箱会话Key，优先使用用户提供的sessionKey，否则使用sessionId
  const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
  // 初始化沙箱环境，根据配置决定是否启用文件系统隔离
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  // 计算实际生效的工作区路径：
  // - 沙箱启用且是只读模式时，使用沙箱复制的工作区目录
  // - 沙箱关闭或读写模式时，直接使用原工作区目录
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  // 确保实际工作区目录存在
  await fs.mkdir(effectiveWorkspace, { recursive: true });

  // Skill环境恢复函数，运行结束后用于恢复原环境变量
  let restoreSkillEnv: (() => void) | undefined;
  // 切换工作目录到实际生效的工作区，所有后续操作都在该目录下执行
  process.chdir(effectiveWorkspace);
  try {
    // 解析当前运行可用的Skill列表
    // Skill是OpenClaw的扩展机制，用户可以自定义Skill扩展Agent能力
    const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
      workspaceDir: effectiveWorkspace,
      config: params.config,
      skillsSnapshot: params.skillsSnapshot,
    });
    // 应用Skill定义的环境变量覆盖
    // 如果有Skill快照（如子Agent继承父Agent的Skill）则从快照加载，否则从当前工作区加载
    restoreSkillEnv = params.skillsSnapshot
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: params.skillsSnapshot,
          config: params.config,
        })
      : applySkillEnvOverrides({
          skills: skillEntries ?? [],
          config: params.config,
        });

    // 构建Skill使用提示，会注入到系统提示中，告知LLM可用的Skill和使用方法
    const skillsPrompt = resolveSkillsPromptForRun({
      skillsSnapshot: params.skillsSnapshot,
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      config: params.config,
      workspaceDir: effectiveWorkspace,
    });

    // 构建会话标签，用于日志和警告信息展示
    const sessionLabel = params.sessionKey ?? params.sessionId;
    // 加载启动上下文文件（Bootstrap文件）：
    // 自动加载工作区的BOOTSTRAP.md、MEMORY.md、README.md等文件内容
    // 这些文件内容会被注入到系统提示中，作为Agent的工作区知识
    const { bootstrapFiles: hookAdjustedBootstrapFiles, contextFiles } =
      await resolveBootstrapContextForRun({
        workspaceDir: effectiveWorkspace,
        config: params.config,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
        contextMode: params.bootstrapContextMode,
        runKind: params.bootstrapContextRunKind,
      });
    // 解析bootstrap文件大小限制，避免注入内容过长占用太多上下文窗口
    const bootstrapMaxChars = resolveBootstrapMaxChars(params.config);
    const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config);
    // 分析bootstrap文件的字符预算，判断是否需要截断
    const bootstrapAnalysis = analyzeBootstrapBudget({
      files: buildBootstrapInjectionStats({
        bootstrapFiles: hookAdjustedBootstrapFiles,
        injectedFiles: contextFiles,
      }),
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
    });
    // 解析bootstrap截断警告的展示模式
    const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(params.config);
    // 构建bootstrap截断警告信息，会告知用户哪些文件被截断
    const bootstrapPromptWarning = buildBootstrapPromptWarning({
      analysis: bootstrapAnalysis,
      mode: bootstrapPromptWarningMode,
      seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
      previousSignature: params.bootstrapPromptWarningSignature,
    });
    // 如果工作区存在BOOTSTRAP.md文件，添加工作区变更提醒
    const workspaceNotes = hookAdjustedBootstrapFiles.some(
      (file) => file.name === DEFAULT_BOOTSTRAP_FILENAME && !file.missing,
    )
      ? ["Reminder: commit your changes in this workspace after edits."]
      : undefined;

    const agentDir = params.agentDir ?? resolveOpenClawAgentDir();

    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
      agentId: params.agentId,
    });
    // 解析文件系统访问限制：是否仅允许访问工作区目录
    const effectiveFsWorkspaceOnly = resolveAttemptFsWorkspaceOnly({
      config: params.config,
      sessionAgentId,
    });
    // 会话让步相关状态变量：用于在工具调用中主动中止当前执行，等待外部事件触发后续轮次
    // yieldDetected：是否检测到让步请求
    let yieldDetected = false;
    // yieldMessage：让步原因描述
    let yieldMessage: string | null = null;
    // 后绑定的会话控制函数，在会话创建后赋值，用于让步时中止执行
    // abortSessionForYield：中止会话执行
    let abortSessionForYield: (() => void) | null = null;
    // queueYieldInterruptForSession：插入让步中断消息
    let queueYieldInterruptForSession: (() => void) | null = null;
    // yieldAbortSettled：让步中止操作完成的Promise
    let yieldAbortSettled: Promise<void> | null = null;
    // 检查模型是否支持图像输入能力
    const modelHasVision = params.model.input?.includes("image") ?? false;
    const toolsRaw = params.disableTools
      ? []
      : createOpenClawCodingTools({
          agentId: sessionAgentId,
          exec: {
            ...params.execOverrides,
            elevated: params.bashElevated,
          },
          sandbox,
          messageProvider: params.messageChannel ?? params.messageProvider,
          agentAccountId: params.agentAccountId,
          messageTo: params.messageTo,
          messageThreadId: params.messageThreadId,
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          spawnedBy: params.spawnedBy,
          senderId: params.senderId,
          senderName: params.senderName,
          senderUsername: params.senderUsername,
          senderE164: params.senderE164,
          senderIsOwner: params.senderIsOwner,
          sessionKey: sandboxSessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          agentDir,
          workspaceDir: effectiveWorkspace,
          // When sandboxing uses a copied workspace (`ro` or `none`), effectiveWorkspace points
          // at the sandbox copy. Spawned subagents should inherit the real workspace instead.
          spawnWorkspaceDir:
            sandbox?.enabled && sandbox.workspaceAccess !== "rw" ? resolvedWorkspace : undefined,
          config: params.config,
          abortSignal: runAbortController.signal,
          modelProvider: params.model.provider,
          modelId: params.modelId,
          modelContextWindowTokens: params.model.contextWindow,
          modelAuthMode: resolveModelAuthMode(params.model.provider, params.config),
          currentChannelId: params.currentChannelId,
          currentThreadTs: params.currentThreadTs,
          currentMessageId: params.currentMessageId,
          replyToMode: params.replyToMode,
          hasRepliedRef: params.hasRepliedRef,
          modelHasVision,
          requireExplicitMessageTarget:
            params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
          disableMessageTool: params.disableMessageTool,
          onYield: (message) => {
            yieldDetected = true;
            yieldMessage = message;
            queueYieldInterruptForSession?.();
            runAbortController.abort("sessions_yield");
            abortSessionForYield?.();
          },
        });
    const toolsEnabled = supportsModelTools(params.model);
    // 针对Google模型的工具格式适配，Google对工具调用格式有特殊要求
    const tools = sanitizeToolsForGoogle({
      tools: toolsEnabled ? toolsRaw : [],
      provider: params.provider,
    });
    // 客户端提供的工具（如用户自定义工具、平台托管工具）
    const clientTools = toolsEnabled ? params.clientTools : undefined;
    // 收集所有允许使用的工具名称，用于工具调用权限校验
    const allowedToolNames = collectAllowedToolNames({
      tools,
      clientTools,
    });
    // 记录工具Schema日志，便于调试Google模型工具调用问题
    logToolSchemasForGoogle({ tools, provider: params.provider });

    const machineName = await getMachineDisplayName();
    const runtimeChannel = normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    let runtimeCapabilities = runtimeChannel
      ? (resolveChannelCapabilities({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        }) ?? [])
      : undefined;
    if (runtimeChannel === "telegram" && params.config) {
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg: params.config,
        accountId: params.agentAccountId ?? undefined,
      });
      if (inlineButtonsScope !== "off") {
        if (!runtimeCapabilities) {
          runtimeCapabilities = [];
        }
        if (
          !runtimeCapabilities.some((cap) => String(cap).trim().toLowerCase() === "inlinebuttons")
        ) {
          runtimeCapabilities.push("inlineButtons");
        }
      }
    }
    const reactionGuidance =
      runtimeChannel && params.config
        ? (() => {
            if (runtimeChannel === "telegram") {
              const resolved = resolveTelegramReactionLevel({
                cfg: params.config,
                accountId: params.agentAccountId ?? undefined,
              });
              const level = resolved.agentReactionGuidance;
              return level ? { level, channel: "Telegram" } : undefined;
            }
            if (runtimeChannel === "signal") {
              const resolved = resolveSignalReactionLevel({
                cfg: params.config,
                accountId: params.agentAccountId ?? undefined,
              });
              const level = resolved.agentReactionGuidance;
              return level ? { level, channel: "Signal" } : undefined;
            }
            return undefined;
          })()
        : undefined;
    const sandboxInfo = buildEmbeddedSandboxInfo(sandbox, params.bashElevated);
    const reasoningTagHint = isReasoningTagProvider(params.provider);
    // Resolve channel-specific message actions for system prompt
    const channelActions = runtimeChannel
      ? listChannelSupportedActions({
          cfg: params.config,
          channel: runtimeChannel,
        })
      : undefined;
    const messageToolHints = runtimeChannel
      ? resolveChannelMessageToolHints({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        })
      : undefined;

    // 解析当前Agent的默认模型配置
    const defaultModelRef = resolveDefaultModelForAgent({
      cfg: params.config ?? {},
      agentId: sessionAgentId,
    });
    // 格式化默认模型显示名称
    const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
    // 构建系统提示需要的运行时参数，包含机器信息、运行环境、时间等
    const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
      config: params.config,
      agentId: sessionAgentId,
      workspaceDir: effectiveWorkspace,
      cwd: process.cwd(),
      runtime: {
        host: machineName,
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        node: process.version,
        model: `${params.provider}/${params.modelId}`,
        defaultModel: defaultModelLabel,
        shell: detectRuntimeShell(),
        channel: runtimeChannel,
        capabilities: runtimeCapabilities,
        channelActions,
      },
    });
    // 判断是否使用默认Agent配置
    const isDefaultAgent = sessionAgentId === defaultAgentId;
    // 解析会话的提示模式，不同类型会话有不同的提示生成规则
    const promptMode = resolvePromptModeForSession(params.sessionKey);
    // 解析OpenClaw文档路径，用于在系统提示中提供文档链接
    const docsPath = await resolveOpenClawDocsPath({
      workspaceDir: effectiveWorkspace,
      argv1: process.argv[1],
      cwd: process.cwd(),
      moduleUrl: import.meta.url,
    });
    // 构建TTS（语音合成）相关的系统提示
    const ttsHint = params.config ? buildTtsSystemPromptHint(params.config) : undefined;
    // 解析所有者显示配置，控制是否在回复中显示所有者信息
    const ownerDisplay = resolveOwnerDisplaySetting(params.config);

    // 构建嵌入式Agent的完整系统提示，整合所有上下文信息
    const appendPrompt = buildEmbeddedSystemPrompt({
      workspaceDir: effectiveWorkspace,
      defaultThinkLevel: params.thinkLevel,
      reasoningLevel: params.reasoningLevel ?? "off",
      extraSystemPrompt: params.extraSystemPrompt,
      ownerNumbers: params.ownerNumbers,
      ownerDisplay: ownerDisplay.ownerDisplay,
      ownerDisplaySecret: ownerDisplay.ownerDisplaySecret,
      reasoningTagHint,
      heartbeatPrompt: isDefaultAgent
        ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
        : undefined,
      skillsPrompt,
      docsPath: docsPath ?? undefined,
      ttsHint,
      workspaceNotes,
      reactionGuidance,
      promptMode,
      acpEnabled: params.config?.acp?.enabled !== false,
      runtimeInfo,
      messageToolHints,
      sandboxInfo,
      tools,
      modelAliasLines: buildModelAliasLines(params.config),
      userTimezone,
      userTime,
      userTimeFormat,
      contextFiles,
      bootstrapTruncationWarningLines: bootstrapPromptWarning.lines,
      memoryCitationsMode: params.config?.memory?.citations,
    });
    // 构建系统提示报告，用于调试和审计，记录系统提示生成的所有元信息
    const systemPromptReport = buildSystemPromptReport({
      source: "run",
      generatedAt: Date.now(),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      provider: params.provider,
      model: params.modelId,
      workspaceDir: effectiveWorkspace,
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
      bootstrapTruncation: buildBootstrapTruncationReportMeta({
        analysis: bootstrapAnalysis,
        warningMode: bootstrapPromptWarningMode,
        warning: bootstrapPromptWarning,
      }),
      sandbox: (() => {
        const runtime = resolveSandboxRuntimeStatus({
          cfg: params.config,
          sessionKey: sandboxSessionKey,
        });
        return { mode: runtime.mode, sandboxed: runtime.sandboxed };
      })(),
      systemPrompt: appendPrompt,
      bootstrapFiles: hookAdjustedBootstrapFiles,
      injectedFiles: contextFiles,
      skillsPrompt,
      tools,
    });
    // 创建系统提示覆写函数，用于在运行时动态修改系统提示
    const systemPromptOverride = createSystemPromptOverride(appendPrompt);
    // 生成最终的系统提示文本
    let systemPromptText = systemPromptOverride();

    // 获取会话文件写锁，避免多个进程同时修改会话文件导致冲突
    const sessionLock = await acquireSessionWriteLock({
      sessionFile: params.sessionFile,
      maxHoldMs: resolveSessionLockMaxHoldFromTimeout({
        timeoutMs: resolveRunTimeoutWithCompactionGraceMs({
          runTimeoutMs: params.timeoutMs,
          compactionTimeoutMs: resolveCompactionTimeoutMs(params.config),
        }),
      }),
    });

    // 会话管理器实例，负责会话历史的持久化和管理
    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    // Agent会话实例，是与模型交互的核心对象
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    // 工具结果上下文守卫的清理函数，运行结束时调用
    let removeToolResultContextGuard: (() => void) | undefined;
    try {
      // 检查并修复损坏的会话文件，避免因文件损坏导致运行失败
      await repairSessionFileIfNeeded({
        sessionFile: params.sessionFile,
        warn: (message) => log.warn(message),
      });
      // 检查会话文件是否已存在（是否为历史会话）
      const hadSessionFile = await fs
        .stat(params.sessionFile)
        .then(() => true)
        .catch(() => false);

      // 解析会话历史策略，不同模型对会话历史格式有不同要求
      const transcriptPolicy = resolveTranscriptPolicy({
        modelApi: params.model?.api,
        provider: params.provider,
        modelId: params.modelId,
      });

      // 预热会话文件，将文件内容加载到缓存，提高后续访问速度
      await prewarmSessionFile(params.sessionFile);
      // 打开会话管理器并添加安全守卫，防止非法工具调用和消息篡改
      sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        inputProvenance: params.inputProvenance,
        allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
        allowedToolNames,
      });
      // 记录会话管理器访问，用于缓存和性能监控
      trackSessionManagerAccess(params.sessionFile);

      // 如果是历史会话且存在上下文引擎，执行上下文引擎初始化
      if (hadSessionFile && params.contextEngine?.bootstrap) {
        try {
          await params.contextEngine.bootstrap({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            sessionFile: params.sessionFile,
          });
        } catch (bootstrapErr) {
          log.warn(`context engine bootstrap failed: ${String(bootstrapErr)}`);
        }
      }

      // 为本次运行准备会话管理器，清理过期数据、初始化运行时状态
      await prepareSessionManagerForRun({
        sessionManager,
        sessionFile: params.sessionFile,
        hadSessionFile,
        sessionId: params.sessionId,
        cwd: effectiveWorkspace,
      });

      // 创建并初始化Pi设置管理器，负责Agent运行时配置的加载和管理
      const settingsManager = createPreparedEmbeddedPiSettingsManager({
        cwd: effectiveWorkspace,
        agentDir,
        cfg: params.config,
      });
      // 应用会话自动压缩守卫，防止会话历史过大导致上下文窗口溢出
      applyPiAutoCompactionGuard({
        settingsManager,
        contextEngineInfo: params.contextEngine?.info,
      });

      // 构建嵌入式扩展工厂集合，扩展可以拦截和修改Agent运行时的各种行为
      // 包括会话压缩、历史裁剪等安全机制的实现
      const extensionFactories = buildEmbeddedExtensionFactories({
        cfg: params.config,
        sessionManager,
        provider: params.provider,
        modelId: params.modelId,
        model: params.model,
      });
      // 只有当有扩展需要注册时才显式创建资源加载器，否则使用内置默认实现
      let resourceLoader: DefaultResourceLoader | undefined;
      if (extensionFactories.length > 0) {
        resourceLoader = new DefaultResourceLoader({
          cwd: resolvedWorkspace,
          agentDir,
          settingsManager,
          extensionFactories,
        });
        // 重载资源加载器，加载所有扩展和配置
        await resourceLoader.reload();
      }

      // 获取全局插件Hook运行器，用于执行插件定义的各种生命周期钩子
      const hookRunner = getGlobalHookRunner();

      // 拆分工具为内置工具和自定义工具，内置工具由SDK提供，自定义工具由用户或插件提供
      const { builtInTools, customTools } = splitSdkTools({
        tools,
        sandboxEnabled: !!sandbox?.enabled,
      });

      // 处理客户端工具（平台托管工具），将其转换为SDK可识别的工具定义
      // clientToolCallDetected：记录是否检测到客户端工具调用，用于特殊处理逻辑
      let clientToolCallDetected: { name: string; params: Record<string, unknown> } | null = null;
      // 解析客户端工具循环检测配置，防止工具调用进入死循环
      const clientToolLoopDetection = resolveToolLoopDetectionConfig({
        cfg: params.config,
        agentId: sessionAgentId,
      });
      // 将客户端工具转换为SDK兼容的工具定义格式，注册调用回调
      const clientToolDefs = clientTools
        ? toClientToolDefinitions(
            clientTools,
            (toolName, toolParams) => {
              clientToolCallDetected = { name: toolName, params: toolParams };
            },
            {
              agentId: sessionAgentId,
              sessionKey: sandboxSessionKey,
              sessionId: params.sessionId,
              runId: params.runId,
              loopDetection: clientToolLoopDetection,
            },
          )
        : [];

      // 合并所有自定义工具：用户自定义工具 + 客户端托管工具
      const allCustomTools = [...customTools, ...clientToolDefs];

      // 创建Agent会话实例，这是与模型交互的核心对象
      ({ session } = await createAgentSession({
        cwd: resolvedWorkspace,
        agentDir,
        authStorage: params.authStorage,
        modelRegistry: params.modelRegistry,
        model: params.model,
        thinkingLevel: mapThinkingLevel(params.thinkLevel),
        tools: builtInTools,
        customTools: allCustomTools,
        sessionManager,
        settingsManager,
        resourceLoader,
      }));
      // 将之前构建的系统提示应用到会话中
      applySystemPromptOverrideToSession(session, systemPromptText);
      // 会话创建失败则抛出错误
      if (!session) {
        throw new Error("Embedded agent session missing");
      }
      const activeSession = session;
      // 为之前声明的让步相关函数赋值，现在会话已创建，可以调用会话的中止方法
      abortSessionForYield = () => {
        yieldAbortSettled = Promise.resolve(activeSession.abort());
      };
      queueYieldInterruptForSession = () => {
        queueSessionsYieldInterruptMessage(activeSession);
      };
      // 安装工具结果上下文守卫，防止工具返回的内容过长导致上下文窗口溢出
      removeToolResultContextGuard = installToolResultContextGuard({
        agent: activeSession.agent,
        contextWindowTokens: Math.max(
          1,
          Math.floor(
            params.model.contextWindow ?? params.model.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
          ),
        ),
      });
      // 创建缓存追踪器，用于记录和分析缓存命中情况，优化性能
      const cacheTrace = createCacheTrace({
        cfg: params.config,
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });
      // 创建Anthropic请求负载日志记录器，用于调试Anthropic模型的调用问题
      const anthropicPayloadLogger = createAnthropicPayloadLogger({
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });

      // Ollama原生API特殊处理：绕过SDK默认的streamSimple实现，直接调用Ollama的/api/chat接口
      // 这样可以获得更可靠的流式输出和工具调用支持
      if (params.model.api === "ollama") {
        // 优先使用配置文件中指定的provider baseUrl，确保Docker/远程Ollama服务能正常工作
        const providerConfig = params.config?.models?.providers?.[params.model.provider];
        const providerBaseUrl =
          typeof providerConfig?.baseUrl === "string" ? providerConfig.baseUrl : undefined;
        // 创建Ollama专用的流处理函数
        const ollamaStreamFn = createConfiguredOllamaStreamFn({
          model: params.model,
          providerBaseUrl,
        });
        // 替换会话的流处理函数
        activeSession.agent.streamFn = ollamaStreamFn;
        // 注册自定义API实现，确保全局可用
        ensureCustomApiRegistered(params.model.api, ollamaStreamFn);
      }
      // OpenAI Responses API特殊处理：使用WebSocket连接获得更低延迟的流式输出
      else if (params.model.api === "openai-responses" && params.provider === "openai") {
        const wsApiKey = await params.authStorage.getApiKey(params.provider);
        if (wsApiKey) {
          // 创建OpenAI WebSocket流处理函数
          activeSession.agent.streamFn = createOpenAIWebSocketStreamFn(wsApiKey, params.sessionId, {
            signal: runAbortController.signal,
          });
        } else {
          log.warn(`[ws-stream] no API key for provider=${params.provider}; using HTTP transport`);
          // 没有API密钥时回退到默认HTTP传输
          activeSession.agent.streamFn = streamSimple;
        }
      }
      // 其他模型使用默认的流处理实现
      else {
        // 固定streamFn引用，方便vitest测试时进行mock
        activeSession.agent.streamFn = streamSimple;
      }

      // 针对使用OpenAI兼容API的Ollama模型，需要在请求参数中注入num_ctx
      // 否则Ollama会默认使用4096的上下文窗口，无法充分利用大模型的上下文能力
      const providerIdForNumCtx =
        typeof params.model.provider === "string" && params.model.provider.trim().length > 0
          ? params.model.provider
          : params.provider;
      // 判断是否需要注入num_ctx参数
      const shouldInjectNumCtx = shouldInjectOllamaCompatNumCtx({
        model: params.model,
        config: params.config,
        providerId: providerIdForNumCtx,
      });
      if (shouldInjectNumCtx) {
        // 使用模型的上下文窗口大小作为num_ctx值
        const numCtx = Math.max(
          1,
          Math.floor(
            params.model.contextWindow ?? params.model.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
          ),
        );
        // 包装流函数，自动注入num_ctx参数
        activeSession.agent.streamFn = wrapOllamaCompatNumCtx(activeSession.agent.streamFn, numCtx);
      }

      // 向Agent应用额外的运行参数，包括流参数、快速模式、思考级别等
      applyExtraParamsToAgent(
        activeSession.agent,
        params.config,
        params.provider,
        params.modelId,
        {
          ...params.streamParams,
          fastMode: params.fastMode,
        },
        params.thinkLevel,
        sessionAgentId,
      );

      // 如果启用了缓存追踪，记录会话加载完成阶段，并包装流函数以追踪缓存情况
      if (cacheTrace) {
        cacheTrace.recordStage("session:loaded", {
          messages: activeSession.messages,
          system: systemPromptText,
          note: "after session create",
        });
        activeSession.agent.streamFn = cacheTrace.wrapStreamFn(activeSession.agent.streamFn);
      }

      // Anthropic Claude endpoints can reject replayed `thinking` blocks
      // (e.g. thinkingSignature:"reasoning_text") on any follow-up provider
      // call, including tool continuations. Wrap the stream function so every
      // outbound request sees sanitized messages.
      if (transcriptPolicy.dropThinkingBlocks) {
        const inner = activeSession.agent.streamFn;
        activeSession.agent.streamFn = (model, context, options) => {
          const ctx = context as unknown as { messages?: unknown };
          const messages = ctx?.messages;
          if (!Array.isArray(messages)) {
            return inner(model, context, options);
          }
          const sanitized = dropThinkingBlocks(messages as unknown as AgentMessage[]) as unknown;
          if (sanitized === messages) {
            return inner(model, context, options);
          }
          const nextContext = {
            ...(context as unknown as Record<string, unknown>),
            messages: sanitized,
          } as unknown;
          return inner(model, nextContext as typeof context, options);
        };
      }

      // Mistral (and other strict providers) reject tool call IDs that don't match their
      // format requirements (e.g. [a-zA-Z0-9]{9}). sanitizeSessionHistory only processes
      // historical messages at attempt start, but the agent loop's internal tool call →
      // tool result cycles bypass that path. Wrap streamFn so every outbound request
      // sees sanitized tool call IDs.
      if (transcriptPolicy.sanitizeToolCallIds && transcriptPolicy.toolCallIdMode) {
        const inner = activeSession.agent.streamFn;
        const mode = transcriptPolicy.toolCallIdMode;
        activeSession.agent.streamFn = (model, context, options) => {
          const ctx = context as unknown as { messages?: unknown };
          const messages = ctx?.messages;
          if (!Array.isArray(messages)) {
            return inner(model, context, options);
          }
          const sanitized = sanitizeToolCallIdsForCloudCodeAssist(messages as AgentMessage[], mode);
          if (sanitized === messages) {
            return inner(model, context, options);
          }
          const nextContext = {
            ...(context as unknown as Record<string, unknown>),
            messages: sanitized,
          } as unknown;
          return inner(model, nextContext as typeof context, options);
        };
      }

      if (
        params.model.api === "openai-responses" ||
        params.model.api === "openai-codex-responses"
      ) {
        const inner = activeSession.agent.streamFn;
        activeSession.agent.streamFn = (model, context, options) => {
          const ctx = context as unknown as { messages?: unknown };
          const messages = ctx?.messages;
          if (!Array.isArray(messages)) {
            return inner(model, context, options);
          }
          const sanitized = downgradeOpenAIFunctionCallReasoningPairs(messages as AgentMessage[]);
          if (sanitized === messages) {
            return inner(model, context, options);
          }
          const nextContext = {
            ...(context as unknown as Record<string, unknown>),
            messages: sanitized,
          } as unknown;
          return inner(model, nextContext as typeof context, options);
        };
      }

      const innerStreamFn = activeSession.agent.streamFn;
      activeSession.agent.streamFn = (model, context, options) => {
        const signal = runAbortController.signal as AbortSignal & { reason?: unknown };
        if (yieldDetected && signal.aborted && signal.reason === "sessions_yield") {
          return createYieldAbortedResponse(model) as unknown as Awaited<
            ReturnType<typeof innerStreamFn>
          >;
        }
        return innerStreamFn(model, context, options);
      };

      // Some models emit tool names with surrounding whitespace (e.g. " read ").
      // pi-agent-core dispatches tool calls with exact string matching, so normalize
      // names on the live response stream before tool execution.
      activeSession.agent.streamFn = wrapStreamFnTrimToolCallNames(
        activeSession.agent.streamFn,
        allowedToolNames,
      );

      if (
        params.model.api === "anthropic-messages" &&
        shouldRepairMalformedAnthropicToolCallArguments(params.provider)
      ) {
        activeSession.agent.streamFn = wrapStreamFnRepairMalformedToolCallArguments(
          activeSession.agent.streamFn,
        );
      }

      if (isXaiProvider(params.provider, params.modelId)) {
        activeSession.agent.streamFn = wrapStreamFnDecodeXaiToolCallArguments(
          activeSession.agent.streamFn,
        );
      }

      if (anthropicPayloadLogger) {
        activeSession.agent.streamFn = anthropicPayloadLogger.wrapStreamFn(
          activeSession.agent.streamFn,
        );
      }

      try {
        const prior = await sanitizeSessionHistory({
          messages: activeSession.messages,
          modelApi: params.model.api,
          modelId: params.modelId,
          provider: params.provider,
          allowedToolNames,
          config: params.config,
          sessionManager,
          sessionId: params.sessionId,
          policy: transcriptPolicy,
        });
        cacheTrace?.recordStage("session:sanitized", { messages: prior });
        const validatedGemini = transcriptPolicy.validateGeminiTurns
          ? validateGeminiTurns(prior)
          : prior;
        const validated = transcriptPolicy.validateAnthropicTurns
          ? validateAnthropicTurns(validatedGemini)
          : validatedGemini;
        const truncated = limitHistoryTurns(
          validated,
          getDmHistoryLimitFromSessionKey(params.sessionKey, params.config),
        );
        // Re-run tool_use/tool_result pairing repair after truncation, since
        // limitHistoryTurns can orphan tool_result blocks by removing the
        // assistant message that contained the matching tool_use.
        const limited = transcriptPolicy.repairToolUseResultPairing
          ? sanitizeToolUseResultPairing(truncated)
          : truncated;
        cacheTrace?.recordStage("session:limited", { messages: limited });
        if (limited.length > 0) {
          activeSession.agent.replaceMessages(limited);
        }

        if (params.contextEngine) {
          try {
            const assembled = await params.contextEngine.assemble({
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              messages: activeSession.messages,
              tokenBudget: params.contextTokenBudget,
            });
            if (assembled.messages !== activeSession.messages) {
              activeSession.agent.replaceMessages(assembled.messages);
            }
            if (assembled.systemPromptAddition) {
              systemPromptText = prependSystemPromptAddition({
                systemPrompt: systemPromptText,
                systemPromptAddition: assembled.systemPromptAddition,
              });
              applySystemPromptOverrideToSession(activeSession, systemPromptText);
              log.debug(
                `context engine: prepended system prompt addition (${assembled.systemPromptAddition.length} chars)`,
              );
            }
          } catch (assembleErr) {
            log.warn(
              `context engine assemble failed, using pipeline messages: ${String(assembleErr)}`,
            );
          }
        }
      } catch (err) {
        await flushPendingToolResultsAfterIdle({
          agent: activeSession?.agent,
          sessionManager,
          clearPendingOnTimeout: true,
        });
        activeSession.dispose();
        throw err;
      }

      let aborted = Boolean(params.abortSignal?.aborted);
      let yieldAborted = false;
      let timedOut = false;
      let timedOutDuringCompaction = false;
      const getAbortReason = (signal: AbortSignal): unknown =>
        "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
      const makeTimeoutAbortReason = (): Error => {
        const err = new Error("request timed out");
        err.name = "TimeoutError";
        return err;
      };
      const makeAbortError = (signal: AbortSignal): Error => {
        const reason = getAbortReason(signal);
        const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
        err.name = "AbortError";
        return err;
      };
      const abortCompaction = () => {
        if (!activeSession.isCompacting) {
          return;
        }
        try {
          activeSession.abortCompaction();
        } catch (err) {
          if (!isProbeSession) {
            log.warn(
              `embedded run abortCompaction failed: runId=${params.runId} sessionId=${params.sessionId} err=${String(err)}`,
            );
          }
        }
      };
      const abortRun = (isTimeout = false, reason?: unknown) => {
        aborted = true;
        if (isTimeout) {
          timedOut = true;
        }
        if (isTimeout) {
          runAbortController.abort(reason ?? makeTimeoutAbortReason());
        } else {
          runAbortController.abort(reason);
        }
        abortCompaction();
        void activeSession.abort();
      };
      const abortable = <T>(promise: Promise<T>): Promise<T> => {
        const signal = runAbortController.signal;
        if (signal.aborted) {
          return Promise.reject(makeAbortError(signal));
        }
        return new Promise<T>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(makeAbortError(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          promise.then(
            (value) => {
              signal.removeEventListener("abort", onAbort);
              resolve(value);
            },
            (err) => {
              signal.removeEventListener("abort", onAbort);
              reject(err);
            },
          );
        });
      };

      const subscription = subscribeEmbeddedPiSession({
        session: activeSession,
        runId: params.runId,
        hookRunner: getGlobalHookRunner() ?? undefined,
        verboseLevel: params.verboseLevel,
        reasoningMode: params.reasoningLevel ?? "off",
        toolResultFormat: params.toolResultFormat,
        shouldEmitToolResult: params.shouldEmitToolResult,
        shouldEmitToolOutput: params.shouldEmitToolOutput,
        onToolResult: params.onToolResult,
        onReasoningStream: params.onReasoningStream,
        onReasoningEnd: params.onReasoningEnd,
        onBlockReply: params.onBlockReply,
        onBlockReplyFlush: params.onBlockReplyFlush,
        blockReplyBreak: params.blockReplyBreak,
        blockReplyChunking: params.blockReplyChunking,
        onPartialReply: params.onPartialReply,
        onAssistantMessageStart: params.onAssistantMessageStart,
        onAgentEvent: params.onAgentEvent,
        enforceFinalTag: params.enforceFinalTag,
        config: params.config,
        sessionKey: sandboxSessionKey,
        sessionId: params.sessionId,
        agentId: sessionAgentId,
      });

      const {
        assistantTexts,
        toolMetas,
        unsubscribe,
        waitForCompactionRetry,
        isCompactionInFlight,
        getMessagingToolSentTexts,
        getMessagingToolSentMediaUrls,
        getMessagingToolSentTargets,
        getSuccessfulCronAdds,
        didSendViaMessagingTool,
        getLastToolError,
        getUsageTotals,
        getCompactionCount,
      } = subscription;

      const queueHandle: EmbeddedPiQueueHandle = {
        queueMessage: async (text: string) => {
          await activeSession.steer(text);
        },
        isStreaming: () => activeSession.isStreaming,
        isCompacting: () => subscription.isCompacting(),
        abort: abortRun,
      };
      setActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey);

      let abortWarnTimer: NodeJS.Timeout | undefined;
      const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;
      const compactionTimeoutMs = resolveCompactionTimeoutMs(params.config);
      let abortTimer: NodeJS.Timeout | undefined;
      let compactionGraceUsed = false;
      const scheduleAbortTimer = (delayMs: number, reason: "initial" | "compaction-grace") => {
        abortTimer = setTimeout(
          () => {
            const timeoutAction = resolveRunTimeoutDuringCompaction({
              isCompactionPendingOrRetrying: subscription.isCompacting(),
              isCompactionInFlight: activeSession.isCompacting,
              graceAlreadyUsed: compactionGraceUsed,
            });
            if (timeoutAction === "extend") {
              compactionGraceUsed = true;
              if (!isProbeSession) {
                log.warn(
                  `embedded run timeout reached during compaction; extending deadline: ` +
                    `runId=${params.runId} sessionId=${params.sessionId} extraMs=${compactionTimeoutMs}`,
                );
              }
              scheduleAbortTimer(compactionTimeoutMs, "compaction-grace");
              return;
            }

            if (!isProbeSession) {
              log.warn(
                reason === "compaction-grace"
                  ? `embedded run timeout after compaction grace: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${params.timeoutMs} compactionGraceMs=${compactionTimeoutMs}`
                  : `embedded run timeout: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${params.timeoutMs}`,
              );
            }
            if (
              shouldFlagCompactionTimeout({
                isTimeout: true,
                isCompactionPendingOrRetrying: subscription.isCompacting(),
                isCompactionInFlight: activeSession.isCompacting,
              })
            ) {
              timedOutDuringCompaction = true;
            }
            abortRun(true);
            if (!abortWarnTimer) {
              abortWarnTimer = setTimeout(() => {
                if (!activeSession.isStreaming) {
                  return;
                }
                if (!isProbeSession) {
                  log.warn(
                    `embedded run abort still streaming: runId=${params.runId} sessionId=${params.sessionId}`,
                  );
                }
              }, 10_000);
            }
          },
          Math.max(1, delayMs),
        );
      };
      scheduleAbortTimer(params.timeoutMs, "initial");

      let messagesSnapshot: AgentMessage[] = [];
      let sessionIdUsed = activeSession.sessionId;
      const onAbort = () => {
        const reason = params.abortSignal ? getAbortReason(params.abortSignal) : undefined;
        const timeout = reason ? isTimeoutError(reason) : false;
        if (
          shouldFlagCompactionTimeout({
            isTimeout: timeout,
            isCompactionPendingOrRetrying: subscription.isCompacting(),
            isCompactionInFlight: activeSession.isCompacting,
          })
        ) {
          timedOutDuringCompaction = true;
        }
        abortRun(timeout, reason);
      };
      if (params.abortSignal) {
        if (params.abortSignal.aborted) {
          onAbort();
        } else {
          params.abortSignal.addEventListener("abort", onAbort, {
            once: true,
          });
        }
      }

      // Hook runner was already obtained earlier before tool creation
      const hookAgentId = sessionAgentId;

      let promptError: unknown = null;
      let promptErrorSource: "prompt" | "compaction" | null = null;
      const prePromptMessageCount = activeSession.messages.length;
      try {
        const promptStartedAt = Date.now();

        // Run before_prompt_build hooks to allow plugins to inject prompt context.
        // Legacy compatibility: before_agent_start is also checked for context fields.
        let effectivePrompt = params.prompt;
        const hookCtx = {
          agentId: hookAgentId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          workspaceDir: params.workspaceDir,
          messageProvider: params.messageProvider ?? undefined,
          trigger: params.trigger,
          channelId: params.messageChannel ?? params.messageProvider ?? undefined,
        };
        const hookResult = await resolvePromptBuildHookResult({
          prompt: params.prompt,
          messages: activeSession.messages,
          hookCtx,
          hookRunner,
          legacyBeforeAgentStartResult: params.legacyBeforeAgentStartResult,
        });
        {
          if (hookResult?.prependContext) {
            effectivePrompt = `${hookResult.prependContext}\n\n${params.prompt}`;
            log.debug(
              `hooks: prepended context to prompt (${hookResult.prependContext.length} chars)`,
            );
          }
          const legacySystemPrompt =
            typeof hookResult?.systemPrompt === "string" ? hookResult.systemPrompt.trim() : "";
          if (legacySystemPrompt) {
            applySystemPromptOverrideToSession(activeSession, legacySystemPrompt);
            systemPromptText = legacySystemPrompt;
            log.debug(`hooks: applied systemPrompt override (${legacySystemPrompt.length} chars)`);
          }
          const prependedOrAppendedSystemPrompt = composeSystemPromptWithHookContext({
            baseSystemPrompt: systemPromptText,
            prependSystemContext: hookResult?.prependSystemContext,
            appendSystemContext: hookResult?.appendSystemContext,
          });
          if (prependedOrAppendedSystemPrompt) {
            const prependSystemLen = hookResult?.prependSystemContext?.trim().length ?? 0;
            const appendSystemLen = hookResult?.appendSystemContext?.trim().length ?? 0;
            applySystemPromptOverrideToSession(activeSession, prependedOrAppendedSystemPrompt);
            systemPromptText = prependedOrAppendedSystemPrompt;
            log.debug(
              `hooks: applied prependSystemContext/appendSystemContext (${prependSystemLen}+${appendSystemLen} chars)`,
            );
          }
        }

        log.debug(`embedded run prompt start: runId=${params.runId} sessionId=${params.sessionId}`);
        cacheTrace?.recordStage("prompt:before", {
          prompt: effectivePrompt,
          messages: activeSession.messages,
        });

        // Repair orphaned trailing user messages so new prompts don't violate role ordering.
        const leafEntry = sessionManager.getLeafEntry();
        if (leafEntry?.type === "message" && leafEntry.message.role === "user") {
          if (leafEntry.parentId) {
            sessionManager.branch(leafEntry.parentId);
          } else {
            sessionManager.resetLeaf();
          }
          const sessionContext = sessionManager.buildSessionContext();
          activeSession.agent.replaceMessages(sessionContext.messages);
          log.warn(
            `Removed orphaned user message to prevent consecutive user turns. ` +
              `runId=${params.runId} sessionId=${params.sessionId}`,
          );
        }
        const transcriptLeafId =
          (sessionManager.getLeafEntry() as { id?: string } | null | undefined)?.id ?? null;

        try {
          // Idempotent cleanup for legacy sessions with persisted image payloads.
          // Called each run; only mutates already-answered user turns that still carry image blocks.
          const didPruneImages = pruneProcessedHistoryImages(activeSession.messages);
          if (didPruneImages) {
            activeSession.agent.replaceMessages(activeSession.messages);
          }

          // Detect and load images referenced in the prompt for vision-capable models.
          // Images are prompt-local only (pi-like behavior).
          const imageResult = await detectAndLoadPromptImages({
            prompt: effectivePrompt,
            workspaceDir: effectiveWorkspace,
            model: params.model,
            existingImages: params.images,
            maxBytes: MAX_IMAGE_BYTES,
            maxDimensionPx: resolveImageSanitizationLimits(params.config).maxDimensionPx,
            workspaceOnly: effectiveFsWorkspaceOnly,
            // Enforce sandbox path restrictions when sandbox is enabled
            sandbox:
              sandbox?.enabled && sandbox?.fsBridge
                ? { root: sandbox.workspaceDir, bridge: sandbox.fsBridge }
                : undefined,
          });

          cacheTrace?.recordStage("prompt:images", {
            prompt: effectivePrompt,
            messages: activeSession.messages,
            note: `images: prompt=${imageResult.images.length}`,
          });

          // Diagnostic: log context sizes before prompt to help debug early overflow errors.
          if (log.isEnabled("debug")) {
            const msgCount = activeSession.messages.length;
            const systemLen = systemPromptText?.length ?? 0;
            const promptLen = effectivePrompt.length;
            const sessionSummary = summarizeSessionContext(activeSession.messages);
            log.debug(
              `[context-diag] pre-prompt: sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `messages=${msgCount} roleCounts=${sessionSummary.roleCounts} ` +
                `historyTextChars=${sessionSummary.totalTextChars} ` +
                `maxMessageTextChars=${sessionSummary.maxMessageTextChars} ` +
                `historyImageBlocks=${sessionSummary.totalImageBlocks} ` +
                `systemPromptChars=${systemLen} promptChars=${promptLen} ` +
                `promptImages=${imageResult.images.length} ` +
                `provider=${params.provider}/${params.modelId} sessionFile=${params.sessionFile}`,
            );
          }

          if (hookRunner?.hasHooks("llm_input")) {
            hookRunner
              .runLlmInput(
                {
                  runId: params.runId,
                  sessionId: params.sessionId,
                  provider: params.provider,
                  model: params.modelId,
                  systemPrompt: systemPromptText,
                  prompt: effectivePrompt,
                  historyMessages: activeSession.messages,
                  imagesCount: imageResult.images.length,
                },
                {
                  agentId: hookAgentId,
                  sessionKey: params.sessionKey,
                  sessionId: params.sessionId,
                  workspaceDir: params.workspaceDir,
                  messageProvider: params.messageProvider ?? undefined,
                  trigger: params.trigger,
                  channelId: params.messageChannel ?? params.messageProvider ?? undefined,
                },
              )
              .catch((err) => {
                log.warn(`llm_input hook failed: ${String(err)}`);
              });
          }

          const btwSnapshotMessages = activeSession.messages.slice(-MAX_BTW_SNAPSHOT_MESSAGES);
          updateActiveEmbeddedRunSnapshot(params.sessionId, {
            transcriptLeafId,
            messages: btwSnapshotMessages,
            inFlightPrompt: effectivePrompt,
          });

          // Only pass images option if there are actually images to pass
          // This avoids potential issues with models that don't expect the images parameter
          if (imageResult.images.length > 0) {
            await abortable(activeSession.prompt(effectivePrompt, { images: imageResult.images }));
          } else {
            await abortable(activeSession.prompt(effectivePrompt));
          }
        } catch (err) {
          // Yield-triggered abort is intentional — treat as clean stop, not error.
          // Check the abort reason to distinguish from external aborts (timeout, user cancel)
          // that may race after yieldDetected is set.
          yieldAborted =
            yieldDetected &&
            isRunnerAbortError(err) &&
            err instanceof Error &&
            err.cause === "sessions_yield";
          if (yieldAborted) {
            aborted = false;
            // Ensure the session abort has fully settled before proceeding.
            if (yieldAbortSettled) {
              // eslint-disable-next-line @typescript-eslint/await-thenable -- abort() returns Promise<void> per AgentSession.d.ts
              await yieldAbortSettled;
            }
            stripSessionsYieldArtifacts(activeSession);
            if (yieldMessage) {
              await persistSessionsYieldContextMessage(activeSession, yieldMessage);
            }
          } else {
            promptError = err;
            promptErrorSource = "prompt";
          }
        } finally {
          log.debug(
            `embedded run prompt end: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - promptStartedAt}`,
          );
        }

        // Capture snapshot before compaction wait so we have complete messages if timeout occurs
        // Check compaction state before and after to avoid race condition where compaction starts during capture
        // Use session state (not subscription) for snapshot decisions - need instantaneous compaction status
        const wasCompactingBefore = activeSession.isCompacting;
        const snapshot = activeSession.messages.slice();
        const wasCompactingAfter = activeSession.isCompacting;
        // Only trust snapshot if compaction wasn't running before or after capture
        const preCompactionSnapshot = wasCompactingBefore || wasCompactingAfter ? null : snapshot;
        const preCompactionSessionId = activeSession.sessionId;
        const COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS = 60_000;

        try {
          // Flush buffered block replies before waiting for compaction so the
          // user receives the assistant response immediately.  Without this,
          // coalesced/buffered blocks stay in the pipeline until compaction
          // finishes — which can take minutes on large contexts (#35074).
          if (params.onBlockReplyFlush) {
            await params.onBlockReplyFlush();
          }

          // Skip compaction wait when yield aborted the run — the signal is
          // already tripped and abortable() would immediately reject.
          const compactionRetryWait = yieldAborted
            ? { timedOut: false }
            : await waitForCompactionRetryWithAggregateTimeout({
                waitForCompactionRetry,
                abortable,
                aggregateTimeoutMs: COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS,
                isCompactionStillInFlight: isCompactionInFlight,
              });
          if (compactionRetryWait.timedOut) {
            timedOutDuringCompaction = true;
            if (!isProbeSession) {
              log.warn(
                `compaction retry aggregate timeout (${COMPACTION_RETRY_AGGREGATE_TIMEOUT_MS}ms): ` +
                  `proceeding with pre-compaction state runId=${params.runId} sessionId=${params.sessionId}`,
              );
            }
          }
        } catch (err) {
          if (isRunnerAbortError(err)) {
            if (!promptError) {
              promptError = err;
              promptErrorSource = "compaction";
            }
            if (!isProbeSession) {
              log.debug(
                `compaction wait aborted: runId=${params.runId} sessionId=${params.sessionId}`,
              );
            }
          } else {
            throw err;
          }
        }

        // Check if ANY compaction occurred during the entire attempt (prompt + retry).
        // Using a cumulative count (> 0) instead of a delta check avoids missing
        // compactions that complete during activeSession.prompt() before the delta
        // baseline is sampled.
        const compactionOccurredThisAttempt = getCompactionCount() > 0;
        // Append cache-TTL timestamp AFTER prompt + compaction retry completes.
        // Previously this was before the prompt, which caused a custom entry to be
        // inserted between compaction and the next prompt — breaking the
        // prepareCompaction() guard that checks the last entry type, leading to
        // double-compaction. See: https://github.com/openclaw/openclaw/issues/9282
        // Skip when timed out during compaction — session state may be inconsistent.
        // Also skip when compaction ran this attempt — appending a custom entry
        // after compaction would break the guard again. See: #28491
        if (!timedOutDuringCompaction && !compactionOccurredThisAttempt) {
          const shouldTrackCacheTtl =
            params.config?.agents?.defaults?.contextPruning?.mode === "cache-ttl" &&
            isCacheTtlEligibleProvider(params.provider, params.modelId);
          if (shouldTrackCacheTtl) {
            appendCacheTtlTimestamp(sessionManager, {
              timestamp: Date.now(),
              provider: params.provider,
              modelId: params.modelId,
            });
          }
        }

        // If timeout occurred during compaction, use pre-compaction snapshot when available
        // (compaction restructures messages but does not add user/assistant turns).
        const snapshotSelection = selectCompactionTimeoutSnapshot({
          timedOutDuringCompaction,
          preCompactionSnapshot,
          preCompactionSessionId,
          currentSnapshot: activeSession.messages.slice(),
          currentSessionId: activeSession.sessionId,
        });
        if (timedOutDuringCompaction) {
          if (!isProbeSession) {
            log.warn(
              `using ${snapshotSelection.source} snapshot: timed out during compaction runId=${params.runId} sessionId=${params.sessionId}`,
            );
          }
        }
        messagesSnapshot = snapshotSelection.messagesSnapshot;
        sessionIdUsed = snapshotSelection.sessionIdUsed;

        if (promptError && promptErrorSource === "prompt" && !compactionOccurredThisAttempt) {
          try {
            sessionManager.appendCustomEntry("openclaw:prompt-error", {
              timestamp: Date.now(),
              runId: params.runId,
              sessionId: params.sessionId,
              provider: params.provider,
              model: params.modelId,
              api: params.model.api,
              error: describeUnknownError(promptError),
            });
          } catch (entryErr) {
            log.warn(`failed to persist prompt error entry: ${String(entryErr)}`);
          }
        }

        // Let the active context engine run its post-turn lifecycle.
        if (params.contextEngine) {
          const afterTurnRuntimeContext = buildAfterTurnRuntimeContext({
            attempt: params,
            workspaceDir: effectiveWorkspace,
            agentDir,
          });

          if (typeof params.contextEngine.afterTurn === "function") {
            try {
              await params.contextEngine.afterTurn({
                sessionId: sessionIdUsed,
                sessionKey: params.sessionKey,
                sessionFile: params.sessionFile,
                messages: messagesSnapshot,
                prePromptMessageCount,
                tokenBudget: params.contextTokenBudget,
                runtimeContext: afterTurnRuntimeContext,
              });
            } catch (afterTurnErr) {
              log.warn(`context engine afterTurn failed: ${String(afterTurnErr)}`);
            }
          } else {
            // Fallback: ingest new messages individually
            const newMessages = messagesSnapshot.slice(prePromptMessageCount);
            if (newMessages.length > 0) {
              if (typeof params.contextEngine.ingestBatch === "function") {
                try {
                  await params.contextEngine.ingestBatch({
                    sessionId: sessionIdUsed,
                    sessionKey: params.sessionKey,
                    messages: newMessages,
                  });
                } catch (ingestErr) {
                  log.warn(`context engine ingest failed: ${String(ingestErr)}`);
                }
              } else {
                for (const msg of newMessages) {
                  try {
                    await params.contextEngine.ingest({
                      sessionId: sessionIdUsed,
                      sessionKey: params.sessionKey,
                      message: msg,
                    });
                  } catch (ingestErr) {
                    log.warn(`context engine ingest failed: ${String(ingestErr)}`);
                  }
                }
              }
            }
          }
        }

        cacheTrace?.recordStage("session:after", {
          messages: messagesSnapshot,
          note: timedOutDuringCompaction
            ? "compaction timeout"
            : promptError
              ? "prompt error"
              : undefined,
        });
        anthropicPayloadLogger?.recordUsage(messagesSnapshot, promptError);

        // Run agent_end hooks to allow plugins to analyze the conversation
        // This is fire-and-forget, so we don't await
        // Run even on compaction timeout so plugins can log/cleanup
        if (hookRunner?.hasHooks("agent_end")) {
          hookRunner
            .runAgentEnd(
              {
                messages: messagesSnapshot,
                success: !aborted && !promptError,
                error: promptError ? describeUnknownError(promptError) : undefined,
                durationMs: Date.now() - promptStartedAt,
              },
              {
                agentId: hookAgentId,
                sessionKey: params.sessionKey,
                sessionId: params.sessionId,
                workspaceDir: params.workspaceDir,
                messageProvider: params.messageProvider ?? undefined,
                trigger: params.trigger,
                channelId: params.messageChannel ?? params.messageProvider ?? undefined,
              },
            )
            .catch((err) => {
              log.warn(`agent_end hook failed: ${err}`);
            });
        }
      } finally {
        clearTimeout(abortTimer);
        if (abortWarnTimer) {
          clearTimeout(abortWarnTimer);
        }
        if (!isProbeSession && (aborted || timedOut) && !timedOutDuringCompaction) {
          log.debug(
            `run cleanup: runId=${params.runId} sessionId=${params.sessionId} aborted=${aborted} timedOut=${timedOut}`,
          );
        }
        try {
          unsubscribe();
        } catch (err) {
          // unsubscribe() should never throw; if it does, it indicates a serious bug.
          // Log at error level to ensure visibility, but don't rethrow in finally block
          // as it would mask any exception from the try block above.
          log.error(
            `CRITICAL: unsubscribe failed, possible resource leak: runId=${params.runId} ${String(err)}`,
          );
        }
        clearActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey);
        params.abortSignal?.removeEventListener?.("abort", onAbort);
      }

      const lastAssistant = messagesSnapshot
        .slice()
        .toReversed()
        .find((m) => m.role === "assistant");

      const toolMetasNormalized = toolMetas
        .filter(
          (entry): entry is { toolName: string; meta?: string } =>
            typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
        )
        .map((entry) => ({ toolName: entry.toolName, meta: entry.meta }));

      if (hookRunner?.hasHooks("llm_output")) {
        hookRunner
          .runLlmOutput(
            {
              runId: params.runId,
              sessionId: params.sessionId,
              provider: params.provider,
              model: params.modelId,
              assistantTexts,
              lastAssistant,
              usage: getUsageTotals(),
            },
            {
              agentId: hookAgentId,
              sessionKey: params.sessionKey,
              sessionId: params.sessionId,
              workspaceDir: params.workspaceDir,
              messageProvider: params.messageProvider ?? undefined,
              trigger: params.trigger,
              channelId: params.messageChannel ?? params.messageProvider ?? undefined,
            },
          )
          .catch((err) => {
            log.warn(`llm_output hook failed: ${String(err)}`);
          });
      }

      return {
        aborted,
        timedOut,
        timedOutDuringCompaction,
        promptError,
        sessionIdUsed,
        bootstrapPromptWarningSignaturesSeen: bootstrapPromptWarning.warningSignaturesSeen,
        bootstrapPromptWarningSignature: bootstrapPromptWarning.signature,
        systemPromptReport,
        messagesSnapshot,
        assistantTexts,
        toolMetas: toolMetasNormalized,
        lastAssistant,
        lastToolError: getLastToolError?.(),
        didSendViaMessagingTool: didSendViaMessagingTool(),
        messagingToolSentTexts: getMessagingToolSentTexts(),
        messagingToolSentMediaUrls: getMessagingToolSentMediaUrls(),
        messagingToolSentTargets: getMessagingToolSentTargets(),
        successfulCronAdds: getSuccessfulCronAdds(),
        cloudCodeAssistFormatError: Boolean(
          lastAssistant?.errorMessage && isCloudCodeAssistFormatError(lastAssistant.errorMessage),
        ),
        attemptUsage: getUsageTotals(),
        compactionCount: getCompactionCount(),
        // Client tool call detected (OpenResponses hosted tools)
        clientToolCall: clientToolCallDetected ?? undefined,
        yieldDetected: yieldDetected || undefined,
      };
    } finally {
      // Always tear down the session (and release the lock) before we leave this attempt.
      //
      // BUGFIX: Wait for the agent to be truly idle before flushing pending tool results.
      // pi-agent-core's auto-retry resolves waitForRetry() on assistant message receipt,
      // *before* tool execution completes in the retried agent loop. Without this wait,
      // flushPendingToolResults() fires while tools are still executing, inserting
      // synthetic "missing tool result" errors and causing silent agent failures.
      // See: https://github.com/openclaw/openclaw/issues/8643
      removeToolResultContextGuard?.();
      await flushPendingToolResultsAfterIdle({
        agent: session?.agent,
        sessionManager,
        clearPendingOnTimeout: true,
      });
      session?.dispose();
      releaseWsSession(params.sessionId);
      await sessionLock.release();
    }
  } finally {
    restoreSkillEnv?.();
    process.chdir(prevCwd);
  }
}
