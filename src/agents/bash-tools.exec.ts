import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type ExecHost, loadExecApprovals, maxAsk, minSecurity } from "../infra/exec-approvals.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import {
  getShellPathFromLoginShell,
  resolveShellEnvFallbackTimeoutMs,
} from "../infra/shell-env.js";
import { logInfo } from "../logger.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { markBackgrounded } from "./bash-process-registry.js";
import { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import {
  DEFAULT_MAX_OUTPUT,
  DEFAULT_PATH,
  DEFAULT_PENDING_MAX_OUTPUT,
  applyPathPrepend,
  applyShellPath,
  normalizeExecAsk,
  normalizeExecHost,
  normalizeExecSecurity,
  normalizePathPrepend,
  renderExecHostLabel,
  resolveApprovalRunningNoticeMs,
  runExecProcess,
  sanitizeHostBaseEnv,
  execSchema,
  validateHostEnv,
} from "./bash-tools.exec-runtime.js";
import type {
  ExecElevatedDefaults,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";
import {
  buildSandboxEnv,
  clampWithDefault,
  coerceEnv,
  readEnvInt,
  resolveSandboxWorkdir,
  resolveWorkdir,
  truncateMiddle,
} from "./bash-tools.shared.js";
import { assertSandboxPath } from "./sandbox-paths.js";

export type { BashSandboxConfig } from "./bash-tools.shared.js";
export type {
  ExecElevatedDefaults,
  ExecToolDefaults,
  ExecToolDetails,
} from "./bash-tools.exec-types.js";

/**
 * 从命令字符串中提取脚本目标信息
 * 支持解析 python/python3 和 node 命令，识别要执行的脚本文件路径
 *
 * @param command - 原始命令字符串
 * @returns 解析结果，包含脚本类型(python/node)和脚本路径；无法解析时返回null
 *
 * @example
 * extractScriptTargetFromCommand("python script.py") // => { kind: "python", relOrAbsPath: "script.py" }
 * extractScriptTargetFromCommand("node app.js") // => { kind: "node", relOrAbsPath: "app.js" }
 * extractScriptTargetFromCommand("ls -la") // => null
 */
function extractScriptTargetFromCommand(
  command: string,
): { kind: "python"; relOrAbsPath: string } | { kind: "node"; relOrAbsPath: string } | null {
  const raw = command.trim();
  if (!raw) {
    return null;
  }

  // Intentionally simple parsing: we only support common forms like
  //   python file.py
  //   python3 -u file.py
  //   node --experimental-something file.js
  // If the command is more complex (pipes, heredocs, quoted paths with spaces), skip preflight.
  // 简单解析：仅支持常见形式如 "python file.py"、"node app.js"
  // 复杂命令（管道、here文档、带空格的路径）跳过预检
  const pythonMatch = raw.match(/^\s*(python3?|python)\s+(?:-[^\s]+\s+)*([^\s]+\.py)\b/i);
  if (pythonMatch?.[2]) {
    return { kind: "python", relOrAbsPath: pythonMatch[2] };
  }
  const nodeMatch = raw.match(/^\s*(node)\s+(?:-[^\s]+\s+)*([^\s]+\.js)\b/i);
  if (nodeMatch?.[2]) {
    return { kind: "node", relOrAbsPath: nodeMatch[2] };
  }

  return null;
}

/**
 * 预检脚本文件，检测常见的 shell 变量泄漏问题
 * 当模型生成的命令包含 shell 环境变量语法（如 $VAR）但写在 Python/JS 脚本中时，
 * 会在执行前捕获这类错误，避免在 cron 循环中浪费 tokens
 *
 * @param params.command - 要执行的命令
 * @param params.workdir - 工作目录
 *
 * @throws 检测到 shell 变量泄漏到脚本文件时抛出错误
 *
 * @example
 * // 如果脚本开头包含 $USER 等 shell 变量，会抛出错误
 * await validateScriptFileForShellBleed({ command: "python app.py", workdir: "/app" });
 */
async function validateScriptFileForShellBleed(params: {
  command: string;
  workdir: string;
}): Promise<void> {
  // 从命令中提取脚本目标（仅支持 python/python3 和 node）
  const target = extractScriptTargetFromCommand(params.command);
  if (!target) {
    return;
  }

  // 将相对路径解析为绝对路径
  const absPath = path.isAbsolute(target.relOrAbsPath)
    ? path.resolve(target.relOrAbsPath)
    : path.resolve(params.workdir, target.relOrAbsPath);

  // Best-effort: only validate if file exists and is reasonably small.
  // 仅在文件存在且大小合理（<512KB）时进行验证，避免读取大文件
  let stat: { isFile(): boolean; size: number };
  try {
    await assertSandboxPath({
      filePath: absPath,
      cwd: params.workdir,
      root: params.workdir,
    });
    stat = await fs.stat(absPath);
  } catch {
    return;
  }
  if (!stat.isFile()) {
    return;
  }
  if (stat.size > 512 * 1024) {
    return;
  }

  // 读取脚本内容进行检测
  const content = await fs.readFile(absPath, "utf-8");

  // Common failure mode: shell env var syntax leaking into Python/JS.
  // We deliberately match all-caps/underscore vars to avoid false positives with `$` as a JS identifier.
  // 常见错误模式：shell 环境变量语法泄漏到 Python/JS 脚本中
  // 匹配大写/下划线格式的变量（如 $USER, $PATH），避免误匹配 JS 标识符中的 $
  const envVarRegex = /\$[A-Z_][A-Z0-9_]{1,}/g;
  const first = envVarRegex.exec(content);
  if (first) {
    const idx = first.index;
    const before = content.slice(0, idx);
    const line = before.split("\n").length;
    const token = first[0];
    throw new Error(
      [
        `exec preflight: detected likely shell variable injection (${token}) in ${target.kind} script: ${path.basename(
          absPath,
        )}:${line}.`,
        target.kind === "python"
          ? `In Python, use os.environ.get(${JSON.stringify(token.slice(1))}) instead of raw ${token}.`
          : `In Node.js, use process.env[${JSON.stringify(token.slice(1))}] instead of raw ${token}.`,
        "(If this is inside a string literal on purpose, escape it or restructure the code.)",
      ].join("\n"),
    );
  }

  // Another recurring pattern from the issue: shell commands accidentally emitted as JS.
  // 另一个常见问题：shell 命令被错误地写成 JavaScript
  if (target.kind === "node") {
    const firstNonEmpty = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (firstNonEmpty && /^NODE\b/.test(firstNonEmpty)) {
      throw new Error(
        `exec preflight: JS file starts with shell syntax (${firstNonEmpty}). ` +
          `This looks like a shell command, not JavaScript.`,
      );
    }
  }
}

/**
 * 创建 exec 工具的工厂函数
 * exec 工具是 OpenClaw Agent 执行 shell 命令的核心工具，支持：
 * - 在沙箱、网关主机或远程节点执行命令
 * - 提权执行（elevated）
 * - 安全策略和审批流程
 * - 后台执行和超时控制
 * - PTY 模式（用于需要终端的交互式命令）
 *
 * @param defaults - 可选的默认执行配置，会被命令参数覆盖
 * @returns AgentTool 实例，可被 Agent 调用
 *
 * @example
 * const tool = createExecTool({ host: "sandbox", security: "deny" });
 * await tool.execute(toolCallId, { command: "ls -la", timeout: 30 });
 */
export function createExecTool(
  defaults?: ExecToolDefaults,
  // oxlint-disable-next-line typescript/no-explicit-any
): AgentTool<any, ExecToolDetails> {
  // ==================== 初始化默认配置 ====================
  // 默认后台执行等待时间（毫秒），可通过 yieldMs 参数覆盖
  const defaultBackgroundMs = clampWithDefault(
    defaults?.backgroundMs ?? readEnvInt("PI_BASH_YIELD_MS"),
    10_000,
    10,
    120_000,
  );
  // 是否允许后台执行，默认允许
  const allowBackground = defaults?.allowBackground ?? true;
  // 默认命令超时时间（秒），0 表示不超时
  const defaultTimeoutSec =
    typeof defaults?.timeoutSec === "number" && defaults.timeoutSec > 0
      ? defaults.timeoutSec
      : 1800;
  // PATH 前置路径，用于在执行命令时优先使用特定路径下的程序
  const defaultPathPrepend = normalizePathPrepend(defaults?.pathPrepend);

  // ==================== 解析安全二进制配置 ====================
  // safeBins 是经过审批的二进制文件列表，在沙箱中可以执行而不触发审批流程
  // safeBinProfiles 提供硬化的运行时配置，对特殊二进制进行更细粒度的控制
  const {
    safeBins,
    safeBinProfiles,
    trustedSafeBinDirs,
    unprofiledSafeBins,
    unprofiledInterpreterSafeBins,
  } = resolveExecSafeBinRuntimePolicy({
    local: {
      safeBins: defaults?.safeBins,
      safeBinTrustedDirs: defaults?.safeBinTrustedDirs,
      safeBinProfiles: defaults?.safeBinProfiles,
    },
    onWarning: (message) => {
      logInfo(message);
    },
  });

  // 记录未配置的 safeBins 条目，这些会被忽略
  if (unprofiledSafeBins.length > 0) {
    logInfo(
      `exec: ignoring unprofiled safeBins entries (${unprofiledSafeBins.toSorted().join(", ")}); use allowlist or define tools.exec.safeBinProfiles.<bin>`,
    );
  }

  // 解释器/运行时二进制（如 python, node）在 safeBins 中是不安全的，除非有明确的 hardened profiles
  if (unprofiledInterpreterSafeBins.length > 0) {
    logInfo(
      `exec: interpreter/runtime binaries in safeBins (${unprofiledInterpreterSafeBins.join(", ")}) are unsafe without explicit hardened profiles; prefer allowlist entries`,
    );
  }

  // ==================== 通知和会话配置 ====================
  // 命令退出时是否发送通知
  const notifyOnExit = defaults?.notifyOnExit !== false;
  // 命令成功且无输出时是否发送通知
  const notifyOnExitEmptySuccess = defaults?.notifyOnExitEmptySuccess === true;
  // 用于发送通知的会话键
  const notifySessionKey = defaults?.sessionKey?.trim() || undefined;
  // 审批请求的运行通知超时时间
  const approvalRunningNoticeMs = resolveApprovalRunningNoticeMs(defaults?.approvalRunningNoticeMs);

  // 从会话键派生 agentId（仅当会话键是 agent 会话键时才有效）
  const parsedAgentSession = parseAgentSessionKey(defaults?.sessionKey);
  const agentId =
    defaults?.agentId ??
    (parsedAgentSession ? resolveAgentIdFromSessionKey(defaults?.sessionKey) : undefined);

  // ==================== 定义 exec 工具 ====================
  return {
    name: "exec",
    label: "exec",
    description:
      "Execute shell commands with background continuation. Use yieldMs/background to continue later via process tool. Use pty=true for TTY-required commands (terminal UIs, coding agents).",
    parameters: execSchema,

    /**
     * 执行 shell 命令的核心逻辑
     *
     * @param _toolCallId - 工具调用 ID（用于追踪）
     * @param args - 执行参数
     * @param args.command - 要执行的命令（必需）
     * @param args.workdir - 工作目录（可选）
     * @param args.env - 环境变量（可选）
     * @param args.yieldMs - 等待毫秒数后进入后台（可选）
     * @param args.background - 是否立即后台执行（可选）
     * @param args.timeout - 超时秒数（可选）
     * @param args.pty - 是否使用 PTY 模式（可选，用于交互式命令）
     * @param args.elevated - 是否提权执行（可选）
     * @param args.host - 执行主机：sandbox/gateway/node（可选）
     * @param args.security - 安全模式：deny/allowlist/full（可选）
     * @param args.ask - 审批模式：off/on-miss/always（可选）
     * @param args.node - 远程节点 ID（可选，当 host=node 时）
     * @param signal - AbortSignal，用于取消执行
     * @param onUpdate - 进度回调函数
     */
    execute: async (_toolCallId, args, signal, onUpdate) => {
      const params = args as {
        command: string;
        workdir?: string;
        env?: Record<string, string>;
        yieldMs?: number;
        background?: boolean;
        timeout?: number;
        pty?: boolean;
        elevated?: boolean;
        host?: string;
        security?: string;
        ask?: string;
        node?: string;
      };

      // ==================== 参数验证 ====================
      if (!params.command) {
        throw new Error("Provide a command to start.");
      }

      const maxOutput = DEFAULT_MAX_OUTPUT;
      const pendingMaxOutput = DEFAULT_PENDING_MAX_OUTPUT;
      const warnings: string[] = [];
      let execCommandOverride: string | undefined;

      // ==================== 后台执行配置 ====================
      // 是否请求后台执行
      const backgroundRequested = params.background === true;
      const yieldRequested = typeof params.yieldMs === "number";

      // 如果后台执行被禁用，发出警告并同步执行
      if (!allowBackground && (backgroundRequested || yieldRequested)) {
        warnings.push("Warning: background execution is disabled; running synchronously.");
      }

      // 计算 yield 窗口期：0 表示立即后台执行，null 表示禁用后台执行
      const yieldWindow = allowBackground
        ? backgroundRequested
          ? 0
          : clampWithDefault(
              params.yieldMs ?? defaultBackgroundMs,
              defaultBackgroundMs,
              10,
              120_000,
            )
        : null;

      // ==================== 提权（elevated）配置 ====================
      // elevated 允许在主机上以提升的权限执行命令，绕过沙箱限制
      const elevatedDefaults = defaults?.elevated;
      const elevatedAllowed = Boolean(elevatedDefaults?.enabled && elevatedDefaults.allowed);

      // 提权默认模式：full（完全绕过审批）、ask（需要审批）、off（禁用）
      const elevatedDefaultMode =
        elevatedDefaults?.defaultLevel === "full"
          ? "full"
          : elevatedDefaults?.defaultLevel === "ask"
            ? "ask"
            : elevatedDefaults?.defaultLevel === "on"
              ? "ask"
              : "off";

      // 如果提权未启用，强制为 off
      const effectiveDefaultMode = elevatedAllowed ? elevatedDefaultMode : "off";

      // 解析用户请求的提权模式
      const elevatedMode =
        typeof params.elevated === "boolean"
          ? params.elevated
            ? elevatedDefaultMode === "full"
              ? "full"
              : "ask"
            : "off"
          : effectiveDefaultMode;

      const elevatedRequested = elevatedMode !== "off";

      // ==================== 提权可用性检查 ====================
      // 检查提权功能是否可用
      if (elevatedRequested) {
        if (!elevatedDefaults?.enabled || !elevatedDefaults.allowed) {
          const runtime = defaults?.sandbox ? "sandboxed" : "direct";
          const gates: string[] = [];
          const contextParts: string[] = [];
          const provider = defaults?.messageProvider?.trim();
          const sessionKey = defaults?.sessionKey?.trim();

          if (provider) {
            contextParts.push(`provider=${provider}`);
          }
          if (sessionKey) {
            contextParts.push(`session=${sessionKey}`);
          }

          if (!elevatedDefaults?.enabled) {
            gates.push("enabled (tools.elevated.enabled / agents.list[].tools.elevated.enabled)");
          } else {
            gates.push(
              "allowFrom (tools.elevated.allowFrom.<provider> / agents.list[].tools.elevated.allowFrom.<provider>)",
            );
          }

          throw new Error(
            [
              `elevated is not available right now (runtime=${runtime}).`,
              `Failing gates: ${gates.join(", ")}`,
              contextParts.length > 0 ? `Context: ${contextParts.join(" ")}` : undefined,
              "Fix-it keys:",
              "- tools.elevated.enabled",
              "- tools.elevated.allowFrom.<provider>",
              "- agents.list[].tools.elevated.enabled",
              "- agents.list[].tools.elevated.allowFrom.<provider>",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
      }

      // 记录提权命令的执行日志
      if (elevatedRequested) {
        logInfo(`exec: elevated command ${truncateMiddle(params.command, 120)}`);
      }

      // ==================== 执行主机（host）配置 ====================
      // host 指定命令在哪里执行：
      // - sandbox:  在 Docker 沙箱容器中执行（默认）
      // - gateway: 在网关主机上执行
      // - node: 在远程配对节点上执行
      const configuredHost = defaults?.host ?? "sandbox"; // 配置的默认 host
      const sandboxHostConfigured = defaults?.host === "sandbox"; // 是否显式配置了 sandbox
      const requestedHost = normalizeExecHost(params.host) ?? null; // 用户请求的 host
      let host: ExecHost = requestedHost ?? configuredHost; // 最终使用的 host

      // host 切换检查：非提权请求不能切换 host
      if (!elevatedRequested && requestedHost && requestedHost !== configuredHost) {
        throw new Error(
          `exec host not allowed (requested ${renderExecHostLabel(requestedHost)}; ` +
            `configure tools.exec.host=${renderExecHostLabel(configuredHost)} to allow).`,
        );
      }

      // 提权请求强制使用 gateway host（在主机上执行）
      if (elevatedRequested) {
        host = "gateway";
      }

      // ==================== 安全策略（security）配置 ====================
      // security 定义命令执行的审批策略：
      // - deny: 默认拒绝，需要在 allowlist 中明确批准
      // - allowlist: 使用白名单审批
      // - full: 完全信任，不进行审批检查
      const configuredSecurity = defaults?.security ?? (host === "sandbox" ? "deny" : "allowlist");
      const requestedSecurity = normalizeExecSecurity(params.security);
      let security = minSecurity(configuredSecurity, requestedSecurity ?? configuredSecurity);

      // elevated + full 模式完全绕过安全检查
      if (elevatedRequested && elevatedMode === "full") {
        security = "full";
      }

      // ==================== 审批询问（ask）配置 ====================
      // ask 定义何时需要用户审批：
      // - off: 从不询问
      // - on-miss: 命令不在白名单时询问（默认）
      // - always: 始终询问
      const configuredAsk = defaults?.ask ?? loadExecApprovals().defaults?.ask ?? "on-miss";
      const requestedAsk = normalizeExecAsk(params.ask);
      let ask = maxAsk(configuredAsk, requestedAsk ?? configuredAsk);

      // elevated + full 模式完全绕过审批
      const bypassApprovals = elevatedRequested && elevatedMode === "full";
      if (bypassApprovals) {
        ask = "off";
      }

      // ==================== 沙箱配置解析 ====================
      // 如果 host 是 sandbox，获取沙箱配置（包含容器名、工作目录等信息）
      const sandbox = host === "sandbox" ? defaults?.sandbox : undefined;

      // 检查沙箱可用性：如果配置了 sandbox host 但沙箱运行时不可用，抛出错误
      if (
        host === "sandbox" &&
        !sandbox &&
        (sandboxHostConfigured || requestedHost === "sandbox")
      ) {
        throw new Error(
          [
            "exec host=sandbox is configured, but sandbox runtime is unavailable for this session.",
            'Enable sandbox mode (`agents.defaults.sandbox.mode="non-main"` or `"all"`) or set tools.exec.host to "gateway"/"node".',
          ].join("\n"),
        );
      }

      // ==================== 工作目录解析 ====================
      // 解析命令执行的工作目录
      const rawWorkdir = params.workdir?.trim() || defaults?.cwd || process.cwd();
      let workdir = rawWorkdir;
      let containerWorkdir = sandbox?.containerWorkdir;

      if (sandbox) {
        // 沙箱环境：工作目录需要映射到容器内的路径
        const resolved = await resolveSandboxWorkdir({
          workdir: rawWorkdir,
          sandbox,
          warnings,
        });
        workdir = resolved.hostWorkdir;
        containerWorkdir = resolved.containerWorkdir;
      } else {
        // 非沙箱环境：直接使用原始工作目录
        workdir = resolveWorkdir(rawWorkdir, warnings);
      }

      // ==================== 环境变量处理 ====================
      // 沙箱环境获取原始环境变量，主机环境需要清理危险变量
      const inheritedBaseEnv = coerceEnv(process.env);
      const baseEnv = host === "sandbox" ? inheritedBaseEnv : sanitizeHostBaseEnv(inheritedBaseEnv);

      // Logic: Sandbox gets raw env. Host (gateway/node) must pass validation.
      // We validate BEFORE merging to prevent any dangerous vars from entering the stream.
      // 沙箱获取原始环境变量，主机环境必须在合并前验证并清理危险变量
      if (host !== "sandbox" && params.env) {
        validateHostEnv(params.env);
      }

      // 合并环境变量：基础环境 + 用户传递的环境变量
      const mergedEnv = params.env ? { ...baseEnv, ...params.env } : baseEnv;

      // 为沙箱构建特殊的环境变量（包含容器内的路径配置）
      const env = sandbox
        ? buildSandboxEnv({
            defaultPath: DEFAULT_PATH,
            paramsEnv: params.env,
            sandboxEnv: sandbox.env,
            containerWorkdir: containerWorkdir ?? sandbox.containerWorkdir,
          })
        : mergedEnv;

      // ==================== Shell 路径配置 ====================
      // Gateway 主机执行时，如果用户没有指定 PATH，使用登录 shell 的 PATH
      if (!sandbox && host === "gateway" && !params.env?.PATH) {
        const shellPath = getShellPathFromLoginShell({
          env: process.env,
          timeoutMs: resolveShellEnvFallbackTimeoutMs(process.env),
        });
        applyShellPath(env, shellPath);
      }

      // ==================== PATH 前置配置 ====================
      // tools.exec.pathPrepend 仅对本地执行（gateway 或沙箱）有意义
      // Node 主机忽略请求级别的 PATH 覆盖
      if (host === "node" && defaultPathPrepend.length > 0) {
        warnings.push(
          "Warning: tools.exec.pathPrepend is ignored for host=node. Configure PATH on the node host/service instead.",
        );
      } else {
        applyPathPrepend(env, defaultPathPrepend);
      }

      // ==================== 根据 host 分发执行 ====================
      // host=node: 在远程配对节点上执行命令
      if (host === "node") {
        return executeNodeHostCommand({
          command: params.command,
          workdir,
          env,
          requestedEnv: params.env,
          requestedNode: params.node?.trim(),
          boundNode: defaults?.node?.trim(),
          sessionKey: defaults?.sessionKey,
          turnSourceChannel: defaults?.messageProvider,
          turnSourceTo: defaults?.currentChannelId,
          turnSourceAccountId: defaults?.accountId,
          turnSourceThreadId: defaults?.currentThreadTs,
          agentId,
          security,
          ask,
          timeoutSec: params.timeout,
          defaultTimeoutSec,
          approvalRunningNoticeMs,
          warnings,
          notifySessionKey,
          trustedSafeBinDirs,
        });
      }

      // host=gateway + 需要审批: 在执行前进行网关级别的白名单审批
      if (host === "gateway" && !bypassApprovals) {
        const gatewayResult = await processGatewayAllowlist({
          command: params.command,
          workdir,
          env,
          pty: params.pty === true && !sandbox,
          timeoutSec: params.timeout,
          defaultTimeoutSec,
          security,
          ask,
          safeBins,
          safeBinProfiles,
          agentId,
          sessionKey: defaults?.sessionKey,
          turnSourceChannel: defaults?.messageProvider,
          turnSourceTo: defaults?.currentChannelId,
          turnSourceAccountId: defaults?.accountId,
          turnSourceThreadId: defaults?.currentThreadTs,
          scopeKey: defaults?.scopeKey,
          warnings,
          notifySessionKey,
          approvalRunningNoticeMs,
          maxOutput,
          pendingMaxOutput,
          trustedSafeBinDirs,
        });

        // 如果需要用户审批，返回待审批状态
        if (gatewayResult.pendingResult) {
          return gatewayResult.pendingResult;
        }

        // 审批通过，使用处理后的命令（可能经过重写）
        execCommandOverride = gatewayResult.execCommandOverride;
      }

      // ==================== 执行前预检 ====================
      // 预检：捕获常见的模型失败模式（shell 语法泄漏到 Python/JS 源文件）
      // 在执行前进行检测，避免在 cron 循环中浪费 tokens
      await validateScriptFileForShellBleed({ command: params.command, workdir });

      // 计算最终超时时间
      const explicitTimeoutSec = typeof params.timeout === "number" ? params.timeout : null;
      const backgroundTimeoutBypass =
        allowBackground && explicitTimeoutSec === null && (backgroundRequested || yieldRequested);
      const effectiveTimeout = backgroundTimeoutBypass
        ? null
        : (explicitTimeoutSec ?? defaultTimeoutSec);

      // 获取警告文本
      const getWarningText = () => (warnings.length ? `${warnings.join("\n")}\n\n` : "");

      // 是否使用 PTY 模式（仅在非沙箱的主机执行时有效）
      const usePty = params.pty === true && !sandbox;

      // Preflight: catch a common model failure mode (shell syntax leaking into Python/JS sources)
      // before we execute and burn tokens in cron loops.
      await validateScriptFileForShellBleed({ command: params.command, workdir });

      const run = await runExecProcess({
        command: params.command,
        execCommand: execCommandOverride,
        workdir,
        env,
        sandbox,
        containerWorkdir,
        usePty,
        warnings,
        maxOutput,
        pendingMaxOutput,
        notifyOnExit,
        notifyOnExitEmptySuccess,
        scopeKey: defaults?.scopeKey,
        sessionKey: notifySessionKey,
        timeoutSec: effectiveTimeout,
        onUpdate,
      });

      // ==================== 处理中止信号 ====================
      let yielded = false;
      let yieldTimer: NodeJS.Timeout | null = null;

      // Tool-call abort should not kill backgrounded sessions; timeouts still must.
      const onAbortSignal = () => {
        if (yielded || run.session.backgrounded) {
          return;
        }
        run.kill();
      };

      if (signal?.aborted) {
        onAbortSignal();
      } else if (signal) {
        signal.addEventListener("abort", onAbortSignal, { once: true });
      }

      // ==================== 返回执行结果 ====================
      return new Promise<AgentToolResult<ExecToolDetails>>((resolve, reject) => {
        // 返回"命令仍在运行"的状态
        const resolveRunning = () =>
          resolve({
            content: [
              {
                type: "text",
                text: `${getWarningText()}Command still running (session ${run.session.id}, pid ${
                  run.session.pid ?? "n/a"
                }). Use process (list/poll/log/write/kill/clear/remove) for follow-up.`,
              },
            ],
            details: {
              status: "running",
              sessionId: run.session.id,
              pid: run.session.pid ?? undefined,
              startedAt: run.startedAt,
              cwd: run.session.cwd,
              tail: run.session.tail,
            },
          });

        // 立即进入后台执行的回调
        const onYieldNow = () => {
          if (yieldTimer) {
            clearTimeout(yieldTimer);
          }
          if (yielded) {
            return;
          }
          yielded = true;
          markBackgrounded(run.session);
          resolveRunning();
        };

        // 设置 yield 计时器
        if (allowBackground && yieldWindow !== null) {
          if (yieldWindow === 0) {
            // yieldWindow=0 表示立即后台执行
            onYieldNow();
          } else {
            // 等待指定时间后进入后台
            yieldTimer = setTimeout(() => {
              if (yielded) {
                return;
              }
              yielded = true;
              markBackgrounded(run.session);
              resolveRunning();
            }, yieldWindow);
          }
        }

        // 等待命令执行完成
        run.promise
          .then((outcome) => {
            if (yieldTimer) {
              clearTimeout(yieldTimer);
            }

            // 如果已经 yield 或进入后台，不再处理结果
            if (yielded || run.session.backgrounded) {
              return;
            }

            // 命令执行失败
            if (outcome.status === "failed") {
              reject(new Error(outcome.reason ?? "Command failed."));
              return;
            }

            // 命令执行成功，返回结果
            resolve({
              content: [
                {
                  type: "text",
                  text: `${getWarningText()}${outcome.aggregated || "(no output)"}`,
                },
              ],
              details: {
                status: "completed",
                exitCode: outcome.exitCode ?? 0,
                durationMs: outcome.durationMs,
                aggregated: outcome.aggregated,
                cwd: run.session.cwd,
              },
            });
          })
          .catch((err) => {
            if (yieldTimer) {
              clearTimeout(yieldTimer);
            }
            if (yielded || run.session.backgrounded) {
              return;
            }
            reject(err as Error);
          });
      });
    },
  };
}

// 默认导出的 exec 工具实例（使用全局默认配置创建）
export const execTool = createExecTool();
