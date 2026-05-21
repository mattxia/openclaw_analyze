/**
 * Bash 进程注册表
 *
 * 本模块负责管理 Bash 子进程的生命周期，包括：
 * - 进程会话的创建、存储、查询与删除
 * - 子进程输出（stdout/stderr）的缓冲、截断与聚合
 * - 会话状态转换（运行中 → 已退出/已后台化）
 * - 已完成会话的定时清理（TTL 机制）
 * - 子进程资源的清理（文件描述符、事件监听器等）
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createSessionSlug as createSessionSlugId } from "./session-slug.js";

// ==================== 常量定义 ====================

const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes —— 已完成会话的默认存活时间
const MIN_JOB_TTL_MS = 60 * 1000; // 1 minute —— 最小 TTL
const MAX_JOB_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours —— 最大 TTL
const DEFAULT_PENDING_OUTPUT_CHARS = 30_000; // 待消费输出缓冲区的默认字符上限

/**
 * 将 TTL 值限制在 [MIN_JOB_TTL_MS, MAX_JOB_TTL_MS] 范围内
 * 如果值无效（undefined / NaN），则返回默认值
 */
function clampTtl(value: number | undefined) {
  if (!value || Number.isNaN(value)) {
    return DEFAULT_JOB_TTL_MS;
  }
  return Math.min(Math.max(value, MIN_JOB_TTL_MS), MAX_JOB_TTL_MS);
}

// 从环境变量 PI_BASH_JOB_TTL_MS 读取 TTL 配置，并 clamp 到合法范围
let jobTtlMs = clampTtl(Number.parseInt(process.env.PI_BASH_JOB_TTL_MS ?? "", 10));

// ==================== 类型定义 ====================

/** 进程状态：运行中 / 已完成 / 已失败 / 已终止 */
export type ProcessStatus = "running" | "completed" | "failed" | "killed";

/**
 * 会话标准输入抽象接口
 * 封装了对子进程 stdin 的写入操作，兼容真实 Node 流和 PTY 包装器
 */
export type SessionStdin = {
  write: (data: string, cb?: (err?: Error | null) => void) => void;
  end: () => void;
  // When backed by a real Node stream (child.stdin), this exists; for PTY wrappers it may not.
  destroy?: () => void;
  destroyed?: boolean;
};

/**
 * 运行中的进程会话
 * 记录了一个 Bash 子进程从启动到退出的全部状态信息
 */
export interface ProcessSession {
  id: string; // 会话唯一标识符
  command: string; // 执行的命令
  scopeKey?: string; // 作用域键（用于分组管理）
  sessionKey?: string; // 会话键（用于去重等逻辑）
  notifyOnExit?: boolean; // 退出时是否需要通知
  notifyOnExitEmptySuccess?: boolean; // 退出时是否在输出为空且成功时通知
  exitNotified?: boolean; // 是否已发送退出通知（防止重复通知）
  child?: ChildProcessWithoutNullStreams; // 底层子进程对象
  stdin?: SessionStdin; // 标准输入接口
  pid?: number; // 子进程 PID
  startedAt: number; // 启动时间戳
  cwd?: string; // 工作目录
  maxOutputChars: number; // 聚合输出的最大字符数
  pendingMaxOutputChars?: number; // 待消费输出缓冲区的最大字符数
  totalOutputChars: number; // 累计输出的总字符数（含已截断部分）
  pendingStdout: string[]; // 待消费的 stdout 数据块列表
  pendingStderr: string[]; // 待消费的 stderr 数据块列表
  pendingStdoutChars: number; // 待消费 stdout 的总字符数
  pendingStderrChars: number; // 待消费 stderr 的总字符数
  aggregated: string; // 聚合后的完整输出（可能被截断）
  tail: string; // 聚合输出的末尾 2000 字符（用于快速预览）
  exitCode?: number | null; // 退出码
  exitSignal?: NodeJS.Signals | number | null; // 退出信号
  exited: boolean; // 是否已退出
  truncated: boolean; // 输出是否发生过截断
  backgrounded: boolean; // 是否已后台化
}

/**
 * 已完成的进程会话
 * 仅保留关键信息，不持有子进程引用等运行时资源
 */
export interface FinishedSession {
  id: string; // 会话唯一标识符
  command: string; // 执行的命令
  scopeKey?: string; // 作用域键
  startedAt: number; // 启动时间戳
  endedAt: number; // 结束时间戳
  cwd?: string; // 工作目录
  status: ProcessStatus; // 最终状态
  exitCode?: number | null; // 退出码
  exitSignal?: NodeJS.Signals | number | null; // 退出信号
  aggregated: string; // 聚合输出
  tail: string; // 末尾预览
  truncated: boolean; // 是否被截断
  totalOutputChars: number; // 累计输出总字符数
}

// ==================== 核心数据存储 ====================

/** 运行中的会话映射表：id → ProcessSession */
const runningSessions = new Map<string, ProcessSession>();

/** 已完成的会话映射表：id → FinishedSession（仅后台化会话才存入） */
const finishedSessions = new Map<string, FinishedSession>();

/** 定时清理器的引用 */
let sweeper: NodeJS.Timeout | null = null;

// ==================== 会话 ID 管理 ====================

/** 检查会话 ID 是否已被占用（运行中或已完成） */
function isSessionIdTaken(id: string) {
  return runningSessions.has(id) || finishedSessions.has(id);
}

/** 创建唯一的会话标识符（slug），确保不与现有会话冲突 */
export function createSessionSlug(): string {
  return createSessionSlugId(isSessionIdTaken);
}

// ==================== 会话 CRUD 操作 ====================

/** 注册一个新的运行中会话，并启动定时清理器 */
export function addSession(session: ProcessSession) {
  runningSessions.set(session.id, session);
  startSweeper();
}

/** 根据 ID 获取运行中的会话 */
export function getSession(id: string) {
  return runningSessions.get(id);
}

/** 根据 ID 获取已完成的会话 */
export function getFinishedSession(id: string) {
  return finishedSessions.get(id);
}

/** 从运行中和已完成映射表中删除指定会话 */
export function deleteSession(id: string) {
  runningSessions.delete(id);
  finishedSessions.delete(id);
}

// ==================== 输出缓冲与截断 ====================

/**
 * 将子进程的输出追加到会话的缓冲区中
 *
 * 处理流程：
 * 1. 确保缓冲区及字符计数器已初始化
 * 2. 将新数据块追加到对应流（stdout/stderr）的待消费缓冲区
 * 3. 若缓冲区超出上限，执行截断并标记 truncated
 * 4. 将数据追加到聚合输出中，若超出 maxOutputChars 则从头部截断
 * 5. 更新 tail 字段（保留末尾 2000 字符用于快速预览）
 */
export function appendOutput(session: ProcessSession, stream: "stdout" | "stderr", chunk: string) {
  // 初始化待消费缓冲区和字符计数器（防御性编程）
  session.pendingStdout ??= [];
  session.pendingStderr ??= [];
  session.pendingStdoutChars ??= sumPendingChars(session.pendingStdout);
  session.pendingStderrChars ??= sumPendingChars(session.pendingStderr);

  // 选择目标缓冲区及其当前字符数
  const buffer = stream === "stdout" ? session.pendingStdout : session.pendingStderr;
  const bufferChars = stream === "stdout" ? session.pendingStdoutChars : session.pendingStderrChars;

  // 计算待消费缓冲区的容量上限（取用户配置与 maxOutputChars 的较小值）
  const pendingCap = Math.min(
    session.pendingMaxOutputChars ?? DEFAULT_PENDING_OUTPUT_CHARS,
    session.maxOutputChars,
  );

  // 追加数据块
  buffer.push(chunk);
  let pendingChars = bufferChars + chunk.length;

  // 超出容量上限时截断缓冲区
  if (pendingChars > pendingCap) {
    session.truncated = true;
    pendingChars = capPendingBuffer(buffer, pendingChars, pendingCap);
  }

  // 更新对应流的字符计数
  if (stream === "stdout") {
    session.pendingStdoutChars = pendingChars;
  } else {
    session.pendingStderrChars = pendingChars;
  }

  // 累加总输出字符数（含已截断部分，用于统计）
  session.totalOutputChars += chunk.length;

  // 将新数据追加到聚合输出，若超出上限则从头部截断
  const aggregated = trimWithCap(session.aggregated + chunk, session.maxOutputChars);
  session.truncated =
    session.truncated || aggregated.length < session.aggregated.length + chunk.length;
  session.aggregated = aggregated;

  // 更新末尾预览
  session.tail = tail(session.aggregated, 2000);
}

/**
 * 排空会话的待消费输出缓冲区
 * 将所有待消费的 stdout/stderr 拼接为字符串返回，并重置缓冲区
 * 调用方通常在读取输出后调用此方法，以清空已消费的数据
 */
export function drainSession(session: ProcessSession) {
  const stdout = session.pendingStdout.join("");
  const stderr = session.pendingStderr.join("");
  session.pendingStdout = [];
  session.pendingStderr = [];
  session.pendingStdoutChars = 0;
  session.pendingStderrChars = 0;
  return { stdout, stderr };
}

// ==================== 会话状态转换 ====================

/**
 * 标记会话为已退出
 * 设置退出码和退出信号，更新 tail，然后迁移到已完成表
 */
export function markExited(
  session: ProcessSession,
  exitCode: number | null,
  exitSignal: NodeJS.Signals | number | null,
  status: ProcessStatus,
) {
  session.exited = true;
  session.exitCode = exitCode;
  session.exitSignal = exitSignal;
  session.tail = tail(session.aggregated, 2000);
  moveToFinished(session, status);
}

/** 标记会话为后台化（后台会话在退出后仍保留在 finishedSessions 中供查询） */
export function markBackgrounded(session: ProcessSession) {
  session.backgrounded = true;
}

/**
 * 将会话从运行中迁移到已完成状态
 *
 * 核心逻辑：
 * 1. 从 runningSessions 中移除
 * 2. 清理子进程资源（销毁 stdio 流、移除事件监听器、释放引用）
 * 3. 清理 stdin 包装器
 * 4. 仅后台化的会话才会存入 finishedSessions（非后台会话直接丢弃）
 */
function moveToFinished(session: ProcessSession, status: ProcessStatus) {
  runningSessions.delete(session.id);

  // Clean up child process stdio streams to prevent FD leaks
  if (session.child) {
    // Destroy stdio streams to release file descriptors
    session.child.stdin?.destroy?.();
    session.child.stdout?.destroy?.();
    session.child.stderr?.destroy?.();

    // Remove all event listeners to prevent memory leaks
    session.child.removeAllListeners();

    // Clear the reference
    delete session.child;
  }

  // Clean up stdin wrapper - call destroy if available, otherwise just remove reference
  if (session.stdin) {
    // Try to call destroy/end method if exists
    if (typeof session.stdin.destroy === "function") {
      session.stdin.destroy();
    } else if (typeof session.stdin.end === "function") {
      session.stdin.end();
    }
    // Only set flag if writable
    try {
      (session.stdin as { destroyed?: boolean }).destroyed = true;
    } catch {
      // Ignore if read-only
    }
    delete session.stdin;
  }

  // 只有后台化的会话才保留到 finishedSessions，供后续查询
  if (!session.backgrounded) {
    return;
  }
  finishedSessions.set(session.id, {
    id: session.id,
    command: session.command,
    scopeKey: session.scopeKey,
    startedAt: session.startedAt,
    endedAt: Date.now(),
    cwd: session.cwd,
    status,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    aggregated: session.aggregated,
    tail: session.tail,
    truncated: session.truncated,
    totalOutputChars: session.totalOutputChars,
  });
}

// ==================== 工具函数 ====================

/** 截取字符串末尾 max 个字符 */
export function tail(text: string, max = 2000) {
  if (text.length <= max) {
    return text;
  }
  return text.slice(text.length - max);
}

/** 计算缓冲区中所有数据块的总字符数 */
function sumPendingChars(buffer: string[]) {
  let total = 0;
  for (const chunk of buffer) {
    total += chunk.length;
  }
  return total;
}

/**
 * 将待消费缓冲区截断到指定容量
 *
 * 截断策略（保留最新的数据）：
 * 1. 如果最后一个数据块本身超过容量，直接只保留其末尾
 * 2. 否则从头部开始丢弃完整的数据块，直到剩余数据不超过容量
 * 3. 如果丢弃完整块后仍超出，则对第一个块进行部分截断
 */
function capPendingBuffer(buffer: string[], pendingChars: number, cap: number) {
  if (pendingChars <= cap) {
    return pendingChars;
  }
  // 最后一个块本身就超过容量 → 只保留其末尾 cap 个字符
  const last = buffer.at(-1);
  if (last && last.length >= cap) {
    buffer.length = 0;
    buffer.push(last.slice(last.length - cap));
    return cap;
  }
  // 从头部丢弃完整的数据块
  while (buffer.length && pendingChars - buffer[0].length >= cap) {
    pendingChars -= buffer[0].length;
    buffer.shift();
  }
  // 如果仍超出，对第一个块做部分截断
  if (buffer.length && pendingChars > cap) {
    const overflow = pendingChars - cap;
    buffer[0] = buffer[0].slice(overflow);
    pendingChars = cap;
  }
  return pendingChars;
}

/** 将文本截断到最大长度，保留末尾部分 */
export function trimWithCap(text: string, max: number) {
  if (text.length <= max) {
    return text;
  }
  return text.slice(text.length - max);
}

// ==================== 查询与清理 ====================

/** 列出所有已后台化的运行中会话 */
export function listRunningSessions() {
  return Array.from(runningSessions.values()).filter((s) => s.backgrounded);
}

/** 列出所有已完成的会话 */
export function listFinishedSessions() {
  return Array.from(finishedSessions.values());
}

/** 清空所有已完成会话 */
export function clearFinished() {
  finishedSessions.clear();
}

/** 重置注册表（仅用于测试） */
export function resetProcessRegistryForTests() {
  runningSessions.clear();
  finishedSessions.clear();
  stopSweeper();
}

/** 动态设置 TTL 并重启清理器 */
export function setJobTtlMs(value?: number) {
  if (value === undefined || Number.isNaN(value)) {
    return;
  }
  jobTtlMs = clampTtl(value);
  stopSweeper();
  startSweeper();
}

// ==================== 定时清理器（Sweeper） ====================

/** 清理超过 TTL 的已完成会话 */
function pruneFinishedSessions() {
  const cutoff = Date.now() - jobTtlMs;
  for (const [id, session] of finishedSessions.entries()) {
    if (session.endedAt < cutoff) {
      finishedSessions.delete(id);
    }
  }
}

/**
 * 启动定时清理器
 * 清理间隔为 max(30s, TTL/6)，使用 unref() 使其不阻止进程退出
 */
function startSweeper() {
  if (sweeper) {
    return;
  }
  sweeper = setInterval(pruneFinishedSessions, Math.max(30_000, jobTtlMs / 6));
  sweeper.unref?.();
}

/** 停止定时清理器 */
function stopSweeper() {
  if (!sweeper) {
    return;
  }
  clearInterval(sweeper);
  sweeper = null;
}
