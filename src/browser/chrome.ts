/**
 * Chrome浏览器控制核心模块
 * 负责Chrome浏览器的启动、停止、状态检测、CDP通信等底层操作
 * 支持多平台（Windows/macOS/Linux）、多浏览器（Chrome/Brave/Edge/Chromium）
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensurePortAvailable } from "../infra/ports.js";
import { rawDataToString } from "../infra/ws.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";
import {
  CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS, // Chrome启动引导退出超时时间
  CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS, // Chrome配置文件生成超时时间
  CHROME_LAUNCH_READY_POLL_MS, // Chrome启动就绪检测间隔
  CHROME_LAUNCH_READY_WINDOW_MS, // Chrome启动就绪最大等待时间
  CHROME_REACHABILITY_TIMEOUT_MS, // Chrome可达性检测超时
  CHROME_STDERR_HINT_MAX_CHARS, // 错误提示中显示的最大stderr字符数
  CHROME_STOP_PROBE_TIMEOUT_MS, // Chrome停止探测超时
  CHROME_STOP_TIMEOUT_MS, // Chrome停止最大等待时间
  CHROME_WS_READY_TIMEOUT_MS, // Chrome WebSocket就绪超时
} from "./cdp-timeouts.js";
import { appendCdpPath, fetchCdpChecked, isWebSocketUrl, openCdpWebSocket } from "./cdp.helpers.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import {
  type BrowserExecutable,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
import {
  decorateOpenClawProfile, // 装饰OpenClaw浏览器配置文件
  ensureProfileCleanExit, // 确保配置文件下次启动干净退出
  isProfileDecorated, // 检查配置文件是否已被装饰
} from "./chrome.profile-decoration.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";
import {
  DEFAULT_OPENCLAW_BROWSER_COLOR, // 默认浏览器标识颜色
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME, // 默认配置文件名称
} from "./constants.js";

// Chrome子系统日志实例
const log = createSubsystemLogger("browser").child("chrome");

// 导出类型和公共方法
export type { BrowserExecutable } from "./chrome.executables.js";
export {
  findChromeExecutableLinux,
  findChromeExecutableMac,
  findChromeExecutableWindows,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
export {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";

/**
 * 检查文件是否存在的工具函数
 * 捕获所有异常，文件不存在或无权限时都返回false
 * @param filePath - 要检查的文件路径
 * @returns 文件是否存在
 */
function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * 运行中的Chrome实例信息
 */
export type RunningChrome = {
  pid: number; // 进程ID
  exe: BrowserExecutable; // 浏览器可执行文件信息
  userDataDir: string; // 用户数据目录路径
  cdpPort: number; // CDP监听端口
  startedAt: number; // 启动时间戳
  proc: ChildProcessWithoutNullStreams; // 子进程实例
};

/**
 * 解析当前平台适用的浏览器可执行文件
 * @param resolved - 已解析的浏览器配置
 * @returns 浏览器可执行文件信息，找不到返回null
 */
function resolveBrowserExecutable(resolved: ResolvedBrowserConfig): BrowserExecutable | null {
  return resolveBrowserExecutableForPlatform(resolved, process.platform);
}

/**
 * 解析OpenClaw浏览器用户数据目录路径
 * @param profileName - 配置文件名称，默认使用默认配置
 * @returns 用户数据目录绝对路径
 */
export function resolveOpenClawUserDataDir(profileName = DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) {
  return path.join(CONFIG_DIR, "browser", profileName, "user-data");
}

/**
 * 根据端口生成CDP HTTP地址
 * @param cdpPort - CDP监听端口
 * @returns CDP HTTP地址
 */
function cdpUrlForPort(cdpPort: number) {
  return `http://127.0.0.1:${cdpPort}`;
}

/**
 * 检查是否可以打开WebSocket连接
 * @param url - WebSocket地址
 * @param timeoutMs - 连接超时时间
 * @returns 是否可以成功连接
 */
async function canOpenWebSocket(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const ws = openCdpWebSocket(url, { handshakeTimeoutMs: timeoutMs });
    ws.once("open", () => {
      try {
        ws.close();
      } catch {
        // 忽略关闭错误
      }
      resolve(true);
    });
    ws.once("error", () => resolve(false));
  });
}

/**
 * 检查Chrome CDP服务是否可达
 * 自动识别WebSocket地址和HTTP地址，采用对应的检测方式
 * @param cdpUrl - CDP服务地址
 * @param timeoutMs - 检测超时时间
 * @returns CDP服务是否可达
 */
export async function isChromeReachable(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
): Promise<boolean> {
  if (isWebSocketUrl(cdpUrl)) {
    // WebSocket地址直接通过握手检测
    return await canOpenWebSocket(cdpUrl, timeoutMs);
  }
  // HTTP地址通过获取版本信息检测
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  return Boolean(version);
}

/**
 * Chrome版本信息结构
 */
type ChromeVersion = {
  webSocketDebuggerUrl?: string; // WebSocket调试地址
  Browser?: string; // 浏览器版本
  "User-Agent"?: string; // User-Agent字符串
};

/**
 * 获取Chrome版本信息
 * @param cdpUrl - CDP服务地址
 * @param timeoutMs - 请求超时时间
 * @returns 版本信息，获取失败返回null
 */
async function fetchChromeVersion(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
): Promise<ChromeVersion | null> {
  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
  try {
    const versionUrl = appendCdpPath(cdpUrl, "/json/version");
    const res = await fetchCdpChecked(versionUrl, timeoutMs, { signal: ctrl.signal });
    const data = (await res.json()) as ChromeVersion;
    if (!data || typeof data !== "object") {
      return null;
    }
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 获取Chrome的WebSocket调试地址
 * @param cdpUrl - CDP服务地址
 * @param timeoutMs - 请求超时时间
 * @returns WebSocket地址，获取失败返回null
 */
export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
): Promise<string | null> {
  if (isWebSocketUrl(cdpUrl)) {
    // 如果已经是WebSocket地址直接返回
    return cdpUrl;
  }
  // 从版本信息中获取WebSocket地址
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  const wsUrl = String(version?.webSocketDebuggerUrl ?? "").trim();
  if (!wsUrl) {
    return null;
  }
  // 标准化WebSocket地址（处理IP和路径问题）
  return normalizeCdpWsUrl(wsUrl, cdpUrl);
}

/**
 * 检查CDP服务是否可以正常执行命令
 * 不仅仅是端口连通，而是实际发送CDP命令验证服务可用性
 * @param wsUrl - WebSocket调试地址
 * @param timeoutMs - 超时时间
 * @returns CDP服务是否正常可用
 */
async function canRunCdpHealthCommand(
  wsUrl: string,
  timeoutMs = CHROME_WS_READY_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    // 打开CDP WebSocket连接
    const ws = openCdpWebSocket(wsUrl, {
      handshakeTimeoutMs: timeoutMs,
    });
    let settled = false; // 是否已完成状态判断

    /**
     * 处理WebSocket消息
     * 监听CDP命令的响应结果
     */
    const onMessage = (raw: Parameters<typeof rawDataToString>[0]) => {
      if (settled) return;

      let parsed: { id?: unknown; result?: unknown } | null = null;
      try {
        parsed = JSON.parse(rawDataToString(raw)) as { id?: unknown; result?: unknown };
      } catch {
        return;
      }

      // 匹配我们发送的id为1的请求
      if (parsed?.id !== 1) return;
      // 有result返回说明CDP服务正常工作
      finish(Boolean(parsed.result && typeof parsed.result === "object"));
    };

    /**
     * 完成状态判断，清理资源
     */
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off("message", onMessage);
      try {
        ws.close();
      } catch {
        // 忽略关闭错误
      }
      resolve(value);
    };

    // 超时定时器，超时则认为CDP不可用
    const timer = setTimeout(
      () => {
        try {
          ws.terminate();
        } catch {
          // 忽略终止错误
        }
        finish(false);
      },
      Math.max(50, timeoutMs + 25), // 增加少量缓冲时间避免网络波动
    );

    // 连接打开后发送健康检查命令
    ws.once("open", () => {
      try {
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Browser.getVersion", // 发送获取版本命令作为健康检查
          }),
        );
      } catch {
        finish(false);
      }
    });

    ws.on("message", onMessage);
    ws.once("error", () => finish(false));
    ws.once("close", () => finish(false));
  });
}

/**
 * 完整检查Chrome CDP服务是否就绪
 * 包含获取WebSocket地址和发送健康检查命令两步
 * @param cdpUrl - CDP服务地址
 * @param timeoutMs - 总超时时间
 * @param handshakeTimeoutMs - WebSocket握手超时时间
 * @returns CDP服务是否完全就绪
 */
export async function isChromeCdpReady(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  handshakeTimeoutMs = CHROME_WS_READY_TIMEOUT_MS,
): Promise<boolean> {
  // 第一步：获取WebSocket调试地址
  const wsUrl = await getChromeWebSocketUrl(cdpUrl, timeoutMs);
  if (!wsUrl) {
    return false;
  }
  // 第二步：发送CDP命令验证服务可用性
  return await canRunCdpHealthCommand(wsUrl, handshakeTimeoutMs);
}

/**
 * 启动OpenClaw定制版Chrome浏览器
 * 包含配置文件初始化、装饰、CDP就绪检测等完整流程
 * @param resolved - 已解析的浏览器全局配置
 * @param profile - 要启动的配置文件信息
 * @returns 运行中的Chrome实例信息
 */
export async function launchOpenClawChrome(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): Promise<RunningChrome> {
  // 远程浏览器配置不能本地启动
  if (!profile.cdpIsLoopback) {
    throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
  }
  // 确保CDP端口可用
  await ensurePortAvailable(profile.cdpPort);

  // 解析当前平台适用的浏览器可执行文件
  const exe = resolveBrowserExecutable(resolved);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
    );
  }

  // 创建用户数据目录（递归创建）
  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true });

  // 检查配置文件是否需要装饰（添加OpenClaw定制配置，如主题色等）
  const needsDecorate = !isProfileDecorated(
    userDataDir,
    profile.name,
    (profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR).toUpperCase(),
  );

  /**
   * 通用Chrome启动函数
   * 封装启动参数和环境变量，可复用在引导启动和正式启动
   */
  const spawnOnce = () => {
    const args: string[] = [
      `--remote-debugging-port=${profile.cdpPort}`, // 开启远程调试端口
      `--user-data-dir=${userDataDir}`, // 指定用户数据目录
      "--no-first-run", // 跳过首次运行引导
      "--no-default-browser-check", // 跳过默认浏览器检查
      "--disable-sync", // 禁用Chrome同步
      "--disable-background-networking", // 禁用后台网络请求
      "--disable-component-update", // 禁用组件自动更新
      "--disable-features=Translate,MediaRouter", // 禁用翻译和媒体路由功能
      "--disable-session-crashed-bubble", // 禁用崩溃恢复提示气泡
      "--hide-crash-restore-bubble", // 隐藏崩溃恢复提示
      "--password-store=basic", // 使用基础密码存储，避免密钥环问题
    ];

    // 无头模式配置（新版Chrome的headless=new模式）
    if (resolved.headless) {
      args.push("--headless=new");
      args.push("--disable-gpu"); // 无头模式下禁用GPU加速
    }
    // 禁用沙箱模式（容器或root用户运行时需要）
    if (resolved.noSandbox) {
      args.push("--no-sandbox");
      args.push("--disable-setuid-sandbox");
    }
    // Linux平台禁用/dev/shm使用，避免容器环境内存不足
    if (process.platform === "linux") {
      args.push("--disable-dev-shm-usage");
    }

    // 添加用户自定义的额外启动参数（如隐身模式、窗口大小等）
    if (resolved.extraArgs.length > 0) {
      args.push(...resolved.extraArgs);
    }

    // 始终打开空白页，确保至少有一个CDP目标存在
    args.push("about:blank");

    return spawn(exe.path, args, {
      stdio: "pipe",
      env: {
        ...process.env,
        // 减少与用户环境变量的意外共享
        HOME: os.homedir(),
      },
    });
  };

  const startedAt = Date.now();

  // 配置文件路径
  const localStatePath = path.join(userDataDir, "Local State");
  const preferencesPath = path.join(userDataDir, "Default", "Preferences");
  // 检查是否需要首次引导启动（配置文件不存在时）
  const needsBootstrap = !exists(localStatePath) || !exists(preferencesPath);

  /**
   * 首次启动引导流程：
   * 新配置文件需要先启动一次Chrome，让其生成默认的配置文件
   * 然后我们才能修改这些配置文件（装饰），再正式启动
   */
  if (needsBootstrap) {
    const bootstrap = spawnOnce();
    const deadline = Date.now() + CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS;
    // 等待配置文件生成
    while (Date.now() < deadline) {
      if (exists(localStatePath) && exists(preferencesPath)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // 关闭引导进程
    try {
      bootstrap.kill("SIGTERM");
    } catch {
      // 忽略关闭错误
    }
    // 等待进程完全退出
    const exitDeadline = Date.now() + CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS;
    while (Date.now() < exitDeadline) {
      if (bootstrap.exitCode != null) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // 装饰配置文件：添加OpenClaw定制配置（主题色、标识等）
  if (needsDecorate) {
    try {
      decorateOpenClawProfile(userDataDir, {
        name: profile.name,
        color: profile.color,
      });
      log.info(`🦞 openclaw browser profile decorated (${profile.color})`);
    } catch (err) {
      log.warn(`openclaw browser profile decoration failed: ${String(err)}`);
    }
  }

  // 确保配置文件标记为干净退出，避免下次启动显示崩溃恢复提示
  try {
    ensureProfileCleanExit(userDataDir);
  } catch (err) {
    log.warn(`openclaw browser clean-exit prefs failed: ${String(err)}`);
  }

  // 正式启动Chrome进程
  const proc = spawnOnce();

  /**
   * 收集stderr输出用于启动失败时的诊断
   * 启动成功后会移除监听器，避免长时间运行的Chrome进程输出导致内存泄漏
   */
  const stderrChunks: Buffer[] = [];
  const onStderr = (chunk: Buffer) => {
    stderrChunks.push(chunk);
  };
  proc.stderr?.on("data", onStderr);

  // 等待CDP服务就绪
  const readyDeadline = Date.now() + CHROME_LAUNCH_READY_WINDOW_MS;
  while (Date.now() < readyDeadline) {
    if (await isChromeReachable(profile.cdpUrl)) {
      break;
    }
    await new Promise((r) => setTimeout(r, CHROME_LAUNCH_READY_POLL_MS));
  }

  // 启动失败处理：收集错误信息并抛出友好提示
  if (!(await isChromeReachable(profile.cdpUrl))) {
    const stderrOutput = Buffer.concat(stderrChunks).toString("utf8").trim();
    const stderrHint = stderrOutput
      ? `\nChrome stderr:\n${stderrOutput.slice(0, CHROME_STDERR_HINT_MAX_CHARS)}`
      : "";
    // Linux环境下的沙箱问题提示
    const sandboxHint =
      process.platform === "linux" && !resolved.noSandbox
        ? "\nHint: If running in a container or as root, try setting browser.noSandbox: true in config."
        : "";
    // 强制杀掉进程
    try {
      proc.kill("SIGKILL");
    } catch {
      // 忽略杀死错误
    }
    throw new Error(
      `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}".${sandboxHint}${stderrHint}`,
    );
  }

  // 启动成功：移除stderr监听器，释放缓冲区
  proc.stderr?.off("data", onStderr);
  stderrChunks.length = 0; // 清空缓冲区，帮助GC

  const pid = proc.pid ?? -1;
  log.info(
    `🦞 openclaw browser started (${exe.kind}) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${pid})`,
  );

  return {
    pid,
    exe,
    userDataDir,
    cdpPort: profile.cdpPort,
    startedAt,
    proc,
  };
}

/**
 * 停止运行中的OpenClaw Chrome浏览器
 * 先优雅终止，超时则强制杀死
 * @param running - 运行中的Chrome实例
 * @param timeoutMs - 优雅终止的最大等待时间
 */
export async function stopOpenClawChrome(
  running: RunningChrome,
  timeoutMs = CHROME_STOP_TIMEOUT_MS,
) {
  const proc = running.proc;
  // 进程已经被杀死，直接返回
  if (proc.killed) {
    return;
  }
  // 先发送SIGTERM信号，优雅终止进程
  try {
    proc.kill("SIGTERM");
  } catch {
    // 忽略终止信号发送错误
  }

  // 等待进程退出或CDP服务不可达
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // 进程已被标记为killed且有退出码，说明已成功退出
    if (!proc.exitCode && proc.killed) {
      break;
    }
    // CDP服务不可达，说明浏览器已停止
    if (!(await isChromeReachable(cdpUrlForPort(running.cdpPort), CHROME_STOP_PROBE_TIMEOUT_MS))) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // 优雅终止超时，发送SIGKILL强制杀死进程
  try {
    proc.kill("SIGKILL");
  } catch {
    // 忽略强制杀死错误
  }
}
