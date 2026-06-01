import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { normalizeTargetForProvider } from "../infra/outbound/target-normalization.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { truncateUtf16Safe } from "../utils.js";
import { collectTextContentBlocks } from "./content-blocks.js";
import { type MessagingToolSend } from "./pi-embedded-messaging.js";
import { normalizeToolName } from "./tool-policy.js";

/**
 * 主要功能说明：

1. 常量定义 - 定义了工具结果和错误文本的最大字符数限制
2. 文本截断与规范化 - truncateToolText 和 normalizeToolErrorText 函数用于处理过长的文本
3. 错误检测 - isErrorLikeStatus 用于判断状态是否为错误， readErrorCandidate 和 extractErrorField 用于提取错误信息
4. 工具结果清理 - sanitizeToolResult 函数会：
   
   - 截断过长的文本内容
   - 移除图像的原始数据，只保留字节数
5. 媒体路径处理 - 包括：
   
   - isToolResultMediaTrusted - 判断工具是否可信
   - filterToolResultMediaUrls - 过滤媒体 URL
   - extractToolResultMediaPaths - 从工具结果中提取媒体文件路径
6. 错误信息提取 - isToolResultError 和 extractToolErrorMessage 用于检测和提取错误
7. 消息发送提取 - extractMessagingToolSend 用于从工具参数中提取消息发送信息，支持 message 工具和渠道插件工具两种模式
** 
*/

// 工具结果文本的最大字符数限制，超过此长度将被截断
const TOOL_RESULT_MAX_CHARS = 8000;
// 工具错误文本的最大字符数限制
const TOOL_ERROR_MAX_CHARS = 400;

/**
 * 截断工具结果文本
 * 如果文本长度超过最大限制，则在末尾添加截断标记
 * @param text - 要截断的文本
 * @returns 截断后的文本或原文本（如果未超过限制）
 */
function truncateToolText(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, TOOL_RESULT_MAX_CHARS)}\n…(truncated)…`;
}

/**
 * 规范化工具错误文本
 * 提取错误文本的第一行，并确保不超过最大长度限制
 * @param text - 错误文本
 * @returns 规范化后的错误文本，如果为空则返回 undefined
 */
function normalizeToolErrorText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  // 只取第一行，避免多行错误信息过长
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) {
    return undefined;
  }
  return firstLine.length > TOOL_ERROR_MAX_CHARS
    ? `${truncateUtf16Safe(firstLine, TOOL_ERROR_MAX_CHARS)}…`
    : firstLine;
}

/**
 * 判断状态值是否为错误状态
 * 通过排除已知的成功状态，并匹配错误相关关键词来判断
 * @param status - 状态字符串
 * @returns 是否为错误状态
 */
function isErrorLikeStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  // 排除已知的成功状态值
  if (
    normalized === "0" ||
    normalized === "ok" ||
    normalized === "success" ||
    normalized === "completed" ||
    normalized === "running"
  ) {
    return false;
  }
  // 匹配错误相关的关键词模式
  return /error|fail|timeout|timed[_\s-]?out|denied|cancel|invalid|forbidden/.test(normalized);
}

/**
 * 从值中读取错误候选信息
 * 支持字符串值和包含 message/error 字段的对象
 * @param value - 待检查的值
 * @returns 规范化后的错误信息，如果不符合条件则返回 undefined
 */
function readErrorCandidate(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeToolErrorText(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  // 依次检查 message 和 error 字段
  if (typeof record.message === "string") {
    return normalizeToolErrorText(record.message);
  }
  if (typeof record.error === "string") {
    return normalizeToolErrorText(record.error);
  }
  return undefined;
}

/**
 * 从对象中提取错误字段
 * 按优先级依次检查 error、message、reason 字段，以及 status 字段
 * @param value - 待检查的对象
 * @returns 提取的错误信息，如果不存在则返回 undefined
 */
function extractErrorField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  // 优先检查直接的错误相关字段
  const direct =
    readErrorCandidate(record.error) ??
    readErrorCandidate(record.message) ??
    readErrorCandidate(record.reason);
  if (direct) {
    return direct;
  }
  // 检查 status 字段是否为错误状态
  const status = typeof record.status === "string" ? record.status.trim() : "";
  if (!status || !isErrorLikeStatus(status)) {
    return undefined;
  }
  return normalizeToolErrorText(status);
}

/**
 * 清理工具结果
 * 截断过长的文本内容，移除图像的原始数据并替换为字节数和标记
 * @param result - 工具结果对象
 * @returns 清理后的工具结果
 */
export function sanitizeToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return record;
  }
  // 遍历内容数组，处理文本和图像类型
  const sanitized = content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const entry = item as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type : undefined;
    // 处理文本内容：截断过长的文本
    if (type === "text" && typeof entry.text === "string") {
      return { ...entry, text: truncateToolText(entry.text) };
    }
    // 处理图像内容：移除原始数据，只保留字节数信息
    if (type === "image") {
      const data = typeof entry.data === "string" ? entry.data : undefined;
      const bytes = data ? data.length : undefined;
      const cleaned = { ...entry };
      delete cleaned.data;
      return { ...cleaned, bytes, omitted: true };
    }
    return entry;
  });
  return { ...record, content: sanitized };
}

/**
 * 从工具结果中提取文本内容
 * 收集所有文本内容块并合并为一个字符串
 * @param result - 工具结果对象
 * @returns 合并后的文本内容，如果没有文本则返回 undefined
 */
export function extractToolResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  // 收集所有文本内容块
  const texts = collectTextContentBlocks(record.content)
    .map((item) => {
      const trimmed = item.trim();
      return trimmed ? trimmed : undefined;
    })
    .filter((value): value is string => Boolean(value));
  if (texts.length === 0) {
    return undefined;
  }
  return texts.join("\n");
}

/**
 * 允许输出本地 MEDIA: 路径的核心工具名称集合
 * 插件/MCP 工具被故意排除，以防止不受信任的文件读取
 */
const TRUSTED_TOOL_RESULT_MEDIA = new Set([
  "agents_list",
  "apply_patch",
  "browser",
  "canvas",
  "cron",
  "edit",
  "exec",
  "gateway",
  "image",
  "memory_get",
  "memory_search",
  "message",
  "nodes",
  "process",
  "read",
  "session_status",
  "sessions_history",
  "sessions_list",
  "sessions_send",
  "sessions_spawn",
  "subagents",
  "tts",
  "web_fetch",
  "web_search",
  "write",
]);

// HTTP URL 的正则表达式匹配模式
const HTTP_URL_RE = /^https?:\/\//i;

/**
 * 判断工具结果的媒体路径是否可信
 * 只有在可信工具列表中的工具才允许输出本地文件路径
 * @param toolName - 工具名称
 * @returns 是否可信
 */
export function isToolResultMediaTrusted(toolName?: string): boolean {
  if (!toolName) {
    return false;
  }
  const normalized = normalizeToolName(toolName);
  return TRUSTED_TOOL_RESULT_MEDIA.has(normalized);
}

/**
 * 过滤工具结果中的媒体 URL
 * 对于非可信工具，只保留 HTTP/HTTPS URL，过滤掉本地文件路径
 * @param toolName - 工具名称
 * @param mediaUrls - 媒体 URL 数组
 * @returns 过滤后的媒体 URL 数组
 */
export function filterToolResultMediaUrls(
  toolName: string | undefined,
  mediaUrls: string[],
): string[] {
  if (mediaUrls.length === 0) {
    return mediaUrls;
  }
  // 可信工具保留所有 URL
  if (isToolResultMediaTrusted(toolName)) {
    return mediaUrls;
  }
  // 非可信工具只保留 HTTP/HTTPS URL
  return mediaUrls.filter((url) => HTTP_URL_RE.test(url.trim()));
}

/**
 * 从工具结果中提取媒体文件路径
 *
 * 提取策略（按优先级）：
 * 1. 从文本内容块中解析 MEDIA: 标记（适用于所有 OpenClaw 工具）
 * 2. 如果存在图像内容但没有 MEDIA: 文本，则回退到 details.path（适用于 OpenClaw imageResult）
 *
 * 当没有找到媒体时返回空数组（例如 Pi SDK 的 read 工具返回 base64 图像数据但没有文件路径，
 * 这些需要通过其他方式传递，如保存到临时文件）
 * @param result - 工具结果对象
 * @returns 媒体文件路径数组
 */
export function extractToolResultMediaPaths(result: unknown): string[] {
  if (!result || typeof result !== "object") {
    return [];
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return [];
  }

  // 使用共享解析器从文本内容块中提取 MEDIA: 路径
  // 这样可以确保指令匹配和验证与出站回复解析保持同步
  const paths: string[] = [];
  let hasImageContent = false;
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type === "image") {
      hasImageContent = true;
      continue;
    }
    // 解析文本中的媒体 URL
    if (entry.type === "text" && typeof entry.text === "string") {
      const parsed = splitMediaFromOutput(entry.text);
      if (parsed.mediaUrls?.length) {
        paths.push(...parsed.mediaUrls);
      }
    }
  }

  // 如果找到 MEDIA: 路径，直接返回
  if (paths.length > 0) {
    return paths;
  }

  // 当存在图像内容但没有 MEDIA: 文本时，回退到 details.path
  if (hasImageContent) {
    const details = record.details as Record<string, unknown> | undefined;
    const p = typeof details?.path === "string" ? details.path.trim() : "";
    if (p) {
      return [p];
    }
  }

  return [];
}

/**
 * 判断工具结果是否为错误
 * 通过检查 details.status 字段是否为 "error" 或 "timeout"
 * @param result - 工具结果对象
 * @returns 是否为错误结果
 */
export function isToolResultError(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const record = result as { details?: unknown };
  const details = record.details;
  if (!details || typeof details !== "object") {
    return false;
  }
  const status = (details as { status?: unknown }).status;
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.trim().toLowerCase();
  return normalized === "error" || normalized === "timeout";
}

/**
 * 从工具结果中提取错误消息
 * 按优先级依次检查 details、根对象和 JSON 文本
 * @param result - 工具结果对象
 * @returns 错误消息字符串，如果不存在则返回 undefined
 */
export function extractToolErrorMessage(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  // 优先从 details 中提取错误
  const fromDetails = extractErrorField(record.details);
  if (fromDetails) {
    return fromDetails;
  }
  // 从根对象中提取错误
  const fromRoot = extractErrorField(record);
  if (fromRoot) {
    return fromRoot;
  }
  // 尝试从文本内容中提取错误
  const text = extractToolResultText(result);
  if (!text) {
    return undefined;
  }
  // 尝试解析 JSON 格式的错误信息
  try {
    const parsed = JSON.parse(text) as unknown;
    const fromJson = extractErrorField(parsed);
    if (fromJson) {
      return fromJson;
    }
  } catch {
    // JSON 解析失败，fall through 到纯文本第一行处理
  }
  return normalizeToolErrorText(text);
}

/**
 * 从消息工具参数中解析目标地址
 * 支持 to 和 target 两个参数名
 * @param args - 工具参数对象
 * @returns 目标地址字符串，如果不存在则返回 undefined
 */
function resolveMessageToolTarget(args: Record<string, unknown>): string | undefined {
  const toRaw = typeof args.to === "string" ? args.to : undefined;
  if (toRaw) {
    return toRaw;
  }
  return typeof args.target === "string" ? args.target : undefined;
}

/**
 * 从工具调用参数中提取消息发送信息
 * 支持 message 工具和渠道插件工具两种模式
 * @param toolName - 工具名称
 * @param args - 工具参数对象
 * @returns 消息发送信息对象，如果参数不完整则返回 undefined
 */
export function extractMessagingToolSend(
  toolName: string,
  args: Record<string, unknown>,
): MessagingToolSend | undefined {
  // 提供者对接：新提供者工具必须实现 plugin.actions.extractToolSend
  const action = typeof args.action === "string" ? args.action.trim() : "";
  const accountIdRaw = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
  const accountId = accountIdRaw ? accountIdRaw : undefined;

  // 处理 message 工具
  if (toolName === "message") {
    // 只支持 send 和 thread-reply 两种操作
    if (action !== "send" && action !== "thread-reply") {
      return undefined;
    }
    const toRaw = resolveMessageToolTarget(args);
    if (!toRaw) {
      return undefined;
    }
    // 解析提供者信息
    const providerRaw = typeof args.provider === "string" ? args.provider.trim() : "";
    const channelRaw = typeof args.channel === "string" ? args.channel.trim() : "";
    const providerHint = providerRaw || channelRaw;
    const providerId = providerHint ? normalizeChannelId(providerHint) : null;
    const provider = providerId ?? (providerHint ? providerHint.toLowerCase() : "message");
    const to = normalizeTargetForProvider(provider, toRaw);
    return to ? { tool: toolName, provider, accountId, to } : undefined;
  }

  // 处理渠道插件工具
  const providerId = normalizeChannelId(toolName);
  if (!providerId) {
    return undefined;
  }
  const plugin = getChannelPlugin(providerId);
  const extracted = plugin?.actions?.extractToolSend?.({ args });
  if (!extracted?.to) {
    return undefined;
  }
  const to = normalizeTargetForProvider(providerId, extracted.to);
  return to
    ? {
        tool: toolName,
        provider: providerId,
        accountId: extracted.accountId ?? accountId,
        to,
      }
    : undefined;
}
