/**
 * supervisor.ts — 进程管理器（Process Supervisor）
 *
 * 核心职责：
 *   - 统一管理子进程的生命周期（创建、运行、取消、退出）
 *   - 支持两种运行模式：child（直生子进程）和 pty（伪终端）
 *   - 提供超时控制：整体超时（overall-timeout）和无输出超时（no-output-timeout）
 *   - 通过 RunRegistry 记录每个运行的状态历史
 *   - 支持按 scopeKey 批量取消同作用域的进程
 *
 * 架构：createProcessSupervisor() → { spawn, cancel, cancelScope, getRecord }
 */

import crypto from "node:crypto";
import { getShellConfig } from "../../agents/shell-utils.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createChildAdapter } from "./adapters/child.js";
import { createPtyAdapter } from "./adapters/pty.js";
import { createRunRegistry } from "./registry.js";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  RunRecord,
  SpawnInput,
  TerminationReason,
} from "./types.js";

/** 子系统日志实例，标签为 "process/supervisor" */
const log = createSubsystemLogger("process/supervisor");

/** 活跃运行的包装类型：关联 ManagedRun 与其作用域键 */
type ActiveRun = {
  run: ManagedRun;
  scopeKey?: string;
};

/**
 * 限幅超时值
 * 将输入值转为正整数（≥1），非法或非正值返回 undefined
 */
function clampTimeout(value?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

/** 判断终止原因是否为超时类型 */
function isTimeoutReason(reason: TerminationReason) {
  return reason === "overall-timeout" || reason === "no-output-timeout";
}

/**
 * 创建进程管理器实例
 *
 * 维护两个核心数据结构：
 *   - registry（RunRegistry）：持久化记录所有运行的状态历史
 *   - active（Map<runId, ActiveRun>）：仅存储当前活跃的运行
 */
export function createProcessSupervisor(): ProcessSupervisor {
  const registry = createRunRegistry();
  const active = new Map<string, ActiveRun>();

  /**
   * 取消单个运行
   * 先更新 registry 状态为 "exiting"，再调用 adapter 的 cancel 方法
   */
  const cancel = (runId: string, reason: TerminationReason = "manual-cancel") => {
    const current = active.get(runId);
    if (!current) {
      return;
    }
    registry.updateState(runId, "exiting", {
      terminationReason: reason,
    });
    current.run.cancel(reason);
  };

  /**
   * 批量取消指定作用域内的所有活跃运行
   * 遍历 active Map，匹配 scopeKey 相同的运行并逐一取消
   */
  const cancelScope = (scopeKey: string, reason: TerminationReason = "manual-cancel") => {
    if (!scopeKey.trim()) {
      return;
    }
    for (const [runId, run] of active.entries()) {
      if (run.scopeKey !== scopeKey) {
        continue;
      }
      cancel(runId, reason);
    }
  };

  /**
   * 启动一个新进程运行
   *
   * 流程：
   *   1. 生成 runId / 处理作用域冲突
   *   2. 在 registry 中创建初始记录（state: "starting"）
   *   3. 设置超时定时器（整体超时 + 无输出超时）
   *   4. 根据 mode 创建 adapter（child 或 pty）
   *   5. 绑定 stdout/stderr 回调，捕获输出 + 触发 touchOutput
   *   6. 等待进程退出（waitPromise），清理资源
   *   7. 返回 ManagedRun 给调用方
   */
  const spawn = async (input: SpawnInput): Promise<ManagedRun> => {
    const runId = input.runId?.trim() || crypto.randomUUID();
    // 如果配置了 replaceExistingScope，先取消同作用域的旧运行
    if (input.replaceExistingScope && input.scopeKey?.trim()) {
      cancelScope(input.scopeKey, "manual-cancel");
    }
    // 记录启动时间戳
    const startedAtMs = Date.now();
    // 在 registry 中创建初始运行记录
    const record: RunRecord = {
      runId,
      sessionId: input.sessionId,
      backendId: input.backendId,
      scopeKey: input.scopeKey?.trim() || undefined,
      state: "starting",
      startedAtMs,
      lastOutputAtMs: startedAtMs,
      createdAtMs: startedAtMs,
      updatedAtMs: startedAtMs,
    };
    registry.add(record);

    // 终止原因（仅设置一次，后续调用忽略）
    let forcedReason: TerminationReason | null = null;
    let settled = false;
    // 累积捕获的 stdout / stderr
    let stdout = "";
    let stderr = "";
    // 超时定时器引用
    let timeoutTimer: NodeJS.Timeout | null = null;
    let noOutputTimer: NodeJS.Timeout | null = null;
    const captureOutput = input.captureOutput !== false;

    // 限幅后的超时值（毫秒）
    const overallTimeoutMs = clampTimeout(input.timeoutMs);
    const noOutputTimeoutMs = clampTimeout(input.noOutputTimeoutMs);

    /**
     * 设置强制终止原因
     * 只能设置一次，后续调用不覆盖已有原因（保证首次超时原因被保留）
     */
    const setForcedReason = (reason: TerminationReason) => {
      if (forcedReason) {
        return;
      }
      forcedReason = reason;
      registry.updateState(runId, "exiting", { terminationReason: reason });
    };

    let cancelAdapter: ((reason: TerminationReason) => void) | null = null;

    /** 请求取消运行（由超时触发器调用） */
    const requestCancel = (reason: TerminationReason) => {
      setForcedReason(reason);
      cancelAdapter?.(reason);
    };

    /**
     * 更新最后输出时间戳，并重置无输出超时计时器
     * 每次有 stdout/stderr 输出时触发
     */
    const touchOutput = () => {
      registry.touchOutput(runId);
      if (!noOutputTimeoutMs || settled) {
        return;
      }
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      noOutputTimer = setTimeout(() => {
        requestCancel("no-output-timeout");
      }, noOutputTimeoutMs);
    };

    try {
      // 参数校验：child 模式必须提供 argv
      if (input.mode === "child" && input.argv.length === 0) {
        throw new Error("spawn argv cannot be empty");
      }
      // 根据 mode 创建对应的进程适配器
      const adapter =
        input.mode === "pty"
          ? await (async () => {
              // PTY 模式：获取 shell 配置，拼接命令和参数
              const { shell, args: shellArgs } = getShellConfig();
              const ptyCommand = input.ptyCommand.trim();
              if (!ptyCommand) {
                throw new Error("PTY command cannot be empty");
              }
              return await createPtyAdapter({
                shell,
                args: [...shellArgs, ptyCommand],
                cwd: input.cwd,
                env: input.env,
              });
            })()
          : await createChildAdapter({
              // Child 模式：直接以子进程方式启动
              argv: input.argv,
              cwd: input.cwd,
              env: input.env,
              windowsVerbatimArguments: input.windowsVerbatimArguments,
              input: input.input,
              stdinMode: input.stdinMode,
            });

      // 更新 registry 状态为 "running"，记录 pid
      registry.updateState(runId, "running", { pid: adapter.pid });

      /** 清理所有超时定时器 */
      const clearTimers = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (noOutputTimer) {
          clearTimeout(noOutputTimer);
          noOutputTimer = null;
        }
      };

      // 注册取消回调：向 adapter 发送 SIGKILL 信号
      cancelAdapter = (_reason: TerminationReason) => {
        if (settled) {
          return;
        }
        adapter.kill("SIGKILL");
      };

      // 设置整体超时定时器
      if (overallTimeoutMs) {
        timeoutTimer = setTimeout(() => {
          requestCancel("overall-timeout");
        }, overallTimeoutMs);
      }
      // 设置无输出超时定时器
      if (noOutputTimeoutMs) {
        noOutputTimer = setTimeout(() => {
          requestCancel("no-output-timeout");
        }, noOutputTimeoutMs);
      }

      // 绑定 stdout 回调：累积输出 + 触发 touchOutput
      adapter.onStdout((chunk) => {
        if (captureOutput) {
          stdout += chunk;
        }
        input.onStdout?.(chunk);
        touchOutput();
      });
      // 绑定 stderr 回调：累积输出 + 触发 touchOutput
      adapter.onStderr((chunk) => {
        if (captureOutput) {
          stderr += chunk;
        }
        input.onStderr?.(chunk);
        touchOutput();
      });

      // 等待进程退出，构建 RunExit 结果
      const waitPromise = (async (): Promise<RunExit> => {
        const result = await adapter.wait();
        // 如果已经 settled（被外部提前终止），返回简化的退出信息
        if (settled) {
          return {
            reason: forcedReason ?? "exit",
            exitCode: result.code,
            exitSignal: result.signal,
            durationMs: Date.now() - startedAtMs,
            stdout,
            stderr,
            timedOut: isTimeoutReason(forcedReason ?? "exit"),
            noOutputTimedOut: forcedReason === "no-output-timeout",
          };
        }
        // 首次 settling：清理资源
        settled = true;
        clearTimers();
        adapter.dispose();
        active.delete(runId);

        // 确定终止原因
        const reason: TerminationReason =
          forcedReason ?? (result.signal != null ? ("signal" as const) : ("exit" as const));
        const exit: RunExit = {
          reason,
          exitCode: result.code,
          exitSignal: result.signal,
          durationMs: Date.now() - startedAtMs,
          stdout,
          stderr,
          timedOut: isTimeoutReason(forcedReason ?? reason),
          noOutputTimedOut: forcedReason === "no-output-timeout",
        };
        // 在 registry 中记录最终状态
        registry.finalize(runId, {
          reason: exit.reason,
          exitCode: exit.exitCode,
          exitSignal: exit.exitSignal,
        });
        return exit;
      })().catch((err) => {
        // 异常路径（如 spawn 失败）：确保资源被清理
        if (!settled) {
          settled = true;
          clearTimers();
          active.delete(runId);
          adapter.dispose();
          registry.finalize(runId, {
            reason: "spawn-error",
            exitCode: null,
            exitSignal: null,
          });
        }
        throw err;
      });

      // 构建 ManagedRun 对象，供调用方使用
      const managedRun: ManagedRun = {
        runId,
        pid: adapter.pid,
        startedAtMs,
        stdin: adapter.stdin,
        wait: async () => await waitPromise,
        cancel: (reason = "manual-cancel") => {
          requestCancel(reason);
        },
      };

      // 加入活跃运行 Map
      active.set(runId, {
        run: managedRun,
        scopeKey: input.scopeKey?.trim() || undefined,
      });
      return managedRun;
    } catch (err) {
      // 创建 adapter 过程中异常：记录 spawn-error
      registry.finalize(runId, {
        reason: "spawn-error",
        exitCode: null,
        exitSignal: null,
      });
      log.warn(`spawn failed: runId=${runId} reason=${String(err)}`);
      throw err;
    }
  };

  // 返回 ProcessSupervisor 接口
  return {
    spawn,
    cancel,
    cancelScope,
    reconcileOrphans: async () => {
      // Deliberate no-op: this supervisor uses in-memory ownership only.
      // Active runs are not recovered after process restart in the current model.
    },
    /** 根据 runId 查询运行记录 */
    getRecord: (runId: string) => registry.get(runId),
  };
}
