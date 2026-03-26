// 外部依赖导入：pi-coding-agent提供基础编码工具集
import { codingTools, createReadTool, readTool } from "@mariozechner/pi-coding-agent";
// 配置类型导入
import type { OpenClawConfig } from "../config/config.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
// 基础设施层导入
import { resolveMergedSafeBinProfileFixtures } from "../infra/exec-safe-bin-runtime-policy.js";
import { logWarn } from "../logger.js";
// 插件系统导入
import { getPluginToolMeta } from "../plugins/tools.js";
// 路由和会话相关导入
import { isSubagentSessionKey } from "../routing/session-key.js";
import { resolveGatewayMessageChannel } from "../utils/message-channel.js";
// Agent相关导入
import { resolveAgentConfig } from "./agent-scope.js";
import { createApplyPatchTool } from "./apply-patch.js"; // apply_patch工具实现
import {
  createExecTool,
  createProcessTool,
  type ExecToolDefaults,
  type ProcessToolDefaults,
} from "./bash-tools.js"; // exec和process工具实现
import { listChannelAgentTools } from "./channel-tools.js"; // 渠道专属工具
import { resolveImageSanitizationLimits } from "./image-sanitization.js"; // 图片清理配置
import type { ModelAuthMode } from "./model-auth.js"; // 模型认证模式类型
import { createOpenClawTools } from "./openclaw-tools.js"; // OpenClaw扩展工具集
// 工具包装器导入
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js"; // 工具中止信号包装
import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js"; // 工具调用前置钩子
import {
  isToolAllowedByPolicies,
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicyForSession,
} from "./pi-tools.policy.js"; // 工具权限策略
// 文件操作工具导入
import {
  assertRequiredParams,
  createHostWorkspaceEditTool,
  createHostWorkspaceWriteTool,
  createOpenClawReadTool,
  createSandboxedEditTool,
  createSandboxedReadTool,
  createSandboxedWriteTool,
  normalizeToolParams,
  patchToolSchemaForClaudeCompatibility,
  wrapToolMemoryFlushAppendOnlyWrite,
  wrapToolWorkspaceRootGuard,
  wrapToolWorkspaceRootGuardWithOptions,
  wrapToolParamNormalization,
} from "./pi-tools.read.js"; // 读写编辑工具实现
// 工具Schema处理导入
import { cleanToolSchemaForGemini, normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js"; // 工具通用类型
// 沙箱相关导入
import type { SandboxContext } from "./sandbox.js";
// 模型相关导入
import { isXaiProvider } from "./schema/clean-for-xai.js"; // XAI/Grok模型检测
// 工具策略相关导入
import { createToolFsPolicy, resolveToolFsConfig } from "./tool-fs-policy.js"; // 文件系统策略
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "./tool-policy-pipeline.js"; // 工具策略流水线
import {
  applyOwnerOnlyToolPolicy,
  collectExplicitAllowlist,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "./tool-policy.js"; // 工具权限策略
import { resolveWorkspaceRoot } from "./workspace-dir.js"; // 工作区根目录解析

/**
 * 判断是否是OpenAI系列模型提供商
 * @param provider 模型提供商名称
 * @returns 是否是OpenAI系列提供商
 */
function isOpenAIProvider(provider?: string) {
  const normalized = provider?.trim().toLowerCase();
  return normalized === "openai" || normalized === "openai-codex";
}

// 按消息渠道禁用的工具映射：不同渠道禁用特定工具
const TOOL_DENY_BY_MESSAGE_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  voice: ["tts"], // 语音渠道禁用tts工具，避免重复语音输出
};

// XAI/Grok提供商禁用的工具：因为xAI本身内置了web_search，避免重复
const TOOL_DENY_FOR_XAI_PROVIDERS = new Set(["web_search"]);

// 内存刷新模式下允许使用的工具：仅允许读和写
const MEMORY_FLUSH_ALLOWED_TOOL_NAMES = new Set(["read", "write"]);

/**
 * 标准化消息渠道名称
 * @param messageProvider 原始消息渠道名称
 * @returns 标准化后的渠道名称
 */
function normalizeMessageProvider(messageProvider?: string): string | undefined {
  const normalized = messageProvider?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * 应用消息渠道的工具禁用策略
 * 根据不同的消息渠道过滤掉不允许使用的工具
 * @param tools 原始工具列表
 * @param messageProvider 消息渠道名称
 * @returns 过滤后的工具列表
 */
function applyMessageProviderToolPolicy(
  tools: AnyAgentTool[],
  messageProvider?: string,
): AnyAgentTool[] {
  const normalizedProvider = normalizeMessageProvider(messageProvider);
  // 没有指定渠道，返回所有工具
  if (!normalizedProvider) {
    return tools;
  }
  const deniedTools = TOOL_DENY_BY_MESSAGE_PROVIDER[normalizedProvider];
  // 该渠道没有禁用工具，返回所有工具
  if (!deniedTools || deniedTools.length === 0) {
    return tools;
  }
  // 过滤掉禁用的工具
  const deniedSet = new Set(deniedTools);
  return tools.filter((tool) => !deniedSet.has(tool.name));
}

/**
 * 应用模型提供商的工具禁用策略
 * 针对特定模型提供商过滤掉冲突或不支持的工具
 * @param tools 原始工具列表
 * @param params 模型参数
 * @returns 过滤后的工具列表
 */
function applyModelProviderToolPolicy(
  tools: AnyAgentTool[],
  params?: { modelProvider?: string; modelId?: string },
): AnyAgentTool[] {
  // 如果不是XAI/Grok提供商，返回所有工具
  if (!isXaiProvider(params?.modelProvider, params?.modelId)) {
    return tools;
  }
  // xAI/Grok本身已经内置了web_search工具，如果同时发送OpenClaw的web_search会导致名称冲突
  return tools.filter((tool) => !TOOL_DENY_FOR_XAI_PROVIDERS.has(tool.name));
}

/**
 * 判断apply_patch工具是否允许在当前模型上使用
 * @param params 配置参数
 * @param params.modelProvider 模型提供商
 * @param params.modelId 模型ID
 * @param params.allowModels 允许使用apply_patch的模型列表
 * @returns 是否允许使用apply_patch
 */
function isApplyPatchAllowedForModel(params: {
  modelProvider?: string;
  modelId?: string;
  allowModels?: string[];
}) {
  const allowModels = Array.isArray(params.allowModels) ? params.allowModels : [];
  // 如果没有配置允许的模型列表，默认允许所有模型使用
  if (allowModels.length === 0) {
    return true;
  }
  const modelId = params.modelId?.trim();
  // 模型ID为空时不允许使用
  if (!modelId) {
    return false;
  }
  // 标准化模型ID为小写
  const normalizedModelId = modelId.toLowerCase();
  const provider = params.modelProvider?.trim().toLowerCase();
  // 构造完整的模型标识：provider/modelId格式
  const normalizedFull =
    provider && !normalizedModelId.includes("/")
      ? `${provider}/${normalizedModelId}`
      : normalizedModelId;
  // 检查当前模型是否在允许列表中
  return allowModels.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    // 支持两种匹配方式：直接匹配modelId，或匹配完整的provider/modelId格式
    return normalized === normalizedModelId || normalized === normalizedFull;
  });
}

/**
 * 解析exec工具的配置，合并全局配置和Agent专属配置
 * @param params 配置参数
 * @param params.cfg 全局配置
 * @param params.agentId Agent ID
 * @returns 合并后的exec配置
 */
function resolveExecConfig(params: { cfg?: OpenClawConfig; agentId?: string }) {
  const cfg = params.cfg;
  const globalExec = cfg?.tools?.exec; // 全局exec配置
  const agentExec =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.exec : undefined; // Agent专属exec配置

  // 合并配置，Agent配置优先级高于全局配置
  return {
    host: agentExec?.host ?? globalExec?.host,
    security: agentExec?.security ?? globalExec?.security,
    ask: agentExec?.ask ?? globalExec?.ask,
    node: agentExec?.node ?? globalExec?.node,
    pathPrepend: agentExec?.pathPrepend ?? globalExec?.pathPrepend,
    safeBins: agentExec?.safeBins ?? globalExec?.safeBins,
    safeBinTrustedDirs: agentExec?.safeBinTrustedDirs ?? globalExec?.safeBinTrustedDirs,
    safeBinProfiles: resolveMergedSafeBinProfileFixtures({
      // 合并安全二进制文件配置
      global: globalExec,
      local: agentExec,
    }),
    backgroundMs: agentExec?.backgroundMs ?? globalExec?.backgroundMs,
    timeoutSec: agentExec?.timeoutSec ?? globalExec?.timeoutSec,
    approvalRunningNoticeMs:
      agentExec?.approvalRunningNoticeMs ?? globalExec?.approvalRunningNoticeMs,
    cleanupMs: agentExec?.cleanupMs ?? globalExec?.cleanupMs,
    notifyOnExit: agentExec?.notifyOnExit ?? globalExec?.notifyOnExit,
    notifyOnExitEmptySuccess:
      agentExec?.notifyOnExitEmptySuccess ?? globalExec?.notifyOnExitEmptySuccess,
    applyPatch: agentExec?.applyPatch ?? globalExec?.applyPatch, // apply_patch工具配置
  };
}

/**
 * 解析工具循环检测配置，合并全局配置和Agent专属配置
 * 用于检测和防止工具调用的无限循环
 * @param params 配置参数
 * @param params.cfg 全局配置
 * @param params.agentId Agent ID
 * @returns 合并后的循环检测配置
 */
export function resolveToolLoopDetectionConfig(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): ToolLoopDetectionConfig | undefined {
  const global = params.cfg?.tools?.loopDetection; // 全局循环检测配置
  const agent =
    params.agentId && params.cfg
      ? resolveAgentConfig(params.cfg, params.agentId)?.tools?.loopDetection
      : undefined; // Agent专属循环检测配置

  // Agent没有配置时返回全局配置
  if (!agent) {
    return global;
  }
  // 全局没有配置时返回Agent配置
  if (!global) {
    return agent;
  }

  // 深度合并配置，检测器配置合并而非覆盖
  return {
    ...global,
    ...agent,
    detectors: {
      ...global.detectors,
      ...agent.detectors,
    },
  };
}

// 内部测试导出：仅用于单元测试，外部代码不应该直接使用
export const __testing = {
  cleanToolSchemaForGemini, // Gemini模型Schema清理
  normalizeToolParams, // 工具参数标准化
  patchToolSchemaForClaudeCompatibility, // Claude模型Schema兼容补丁
  wrapToolParamNormalization, // 参数标准化包装器
  assertRequiredParams, // 必填参数校验
  applyModelProviderToolPolicy, // 模型提供商工具策略应用
} as const;

/**
 * 创建OpenClaw编码工具集的核心入口函数
 * 根据会话配置创建并返回所有可用的工具实例，应用所有安全策略和功能包装
 * @param options 工具创建配置选项
 * @returns 可用的工具实例列表
 */
export function createOpenClawCodingTools(options?: {
  agentId?: string; // Agent唯一标识
  exec?: ExecToolDefaults & ProcessToolDefaults; // exec工具的默认配置
  messageProvider?: string; // 消息渠道（如slack/discord/voice等）
  agentAccountId?: string; // Agent账户ID
  messageTo?: string; // 消息接收者
  messageThreadId?: string | number; // 消息线程ID
  sandbox?: SandboxContext | null; // 沙箱上下文配置
  sessionKey?: string; // 会话密钥
  /** 临时会话UUID，执行/new或/reset命令时会重新生成 */
  sessionId?: string;
  /** Agent调用的稳定运行标识 */
  runId?: string;
  /** 触发本次运行的来源，用于触发器特定的工具限制 */
  trigger?: string;
  /** 内存刷新触发的写入操作允许追加的相对工作区路径 */
  memoryFlushWritePath?: string;
  agentDir?: string; // Agent数据目录
  workspaceDir?: string; // 工作区目录
  /**
   * 子Agent应该继承的工作区目录
   * 当沙箱使用复制的工作区（ro或none模式）时，workspaceDir是沙箱副本，
   * 但子Agent应该继承真实的Agent工作区，未设置时默认使用workspaceDir
   */
  spawnWorkspaceDir?: string;
  config?: OpenClawConfig; // 全局配置
  abortSignal?: AbortSignal; // 中止信号
  /**
   * 当前选择的模型提供商，用于处理提供商特定的工具兼容性问题
   * 示例值："anthropic", "openai", "google", "openai-codex"
   */
  modelProvider?: string;
  /** 当前提供商的模型ID，用于模型特定的工具门控 */
  modelId?: string;
  /** 模型上下文窗口大小（token数），用于调整read工具的输出预算 */
  modelContextWindowTokens?: number;
  /**
   * 当前提供商的认证模式，仅用于处理Anthropic OAuth的工具名称阻塞问题
   */
  modelAuthMode?: ModelAuthMode;
  /** 当前渠道ID，用于Slack自动线程功能 */
  currentChannelId?: string;
  /** 当前线程时间戳，用于Slack自动线程功能 */
  currentThreadTs?: string;
  /** 当前入站消息ID，用于操作回退（例如Telegram表情回应） */
  currentMessageId?: string | number;
  /** 群组ID，用于渠道级别的工具策略解析 */
  groupId?: string | null;
  /** 群组渠道标签（例如#general），用于渠道级别的工具策略解析 */
  groupChannel?: string | null;
  /** 群组空间标签（例如guild/team id），用于渠道级别的工具策略解析 */
  groupSpace?: string | null;
  /** 父会话密钥，用于子Agent的群组策略继承 */
  spawnedBy?: string | null;
  senderId?: string | null; // 发送者ID
  senderName?: string | null; // 发送者名称
  senderUsername?: string | null; // 发送者用户名
  senderE164?: string | null; // 发送者电话号码（E.164格式）
  /** Slack自动线程的回复模式 */
  replyToMode?: "off" | "first" | "all";
  /** 可变引用，用于跟踪是否已发送回复（first模式下使用） */
  hasRepliedRef?: { value: boolean };
  /** 模型是否具有原生视觉能力 */
  modelHasVision?: boolean;
  /** 是否需要显式指定消息目标（禁止隐式发送到最后一个路由） */
  requireExplicitMessageTarget?: boolean;
  /** 是否从工具列表中省略message工具 */
  disableMessageTool?: boolean;
  /** 发送者是否是所有者，需要用于所有者专属工具 */
  senderIsOwner?: boolean;
  /** 调用sessions_yield工具时的回调函数 */
  onYield?: (message: string) => Promise<void> | void;
}): AnyAgentTool[] {
  const execToolName = "exec"; // exec工具的名称
  const sandbox = options?.sandbox?.enabled ? options.sandbox : undefined; // 沙箱是否启用
  const isMemoryFlushRun = options?.trigger === "memory"; // 是否是内存刷新触发的运行
  // 内存刷新模式必须指定memoryFlushWritePath
  if (isMemoryFlushRun && !options?.memoryFlushWritePath) {
    throw new Error("memoryFlushWritePath required for memory-triggered tool runs");
  }
  const memoryFlushWritePath = isMemoryFlushRun ? options.memoryFlushWritePath : undefined;
  // 解析工具权限策略：全局、Agent、模型、群组等多层级策略
  const {
    agentId,
    globalPolicy, // 全局工具策略
    globalProviderPolicy, // 全局模型提供商策略
    agentPolicy, // Agent专属工具策略
    agentProviderPolicy, // Agent专属模型提供商策略
    profile, // 工具配置profile（minimal/coding/messaging/full）
    providerProfile, // 模型提供商专属profile
    profileAlsoAllow, // profile额外允许的工具
    providerProfileAlsoAllow, // 模型提供商profile额外允许的工具
  } = resolveEffectiveToolPolicy({
    config: options?.config,
    sessionKey: options?.sessionKey,
    agentId: options?.agentId,
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
  });

  // 解析群组级别的工具策略（针对群组/频道场景）
  const groupPolicy = resolveGroupToolPolicy({
    config: options?.config,
    sessionKey: options?.sessionKey,
    spawnedBy: options?.spawnedBy,
    messageProvider: options?.messageProvider,
    groupId: options?.groupId,
    groupChannel: options?.groupChannel,
    groupSpace: options?.groupSpace,
    accountId: options?.agentAccountId,
    senderId: options?.senderId,
    senderName: options?.senderName,
    senderUsername: options?.senderUsername,
    senderE164: options?.senderE164,
  });

  // 解析profile对应的工具策略
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);

  // 合并额外允许的工具列表
  const profilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllowPolicy(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );

  // 进程隔离范围键：优先使用sessionKey防止跨会话进程可见/操作
  // 没有sessionKey时回退到agentId（例如遗留场景或全局上下文）
  const scopeKey =
    options?.exec?.scopeKey ?? options?.sessionKey ?? (agentId ? `agent:${agentId}` : undefined);

  // 解析子Agent的工具策略
  const subagentPolicy =
    isSubagentSessionKey(options?.sessionKey) && options?.sessionKey
      ? resolveSubagentToolPolicyForSession(options.config, options.sessionKey)
      : undefined;

  // 检查是否允许使用process工具的后台进程功能
  const allowBackground = isToolAllowedByPolicies("process", [
    profilePolicyWithAlsoAllow,
    providerProfilePolicyWithAlsoAllow,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    sandbox?.tools,
    subagentPolicy,
  ]);
  // 解析exec工具配置
  const execConfig = resolveExecConfig({ cfg: options?.config, agentId });
  // 解析文件系统配置
  const fsConfig = resolveToolFsConfig({ cfg: options?.config, agentId });
  // 创建文件系统策略：内存刷新模式下强制只允许工作区操作
  const fsPolicy = createToolFsPolicy({
    workspaceOnly: isMemoryFlushRun || fsConfig.workspaceOnly,
  });

  // 沙箱相关配置
  const sandboxRoot = sandbox?.workspaceDir; // 沙箱工作区根目录
  const sandboxFsBridge = sandbox?.fsBridge; // 沙箱文件系统桥接器
  const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro"; // 是否允许写入工作区（非只读模式）
  const workspaceRoot = resolveWorkspaceRoot(options?.workspaceDir); // 工作区根目录
  const workspaceOnly = fsPolicy.workspaceOnly; // 是否只允许操作工作区内的文件

  // apply_patch工具配置
  const applyPatchConfig = execConfig.applyPatch;
  // 默认安全策略：apply_patch默认只允许操作工作区内的文件，除非显式禁用
  // tools.fs.workspaceOnly是覆盖所有文件操作工具的总开关
  const applyPatchWorkspaceOnly = workspaceOnly || applyPatchConfig?.workspaceOnly !== false;
  // 判定apply_patch工具是否启用：配置启用 + 是OpenAI模型 + 当前模型在允许列表中
  const applyPatchEnabled =
    !!applyPatchConfig?.enabled &&
    isOpenAIProvider(options?.modelProvider) &&
    isApplyPatchAllowedForModel({
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
      allowModels: applyPatchConfig?.allowModels,
    });

  // 沙箱完整性校验：如果启用了沙箱但没有文件系统桥接器，抛出错误
  if (sandboxRoot && !sandboxFsBridge) {
    throw new Error("Sandbox filesystem bridge is unavailable.");
  }

  // 解析图片清理限制配置
  const imageSanitization = resolveImageSanitizationLimits(options?.config);

  // 处理基础编码工具集，根据环境差异创建对应的工具实例
  const base = (codingTools as unknown as AnyAgentTool[]).flatMap((tool) => {
    // 处理read工具
    if (tool.name === readTool.name) {
      // 沙箱环境下创建沙箱版read工具
      if (sandboxRoot) {
        const sandboxed = createSandboxedReadTool({
          root: sandboxRoot,
          bridge: sandboxFsBridge!,
          modelContextWindowTokens: options?.modelContextWindowTokens,
          imageSanitization,
        });
        return [
          // 工作区模式下添加根目录保护
          workspaceOnly
            ? wrapToolWorkspaceRootGuardWithOptions(sandboxed, sandboxRoot, {
                containerWorkdir: sandbox.containerWorkdir,
              })
            : sandboxed,
        ];
      }
      // 普通环境下创建宿主版read工具
      const freshReadTool = createReadTool(workspaceRoot);
      // 包装为OpenClaw增强版read工具（添加自适应分页、图片处理等功能）
      const wrapped = createOpenClawReadTool(freshReadTool, {
        modelContextWindowTokens: options?.modelContextWindowTokens,
        imageSanitization,
      });
      return [workspaceOnly ? wrapToolWorkspaceRootGuard(wrapped, workspaceRoot) : wrapped];
    }

    // 过滤掉上游的bash/exec工具，后面单独创建OpenClaw专属的exec工具
    if (tool.name === "bash" || tool.name === execToolName) {
      return [];
    }

    // 处理write工具
    if (tool.name === "write") {
      // 沙箱环境下write工具后面单独创建，这里先过滤
      if (sandboxRoot) {
        return [];
      }
      // 普通环境创建宿主版write工具
      const wrapped = createHostWorkspaceWriteTool(workspaceRoot, { workspaceOnly });
      return [workspaceOnly ? wrapToolWorkspaceRootGuard(wrapped, workspaceRoot) : wrapped];
    }

    // 处理edit工具
    if (tool.name === "edit") {
      // 沙箱环境下edit工具后面单独创建，这里先过滤
      if (sandboxRoot) {
        return [];
      }
      // 普通环境创建宿主版edit工具
      const wrapped = createHostWorkspaceEditTool(workspaceRoot, { workspaceOnly });
      return [workspaceOnly ? wrapToolWorkspaceRootGuard(wrapped, workspaceRoot) : wrapped];
    }

    // 其他基础工具直接返回
    return [tool];
  });
  // 解构exec配置，提取cleanupMs单独给process工具使用
  const { cleanupMs: cleanupMsOverride, ...execDefaults } = options?.exec ?? {};

  // 创建exec工具：执行系统命令的核心工具
  const execTool = createExecTool({
    ...execDefaults,
    host: options?.exec?.host ?? execConfig.host, // 命令执行宿主
    security: options?.exec?.security ?? execConfig.security, // 安全配置
    ask: options?.exec?.ask ?? execConfig.ask, // 命令执行前是否需要用户确认
    node: options?.exec?.node ?? execConfig.node, // Node.js相关配置
    pathPrepend: options?.exec?.pathPrepend ?? execConfig.pathPrepend, // 环境变量PATH前置路径
    safeBins: options?.exec?.safeBins ?? execConfig.safeBins, // 安全二进制白名单
    safeBinTrustedDirs: options?.exec?.safeBinTrustedDirs ?? execConfig.safeBinTrustedDirs, // 安全二进制信任目录
    safeBinProfiles: options?.exec?.safeBinProfiles ?? execConfig.safeBinProfiles, // 安全二进制profile配置
    agentId,
    cwd: workspaceRoot, // 命令执行的工作目录
    allowBackground, // 是否允许后台进程
    scopeKey, // 进程隔离范围键
    sessionKey: options?.sessionKey, // 会话密钥
    messageProvider: options?.messageProvider, // 消息渠道
    currentChannelId: options?.currentChannelId, // 当前渠道ID
    currentThreadTs: options?.currentThreadTs, // 当前线程时间戳
    accountId: options?.agentAccountId, // Agent账户ID
    backgroundMs: options?.exec?.backgroundMs ?? execConfig.backgroundMs, // 后台进程超时时间
    timeoutSec: options?.exec?.timeoutSec ?? execConfig.timeoutSec, // 命令执行超时时间
    approvalRunningNoticeMs:
      options?.exec?.approvalRunningNoticeMs ?? execConfig.approvalRunningNoticeMs, // 运行中审批通知间隔
    notifyOnExit: options?.exec?.notifyOnExit ?? execConfig.notifyOnExit, // 进程退出时是否通知
    notifyOnExitEmptySuccess:
      options?.exec?.notifyOnExitEmptySuccess ?? execConfig.notifyOnExitEmptySuccess, // 空输出成功时是否通知
    sandbox: sandbox // 沙箱配置（如果启用沙箱）
      ? {
          containerName: sandbox.containerName,
          workspaceDir: sandbox.workspaceDir,
          containerWorkdir: sandbox.containerWorkdir,
          env: sandbox.docker.env,
        }
      : undefined,
  });

  // 创建process工具：管理后台进程的工具
  const processTool = createProcessTool({
    cleanupMs: cleanupMsOverride ?? execConfig.cleanupMs, // 进程清理超时时间
    scopeKey, // 进程隔离范围键
  });

  // 创建apply_patch工具：仅在启用且允许写入的情况下创建
  const applyPatchTool =
    !applyPatchEnabled || (sandboxRoot && !allowWorkspaceWrites)
      ? null
      : createApplyPatchTool({
          cwd: sandboxRoot ?? workspaceRoot, // 执行补丁的工作目录
          sandbox: // 沙箱配置
            sandboxRoot && allowWorkspaceWrites
              ? { root: sandboxRoot, bridge: sandboxFsBridge! }
              : undefined,
          workspaceOnly: applyPatchWorkspaceOnly, // 是否只允许工作区内的补丁操作
        });
  // 组装最终的工具列表
  const tools: AnyAgentTool[] = [
    ...base, // 基础编码工具集
    // 沙箱环境下添加沙箱专属的编辑和写入工具
    ...(sandboxRoot
      ? allowWorkspaceWrites
        ? [
            // 沙箱版edit工具，可选添加工作区根目录保护
            workspaceOnly
              ? wrapToolWorkspaceRootGuardWithOptions(
                  createSandboxedEditTool({ root: sandboxRoot, bridge: sandboxFsBridge! }),
                  sandboxRoot,
                  {
                    containerWorkdir: sandbox.containerWorkdir,
                  },
                )
              : createSandboxedEditTool({ root: sandboxRoot, bridge: sandboxFsBridge! }),
            // 沙箱版write工具，可选添加工作区根目录保护
            workspaceOnly
              ? wrapToolWorkspaceRootGuardWithOptions(
                  createSandboxedWriteTool({ root: sandboxRoot, bridge: sandboxFsBridge! }),
                  sandboxRoot,
                  {
                    containerWorkdir: sandbox.containerWorkdir,
                  },
                )
              : createSandboxedWriteTool({ root: sandboxRoot, bridge: sandboxFsBridge! }),
          ]
        : []
      : []),
    ...(applyPatchTool ? [applyPatchTool as unknown as AnyAgentTool] : []), // apply_patch工具（如果启用）
    execTool as unknown as AnyAgentTool, // exec命令执行工具
    processTool as unknown as AnyAgentTool, // process进程管理工具
    // 渠道专属工具：包含各消息渠道定义的专属工具（如登录等）
    ...listChannelAgentTools({ cfg: options?.config }),
    // OpenClaw扩展工具集：包含浏览器、会话、消息等高级功能工具
    ...createOpenClawTools({
      sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl, // 沙箱浏览器桥接地址
      allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true, // 是否允许控制宿主浏览器
      agentSessionKey: options?.sessionKey, // Agent会话密钥
      agentChannel: resolveGatewayMessageChannel(options?.messageProvider), // Agent消息渠道
      agentAccountId: options?.agentAccountId, // Agent账户ID
      agentTo: options?.messageTo, // 消息接收者
      agentThreadId: options?.messageThreadId, // 消息线程ID
      agentGroupId: options?.groupId ?? null, // 群组ID
      agentGroupChannel: options?.groupChannel ?? null, // 群组渠道
      agentGroupSpace: options?.groupSpace ?? null, // 群组空间
      agentDir: options?.agentDir, // Agent数据目录
      sandboxRoot, // 沙箱根目录
      sandboxFsBridge, // 沙箱文件系统桥接器
      fsPolicy, // 文件系统策略
      workspaceDir: workspaceRoot, // 工作区目录
      spawnWorkspaceDir: options?.spawnWorkspaceDir // 子Agent继承的工作区目录
        ? resolveWorkspaceRoot(options.spawnWorkspaceDir)
        : undefined,
      sandboxed: !!sandbox, // 是否运行在沙箱环境
      config: options?.config, // 全局配置
      pluginToolAllowlist: collectExplicitAllowlist([
        // 插件工具白名单
        profilePolicy,
        providerProfilePolicy,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        sandbox?.tools,
        subagentPolicy,
      ]),
      currentChannelId: options?.currentChannelId, // 当前渠道ID
      currentThreadTs: options?.currentThreadTs, // 当前线程时间戳
      currentMessageId: options?.currentMessageId, // 当前消息ID
      replyToMode: options?.replyToMode, // 回复模式
      hasRepliedRef: options?.hasRepliedRef, // 是否已回复的引用
      modelHasVision: options?.modelHasVision, // 模型是否有视觉能力
      requireExplicitMessageTarget: options?.requireExplicitMessageTarget,
      disableMessageTool: options?.disableMessageTool,
      requesterAgentIdOverride: agentId,
      requesterSenderId: options?.senderId,
      senderIsOwner: options?.senderIsOwner,
      sessionId: options?.sessionId,
      onYield: options?.onYield,
    }),
  ];
  const toolsForMemoryFlush =
    isMemoryFlushRun && memoryFlushWritePath
      ? tools.flatMap((tool) => {
          if (!MEMORY_FLUSH_ALLOWED_TOOL_NAMES.has(tool.name)) {
            return [];
          }
          if (tool.name === "write") {
            return [
              wrapToolMemoryFlushAppendOnlyWrite(tool, {
                root: sandboxRoot ?? workspaceRoot,
                relativePath: memoryFlushWritePath,
                containerWorkdir: sandbox?.containerWorkdir,
                sandbox:
                  sandboxRoot && sandboxFsBridge
                    ? { root: sandboxRoot, bridge: sandboxFsBridge }
                    : undefined,
              }),
            ];
          }
          return [tool];
        })
      : tools;
  const toolsForMessageProvider = applyMessageProviderToolPolicy(
    toolsForMemoryFlush,
    options?.messageProvider,
  );
  const toolsForModelProvider = applyModelProviderToolPolicy(toolsForMessageProvider, {
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
  });
  // Security: treat unknown/undefined as unauthorized (opt-in, not opt-out)
  const senderIsOwner = options?.senderIsOwner === true;
  const toolsByAuthorization = applyOwnerOnlyToolPolicy(toolsForModelProvider, senderIsOwner);
  const subagentFiltered = applyToolPolicyPipeline({
    tools: toolsByAuthorization,
    toolMeta: (tool) => getPluginToolMeta(tool),
    warn: logWarn,
    steps: [
      ...buildDefaultToolPolicyPipelineSteps({
        profilePolicy: profilePolicyWithAlsoAllow,
        profile,
        providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
        providerProfile,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        agentId,
      }),
      { policy: sandbox?.tools, label: "sandbox tools.allow" },
      { policy: subagentPolicy, label: "subagent tools.allow" },
    ],
  });
  // Always normalize tool JSON Schemas before handing them to pi-agent/pi-ai.
  // Without this, some providers (notably OpenAI) will reject root-level union schemas.
  // Provider-specific cleaning: Gemini needs constraint keywords stripped, but Anthropic expects them.
  const normalized = subagentFiltered.map((tool) =>
    normalizeToolParameters(tool, {
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
    }),
  );
  const withHooks = normalized.map((tool) =>
    wrapToolWithBeforeToolCallHook(tool, {
      agentId,
      sessionKey: options?.sessionKey,
      sessionId: options?.sessionId,
      runId: options?.runId,
      loopDetection: resolveToolLoopDetectionConfig({ cfg: options?.config, agentId }),
    }),
  );
  const withAbort = options?.abortSignal
    ? withHooks.map((tool) => wrapToolWithAbortSignal(tool, options.abortSignal))
    : withHooks;

  // NOTE: Keep canonical (lowercase) tool names here.
  // pi-ai's Anthropic OAuth transport remaps tool names to Claude Code-style names
  // on the wire and maps them back for tool dispatch.
  return withAbort;
}
