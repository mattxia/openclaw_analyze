/**
 * 会话转录本（Transcript）管理模块
 * 负责会话历史的持久化、读取、更新等核心操作
 * 会话历史以JSONL格式存储在单独文件中，支持增量写入和随机访问
 */

// Node.js核心模块
import fs from "node:fs"; // 文件系统操作
import path from "node:path"; // 路径处理
// Agent SDK依赖
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent"; // 会话管理器
// 内部模块依赖
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js"; // 会话更新事件通知
import { parseSessionThreadInfo } from "./delivery-info.js"; // 会话线程信息解析
import {
  resolveDefaultSessionStorePath, // 解析默认会话存储路径
  resolveSessionFilePath, // 解析会话文件路径
  resolveSessionFilePathOptions, // 解析会话文件路径配置
  resolveSessionTranscriptPath, // 解析转录本存储路径
} from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js"; // 解析并持久化会话文件
import { loadSessionStore } from "./store.js"; // 加载会话存储
import type { SessionEntry } from "./types.js"; // 会话条目类型定义

/**
 * 移除URL中的查询参数和哈希部分
 * @param value 原始URL字符串
 * @returns 去除查询参数和哈希后的纯路径
 */
function stripQuery(value: string): string {
  // 先移除哈希部分（#后面的内容）
  const noHash = value.split("#")[0] ?? value;
  // 再移除查询参数（?后面的内容）
  return noHash.split("?")[0] ?? noHash;
}

/**
 * 从媒体URL中提取文件名
 * 支持HTTP/HTTPS URL和本地文件路径两种格式
 * @param value 媒体URL或文件路径
 * @returns 提取到的文件名，提取失败返回null
 */
function extractFileNameFromMediaUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  // 先移除URL中的查询参数和哈希
  const cleaned = stripQuery(trimmed);
  try {
    // 尝试作为URL解析（处理HTTP/HTTPS等远程URL）
    const parsed = new URL(cleaned);
    const base = path.basename(parsed.pathname);
    if (!base) {
      return null;
    }
    try {
      // 尝试URL解码文件名
      return decodeURIComponent(base);
    } catch {
      // 解码失败直接返回原始basename
      return base;
    }
  } catch {
    // 解析URL失败，作为本地文件路径处理
    const base = path.basename(cleaned);
    if (!base || base === "/" || base === ".") {
      return null;
    }
    return base;
  }
}

/**
 * 解析镜像转录本的显示文本
 * 用于消息投递镜像功能，将包含媒体的消息转换为适合存储在会话历史中的文本表示
 * 优先使用媒体文件名列表，没有媒体时使用文本内容
 * @param params 包含文本内容和媒体URL列表的参数
 * @returns 处理后的显示文本，内容为空时返回null
 */
export function resolveMirroredTranscriptText(params: {
  text?: string;
  mediaUrls?: string[];
}): string | null {
  const mediaUrls = params.mediaUrls?.filter((url) => url && url.trim()) ?? [];
  // 如果有媒体文件，优先显示媒体文件名列表
  if (mediaUrls.length > 0) {
    const names = mediaUrls
      .map((url) => extractFileNameFromMediaUrl(url))
      .filter((name): name is string => Boolean(name && name.trim()));
    if (names.length > 0) {
      return names.join(", ");
    }
    // 提取不到文件名时显示通用media标记
    return "media";
  }

  // 没有媒体时返回文本内容
  const text = params.text ?? "";
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

/**
 * 确保会话文件头部存在
 * 新创建的会话文件需要写入头部信息，标记会话版本、ID、创建时间等元数据
 * 如果文件已存在则不做任何操作
 * @param params 会话文件路径和会话ID
 */
async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
}): Promise<void> {
  // 文件已存在直接返回
  if (fs.existsSync(params.sessionFile)) {
    return;
  }
  // 确保父目录存在
  await fs.promises.mkdir(path.dirname(params.sessionFile), { recursive: true });
  // 构建会话头部元数据
  const header = {
    type: "session", // 标记为会话头部
    version: CURRENT_SESSION_VERSION, // 会话格式版本，用于兼容性处理
    id: params.sessionId, // 会话唯一ID
    timestamp: new Date().toISOString(), // 创建时间
    cwd: process.cwd(), // 创建时的工作目录
  };
  // 写入头部到文件，权限设为0o600（仅所有者可读写）
  await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * 解析会话转录本文件路径
 * 根据会话信息查找或创建对应的会话历史文件路径，支持自动持久化会话文件关联信息
 * @param params 解析参数
 * @param params.sessionId 会话唯一ID
 * @param params.sessionKey 会话Key（包含渠道、线程等信息的唯一标识）
 * @param params.sessionEntry 会话存储中的现有条目（可选）
 * @param params.sessionStore 会话存储对象（sessions.json的内容）
 * @param params.storePath 会话存储根路径
 * @param params.agentId Agent唯一ID
 * @param params.threadId 线程ID（如Slack/Teams的会话线程ID）
 * @returns 解析后的会话文件路径和更新后的会话条目
 */
export async function resolveSessionTranscriptFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry | undefined }> {
  // 解析会话文件路径配置（存储目录、Agent ID等）
  const sessionPathOpts = resolveSessionFilePathOptions({
    agentId: params.agentId,
    storePath: params.storePath,
  });
  // 优先从现有会话条目中解析会话文件路径
  let sessionFile = resolveSessionFilePath(params.sessionId, params.sessionEntry, sessionPathOpts);
  let sessionEntry = params.sessionEntry;

  // 如果提供了会话存储，尝试持久化会话文件关联（更新sessions.json）
  if (params.sessionStore && params.storePath) {
    // 从sessionKey中解析线程ID（如果有的话）
    const threadIdFromSessionKey = parseSessionThreadInfo(params.sessionKey).threadId;
    // 如果会话条目还没有关联的会话文件，生成fallback路径
    const fallbackSessionFile = !sessionEntry?.sessionFile
      ? resolveSessionTranscriptPath(
          params.sessionId,
          params.agentId,
          params.threadId ?? threadIdFromSessionKey,
        )
      : undefined;
    // 解析并持久化会话文件关联到sessions.json
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      sessionEntry,
      agentId: sessionPathOpts?.agentId,
      sessionsDir: sessionPathOpts?.sessionsDir,
      fallbackSessionFile,
    });
    sessionFile = resolvedSessionFile.sessionFile;
    sessionEntry = resolvedSessionFile.sessionEntry;
  }

  return {
    sessionFile,
    sessionEntry,
  };
}

/**
 * 向会话转录本中追加助手回复消息
 * 用于消息投递镜像功能，将助手的回复同步到会话历史中
 * 支持幂等性，相同idempotencyKey的消息不会重复添加
 * @param params 追加参数
 * @param params.agentId Agent ID
 * @param params.sessionKey 会话Key
 * @param params.text 助手回复的文本内容
 * @param params.mediaUrls 助手回复中的媒体URL列表
 * @param params.idempotencyKey 幂等键，用于避免重复添加相同消息
 * @param params.storePath 会话存储根路径（可选，主要用于测试）
 * @returns 操作结果，成功返回会话文件路径，失败返回错误原因
 */
export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
}): Promise<{ ok: true; sessionFile: string } | { ok: false; reason: string }> {
  // 校验sessionKey非空
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  // 解析要保存的显示文本（处理媒体和文本）
  const mirrorText = resolveMirroredTranscriptText({
    text: params.text,
    mediaUrls: params.mediaUrls,
  });
  if (!mirrorText) {
    return { ok: false, reason: "empty text" };
  }

  // 加载会话存储（sessions.json），跳过缓存确保读取最新数据
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[sessionKey] as SessionEntry | undefined;
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  // 解析会话文件路径
  let sessionFile: string;
  try {
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: entry.sessionId,
      sessionKey,
      sessionStore: store,
      storePath,
      sessionEntry: entry,
      agentId: params.agentId,
      sessionsDir: path.dirname(storePath),
    });
    sessionFile = resolvedSessionFile.sessionFile;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // 确保会话文件头部存在
  await ensureSessionHeader({ sessionFile, sessionId: entry.sessionId });

  // 幂等性检查：如果已经存在相同idempotencyKey的消息，直接返回成功
  if (
    params.idempotencyKey &&
    (await transcriptHasIdempotencyKey(sessionFile, params.idempotencyKey))
  ) {
    return { ok: true, sessionFile };
  }

  // 打开会话管理器，追加助手消息到转录本
  const sessionManager = SessionManager.open(sessionFile);
  sessionManager.appendMessage({
    role: "assistant", // 消息角色：助手
    content: [{ type: "text", text: mirrorText }], // 消息内容
    api: "openai-responses", // 标记使用的API类型
    provider: "openclaw", // 消息提供者
    model: "delivery-mirror", // 标记为投递镜像消息，不是模型直接生成
    usage: {
      // token使用统计，镜像消息全部记为0
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
    stopReason: "stop", // 停止原因
    timestamp: Date.now(), // 时间戳
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}), // 附加幂等键
  });

  // 发送会话更新事件，通知其他模块会话已变更
  emitSessionTranscriptUpdate(sessionFile);
  return { ok: true, sessionFile };
}

/**
 * 检查会话转录本中是否存在指定的幂等键
 * 用于实现消息追加的幂等性，确保相同消息不会被重复添加到会话历史中
 * @param transcriptPath 会话转录本文件路径
 * @param idempotencyKey 要检查的幂等键
 * @returns 存在返回true，不存在或读取失败返回false
 */
async function transcriptHasIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<boolean> {
  try {
    // 读取转录本文件内容
    const raw = await fs.promises.readFile(transcriptPath, "utf-8");
    // 按行分割JSONL格式的文件
    for (const line of raw.split(/\r?\n/)) {
      // 跳过空行
      if (!line.trim()) {
        continue;
      }
      try {
        // 解析单行JSON
        const parsed = JSON.parse(line) as { message?: { idempotencyKey?: unknown } };
        // 检查是否包含匹配的幂等键
        if (parsed.message?.idempotencyKey === idempotencyKey) {
          return true;
        }
      } catch {
        // 解析失败的行直接跳过，不影响整体检查
        continue;
      }
    }
  } catch {
    // 文件读取失败或其他异常，返回false
    return false;
  }
  // 遍历完所有行未找到匹配的幂等键
  return false;
}
