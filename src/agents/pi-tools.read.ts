// Node.js内置模块导入
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 外部依赖类型和工具函数导入
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
// 内部模块导入
import {
  appendFileWithinRoot,
  SafeOpenError,
  openFileWithinRoot,
  readFileWithinRoot,
  writeFileWithinRoot,
} from "../infra/fs-safe.js";
import { detectMime } from "../media/mime.js";
import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";
import type { ImageSanitizationLimits } from "./image-sanitization.js";
import { toRelativeWorkspacePath } from "./path-policy.js";
import { wrapHostEditToolWithPostWriteRecovery } from "./pi-tools.host-edit.js";
import {
  CLAUDE_PARAM_GROUPS,
  assertRequiredParams,
  normalizeToolParams,
  patchToolSchemaForClaudeCompatibility,
  wrapToolParamNormalization,
} from "./pi-tools.params.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { sanitizeToolResultImages } from "./tool-images.js";

// 重新导出参数相关工具函数，方便其他模块使用
export {
  CLAUDE_PARAM_GROUPS,
  assertRequiredParams,
  normalizeToolParams,
  patchToolSchemaForClaudeCompatibility,
  wrapToolParamNormalization,
} from "./pi-tools.params.js";

// 注释(steipete): 上游read工具已经实现了文件类型的MIME检测
// 我们保留这个包装层用于在发送给模型供应商之前标准化负载和清理过大的图片
type ToolContentBlock = AgentToolResult<unknown>["content"][number]; // 工具结果内容块类型
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>; // 图片类型内容块
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>; // 文本类型内容块

// 读取工具配置常量
const DEFAULT_READ_PAGE_MAX_BYTES = 50 * 1024; // 默认单页读取最大字节数：50KB
const MAX_ADAPTIVE_READ_MAX_BYTES = 512 * 1024; // 自适应读取最大总字节数：512KB
const ADAPTIVE_READ_CONTEXT_SHARE = 0.2; // 自适应读取占用上下文窗口的比例：20%
const CHARS_PER_TOKEN_ESTIMATE = 4; // 每个token估计对应4个字符
const MAX_ADAPTIVE_READ_PAGES = 8; // 自适应读取最大页数：8页

// OpenClaw读取工具配置选项类型
type OpenClawReadToolOptions = {
  modelContextWindowTokens?: number; // 模型上下文窗口大小（token数）
  imageSanitization?: ImageSanitizationLimits; // 图片清理限制配置
};

// 读取结果截断详情类型
type ReadTruncationDetails = {
  truncated: boolean; // 是否已截断
  outputLines: number; // 输出行数
  firstLineExceedsLimit: boolean; // 第一行是否超过长度限制
};

// 读取延续提示正则表达式，用于匹配结果末尾的"使用offset=xx继续读取"提示
const READ_CONTINUATION_NOTICE_RE =
  /\n\n\[(?:Showing lines [^\]]*?Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\]\s*$/;

/**
 * 数值限制函数，将数值限制在min和max之间
 * @param value 输入数值
 * @param min 最小值
 * @param max 最大值
 * @returns 限制后的数值
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 计算自适应读取的最大字节数
 * 根据模型上下文窗口大小动态调整读取的内容长度，避免超出上下文限制
 * @param options 读取工具配置选项
 * @returns 最大读取字节数
 */
function resolveAdaptiveReadMaxBytes(options?: OpenClawReadToolOptions): number {
  const contextWindowTokens = options?.modelContextWindowTokens;
  // 如果上下文窗口大小无效，返回默认值
  if (
    typeof contextWindowTokens !== "number" ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return DEFAULT_READ_PAGE_MAX_BYTES;
  }
  // 计算可用于读取内容的字节数：上下文窗口大小 * 每个token字符数 * 读取内容占比
  const fromContext = Math.floor(
    contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * ADAPTIVE_READ_CONTEXT_SHARE,
  );
  // 将结果限制在合理范围内
  return clamp(fromContext, DEFAULT_READ_PAGE_MAX_BYTES, MAX_ADAPTIVE_READ_MAX_BYTES);
}

/**
 * 格式化字节数为易读的字符串格式
 * @param bytes 字节数
 * @returns 格式化后的字符串，如"50KB"、"1.2MB"
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }
  return `${bytes}B`;
}

/**
 * 从工具执行结果中提取文本内容
 * @param result 工具执行结果
 * @returns 提取到的所有文本内容，没有文本内容时返回undefined
 */
function getToolResultText(result: AgentToolResult<unknown>): string | undefined {
  const content = Array.isArray(result.content) ? result.content : [];
  // 筛选出所有文本类型的内容块
  const textBlocks = content
    .map((block) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
      return undefined;
    })
    .filter((value): value is string => typeof value === "string");
  // 没有文本内容时返回undefined
  if (textBlocks.length === 0) {
    return undefined;
  }
  // 用换行符拼接所有文本块
  return textBlocks.join("\n");
}

/**
 * 替换工具执行结果中的文本内容
 * 如果已有文本块则替换第一个，没有则添加新的文本块
 * @param result 原始工具执行结果
 * @param text 新的文本内容
 * @returns 更新后的工具执行结果
 */
function withToolResultText(
  result: AgentToolResult<unknown>,
  text: string,
): AgentToolResult<unknown> {
  const content = Array.isArray(result.content) ? result.content : [];
  let replaced = false;
  // 遍历内容块，替换第一个文本块
  const nextContent: ToolContentBlock[] = content.map((block) => {
    if (
      !replaced &&
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
    ) {
      replaced = true;
      return {
        ...(block as TextContentBlock),
        text,
      };
    }
    return block;
  });
  // 如果成功替换了文本块，返回更新后的结果
  if (replaced) {
    return {
      ...result,
      content: nextContent as unknown as AgentToolResult<unknown>["content"],
    };
  }
  // 如果没有找到文本块，添加新的文本块
  const textBlock = { type: "text", text } as unknown as TextContentBlock;
  return {
    ...result,
    content: [textBlock] as unknown as AgentToolResult<unknown>["content"],
  };
}

/**
 * 从工具执行结果中提取读取截断详情
 * @param result 工具执行结果
 * @returns 截断详情对象，没有截断信息时返回null
 */
function extractReadTruncationDetails(
  result: AgentToolResult<unknown>,
): ReadTruncationDetails | null {
  const details = (result as { details?: unknown }).details;
  // 如果没有details字段或不是对象，返回null
  if (!details || typeof details !== "object") {
    return null;
  }
  const truncation = (details as { truncation?: unknown }).truncation;
  // 如果没有truncation字段或不是对象，返回null
  if (!truncation || typeof truncation !== "object") {
    return null;
  }
  const record = truncation as Record<string, unknown>;
  // 如果没有被截断，返回null
  if (record.truncated !== true) {
    return null;
  }
  const outputLinesRaw = record.outputLines;
  // 解析输出行数，确保是有效的非负整数
  const outputLines =
    typeof outputLinesRaw === "number" && Number.isFinite(outputLinesRaw)
      ? Math.max(0, Math.floor(outputLinesRaw))
      : 0;
  // 构造并返回截断详情
  return {
    truncated: true,
    outputLines,
    firstLineExceedsLimit: record.firstLineExceedsLimit === true,
  };
}

/**
 * 移除文本末尾的读取延续提示
 * @param text 原始文本
 * @returns 移除了延续提示后的文本
 */
function stripReadContinuationNotice(text: string): string {
  return text.replace(READ_CONTINUATION_NOTICE_RE, "");
}

/**
 * 移除工具结果中的截断内容详情，减少返回给LLM的不必要信息
 * @param result 原始工具执行结果
 * @returns 清理后的工具执行结果
 */
function stripReadTruncationContentDetails(
  result: AgentToolResult<unknown>,
): AgentToolResult<unknown> {
  const details = (result as { details?: unknown }).details;
  // 如果没有details字段或不是对象，直接返回原结果
  if (!details || typeof details !== "object") {
    return result;
  }

  const detailsRecord = details as Record<string, unknown>;
  const truncationRaw = detailsRecord.truncation;
  // 如果没有truncation字段或不是对象，直接返回原结果
  if (!truncationRaw || typeof truncationRaw !== "object") {
    return result;
  }

  const truncation = truncationRaw as Record<string, unknown>;
  // 如果truncation中没有content字段，直接返回原结果
  if (!Object.prototype.hasOwnProperty.call(truncation, "content")) {
    return result;
  }

  // 移除truncation中的content字段，保留其他信息
  const { content: _content, ...restTruncation } = truncation;
  return {
    ...result,
    details: {
      ...detailsRecord,
      truncation: restTruncation,
    },
  };
}

/**
 * 执行自适应分页读取
 * 当用户没有指定limit参数时，自动分页读取尽可能多的内容，直到达到最大字节限制或最大页数
 * @param params 读取参数
 * @param params.base 基础读取工具实例
 * @param params.toolCallId 工具调用ID
 * @param params.args 工具调用参数
 * @param params.signal 中止信号
 * @param params.maxBytes 最大读取字节数
 * @returns 聚合后的读取结果
 */
async function executeReadWithAdaptivePaging(params: {
  base: AnyAgentTool;
  toolCallId: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  maxBytes: number;
}): Promise<AgentToolResult<unknown>> {
  const userLimit = params.args.limit;
  // 如果用户明确指定了limit参数，直接执行单次读取
  const hasExplicitLimit =
    typeof userLimit === "number" && Number.isFinite(userLimit) && userLimit > 0;
  if (hasExplicitLimit) {
    return await params.base.execute(params.toolCallId, params.args, params.signal);
  }

  // 解析起始offset，默认从第1行开始
  const offsetRaw = params.args.offset;
  let nextOffset =
    typeof offsetRaw === "number" && Number.isFinite(offsetRaw) && offsetRaw > 0
      ? Math.floor(offsetRaw)
      : 1;

  let firstResult: AgentToolResult<unknown> | null = null; // 保存第一次读取的结果，用于保留元数据
  let aggregatedText = ""; // 聚合的所有文本内容
  let aggregatedBytes = 0; // 已聚合的字节数
  let capped = false; // 是否达到了字节限制
  let continuationOffset: number | undefined; // 下一次读取的起始offset

  // 分页读取循环，最多读取MAX_ADAPTIVE_READ_PAGES页
  for (let page = 0; page < MAX_ADAPTIVE_READ_PAGES; page += 1) {
    const pageArgs = { ...params.args, offset: nextOffset };
    const pageResult = await params.base.execute(params.toolCallId, pageArgs, params.signal);
    firstResult ??= pageResult; // 保存第一次的结果

    const rawText = getToolResultText(pageResult);
    // 如果读取结果不是文本（如图片等），直接返回当前页结果
    if (typeof rawText !== "string") {
      return pageResult;
    }

    const truncation = extractReadTruncationDetails(pageResult);
    // 判断是否可以继续读取下一页：存在截断、第一行没有超过限制、有输出行数、还有剩余页数
    const canContinue =
      Boolean(truncation?.truncated) &&
      !truncation?.firstLineExceedsLimit &&
      (truncation?.outputLines ?? 0) > 0 &&
      page < MAX_ADAPTIVE_READ_PAGES - 1;

    // 如果可以继续读取，移除当前页末尾的延续提示
    const pageText = canContinue ? stripReadContinuationNotice(rawText) : rawText;
    const delimiter = aggregatedText ? "\n\n" : ""; // 页之间用空行分隔
    const nextBytes = Buffer.byteLength(`${delimiter}${pageText}`, "utf-8");

    // 检查添加当前页后是否会超过字节限制
    if (aggregatedText && aggregatedBytes + nextBytes > params.maxBytes) {
      capped = true;
      continuationOffset = nextOffset;
      break;
    }

    // 将当前页内容添加到聚合结果中
    aggregatedText += `${delimiter}${pageText}`;
    aggregatedBytes += nextBytes;

    // 如果不能继续读取，返回聚合后的结果
    if (!canContinue || !truncation) {
      return withToolResultText(pageResult, aggregatedText);
    }

    // 计算下一页的起始offset
    nextOffset += truncation.outputLines;
    continuationOffset = nextOffset;

    // 检查是否达到字节限制
    if (aggregatedBytes >= params.maxBytes) {
      capped = true;
      break;
    }
  }

  // 如果没有获取到任何结果，执行一次普通读取
  if (!firstResult) {
    return await params.base.execute(params.toolCallId, params.args, params.signal);
  }

  let finalText = aggregatedText;
  // 如果达到了字节限制，添加提示信息告知用户可以使用offset继续读取
  if (capped && continuationOffset) {
    finalText += `\n\n[Read output capped at ${formatBytes(params.maxBytes)} for this call. Use offset=${continuationOffset} to continue.]`;
  }
  // 返回聚合后的结果
  return withToolResultText(firstResult, finalText);
}

/**
 * 重写图片读取结果的头部信息，更新MIME类型
 * @param text 原始头部文本
 * @param mimeType 正确的MIME类型
 * @returns 更新后的头部文本
 */
function rewriteReadImageHeader(text: string, mimeType: string): string {
  // pi-coding-agent生成的格式是: "Read image file [image/png]"
  if (text.startsWith("Read image file [") && text.endsWith("]")) {
    return `Read image file [${mimeType}]`;
  }
  return text;
}

/**
 * 标准化图片读取结果，校正MIME类型
 * 对图片内容进行实际嗅探，修正可能错误的MIME类型
 * @param result 原始读取结果
 * @param filePath 读取的文件路径
 * @returns 标准化后的读取结果
 */
async function normalizeReadImageResult(
  result: AgentToolResult<unknown>,
  filePath: string,
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];

  // 查找结果中的图片内容块
  const image = content.find(
    (b): b is ImageContentBlock =>
      !!b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "image" &&
      typeof (b as { data?: unknown }).data === "string" &&
      typeof (b as { mimeType?: unknown }).mimeType === "string",
  );
  // 没有图片内容，直接返回原结果
  if (!image) {
    return result;
  }

  // 检查图片数据是否为空
  if (!image.data.trim()) {
    throw new Error(`read: image payload is empty (${filePath})`);
  }

  // 根据base64内容实际嗅探MIME类型
  const sniffed = await sniffMimeFromBase64(image.data);
  if (!sniffed) {
    return result;
  }

  // 检查嗅探结果是否确实是图片类型
  if (!sniffed.startsWith("image/")) {
    throw new Error(
      `read: file looks like ${sniffed} but was treated as ${image.mimeType} (${filePath})`,
    );
  }

  // 如果MIME类型一致，不需要修改
  if (sniffed === image.mimeType) {
    return result;
  }

  // 更新内容块中的MIME类型和头部文本
  const nextContent = content.map((block) => {
    // 更新图片块的MIME类型
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
      const b = block as ImageContentBlock & { mimeType: string };
      return { ...b, mimeType: sniffed } satisfies ImageContentBlock;
    }
    // 更新文本块中的头部信息
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const b = block as TextContentBlock & { text: string };
      return {
        ...b,
        text: rewriteReadImageHeader(b.text, sniffed),
      } satisfies TextContentBlock;
    }
    return block;
  });

  return { ...result, content: nextContent };
}

/**
 * 为工具添加工作区根目录保护的包装函数（简化版本）
 * 确保工具只能访问工作区根目录内的文件
 * @param tool 原始工具实例
 * @param root 工作区根目录路径
 * @returns 包装后的工具实例
 */
export function wrapToolWorkspaceRootGuard(tool: AnyAgentTool, root: string): AnyAgentTool {
  return wrapToolWorkspaceRootGuardWithOptions(tool, root);
}

/**
 * 将容器内的路径映射到宿主机的工作区根目录
 * 处理容器化环境下的路径转换问题
 * @param params 路径映射参数
 * @param params.filePath 原始文件路径
 * @param params.root 宿主机工作区根目录
 * @param params.containerWorkdir 容器内的工作目录
 * @returns 映射后的宿主机路径
 */
function mapContainerPathToWorkspaceRoot(params: {
  filePath: string;
  root: string;
  containerWorkdir?: string;
}): string {
  const containerWorkdir = params.containerWorkdir?.trim();
  // 如果没有配置容器工作目录，直接返回原路径
  if (!containerWorkdir) {
    return params.filePath;
  }
  // 标准化容器工作目录：转换为Unix风格路径，移除末尾斜杠
  const normalizedWorkdir = containerWorkdir.replace(/\\/g, "/").replace(/\/+$/, "");
  // 如果容器工作目录不是绝对路径，直接返回原路径
  if (!normalizedWorkdir.startsWith("/")) {
    return params.filePath;
  }
  if (!normalizedWorkdir) {
    return params.filePath;
  }

  // 处理路径前缀
  let candidate = params.filePath.startsWith("@") ? params.filePath.slice(1) : params.filePath;
  // 处理file://协议的URL路径
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== "file:") {
          return params.filePath;
        }
        candidate = decodeURIComponent(parsed.pathname || "");
        if (!candidate.startsWith("/")) {
          return params.filePath;
        }
      } catch {
        return params.filePath;
      }
    }
  }

  // 标准化候选路径为Unix风格
  const normalizedCandidate = candidate.replace(/\\/g, "/");
  // 如果路径正好是容器工作目录，映射到宿主机工作区根目录
  if (normalizedCandidate === normalizedWorkdir) {
    return path.resolve(params.root);
  }
  const prefix = `${normalizedWorkdir}/`;
  // 如果路径不是以容器工作目录开头，直接返回原候选路径
  if (!normalizedCandidate.startsWith(prefix)) {
    return candidate;
  }
  // 提取相对路径部分，映射到宿主机工作区根目录
  const relative = normalizedCandidate.slice(prefix.length);
  if (!relative) {
    return path.resolve(params.root);
  }
  return path.resolve(params.root, ...relative.split("/").filter(Boolean));
}

/**
 * 将工具调用的路径解析为相对于工作区根目录的绝对路径
 * @param params 路径解析参数
 * @param params.filePath 原始文件路径
 * @param params.root 工作区根目录
 * @param params.containerWorkdir 容器内的工作目录
 * @returns 解析后的绝对路径
 */
export function resolveToolPathAgainstWorkspaceRoot(params: {
  filePath: string;
  root: string;
  containerWorkdir?: string;
}): string {
  // 先进行容器路径映射
  const mapped = mapContainerPathToWorkspaceRoot(params);
  // 移除路径前的@前缀
  const candidate = mapped.startsWith("@") ? mapped.slice(1) : mapped;
  // 如果已经是绝对路径，直接解析；否则相对于工作区根目录解析
  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(params.root, candidate || ".");
}

/**
 * 内存刷新追加写入的配置选项类型
 * 用于限制内存刷新时只能追加写入到指定文件
 */
type MemoryFlushAppendOnlyWriteOptions = {
  root: string; // 工作区根目录
  relativePath: string; // 允许写入的相对路径
  containerWorkdir?: string; // 容器工作目录
  sandbox?: {
    // 沙箱环境配置
    root: string;
    bridge: SandboxFsBridge;
  };
};

/**
 * 读取UTF-8文件，文件不存在时返回空字符串而不是抛出错误
 * @param params 读取参数
 * @param params.absolutePath 宿主机上的绝对路径
 * @param params.relativePath 相对于工作区的相对路径
 * @param params.sandbox 沙箱配置
 * @param params.signal 中止信号
 * @returns 文件内容，文件不存在时返回空字符串
 */
async function readOptionalUtf8File(params: {
  absolutePath: string;
  relativePath: string;
  sandbox?: MemoryFlushAppendOnlyWriteOptions["sandbox"];
  signal?: AbortSignal;
}): Promise<string> {
  try {
    // 如果是沙箱环境，使用沙桥读取文件
    if (params.sandbox) {
      const stat = await params.sandbox.bridge.stat({
        filePath: params.relativePath,
        cwd: params.sandbox.root,
        signal: params.signal,
      });
      // 文件不存在时返回空字符串
      if (!stat) {
        return "";
      }
      const buffer = await params.sandbox.bridge.readFile({
        filePath: params.relativePath,
        cwd: params.sandbox.root,
        signal: params.signal,
      });
      return buffer.toString("utf-8");
    }
    // 非沙箱环境直接读取文件
    return await fs.readFile(params.absolutePath, "utf-8");
  } catch (error) {
    // 文件不存在时返回空字符串
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return "";
    }
    // 其他错误重新抛出
    throw error;
  }
}

/**
 * 追加内容到指定文件（内存刷新专用）
 * 支持沙箱环境和普通环境，确保只能追加写入
 * @param params 写入参数
 * @param params.absolutePath 宿主机绝对路径
 * @param params.root 工作区根目录
 * @param params.relativePath 相对路径
 * @param params.content 要追加的内容
 * @param params.sandbox 沙箱配置
 * @param params.signal 中止信号
 */
async function appendMemoryFlushContent(params: {
  absolutePath: string;
  root: string;
  relativePath: string;
  content: string;
  sandbox?: MemoryFlushAppendOnlyWriteOptions["sandbox"];
  signal?: AbortSignal;
}) {
  // 非沙箱环境使用安全的追加写入方法
  if (!params.sandbox) {
    await appendFileWithinRoot({
      rootDir: params.root,
      relativePath: params.relativePath,
      data: params.content,
      mkdir: true,
      prependNewlineIfNeeded: true,
    });
    return;
  }

  // 沙箱环境：先读取现有内容
  const existing = await readOptionalUtf8File({
    absolutePath: params.absolutePath,
    relativePath: params.relativePath,
    sandbox: params.sandbox,
    signal: params.signal,
  });
  // 智能添加分隔符：如果现有内容末尾和新内容开头都没有换行符，则添加一个
  const separator =
    existing.length > 0 && !existing.endsWith("\n") && !params.content.startsWith("\n") ? "\n" : "";
  const next = `${existing}${separator}${params.content}`;

  if (params.sandbox) {
    // 确保父目录存在
    const parent = path.posix.dirname(params.relativePath);
    if (parent && parent !== ".") {
      await params.sandbox.bridge.mkdirp({
        filePath: parent,
        cwd: params.sandbox.root,
        signal: params.signal,
      });
    }
    // 沙箱环境写入文件
    await params.sandbox.bridge.writeFile({
      filePath: params.relativePath,
      cwd: params.sandbox.root,
      data: next,
      mkdir: true,
      signal: params.signal,
    });
    return;
  }
  // 兜底的普通写入方式（理论上不会执行到这里）
  await fs.mkdir(path.dirname(params.absolutePath), { recursive: true });
  await fs.writeFile(params.absolutePath, next, "utf-8");
}

/**
 * 包装写入工具，使其在内存刷新模式下只能追加写入到指定文件
 * 用于内存刷新场景，限制写入操作的安全性
 * @param tool 原始写入工具实例
 * @param options 配置选项
 * @returns 包装后的写入工具实例
 */
export function wrapToolMemoryFlushAppendOnlyWrite(
  tool: AnyAgentTool,
  options: MemoryFlushAppendOnlyWriteOptions,
): AnyAgentTool {
  // 计算允许写入的绝对路径
  const allowedAbsolutePath = path.resolve(options.root, options.relativePath);
  return {
    ...tool,
    // 更新工具描述，说明只能追加写入到指定路径
    description: `${tool.description} During memory flush, this tool may only append to ${options.relativePath}.`,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const normalized = normalizeToolParams(args);
      const record =
        normalized ??
        (args && typeof args === "object" ? (args as Record<string, unknown>) : undefined);
      // 校验必填参数
      assertRequiredParams(record, CLAUDE_PARAM_GROUPS.write, tool.name);
      const filePath =
        typeof record?.path === "string" && record.path.trim() ? record.path : undefined;
      const content = typeof record?.content === "string" ? record.content : undefined;

      // 如果路径或内容为空，使用原始工具的执行逻辑
      if (!filePath || content === undefined) {
        return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
      }

      // 解析用户提供的路径
      const resolvedPath = resolveToolPathAgainstWorkspaceRoot({
        filePath,
        root: options.root,
        containerWorkdir: options.containerWorkdir,
      });
      // 检查路径是否在允许的范围内，不在则抛出错误
      if (resolvedPath !== allowedAbsolutePath) {
        throw new Error(
          `Memory flush writes are restricted to ${options.relativePath}; use that path only.`,
        );
      }

      // 执行追加写入操作
      await appendMemoryFlushContent({
        absolutePath: allowedAbsolutePath,
        root: options.root,
        relativePath: options.relativePath,
        content,
        sandbox: options.sandbox,
        signal,
      });
      // 返回成功结果
      return {
        content: [{ type: "text", text: `Appended content to ${options.relativePath}.` }],
        details: {
          path: options.relativePath,
          appendOnly: true,
        },
      };
    },
  };
}

/**
 * 为工具添加工作区根目录保护的包装函数（带配置选项版本）
 * 确保工具只能访问工作区根目录内的文件，防止目录遍历攻击
 * @param tool 原始工具实例
 * @param root 工作区根目录路径
 * @param options 配置选项
 * @param options.containerWorkdir 容器内的工作目录
 * @returns 包装后的工具实例
 */
export function wrapToolWorkspaceRootGuardWithOptions(
  tool: AnyAgentTool,
  root: string,
  options?: {
    containerWorkdir?: string;
  },
): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const normalized = normalizeToolParams(args);
      const record =
        normalized ??
        (args && typeof args === "object" ? (args as Record<string, unknown>) : undefined);
      const filePath = record?.path;
      // 如果参数中有path字段，进行路径校验
      if (typeof filePath === "string" && filePath.trim()) {
        // 先进行容器路径映射
        const sandboxPath = mapContainerPathToWorkspaceRoot({
          filePath,
          root,
          containerWorkdir: options?.containerWorkdir,
        });
        // 校验路径是否在工作区根目录内
        await assertSandboxPath({ filePath: sandboxPath, cwd: root, root });
      }
      // 执行原始工具逻辑
      return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
    },
  };
}

/**
 * 沙箱环境工具创建参数类型
 */
type SandboxToolParams = {
  root: string; // 沙箱根目录
  bridge: SandboxFsBridge; // 沙箱文件系统桥接器
  modelContextWindowTokens?: number; // 模型上下文窗口大小
  imageSanitization?: ImageSanitizationLimits; // 图片清理配置
};

/**
 * 创建沙箱环境下的读取工具
 * @param params 沙箱工具参数
 * @returns 包装后的读取工具实例
 */
export function createSandboxedReadTool(params: SandboxToolParams) {
  // 创建基础读取工具，使用沙箱操作实现
  const base = createReadTool(params.root, {
    operations: createSandboxReadOperations(params),
  }) as unknown as AnyAgentTool;
  // 包装为OpenClaw的读取工具，添加自适应分页等功能
  return createOpenClawReadTool(base, {
    modelContextWindowTokens: params.modelContextWindowTokens,
    imageSanitization: params.imageSanitization,
  });
}

/**
 * 创建沙箱环境下的写入工具
 * @param params 沙箱工具参数
 * @returns 包装后的写入工具实例
 */
export function createSandboxedWriteTool(params: SandboxToolParams) {
  // 创建基础写入工具，使用沙箱操作实现
  const base = createWriteTool(params.root, {
    operations: createSandboxWriteOperations(params),
  }) as unknown as AnyAgentTool;
  // 添加参数标准化包装，兼容Claude格式
  return wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.write);
}

/**
 * 创建沙箱环境下的编辑工具
 * @param params 沙箱工具参数
 * @returns 包装后的编辑工具实例
 */
export function createSandboxedEditTool(params: SandboxToolParams) {
  // 创建基础编辑工具，使用沙箱操作实现
  const base = createEditTool(params.root, {
    operations: createSandboxEditOperations(params),
  }) as unknown as AnyAgentTool;
  // 添加参数标准化包装，兼容Claude格式
  return wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.edit);
}

/**
 * 创建宿主工作区的写入工具
 * @param root 工作区根目录
 * @param options 配置选项
 * @returns 包装后的写入工具实例
 */
export function createHostWorkspaceWriteTool(root: string, options?: { workspaceOnly?: boolean }) {
  // 创建基础写入工具，使用宿主环境操作实现
  const base = createWriteTool(root, {
    operations: createHostWriteOperations(root, options),
  }) as unknown as AnyAgentTool;
  // 添加参数标准化包装，兼容Claude格式
  return wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.write);
}

/**
 * 创建宿主工作区的编辑工具
 * @param root 工作区根目录
 * @param options 配置选项
 * @returns 包装后的编辑工具实例
 */
export function createHostWorkspaceEditTool(root: string, options?: { workspaceOnly?: boolean }) {
  // 创建基础编辑工具，使用宿主环境操作实现
  const base = createEditTool(root, {
    operations: createHostEditOperations(root, options),
  }) as unknown as AnyAgentTool;
  // 添加写入后恢复包装，处理编辑后的恢复逻辑
  const withRecovery = wrapHostEditToolWithPostWriteRecovery(base, root);
  // 添加参数标准化包装，兼容Claude格式
  return wrapToolParamNormalization(withRecovery, CLAUDE_PARAM_GROUPS.edit);
}

/**
 * 创建OpenClaw的读取工具包装器
 * 添加自适应分页、图片标准化、内容清理等增强功能
 * @param base 基础读取工具实例
 * @param options 配置选项
 * @returns 增强后的读取工具实例
 */
export function createOpenClawReadTool(
  base: AnyAgentTool,
  options?: OpenClawReadToolOptions,
): AnyAgentTool {
  // 修补工具Schema，兼容Claude格式
  const patched = patchToolSchemaForClaudeCompatibility(base);
  return {
    ...patched,
    execute: async (toolCallId, params, signal) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      // 校验必填参数
      assertRequiredParams(record, CLAUDE_PARAM_GROUPS.read, base.name);
      const result = await executeReadWithAdaptivePaging({
        base,
        toolCallId,
        args: (normalized ?? params ?? {}) as Record<string, unknown>,
        signal,
        maxBytes: resolveAdaptiveReadMaxBytes(options),
      });
      const filePath = typeof record?.path === "string" ? String(record.path) : "<unknown>";
      const strippedDetailsResult = stripReadTruncationContentDetails(result);
      const normalizedResult = await normalizeReadImageResult(strippedDetailsResult, filePath);
      return sanitizeToolResultImages(
        normalizedResult,
        `read:${filePath}`,
        options?.imageSanitization,
      );
    },
  };
}

function createSandboxReadOperations(params: SandboxToolParams) {
  return {
    readFile: (absolutePath: string) =>
      params.bridge.readFile({ filePath: absolutePath, cwd: params.root }),
    access: async (absolutePath: string) => {
      const stat = await params.bridge.stat({ filePath: absolutePath, cwd: params.root });
      if (!stat) {
        throw createFsAccessError("ENOENT", absolutePath);
      }
    },
    detectImageMimeType: async (absolutePath: string) => {
      const buffer = await params.bridge.readFile({ filePath: absolutePath, cwd: params.root });
      const mime = await detectMime({ buffer, filePath: absolutePath });
      return mime && mime.startsWith("image/") ? mime : undefined;
    },
  } as const;
}

function createSandboxWriteOperations(params: SandboxToolParams) {
  return {
    mkdir: async (dir: string) => {
      await params.bridge.mkdirp({ filePath: dir, cwd: params.root });
    },
    writeFile: async (absolutePath: string, content: string) => {
      await params.bridge.writeFile({ filePath: absolutePath, cwd: params.root, data: content });
    },
  } as const;
}

function createSandboxEditOperations(params: SandboxToolParams) {
  return {
    readFile: (absolutePath: string) =>
      params.bridge.readFile({ filePath: absolutePath, cwd: params.root }),
    writeFile: (absolutePath: string, content: string) =>
      params.bridge.writeFile({ filePath: absolutePath, cwd: params.root, data: content }),
    access: async (absolutePath: string) => {
      const stat = await params.bridge.stat({ filePath: absolutePath, cwd: params.root });
      if (!stat) {
        throw createFsAccessError("ENOENT", absolutePath);
      }
    },
  } as const;
}

async function writeHostFile(absolutePath: string, content: string) {
  const resolved = path.resolve(absolutePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf-8");
}

function createHostWriteOperations(root: string, options?: { workspaceOnly?: boolean }) {
  const workspaceOnly = options?.workspaceOnly ?? false;

  if (!workspaceOnly) {
    // When workspaceOnly is false, allow writes anywhere on the host
    return {
      mkdir: async (dir: string) => {
        const resolved = path.resolve(dir);
        await fs.mkdir(resolved, { recursive: true });
      },
      writeFile: writeHostFile,
    } as const;
  }

  // When workspaceOnly is true, enforce workspace boundary
  return {
    mkdir: async (dir: string) => {
      const relative = toRelativeWorkspacePath(root, dir, { allowRoot: true });
      const resolved = relative ? path.resolve(root, relative) : path.resolve(root);
      await assertSandboxPath({ filePath: resolved, cwd: root, root });
      await fs.mkdir(resolved, { recursive: true });
    },
    writeFile: async (absolutePath: string, content: string) => {
      const relative = toRelativeWorkspacePath(root, absolutePath);
      await writeFileWithinRoot({
        rootDir: root,
        relativePath: relative,
        data: content,
        mkdir: true,
      });
    },
  } as const;
}

function createHostEditOperations(root: string, options?: { workspaceOnly?: boolean }) {
  const workspaceOnly = options?.workspaceOnly ?? false;

  if (!workspaceOnly) {
    // When workspaceOnly is false, allow edits anywhere on the host
    return {
      readFile: async (absolutePath: string) => {
        const resolved = path.resolve(absolutePath);
        return await fs.readFile(resolved);
      },
      writeFile: writeHostFile,
      access: async (absolutePath: string) => {
        const resolved = path.resolve(absolutePath);
        await fs.access(resolved);
      },
    } as const;
  }

  // When workspaceOnly is true, enforce workspace boundary
  return {
    readFile: async (absolutePath: string) => {
      const relative = toRelativeWorkspacePath(root, absolutePath);
      const safeRead = await readFileWithinRoot({
        rootDir: root,
        relativePath: relative,
      });
      return safeRead.buffer;
    },
    writeFile: async (absolutePath: string, content: string) => {
      const relative = toRelativeWorkspacePath(root, absolutePath);
      await writeFileWithinRoot({
        rootDir: root,
        relativePath: relative,
        data: content,
        mkdir: true,
      });
    },
    access: async (absolutePath: string) => {
      let relative: string;
      try {
        relative = toRelativeWorkspacePath(root, absolutePath);
      } catch {
        // Path escapes workspace root.  Don't throw here – the upstream
        // library replaces any `access` error with a misleading "File not
        // found" message.  By returning silently the subsequent `readFile`
        // call will throw the same "Path escapes workspace root" error
        // through a code-path that propagates the original message.
        return;
      }
      try {
        const opened = await openFileWithinRoot({
          rootDir: root,
          relativePath: relative,
        });
        await opened.handle.close().catch(() => {});
      } catch (error) {
        if (error instanceof SafeOpenError && error.code === "not-found") {
          throw createFsAccessError("ENOENT", absolutePath);
        }
        if (error instanceof SafeOpenError && error.code === "outside-workspace") {
          // Don't throw here – see the comment above about the upstream
          // library swallowing access errors as "File not found".
          return;
        }
        throw error;
      }
    },
  } as const;
}

function createFsAccessError(code: string, filePath: string): NodeJS.ErrnoException {
  const error = new Error(`Sandbox FS error (${code}): ${filePath}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
