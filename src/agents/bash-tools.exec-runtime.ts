import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { type ExecHost } from "../infra/exec-approvals.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { isDangerousHostEnvVarName } from "../infra/host-env-security.js";
import { findPathKey, mergePathPrepend } from "../infra/path-prepend.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { scopedHeartbeatWakeOptions } from "../routing/session-key.js";
import type { ProcessSession } from "./bash-process-registry.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
export { applyPathPrepend, findPathKey, normalizePathPrepend } from "../infra/path-prepend.js";
export {
  normalizeExecAsk,
  normalizeExecHost,
  normalizeExecSecurity,
} from "../infra/exec-approvals.js";
import { logWarn } from "../logger.js";
import type { ManagedRun } from "../process/supervisor/index.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  addSession,
  appendOutput,
  createSessionSlug,
  markExited,
  tail,
} from "./bash-process-registry.js";
import {
  buildDockerExecArgs,
  chunkString,
  clampWithDefault,
  readEnvInt,
} from "./bash-tools.shared.js";
import { buildCursorPositionResponse, stripDsrRequests } from "./pty-dsr.js";
import { getShellConfig, sanitizeBinaryOutput } from "./shell-utils.js";

// ============================================================
// 环境变量清理与安全验证
// ============================================================

// 在继承宿主环境变量之前进行清理，防止危险变量传播到非沙箱执行环境
// Sanitize inherited host env before merge so dangerous variables from process.env
// are not propagated into non-sandboxed executions.
export function sanitizeHostBaseEnv(env: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const upperKey = key.toUpperCase();
    // PATH 变量特殊处理，直接保留
    if (upperKey === "PATH") {
      sanitized[key] = value;
      continue;
    }
    // 危险变量（如可能导致权限提升的变量）跳过
    if (isDangerousHostEnvVarName(upperKey)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

// 集中化的环境变量验证辅助函数
// 在宿主环境执行时检测危险变量或 PATH 修改
// Centralized sanitization helper.
// Throws an error if dangerous variables or PATH modifications are detected on the host.
export function validateHostEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase();

    // 1. 阻止已知的危险变量（fail closed 策略）
    // Block known dangerous variables (Fail Closed)
    if (isDangerousHostEnvVarName(upperKey)) {
      throw new Error(
        `Security Violation: Environment variable '${key}' is forbidden during host execution.`,
      );
    }

    // 2. 严格阻止 PATH 修改
    // 允许自定义 PATH 可能导致二进制文件劫持攻击
    // Allowing custom PATH on the gateway/node can lead to binary hijacking.
    if (upperKey === "PATH") {
      throw new Error(
        "Security Violation: Custom 'PATH' variable is forbidden during host execution.",
      );
    }
  }
}

// ============================================================
// 常量定义：输出限制、审批超时等
// ============================================================

// 命令最大输出字符数（默认 20 万），可通过环境变量 PI_BASH_MAX_OUTPUT_CHARS 覆盖
export const DEFAULT_MAX_OUTPUT = clampWithDefault(
  readEnvInt("PI_BASH_MAX_OUTPUT_CHARS"),
  200_000,
  1_000,
  200_000,
);

// 后台进程最大输出字符数（默认 3 万），可通过环境变量 OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS 覆盖
export const DEFAULT_PENDING_MAX_OUTPUT = clampWithDefault(
  readEnvInt("OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS"),
  30_000,
  1_000,
  200_000,
);

// 默认 PATH 环境变量值
export const DEFAULT_PATH =
  process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// 通知时显示的尾部输出字符数（默认 400）
export const DEFAULT_NOTIFY_TAIL_CHARS = 400;

// 通知摘要的最大字符数（默认 180）
const DEFAULT_NOTIFY_SNIPPET_CHARS = 180;

// 审批超时时间（默认 120 秒）
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

// 审批请求超时时间（默认 130 秒）
export const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = 130_000;

// 运行中审批通知间隔（默认 10 秒）
const DEFAULT_APPROVAL_RUNNING_NOTICE_MS = 10_000;

// 审批 slug 长度（取 id 前 8 位）
const APPROVAL_SLUG_LENGTH = 8;

// ============================================================
// exec 工具参数 Schema 定义
// ============================================================

// exec 工具的参数 schema，定义所有可接受的参数及其类型和描述
export const execSchema = Type.Object({
  // 要执行的 Shell 命令（必填）
  command: Type.String({ description: "Shell command to execute" }),
  // 工作目录（可选，默认为当前目录）
  workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
  // 环境变量映射（可选）
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  // 后台化前的等待毫秒数（可选，默认 10000）
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait before backgrounding (default 10000)",
    }),
  ),
  // 是否立即后台运行（可选）
  background: Type.Optional(Type.Boolean({ description: "Run in background immediately" })),
  // 超时秒数（可选，超时后终止进程）
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, kills process on expiry)",
    }),
  ),
  // 是否使用 PTY 模式（可选，用于需要 TTY 的命令，如终端 UI、编码代理）
  pty: Type.Optional(
    Type.Boolean({
      description:
        "Run in a pseudo-terminal (PTY) when available (TTY-required CLIs, coding agents)",
    }),
  ),
  // 是否提权执行（可选，在主机上以提升权限运行）
  elevated: Type.Optional(
    Type.Boolean({
      description: "Run on the host with elevated permissions (if allowed)",
    }),
  ),
  // 执行主机（可选：sandbox|gateway|node）
  host: Type.Optional(
    Type.String({
      description: "Exec host (sandbox|gateway|node).",
    }),
  ),
  // 安全模式（可选：deny|allowlist|full）
  security: Type.Optional(
    Type.String({
      description: "Exec security mode (deny|allowlist|full).",
    }),
  ),
  // 审批模式（可选：off|on-miss|always）
  ask: Type.Optional(
    Type.String({
      description: "Exec ask mode (off|on-miss|always).",
    }),
  ),
  // 节点 ID/名称（用于 host=node）
  node: Type.Optional(
    Type.String({
      description: "Node id/name for host=node.",
    }),
  ),
});

// ============================================================
// 类型定义：执行结果和进程句柄
// ============================================================

// 命令执行结果类型
export type ExecProcessOutcome = {
  // 执行状态：completed（成功）或 failed（失败）
  status: "completed" | "failed";
  // 退出码
  exitCode: number | null;
  // 终止信号
  exitSignal: NodeJS.Signals | number | null;
  // 执行耗时（毫秒）
  durationMs: number;
  // 聚合输出（stdout + stderr）
  aggregated: string;
  // 是否超时
  timedOut: boolean;
  // 失败原因描述
  reason?: string;
};

// 进程句柄类型，用于管理运行中的进程
export type ExecProcessHandle = {
  // 进程会话信息
  session: ProcessSession;
  // 开始时间戳
  startedAt: number;
  // 进程 ID
  pid?: number;
  // 执行结果 Promise
  promise: Promise<ExecProcessOutcome>;
  // 终止进程的函数
  kill: () => void;
};

// ============================================================
// 工具函数
// ============================================================

// 将 ExecHost 转换为可读标签
export function renderExecHostLabel(host: ExecHost) {
  return host === "sandbox" ? "sandbox" : host === "gateway" ? "gateway" : "node";
}

// 标准化通知输出：合并空白字符为首尾空格
export function normalizeNotifyOutput(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

// 压缩通知输出到指定最大字符数
function compactNotifyOutput(value: string, maxChars = DEFAULT_NOTIFY_SNIPPET_CHARS) {
  const normalized = normalizeNotifyOutput(value);
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const safe = Math.max(1, maxChars - 1);
  return `${normalized.slice(0, safe)}…`;
}

// 应用 Shell PATH 前置配置
export function applyShellPath(env: Record<string, string>, shellPath?: string | null) {
  if (!shellPath) {
    return;
  }
  // 按路径分隔符分割
  const entries = shellPath
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return;
  }
  const pathKey = findPathKey(env);
  const merged = mergePathPrepend(env[pathKey], entries);
  if (merged) {
    env[pathKey] = merged;
  }
}

// 后台进程退出时发送通知
// 仅在以下条件满足时发送：
// - 进程处于后台模式
// - 启用了退出通知
// - 尚未发送过通知
function maybeNotifyOnExit(session: ProcessSession, status: "completed" | "failed") {
  if (!session.backgrounded || !session.notifyOnExit || session.exitNotified) {
    return;
  }
  const sessionKey = session.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  session.exitNotified = true;
  // 构建退出标签
  const exitLabel = session.exitSignal
    ? `signal ${session.exitSignal}`
    : `code ${session.exitCode ?? 0}`;
  // 获取尾部输出
  const output = compactNotifyOutput(
    tail(session.tail || session.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
  );
  // 如果是成功且无输出且未配置空输出成功通知，则跳过
  if (status === "completed" && !output && session.notifyOnExitEmptySuccess !== true) {
    return;
  }
  // 构建通知摘要
  const summary = output
    ? `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}`
    : `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel})`;
  // 发送系统事件
  enqueueSystemEvent(summary, { sessionKey });
  // 触发心跳以确保通知被发送
  requestHeartbeatNow(
    scopedHeartbeatWakeOptions(sessionKey, { reason: `exec:${session.id}:exit` }),
  );
}

// 创建审批 slug（取 id 前 8 位）
export function createApprovalSlug(id: string) {
  return id.slice(0, APPROVAL_SLUG_LENGTH);
}

// 构建审批待处理消息
export function buildApprovalPendingMessage(params: {
  warningText?: string;
  approvalSlug: string;
  approvalId: string;
  command: string;
  cwd: string;
  host: "gateway" | "node";
  nodeId?: string;
}) {
  // 动态选择代码块标记，避免与命令内容冲突
  let fence = "```";
  while (params.command.includes(fence)) {
    fence += "`";
  }
  const commandBlock = `${fence}sh\n${params.command}\n${fence}`;
  const lines: string[] = [];
  // 添加警告文本（如果有）
  const warningText = params.warningText?.trim();
  if (warningText) {
    lines.push(warningText, "");
  }
  // 审批信息头
  lines.push(`Approval required (id ${params.approvalSlug}, full ${params.approvalId}).`);
  lines.push(`Host: ${params.host}`);
  if (params.nodeId) {
    lines.push(`Node: ${params.nodeId}`);
  }
  lines.push(`CWD: ${params.cwd}`);
  lines.push("Command:");
  lines.push(commandBlock);
  lines.push("Mode: foreground (interactive approvals available).");
  lines.push("Background mode requires pre-approved policy (allow-always or ask=off).");
  lines.push(`Reply with: /approve ${params.approvalSlug} allow-once|allow-always|deny`);
  lines.push("If the short code is ambiguous, use the full id in /approve.");
  return lines.join("\n");
}

// 解析审批运行通知间隔
export function resolveApprovalRunningNoticeMs(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APPROVAL_RUNNING_NOTICE_MS;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

// 发送执行系统事件
export function emitExecSystemEvent(
  text: string,
  opts: { sessionKey?: string; contextKey?: string },
) {
  const sessionKey = opts.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  enqueueSystemEvent(text, { sessionKey, contextKey: opts.contextKey });
  requestHeartbeatNow(scopedHeartbeatWakeOptions(sessionKey, { reason: "exec-event" }));
}

// ============================================================
// 核心执行函数：runExecProcess
// ============================================================

// 在指定环境下执行 Shell 命令的核心函数
// 该函数处理沙箱/主机/节点三种执行模式
export async function runExecProcess(opts: {
  // 要执行的命令（必填）
  command: string;
  // 实际执行的命令（可选，用于 safeBins 执行时的sanitization，同时保留原始命令用于显示/日志）
  // Execute this instead of `command` (which is kept for display/session/logging).
  // Used to sanitize safeBins execution while preserving the original user input.
  execCommand?: string;
  // 工作目录
  workdir: string;
  // 环境变量
  env: Record<string, string>;
  // 沙箱配置（如果有）
  sandbox?: BashSandboxConfig;
  // 容器内工作目录
  containerWorkdir?: string | null;
  // 是否使用 PTY 模式
  usePty: boolean;
  // 警告信息数组
  warnings: string[];
  // 最大输出字符数
  maxOutput: number;
  // 待处理最大输出字符数
  pendingMaxOutput: number;
  // 退出时是否通知
  notifyOnExit: boolean;
  // 空输出成功时是否通知
  notifyOnExitEmptySuccess?: boolean;
  // 进程隔离范围键
  scopeKey?: string;
  // 会话键
  sessionKey?: string;
  // 超时秒数
  timeoutSec: number | null;
  // 更新回调
  onUpdate?: (partialResult: AgentToolResult<ExecToolDetails>) => void;
}): Promise<ExecProcessHandle> {
  const startedAt = Date.now();
  // 创建会话 slug（唯一标识符）
  const sessionId = createSessionSlug();
  // 实际执行的命令（如果未指定则使用原始命令）
  const execCommand = opts.execCommand ?? opts.command;
  // 获取进程监督器
  const supervisor = getProcessSupervisor();
  // Shell 运行时环境变量，添加 OPENCLAW_SHELL 标记
  const shellRuntimeEnv: Record<string, string> = {
    ...opts.env,
    OPENCLAW_SHELL: "exec",
  };

  // 初始化进程会话对象
  const session: ProcessSession = {
    id: sessionId,
    command: opts.command,
    scopeKey: opts.scopeKey,
    sessionKey: opts.sessionKey,
    notifyOnExit: opts.notifyOnExit,
    notifyOnExitEmptySuccess: opts.notifyOnExitEmptySuccess === true,
    exitNotified: false,
    child: undefined,
    stdin: undefined,
    pid: undefined,
    startedAt,
    cwd: opts.workdir,
    maxOutputChars: opts.maxOutput,
    pendingMaxOutputChars: opts.pendingMaxOutput,
    totalOutputChars: 0,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    aggregated: "",
    tail: "",
    exited: false,
    exitCode: undefined as number | null | undefined,
    exitSignal: undefined as NodeJS.Signals | number | null | undefined,
    truncated: false,
    backgrounded: false,
  };
  // 将会话添加到注册表
  addSession(session);

  // 发出更新回调的辅助函数
  const emitUpdate = () => {
    if (!opts.onUpdate) {
      return;
    }
    const tailText = session.tail || session.aggregated;
    const warningText = opts.warnings.length ? `${opts.warnings.join("\n")}\n\n` : "";
    opts.onUpdate({
      content: [{ type: "text", text: warningText + (tailText || "") }],
      details: {
        status: "running",
        sessionId,
        pid: session.pid ?? undefined,
        startedAt,
        cwd: session.cwd,
        tail: session.tail,
      },
    });
  };

  // 处理标准输出
  const handleStdout = (data: string) => {
    const str = sanitizeBinaryOutput(data.toString());
    for (const chunk of chunkString(str)) {
      appendOutput(session, "stdout", chunk);
      emitUpdate();
    }
  };

  // 处理标准错误输出
  const handleStderr = (data: string) => {
    const str = sanitizeBinaryOutput(data.toString());
    for (const chunk of chunkString(str)) {
      appendOutput(session, "stderr", chunk);
      emitUpdate();
    }
  };

  // 将秒转换为毫秒超时
  const timeoutMs =
    typeof opts.timeoutSec === "number" && opts.timeoutSec > 0
      ? Math.floor(opts.timeoutSec * 1000)
      : undefined;

  // 根据配置构建 spawn 规格
  // 两种模式：child（子进程）或 pty（伪终端）
  const spawnSpec:
    | {
        mode: "child";
        argv: string[];
        env: NodeJS.ProcessEnv;
        stdinMode: "pipe-open" | "pipe-closed";
      }
    | {
        mode: "pty";
        ptyCommand: string;
        childFallbackArgv: string[];
        env: NodeJS.ProcessEnv;
        stdinMode: "pipe-open";
      } = (() => {
    // 沙箱模式：使用 Docker exec
    if (opts.sandbox) {
      return {
        mode: "child" as const,
        argv: [
          "docker",
          ...buildDockerExecArgs({
            containerName: opts.sandbox.containerName,
            command: execCommand,
            workdir: opts.containerWorkdir ?? opts.sandbox.containerWorkdir,
            env: shellRuntimeEnv,
            tty: opts.usePty,
          }),
        ],
        env: process.env,
        stdinMode: opts.usePty ? ("pipe-open" as const) : ("pipe-closed" as const),
      };
    }
    // 非沙箱模式：直接本地执行
    const { shell, args: shellArgs } = getShellConfig();
    const childArgv = [shell, ...shellArgs, execCommand];
    // PTY 模式：用于需要终端的功能（如 vim、top、编码代理）
    if (opts.usePty) {
      return {
        mode: "pty" as const,
        ptyCommand: execCommand,
        childFallbackArgv: childArgv,
        env: shellRuntimeEnv,
        stdinMode: "pipe-open" as const,
      };
    }
    // 普通子进程模式
    return {
      mode: "child" as const,
      argv: childArgv,
      env: shellRuntimeEnv,
      stdinMode: "pipe-closed" as const,
    };
  })();

  let managedRun: ManagedRun | null = null;
  let usingPty = spawnSpec.mode === "pty";
  // 光标位置响应（用于 PTY DSR 请求）
  const cursorResponse = buildCursorPositionResponse();

  // 处理监督器输出的标准输出
  const onSupervisorStdout = (chunk: string) => {
    if (usingPty) {
      // 剥离 DSR（设备状态请求）并处理光标响应
      const { cleaned, requests } = stripDsrRequests(chunk);
      if (requests > 0 && managedRun?.stdin) {
        for (let i = 0; i < requests; i += 1) {
          managedRun.stdin.write(cursorResponse);
        }
      }
      handleStdout(cleaned);
      return;
    }
    handleStdout(chunk);
  };

  // 尝试启动进程
  try {
    const spawnBase = {
      runId: sessionId,
      sessionId: opts.sessionKey?.trim() || sessionId,
      backendId: opts.sandbox ? "exec-sandbox" : "exec-host",
      scopeKey: opts.scopeKey,
      cwd: opts.workdir,
      env: spawnSpec.env,
      timeoutMs,
      captureOutput: false,
      onStdout: onSupervisorStdout,
      onStderr: handleStderr,
    };
    // 根据模式选择 spawn 方式
    managedRun =
      spawnSpec.mode === "pty"
        ? await supervisor.spawn({
            ...spawnBase,
            mode: "pty",
            ptyCommand: spawnSpec.ptyCommand,
          })
        : await supervisor.spawn({
            ...spawnBase,
            mode: "child",
            argv: spawnSpec.argv,
            stdinMode: spawnSpec.stdinMode,
          });
  } catch (err) {
    // PTY 模式失败时，尝试回退到普通子进程模式
    if (spawnSpec.mode === "pty") {
      const warning = `Warning: PTY spawn failed (${String(err)}); retrying without PTY for \`${opts.command}\`.`;
      logWarn(
        `exec: PTY spawn failed (${String(err)}); retrying without PTY for "${opts.command}".`,
      );
      opts.warnings.push(warning);
      usingPty = false;
      try {
        managedRun = await supervisor.spawn({
          runId: sessionId,
          sessionId: opts.sessionKey?.trim() || sessionId,
          backendId: "exec-host",
          scopeKey: opts.scopeKey,
          mode: "child",
          argv: spawnSpec.childFallbackArgv,
          cwd: opts.workdir,
          env: spawnSpec.env,
          stdinMode: "pipe-open",
          timeoutMs,
          captureOutput: false,
          onStdout: handleStdout,
          onStderr: handleStderr,
        });
      } catch (retryErr) {
        markExited(session, null, null, "failed");
        maybeNotifyOnExit(session, "failed");
        throw retryErr;
      }
    } else {
      markExited(session, null, null, "failed");
      maybeNotifyOnExit(session, "failed");
      throw err;
    }
  }
  // 保存 stdin 和 pid 到会话
  session.stdin = managedRun.stdin;
  session.pid = managedRun.pid;

  // 等待进程完成的 Promise
  const promise = managedRun
    .wait()
    .then((exit): ExecProcessOutcome => {
      const durationMs = Date.now() - startedAt;
      const isNormalExit = exit.reason === "exit";
      const exitCode = exit.exitCode ?? 0;
      // Shell 退出码 126（不可执行）和 127（命令未找到）是基础设施故障
      // 应该作为真实错误暴露而不是静默完成
      // 例如：`python: command not found`
      // Shell exit codes 126 (not executable) and 127 (command not found) are
      // unrecoverable infrastructure failures that should surface as real errors
      // rather than silently completing — e.g. `python: command not found`.
      const isShellFailure = exitCode === 126 || exitCode === 127;
      const status: "completed" | "failed" =
        isNormalExit && !isShellFailure ? "completed" : "failed";

      markExited(session, exit.exitCode, exit.exitSignal, status);
      maybeNotifyOnExit(session, status);
      if (!session.child && session.stdin) {
        session.stdin.destroyed = true;
      }
      const aggregated = session.aggregated.trim();
      // 成功完成时
      if (status === "completed") {
        const exitMsg = exitCode !== 0 ? `\n\n(Command exited with code ${exitCode})` : "";
        return {
          status: "completed",
          exitCode,
          exitSignal: exit.exitSignal,
          durationMs,
          aggregated: aggregated + exitMsg,
          timedOut: false,
        };
      }
      // 失败时构建原因描述
      const reason = isShellFailure
        ? exitCode === 127
          ? "Command not found"
          : "Command not executable (permission denied)"
        : exit.reason === "overall-timeout"
          ? typeof opts.timeoutSec === "number" && opts.timeoutSec > 0
            ? `Command timed out after ${opts.timeoutSec} seconds. If this command is expected to take longer, re-run with a higher timeout (e.g., exec timeout=300).`
            : "Command timed out. If this command is expected to take longer, re-run with a higher timeout (e.g., exec timeout=300)."
          : exit.reason === "no-output-timeout"
            ? "Command timed out waiting for output"
            : exit.exitSignal != null
              ? `Command aborted by signal ${exit.exitSignal}`
              : "Command aborted before exit code was captured";
      return {
        status: "failed",
        exitCode: exit.exitCode,
        exitSignal: exit.exitSignal,
        durationMs,
        aggregated,
        timedOut: exit.timedOut,
        reason: aggregated ? `${aggregated}\n\n${reason}` : reason,
      };
    })
    // 捕获异常的处理
    .catch((err): ExecProcessOutcome => {
      markExited(session, null, null, "failed");
      maybeNotifyOnExit(session, "failed");
      const aggregated = session.aggregated.trim();
      const message = aggregated ? `${aggregated}\n\n${String(err)}` : String(err);
      return {
        status: "failed",
        exitCode: null,
        exitSignal: null,
        durationMs: Date.now() - startedAt,
        aggregated,
        timedOut: false,
        reason: message,
      };
    });

  // 返回进程句柄
  return {
    session,
    startedAt,
    pid: session.pid ?? undefined,
    promise,
    kill: () => {
      managedRun?.cancel("manual-cancel");
    },
  };
}
