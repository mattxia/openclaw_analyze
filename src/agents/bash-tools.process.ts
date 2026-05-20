/**
 * bash-tools.process.ts — 后台进程管理工具
 *
 * 提供 process 工具，用于管理后台运行的 shell 会话，支持以下操作：
 *   - list:   列出当前运行中及已完成的后台会话
 *   - poll:   轮询会话输出，支持超时等待
 *   - log:    查看会话的聚合日志，支持分页（offset/limit）
 *   - write:  向后台会话的标准输入写入数据
 *   - send-keys: 向后台会话发送按键序列（支持 key token、hex、literal）
 *   - submit: 向后台会话发送回车（CR），相当于提交当前输入行
 *   - paste:  向后台会话粘贴文本（支持 bracketed paste 模式）
 *   - kill:   终止后台会话
 *   - clear:  清除已完成的会话记录
 *   - remove: 强制移除会话（先尝试取消，失败则强杀进程树）
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import { getDiagnosticSessionState } from "../logging/diagnostic-session-state.js";
import { killProcessTree } from "../process/kill-tree.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  type ProcessSession,
  deleteSession,
  drainSession,
  getFinishedSession,
  getSession,
  listFinishedSessions,
  listRunningSessions,
  markExited,
  setJobTtlMs,
} from "./bash-process-registry.js";
import { deriveSessionName, pad, sliceLogLines, truncateMiddle } from "./bash-tools.shared.js";
import { recordCommandPoll, resetCommandPollCount } from "./command-poll-backoff.js";
import { encodeKeySequence, encodePaste } from "./pty-keys.js";

/** process 工具的默认配置项 */
export type ProcessToolDefaults = {
  /** 会话清理之前的存活时间（毫秒），用于 TTL 控制 */
  cleanupMs?: number;
  /** 作用域键，用于隔离不同来源的会话 */
  scopeKey?: string;
};

/** 可写标准输入接口，封装了 Node.js stream 的写入操作 */
type WritableStdin = {
  write: (data: string, cb?: (err?: Error | null) => void) => void;
  end: () => void;
  destroyed?: boolean;
};
/** 默认日志尾部行数，log 操作未指定 offset/limit 时使用 */
const DEFAULT_LOG_TAIL_LINES = 200;

/**
 * 解析日志分片窗口参数
 * 当用户未提供 offset/limit 时，自动回退到默认尾部行数（DEFAULT_LOG_TAIL_LINES）
 * 返回有效的 offset、limit 以及是否使用了默认尾部模式
 */
function resolveLogSliceWindow(offset?: number, limit?: number) {
  const usingDefaultTail = offset === undefined && limit === undefined;
  const effectiveLimit =
    typeof limit === "number" && Number.isFinite(limit)
      ? limit
      : usingDefaultTail
        ? DEFAULT_LOG_TAIL_LINES
        : undefined;
  return { effectiveOffset: offset, effectiveLimit, usingDefaultTail };
}

/**
 * 当使用默认尾部行数截断日志时，生成提示信息
 * 告知用户当前仅显示了最后 N 行，可以通过 offset/limit 翻页
 */
function defaultTailNote(totalLines: number, usingDefaultTail: boolean) {
  if (!usingDefaultTail || totalLines <= DEFAULT_LOG_TAIL_LINES) {
    return "";
  }
  return `\n\n[showing last ${DEFAULT_LOG_TAIL_LINES} of ${totalLines} lines; pass offset/limit to page]`;
}

/** process 工具的 TypeBox 参数 Schema，定义了所有 action 及其参数 */
const processSchema = Type.Object({
  action: Type.String({ description: "Process action" }),
  sessionId: Type.Optional(Type.String({ description: "Session id for actions other than list" })),
  data: Type.Optional(Type.String({ description: "Data to write for write" })),
  keys: Type.Optional(
    Type.Array(Type.String(), { description: "Key tokens to send for send-keys" }),
  ),
  hex: Type.Optional(Type.Array(Type.String(), { description: "Hex bytes to send for send-keys" })),
  literal: Type.Optional(Type.String({ description: "Literal string for send-keys" })),
  text: Type.Optional(Type.String({ description: "Text to paste for paste" })),
  bracketed: Type.Optional(Type.Boolean({ description: "Wrap paste in bracketed mode" })),
  eof: Type.Optional(Type.Boolean({ description: "Close stdin after write" })),
  offset: Type.Optional(Type.Number({ description: "Log offset" })),
  limit: Type.Optional(Type.Number({ description: "Log length" })),
  timeout: Type.Optional(
    Type.Number({
      description: "For poll: wait up to this many milliseconds before returning",
      minimum: 0,
    }),
  ),
});

/** poll 操作的最大等待时间（毫秒），防止无限等待 */
const MAX_POLL_WAIT_MS = 120_000;

/**
 * 解析 poll 操作的等待超时值
 * 支持数字或字符串输入，限制在 [0, MAX_POLL_WAIT_MS] 范围内
 */
function resolvePollWaitMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(MAX_POLL_WAIT_MS, Math.floor(value)));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(MAX_POLL_WAIT_MS, parsed));
    }
  }
  return 0;
}

/** 快速构造失败结果的辅助函数 */
function failText(text: string): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    details: { status: "failed" },
  };
}

/**
 * 记录 poll 操作的重试建议
 * 根据是否有新输出来调整轮询退避策略，返回建议的重试间隔（毫秒）
 */
function recordPollRetrySuggestion(sessionId: string, hasNewOutput: boolean): number | undefined {
  try {
    const sessionState = getDiagnosticSessionState({ sessionId });
    return recordCommandPoll(sessionState, sessionId, hasNewOutput);
  } catch {
    return undefined;
  }
}

/** 重置 poll 重试建议计数，通常在会话结束或清除时调用 */
function resetPollRetrySuggestion(sessionId: string): void {
  try {
    const sessionState = getDiagnosticSessionState({ sessionId });
    resetCommandPollCount(sessionState, sessionId);
  } catch {
    // Ignore diagnostics state failures for process tool behavior.
  }
}

/**
 * 创建 process 工具实例
 *
 * @param defaults 可选的默认配置（会话 TTL、作用域键）
 * @returns 返回一个符合 AgentTool 接口的工具对象
 */
export function createProcessTool(
  defaults?: ProcessToolDefaults,
  // oxlint-disable-next-line typescript/no-explicit-any
): AgentTool<any, unknown> {
  // 设置会话的 TTL（存活时间），超时后自动清理
  if (defaults?.cleanupMs !== undefined) {
    setJobTtlMs(defaults.cleanupMs);
  }
  const scopeKey = defaults?.scopeKey;
  const supervisor = getProcessSupervisor();

  /** 检查会话是否在当前作用域内（如果配置了 scopeKey 则进行过滤） */
  const isInScope = (session?: { scopeKey?: string } | null) =>
    !scopeKey || session?.scopeKey === scopeKey;

  /** 通过进程管理器（supervisor）取消托管会话 */
  const cancelManagedSession = (sessionId: string) => {
    const record = supervisor.getRecord(sessionId);
    if (!record || record.state === "exited") {
      return false;
    }
    supervisor.cancel(sessionId, "manual-cancel");
    return true;
  };

  /** 备用终止方案：当 supervisor 无法管理时，直接 kill 进程树 */
  const terminateSessionFallback = (session: ProcessSession) => {
    const pid = session.pid ?? session.child?.pid;
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
      return false;
    }
    killProcessTree(pid);
    return true;
  };

  return {
    name: "process",
    label: "process",
    description:
      "Manage running exec sessions: list, poll, log, write, send-keys, submit, paste, kill.",
    parameters: processSchema,
    execute: async (_toolCallId, args, _signal, _onUpdate): Promise<AgentToolResult<unknown>> => {
      // 解析工具调用的参数
      const params = args as {
        action:
          | "list"
          | "poll"
          | "log"
          | "write"
          | "send-keys"
          | "submit"
          | "paste"
          | "kill"
          | "clear"
          | "remove";
        sessionId?: string;
        data?: string;
        keys?: string[];
        hex?: string[];
        literal?: string;
        text?: string;
        bracketed?: boolean;
        eof?: boolean;
        offset?: number;
        limit?: number;
        timeout?: unknown;
      };

      // --- list action：列出所有运行中和已完成的会话 ---
      if (params.action === "list") {
        // 收集运行中的会话信息
        const running = listRunningSessions()
          .filter((s) => isInScope(s))
          .map((s) => ({
            sessionId: s.id,
            status: "running",
            pid: s.pid ?? undefined,
            startedAt: s.startedAt,
            runtimeMs: Date.now() - s.startedAt,
            cwd: s.cwd,
            command: s.command,
            name: deriveSessionName(s.command),
            tail: s.tail,
            truncated: s.truncated,
          }));
        // 收集已完成的会话信息
        const finished = listFinishedSessions()
          .filter((s) => isInScope(s))
          .map((s) => ({
            sessionId: s.id,
            status: s.status,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            runtimeMs: s.endedAt - s.startedAt,
            cwd: s.cwd,
            command: s.command,
            name: deriveSessionName(s.command),
            tail: s.tail,
            truncated: s.truncated,
            exitCode: s.exitCode ?? undefined,
            exitSignal: s.exitSignal ?? undefined,
          }));
        // 合并运行中和已完成的会话，按启动时间降序排列
        const lines = [...running, ...finished]
          .toSorted((a, b) => b.startedAt - a.startedAt)
          .map((s) => {
            const label = s.name ? truncateMiddle(s.name, 80) : truncateMiddle(s.command, 120);
            return `${s.sessionId} ${pad(s.status, 9)} ${formatDurationCompact(s.runtimeMs) ?? "n/a"} :: ${label}`;
          });
        return {
          content: [
            {
              type: "text",
              text: lines.join("\n") || "No running or recent sessions.",
            },
          ],
          details: { status: "completed", sessions: [...running, ...finished] },
        };
      }

      // 非 list 操作必须提供 sessionId
      if (!params.sessionId) {
        return {
          content: [{ type: "text", text: "sessionId is required for this action." }],
          details: { status: "failed" },
        };
      }

      // 获取会话：优先查找运行中的会话，再查找已完成的会话
      const session = getSession(params.sessionId);
      const finished = getFinishedSession(params.sessionId);
      const scopedSession = isInScope(session) ? session : undefined;
      const scopedFinished = isInScope(finished) ? finished : undefined;

      /** 快速构造失败结果 */
      const failedResult = (text: string): AgentToolResult<unknown> => ({
        content: [{ type: "text", text }],
        details: { status: "failed" },
      });

      /**
       * 解析后台会话的可写标准输入
       * 验证会话存在、是后台模式且 stdin 可用
       * 返回 ok: true 表示可以写入，否则返回失败结果
       */
      const resolveBackgroundedWritableStdin = () => {
        if (!scopedSession) {
          return {
            ok: false as const,
            result: failedResult(`No active session found for ${params.sessionId}`),
          };
        }
        if (!scopedSession.backgrounded) {
          return {
            ok: false as const,
            result: failedResult(`Session ${params.sessionId} is not backgrounded.`),
          };
        }
        const stdin = scopedSession.stdin ?? scopedSession.child?.stdin;
        if (!stdin || stdin.destroyed) {
          return {
            ok: false as const,
            result: failedResult(`Session ${params.sessionId} stdin is not writable.`),
          };
        }
        return { ok: true as const, session: scopedSession, stdin: stdin as WritableStdin };
      };

      const writeToStdin = async (stdin: WritableStdin, data: string) => {
        // 将数据异步写入 stdin，使用 Promise 封装回调式 API
        await new Promise<void>((resolve, reject) => {
          stdin.write(data, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      };

      /** 构建运行中会话的工具结果 */
      const runningSessionResult = (
        session: ProcessSession,
        text: string,
      ): AgentToolResult<unknown> => ({
        content: [{ type: "text", text }],
        details: {
          status: "running",
          sessionId: params.sessionId,
          name: deriveSessionName(session.command),
        },
      });

      // --- 根据 action 分发到不同处理逻辑 ---
      switch (params.action) {
        // ===== poll：轮询会话输出，支持超时等待 =====
        case "poll": {
          // 如果运行中的会话不存在，但已完成会话存在，则返回已完成的结果
          if (!scopedSession) {
            if (scopedFinished) {
              resetPollRetrySuggestion(params.sessionId);
              return {
                content: [
                  {
                    type: "text",
                    text:
                      (scopedFinished.tail ||
                        `(no output recorded${
                          scopedFinished.truncated ? " — truncated to cap" : ""
                        })`) +
                      `\n\nProcess exited with ${
                        scopedFinished.exitSignal
                          ? `signal ${scopedFinished.exitSignal}`
                          : `code ${scopedFinished.exitCode ?? 0}`
                      }.`,
                  },
                ],
                details: {
                  status: scopedFinished.status === "completed" ? "completed" : "failed",
                  sessionId: params.sessionId,
                  exitCode: scopedFinished.exitCode ?? undefined,
                  aggregated: scopedFinished.aggregated,
                  name: deriveSessionName(scopedFinished.command),
                },
              };
            }
            resetPollRetrySuggestion(params.sessionId);
            return failText(`No session found for ${params.sessionId}`);
          }
          // 检查会话是否为后台模式
          if (!scopedSession.backgrounded) {
            return failText(`Session ${params.sessionId} is not backgrounded.`);
          }
          // 解析超时等待值，如果指定了 timeout 且会话未退出，则循环等待
          const pollWaitMs = resolvePollWaitMs(params.timeout);
          if (pollWaitMs > 0 && !scopedSession.exited) {
            const deadline = Date.now() + pollWaitMs;
            while (!scopedSession.exited && Date.now() < deadline) {
              await new Promise((resolve) =>
                setTimeout(resolve, Math.max(0, Math.min(250, deadline - Date.now()))),
              );
            }
          }
          // 从会话中排空 stdout/stderr 缓冲区
          const { stdout, stderr } = drainSession(scopedSession);
          const exited = scopedSession.exited;
          const exitCode = scopedSession.exitCode ?? 0;
          const exitSignal = scopedSession.exitSignal ?? undefined;
          // 如果已退出，标记退出状态
          if (exited) {
            const status = exitCode === 0 && exitSignal == null ? "completed" : "failed";
            markExited(
              scopedSession,
              scopedSession.exitCode ?? null,
              scopedSession.exitSignal ?? null,
              status,
            );
          }
          // 确定最终状态
          const status = exited
            ? exitCode === 0 && exitSignal == null
              ? "completed"
              : "failed"
            : "running";
          // 拼接 stdout 和 stderr
          const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n").trim();
          const hasNewOutput = output.length > 0;
          // 记录轮询重试建议（用于退避策略）
          const retryInMs = exited
            ? undefined
            : recordPollRetrySuggestion(params.sessionId, hasNewOutput);
          if (exited) {
            resetPollRetrySuggestion(params.sessionId);
          }
          return {
            content: [
              {
                type: "text",
                text:
                  (output || "(no new output)") +
                  (exited
                    ? `\n\nProcess exited with ${
                        exitSignal ? `signal ${exitSignal}` : `code ${exitCode}`
                      }.`
                    : "\n\nProcess still running."),
              },
            ],
            details: {
              status,
              sessionId: params.sessionId,
              exitCode: exited ? exitCode : undefined,
              aggregated: scopedSession.aggregated,
              name: deriveSessionName(scopedSession.command),
              ...(typeof retryInMs === "number" ? { retryInMs } : {}),
            },
          };
        }

        // ===== log：查看会话聚合日志，支持 offset/limit 分页 =====
        case "log": {
          // 运行中会话的日志查看
          if (scopedSession) {
            if (!scopedSession.backgrounded) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Session ${params.sessionId} is not backgrounded.`,
                  },
                ],
                details: { status: "failed" },
              };
            }
            // 解析日志分片窗口，按需截取日志行
            const window = resolveLogSliceWindow(params.offset, params.limit);
            const { slice, totalLines, totalChars } = sliceLogLines(
              scopedSession.aggregated,
              window.effectiveOffset,
              window.effectiveLimit,
            );
            const logDefaultTailNote = defaultTailNote(totalLines, window.usingDefaultTail);
            return {
              content: [{ type: "text", text: (slice || "(no output yet)") + logDefaultTailNote }],
              details: {
                status: scopedSession.exited ? "completed" : "running",
                sessionId: params.sessionId,
                total: totalLines,
                totalLines,
                totalChars,
                truncated: scopedSession.truncated,
                name: deriveSessionName(scopedSession.command),
              },
            };
          }
          // 已完成会话的日志查看
          if (scopedFinished) {
            const window = resolveLogSliceWindow(params.offset, params.limit);
            const { slice, totalLines, totalChars } = sliceLogLines(
              scopedFinished.aggregated,
              window.effectiveOffset,
              window.effectiveLimit,
            );
            const status = scopedFinished.status === "completed" ? "completed" : "failed";
            const logDefaultTailNote = defaultTailNote(totalLines, window.usingDefaultTail);
            return {
              content: [
                { type: "text", text: (slice || "(no output recorded)") + logDefaultTailNote },
              ],
              details: {
                status,
                sessionId: params.sessionId,
                total: totalLines,
                totalLines,
                totalChars,
                truncated: scopedFinished.truncated,
                exitCode: scopedFinished.exitCode ?? undefined,
                exitSignal: scopedFinished.exitSignal ?? undefined,
                name: deriveSessionName(scopedFinished.command),
              },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `No session found for ${params.sessionId}`,
              },
            ],
            details: { status: "failed" },
          };
        }

        // ===== write：向后台会话写入数据 =====
        case "write": {
          const resolved = resolveBackgroundedWritableStdin();
          if (!resolved.ok) {
            return resolved.result;
          }
          // 写入数据到 stdin
          await writeToStdin(resolved.stdin, params.data ?? "");
          // 如果指定 eof，关闭 stdin（通知进程输入结束）
          if (params.eof) {
            resolved.stdin.end();
          }
          return runningSessionResult(
            resolved.session,
            `Wrote ${(params.data ?? "").length} bytes to session ${params.sessionId}${
              params.eof ? " (stdin closed)" : ""
            }.`,
          );
        }

        // ===== send-keys：发送按键序列到后台会话 =====
        case "send-keys": {
          const resolved = resolveBackgroundedWritableStdin();
          if (!resolved.ok) {
            return resolved.result;
          }
          // 编码按键序列（支持 key token、hex 字节、literal 字面量）
          const { data, warnings } = encodeKeySequence({
            keys: params.keys,
            hex: params.hex,
            literal: params.literal,
          });
          if (!data) {
            return {
              content: [
                {
                  type: "text",
                  text: "No key data provided.",
                },
              ],
              details: { status: "failed" },
            };
          }
          await writeToStdin(resolved.stdin, data);
          return runningSessionResult(
            resolved.session,
            `Sent ${data.length} bytes to session ${params.sessionId}.` +
              (warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""),
          );
        }

        // ===== submit：发送回车（CR），提交当前输入行 =====
        case "submit": {
          const resolved = resolveBackgroundedWritableStdin();
          if (!resolved.ok) {
            return resolved.result;
          }
          // 写入 \r 即回车符，等同于按下 Enter
          await writeToStdin(resolved.stdin, "\r");
          return runningSessionResult(
            resolved.session,
            `Submitted session ${params.sessionId} (sent CR).`,
          );
        }

        // ===== paste：粘贴文本，支持 bracketed paste 模式 =====
        case "paste": {
          const resolved = resolveBackgroundedWritableStdin();
          if (!resolved.ok) {
            return resolved.result;
          }
          // 编码粘贴内容，bracketed 默认为 true（终端 bracketed paste 协议）
          const payload = encodePaste(params.text ?? "", params.bracketed !== false);
          if (!payload) {
            return {
              content: [
                {
                  type: "text",
                  text: "No paste text provided.",
                },
              ],
              details: { status: "failed" },
            };
          }
          await writeToStdin(resolved.stdin, payload);
          return runningSessionResult(
            resolved.session,
            `Pasted ${params.text?.length ?? 0} chars to session ${params.sessionId}.`,
          );
        }

        // ===== kill：终止后台会话 =====
        case "kill": {
          if (!scopedSession) {
            return failText(`No active session found for ${params.sessionId}`);
          }
          if (!scopedSession.backgrounded) {
            return failText(`Session ${params.sessionId} is not backgrounded.`);
          }
          // 优先通过 supervisor 取消托管会话
          const canceled = cancelManagedSession(scopedSession.id);
          if (!canceled) {
            // supervisor 无法处理时，使用备用方案强制终止进程树
            const terminated = terminateSessionFallback(scopedSession);
            if (!terminated) {
              return failText(
                `Unable to terminate session ${params.sessionId}: no active supervisor run or process id.`,
              );
            }
            markExited(scopedSession, null, "SIGKILL", "failed");
          }
          resetPollRetrySuggestion(params.sessionId);
          return {
            content: [
              {
                type: "text",
                text: canceled
                  ? `Termination requested for session ${params.sessionId}.`
                  : `Killed session ${params.sessionId}.`,
              },
            ],
            details: {
              status: "failed",
              name: scopedSession ? deriveSessionName(scopedSession.command) : undefined,
            },
          };
        }

        // ===== clear：清除已完成的会话记录 =====
        case "clear": {
          if (scopedFinished) {
            resetPollRetrySuggestion(params.sessionId);
            deleteSession(params.sessionId);
            return {
              content: [{ type: "text", text: `Cleared session ${params.sessionId}.` }],
              details: { status: "completed" },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `No finished session found for ${params.sessionId}`,
              },
            ],
            details: { status: "failed" },
          };
        }

        // ===== remove：强制移除会话（先尝试取消，失败则强杀进程树并删除） =====
        case "remove": {
          // 处理运行中的会话：先取消，取消失败则 kill 进程树，最后从注册表中删除
          if (scopedSession) {
            const canceled = cancelManagedSession(scopedSession.id);
            if (canceled) {
              // Keep remove semantics deterministic: drop from process registry now.
              scopedSession.backgrounded = false;
              deleteSession(params.sessionId);
            } else {
              const terminated = terminateSessionFallback(scopedSession);
              if (!terminated) {
                return failText(
                  `Unable to remove session ${params.sessionId}: no active supervisor run or process id.`,
                );
              }
              markExited(scopedSession, null, "SIGKILL", "failed");
              deleteSession(params.sessionId);
            }
            resetPollRetrySuggestion(params.sessionId);
            return {
              content: [
                {
                  type: "text",
                  text: canceled
                    ? `Removed session ${params.sessionId} (termination requested).`
                    : `Removed session ${params.sessionId}.`,
                },
              ],
              details: {
                status: "failed",
                name: scopedSession ? deriveSessionName(scopedSession.command) : undefined,
              },
            };
          }
          // 处理已完成的会话：直接从注册表中删除
          if (scopedFinished) {
            resetPollRetrySuggestion(params.sessionId);
            deleteSession(params.sessionId);
            return {
              content: [{ type: "text", text: `Removed session ${params.sessionId}.` }],
              details: { status: "completed" },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `No session found for ${params.sessionId}`,
              },
            ],
            details: { status: "failed" },
          };
        }
      }

      // 未知 action 的回退处理
      return {
        content: [{ type: "text", text: `Unknown action ${params.action as string}` }],
        details: { status: "failed" },
      };
    },
  };
}

/** 默认导出的 process 工具实例（使用默认配置） */
export const processTool = createProcessTool();
