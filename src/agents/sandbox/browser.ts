/**
 * @file browser.ts
 *
 * @desc 沙箱浏览器管理模块
 *
 * ## 核心功能
 *
 * ### 1. 沙箱浏览器生命周期管理
 * - `ensureSandboxBrowser()`: 创建、启动、重用沙箱浏览器容器
 * - 自动检测配置变更，决定是否需要重建浏览器
 * - 支持热浏览器复用（短时间内重用）
 *
 * ### 2. Docker 容器管理
 * - 创建浏览器 Docker 容器
 * - 配置网络、端口映射、环境变量
 * - 处理容器启动和停止
 *
 * ### 3. CDP 端口管理
 * - 等待 CDP 端口就绪
 * - 端口映射解析
 * - CDP 源范围限制（可选）
 *
 * ### 4. 浏览器桥接服务
 * - 启动/停止浏览器桥接服务器
 * - 认证令牌管理
 * - 连接复用和认证匹配
 *
 * ### 5. NoVNC 远程访问
 * - NoVNC 密码生成
 * - 观察者令牌管理
 * - VNC 端口映射
 *
 * ## 安全机制
 *
 * - 配置哈希校验：检测配置变更决定是否重建容器
 * - 热浏览器保护：短时间内使用的浏览器不会被重建
 * - 认证隔离：每个沙箱有独立的认证令牌
 * - 网络隔离：支持自定义 Docker 网络模式
 * - CDP 源范围限制：可选限制 CDP 访问来源
 * - noSandbox 标志：Chromium 在容器内不需要额外的 setuid 沙箱
 *
 * ## 关键数据结构
 *
 * - `SandboxBrowserContext`: 返回给调用者的浏览器上下文
 * - `ResolvedBrowserConfig`: 解析后的浏览器配置
 * - `BROWSER_BRIDGES`: 浏览器桥接连接缓存
 *
 * ## 常量
 *
 * - `HOT_BROWSER_WINDOW_MS`: 热浏览器窗口时间（5分钟）
 * - `CDP_SOURCE_RANGE_ENV_KEY`: CDP 源范围环境变量名
 */

import crypto from "node:crypto";
import { startBrowserBridgeServer, stopBrowserBridgeServer } from "../../browser/bridge-server.js";
import { type ResolvedBrowserConfig, resolveProfile } from "../../browser/config.js";
import {
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "../../browser/constants.js";
import { deriveDefaultBrowserCdpPortRange } from "../../config/port-defaults.js";
import { defaultRuntime } from "../../runtime.js";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import { computeSandboxBrowserConfigHash } from "./config-hash.js";
import { resolveSandboxBrowserDockerCreateConfig } from "./config.js";
import { DEFAULT_SANDBOX_BROWSER_IMAGE, SANDBOX_BROWSER_SECURITY_HASH_EPOCH } from "./constants.js";
import {
  buildSandboxCreateArgs,
  dockerContainerState,
  execDocker,
  readDockerContainerEnvVar,
  readDockerContainerLabel,
  readDockerPort,
} from "./docker.js";
import {
  buildNoVncObserverTokenUrl,
  consumeNoVncObserverToken,
  generateNoVncPassword,
  isNoVncEnabled,
  NOVNC_PASSWORD_ENV_KEY,
  issueNoVncObserverToken,
} from "./novnc-auth.js";
import { readBrowserRegistry, updateBrowserRegistry } from "./registry.js";
import { resolveSandboxAgentId, slugifySessionKey } from "./shared.js";
import { isToolAllowed } from "./tool-policy.js";
import type { SandboxBrowserContext, SandboxConfig } from "./types.js";
import { validateNetworkMode } from "./validate-sandbox-security.js";
import { appendWorkspaceMountArgs } from "./workspace-mounts.js";

/**
 * 热浏览器窗口时间
 * 如果浏览器在这个时间内被使用过，不会因为配置变更而重建
 */
const HOT_BROWSER_WINDOW_MS = 5 * 60 * 1000;
/**
 * CDP 源范围环境变量名
 * 用于限制 CDP 连接的来源 IP 范围
 */
const CDP_SOURCE_RANGE_ENV_KEY = "OPENCLAW_BROWSER_CDP_SOURCE_RANGE";

/**
 * 等待沙箱浏览器 CDP 端口就绪
 *
 * 通过轮询 http://127.0.0.1:{cdpPort}/json/version 端点
 * 检测 CDP 是否可以访问
 *
 * @param params.cdpPort CDP 端口号
 * @param params.timeoutMs 超时时间（毫秒）
 * @returns 是否在超时前检测到 CDP 就绪
 */
async function waitForSandboxCdp(params: { cdpPort: number; timeoutMs: number }): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, params.timeoutMs);
  const url = `http://127.0.0.1:${params.cdpPort}/json/version`;
  // 轮询直到超时
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(ctrl.abort.bind(ctrl), 1000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (res.ok) {
          return true;
        }
      } finally {
        clearTimeout(t);
      }
    } catch {
      // ignore
    }
    // 每次轮询间隔 150ms
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * 构建沙箱浏览器解析后的配置
 *
 * 将沙箱参数转换为标准浏览器配置格式
 * 配置了 CDP 协议、端口范围、默认配置等
 *
 * @param params.controlPort 控制端口
 * @param params.cdpPort CDP 端口
 * @param params.headless 是否无头模式
 * @param params.evaluateEnabled 是否启用 JavaScript 执行
 * @returns 解析后的完整浏览器配置
 */
function buildSandboxBrowserResolvedConfig(params: {
  controlPort: number;
  cdpPort: number;
  headless: boolean;
  evaluateEnabled: boolean;
}): ResolvedBrowserConfig {
  const cdpHost = "127.0.0.1";
  // 从控制端口派生 CDP 端口范围
  const cdpPortRange = deriveDefaultBrowserCdpPortRange(params.controlPort);
  return {
    enabled: true,
    evaluateEnabled: params.evaluateEnabled,
    controlPort: params.controlPort,
    cdpProtocol: "http",
    cdpHost,
    cdpIsLoopback: true,
    cdpPortRangeStart: cdpPortRange.start,
    cdpPortRangeEnd: cdpPortRange.end,
    remoteCdpTimeoutMs: 1500,
    remoteCdpHandshakeTimeoutMs: 3000,
    color: DEFAULT_OPENCLAW_BROWSER_COLOR,
    executablePath: undefined,
    headless: params.headless,
    noSandbox: false,
    attachOnly: true,
    defaultProfile: DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
    extraArgs: [],
    profiles: {
      [DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME]: {
        cdpPort: params.cdpPort,
        color: DEFAULT_OPENCLAW_BROWSER_COLOR,
      },
    },
  };
}

/**
 * 确保沙箱浏览器镜像存在
 * 如果镜像不存在，抛出错误提示如何构建
 * @param image 镜像名称
 */
async function ensureSandboxBrowserImage(image: string) {
  const result = await execDocker(["image", "inspect", image], {
    allowFailure: true,
  });
  if (result.code === 0) {
    return;
  }
  throw new Error(
    `Sandbox browser image not found: ${image}. Build it with scripts/sandbox-browser-setup.sh.`,
  );
}

/**
 * 确保 Docker 网络存在
 * 对于非默认网络模式（如 bridge/none），创建自定义网络
 * @param network 网络名称
 * @param opts.allowContainerNamespaceJoin 是否允许容器加入主机网络命名空间
 */
async function ensureDockerNetwork(
  network: string,
  opts?: { allowContainerNamespaceJoin?: boolean },
) {
  // 验证网络模式是否安全
  validateNetworkMode(network, {
    allowContainerNamespaceJoin: opts?.allowContainerNamespaceJoin === true,
  });
  const normalized = network.trim().toLowerCase();
  // 默认网络模式不需要创建
  if (!normalized || normalized === "bridge" || normalized === "none") {
    return;
  }
  // 检查网络是否已存在
  const inspect = await execDocker(["network", "inspect", network], { allowFailure: true });
  if (inspect.code === 0) {
    return;
  }
  // 创建自定义桥接网络
  await execDocker(["network", "create", "--driver", "bridge", network]);
}

/**
 * 确保沙箱浏览器就绪
 *
 * 核心入口函数，负责沙箱浏览器的完整生命周期管理
 *
 * ## 完整流程
 *
 * ```
 * 1. 前置检查
 *    ├── 浏览器是否启用
 *    └── 工具策略是否允许浏览器
 *
 * 2. 容器名称解析
 *    └── 生成容器名称
 *
 * 3. 配置哈希计算
 *    └── 计算预期配置哈希
 *
 * 4. 容器状态检查
 *    ├── 容器存在？
 *    │   ├── 配置哈希匹配？
 *    │   │   ├── 热浏览器？（5分钟内使用）
 *    │   │   │   └── 仅记录警告，不重建
 *    │   │   └── 冷浏览器 → 删除重建
 *    │   └── 容器未运行 → 启动
 *    └── 容器不存在 → 创建
 *
 * 5. 容器创建（需要时）
 *    ├── 创建 Docker 网络
 *    ├── 验证镜像存在
 *    ├── 构建创建参数
 *    ├── 添加挂载点
 *    ├── 配置端口映射
 *    ├── 设置环境变量
 *    └── 启动容器
 *
 * 6. 端口映射解析
 *    ├── 解析 CDP 端口
 *    └── 解析 NoVNC 端口
 *
 * 7. 桥接服务器管理
 *    ├── 检查现有桥接
 *    ├── 验证认证匹配
 *    └── 启动/复用桥接
 *
 * 8. 注册表更新
 *    └── 更新浏览器注册表
 *
 * 9. NoVNC URL 生成
 *    └── 生成观察者令牌 URL
 * ```
 *
 * @param params.scopeKey 作用域键（session/agent/shared）
 * @param params.workspaceDir 工作区目录
 * @param params.agentWorkspaceDir Agent 工作区目录
 * @param params.cfg 沙箱配置
 * @param params.evaluateEnabled 是否启用 JavaScript 执行
 * @param params.bridgeAuth 桥接认证信息
 * @returns 浏览器上下文，浏览器禁用时返回 null
 */
export async function ensureSandboxBrowser(params: {
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: SandboxConfig;
  evaluateEnabled?: boolean;
  bridgeAuth?: { token?: string; password?: string };
}): Promise<SandboxBrowserContext | null> {
  // ============================================================
  // 1. 前置检查
  // ============================================================
  if (!params.cfg.browser.enabled) {
    return null;
  }
  if (!isToolAllowed(params.cfg.tools, "browser")) {
    return null;
  }

  // ============================================================
  // 2. 容器名称解析
  // ============================================================
  // 根据 scope 类型生成容器名称
  const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(params.scopeKey);
  const name = `${params.cfg.browser.containerPrefix}${slug}`;
  // Docker 容器名称最大 63 字符
  const containerName = name.slice(0, 63);

  // ============================================================
  // 3. 配置解析
  // ============================================================
  const state = await dockerContainerState(containerName);
  const browserImage = params.cfg.browser.image ?? DEFAULT_SANDBOX_BROWSER_IMAGE;
  const cdpSourceRange = params.cfg.browser.cdpSourceRange?.trim() || undefined;
  const browserDockerCfg = resolveSandboxBrowserDockerCreateConfig({
    docker: params.cfg.docker,
    browser: { ...params.cfg.browser, image: browserImage },
  });

  // ============================================================
  // 4. 配置哈希计算
  // 用于检测配置变更决定是否需要重建容器
  // ============================================================
  const expectedHash = computeSandboxBrowserConfigHash({
    docker: browserDockerCfg,
    browser: {
      cdpPort: params.cfg.browser.cdpPort,
      vncPort: params.cfg.browser.vncPort,
      noVncPort: params.cfg.browser.noVncPort,
      headless: params.cfg.browser.headless,
      enableNoVnc: params.cfg.browser.enableNoVnc,
      cdpSourceRange,
    },
    securityEpoch: SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
    workspaceAccess: params.cfg.workspaceAccess,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
  });

  const now = Date.now();
  let hasContainer = state.exists;
  let running = state.running;
  let currentHash: string | null = null;
  let hashMismatch = false;
  const noVncEnabled = isNoVncEnabled(params.cfg.browser);
  let noVncPassword: string | undefined;

  // ============================================================
  // 5. 容器状态检查与处理
  // ============================================================
  if (hasContainer) {
    // NoVNC 密码读取
    if (noVncEnabled) {
      noVncPassword =
        (await readDockerContainerEnvVar(containerName, NOVNC_PASSWORD_ENV_KEY)) ?? undefined;
    }

    // 检查配置哈希是否匹配
    const registry = await readBrowserRegistry();
    const registryEntry = registry.entries.find((entry) => entry.containerName === containerName);
    currentHash = await readDockerContainerLabel(containerName, "openclaw.configHash");
    hashMismatch = !currentHash || currentHash !== expectedHash;
    if (!currentHash) {
      // 尝试从注册表恢复哈希
      currentHash = registryEntry?.configHash ?? null;
      hashMismatch = !currentHash || currentHash !== expectedHash;
    }

    // 配置变更处理
    if (hashMismatch) {
      const lastUsedAtMs = registryEntry?.lastUsedAtMs;
      // 检查是否是热浏览器（5分钟内使用过）
      const isHot =
        running && (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_BROWSER_WINDOW_MS);
      if (isHot) {
        // 热浏览器：仅记录警告，不重建
        const hint = (() => {
          if (params.cfg.scope === "session") {
            return `openclaw sandbox recreate --browser --session ${params.scopeKey}`;
          }
          if (params.cfg.scope === "agent") {
            const agentId = resolveSandboxAgentId(params.scopeKey) ?? "main";
            return `openclaw sandbox recreate --browser --agent ${agentId}`;
          }
          return "openclaw sandbox recreate --browser --all";
        })();
        defaultRuntime.log(
          `Sandbox browser config changed for ${containerName} (recently used). Recreate to apply: ${hint}`,
        );
      } else {
        // 冷浏览器：删除重建
        await execDocker(["rm", "-f", containerName], { allowFailure: true });
        hasContainer = false;
        running = false;
      }
    }
  }

  // ============================================================
  // 6. 容器创建（如需要）
  // ============================================================
  if (!hasContainer) {
    // 生成 NoVNC 密码
    if (noVncEnabled) {
      noVncPassword = generateNoVncPassword();
    }
    // 确保 Docker 网络存在
    await ensureDockerNetwork(browserDockerCfg.network, {
      allowContainerNamespaceJoin: browserDockerCfg.dangerouslyAllowContainerNamespaceJoin === true,
    });
    // 确保镜像存在
    await ensureSandboxBrowserImage(browserImage);

    // 构建创建参数
    const args = buildSandboxCreateArgs({
      name: containerName,
      cfg: browserDockerCfg,
      scopeKey: params.scopeKey,
      labels: {
        "openclaw.sandboxBrowser": "1",
        "openclaw.browserConfigEpoch": SANDBOX_BROWSER_SECURITY_HASH_EPOCH,
      },
      configHash: expectedHash,
      includeBinds: false,
      bindSourceRoots: [params.workspaceDir, params.agentWorkspaceDir],
    });

    // 添加工作区挂载
    appendWorkspaceMountArgs({
      args,
      workspaceDir: params.workspaceDir,
      agentWorkspaceDir: params.agentWorkspaceDir,
      workdir: params.cfg.docker.workdir,
      workspaceAccess: params.cfg.workspaceAccess,
    });

    // 添加自定义绑定
    if (browserDockerCfg.binds?.length) {
      for (const bind of browserDockerCfg.binds) {
        args.push("-v", bind);
      }
    }

    // 配置端口映射
    args.push("-p", `127.0.0.1::${params.cfg.browser.cdpPort}`);
    if (noVncEnabled) {
      args.push("-p", `127.0.0.1::${params.cfg.browser.noVncPort}`);
    }

    // 设置环境变量
    args.push("-e", `OPENCLAW_BROWSER_HEADLESS=${params.cfg.browser.headless ? "1" : "0"}`);
    args.push("-e", `OPENCLAW_BROWSER_ENABLE_NOVNC=${params.cfg.browser.enableNoVnc ? "1" : "0"}`);
    args.push("-e", `OPENCLAW_BROWSER_CDP_PORT=${params.cfg.browser.cdpPort}`);
    if (cdpSourceRange) {
      args.push("-e", `${CDP_SOURCE_RANGE_ENV_KEY}=${cdpSourceRange}`);
    }
    args.push("-e", `OPENCLAW_BROWSER_VNC_PORT=${params.cfg.browser.vncPort}`);
    args.push("-e", `OPENCLAW_BROWSER_NOVNC_PORT=${params.cfg.browser.noVncPort}`);
    // Chromium 的 setuid/namespace 沙箱在 Docker 容器内无法工作
    //（PID 命名空间创建需要 Docker 默认不授予的特权）。
    // 容器本身提供了隔离，所以这里 --no-sandbox 是安全的。
    args.push("-e", "OPENCLAW_BROWSER_NO_SANDBOX=1");
    if (noVncEnabled && noVncPassword) {
      args.push("-e", `${NOVNC_PASSWORD_ENV_KEY}=${noVncPassword}`);
    }
    args.push(browserImage);

    // 创建并启动容器
    await execDocker(args);
    await execDocker(["start", containerName]);
  } else if (!running) {
    // 容器存在但未运行，直接启动
    await execDocker(["start", containerName]);
  }

  // ============================================================
  // 7. 端口映射解析
  // ============================================================
  const mappedCdp = await readDockerPort(containerName, params.cfg.browser.cdpPort);
  if (!mappedCdp) {
    throw new Error(`Failed to resolve CDP port mapping for ${containerName}.`);
  }

  const mappedNoVnc = noVncEnabled
    ? await readDockerPort(containerName, params.cfg.browser.noVncPort)
    : null;
  if (noVncEnabled && !noVncPassword) {
    noVncPassword =
      (await readDockerContainerEnvVar(containerName, NOVNC_PASSWORD_ENV_KEY)) ?? undefined;
  }

  // ============================================================
  // 8. 桥接服务器管理
  // ============================================================
  const existing = BROWSER_BRIDGES.get(params.scopeKey);
  const existingProfile = existing
    ? resolveProfile(existing.bridge.state.resolved, DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME)
    : null;

  // 确定期望的认证信息
  let desiredAuthToken = params.bridgeAuth?.token?.trim() || undefined;
  let desiredAuthPassword = params.bridgeAuth?.password?.trim() || undefined;
  if (!desiredAuthToken && !desiredAuthPassword) {
    // 始终需要沙箱桥接服务器认证，即使网关认证模式不产生共享密钥。
    // 通过重用现有桥接认证来保持跨调用稳定。
    desiredAuthToken = existing?.authToken;
    desiredAuthPassword = existing?.authPassword;
    if (!desiredAuthToken && !desiredAuthPassword) {
      desiredAuthToken = crypto.randomBytes(24).toString("hex");
    }
  }

  // 判断是否应该复用现有桥接
  const shouldReuse =
    existing && existing.containerName === containerName && existingProfile?.cdpPort === mappedCdp;
  const authMatches =
    !existing ||
    (existing.authToken === desiredAuthToken && existing.authPassword === desiredAuthPassword);

  // 不匹配时停止旧桥接
  if (existing && !shouldReuse) {
    await stopBrowserBridgeServer(existing.bridge.server).catch(() => undefined);
    BROWSER_BRIDGES.delete(params.scopeKey);
  }
  if (existing && shouldReuse && !authMatches) {
    await stopBrowserBridgeServer(existing.bridge.server).catch(() => undefined);
    BROWSER_BRIDGES.delete(params.scopeKey);
  }

  // 决定使用哪个桥接
  const bridge = (() => {
    if (shouldReuse && authMatches && existing) {
      return existing.bridge;
    }
    return null;
  })();

  // 确保桥接服务器运行
  const ensureBridge = async () => {
    if (bridge) {
      return bridge;
    }

    // 自动启动回调
    const onEnsureAttachTarget = params.cfg.browser.autoStart
      ? async () => {
          const state = await dockerContainerState(containerName);
          if (state.exists && !state.running) {
            await execDocker(["start", containerName]);
          }
          const ok = await waitForSandboxCdp({
            cdpPort: mappedCdp,
            timeoutMs: params.cfg.browser.autoStartTimeoutMs,
          });
          if (!ok) {
            throw new Error(
              `Sandbox browser CDP did not become reachable on 127.0.0.1:${mappedCdp} within ${params.cfg.browser.autoStartTimeoutMs}ms.`,
            );
          }
        }
      : undefined;

    return await startBrowserBridgeServer({
      resolved: buildSandboxBrowserResolvedConfig({
        controlPort: 0,
        cdpPort: mappedCdp,
        headless: params.cfg.browser.headless,
        evaluateEnabled: params.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED,
      }),
      authToken: desiredAuthToken,
      authPassword: desiredAuthPassword,
      onEnsureAttachTarget,
      resolveSandboxNoVncToken: consumeNoVncObserverToken,
    });
  };

  const resolvedBridge = await ensureBridge();

  // 更新桥接缓存
  if (!shouldReuse || !authMatches) {
    BROWSER_BRIDGES.set(params.scopeKey, {
      bridge: resolvedBridge,
      containerName,
      authToken: desiredAuthToken,
      authPassword: desiredAuthPassword,
    });
  }

  // ============================================================
  // 9. 注册表更新
  // ============================================================
  await updateBrowserRegistry({
    containerName,
    sessionKey: params.scopeKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: browserImage,
    configHash: hashMismatch && running ? (currentHash ?? undefined) : expectedHash,
    cdpPort: mappedCdp,
    noVncPort: mappedNoVnc ?? undefined,
  });

  // ============================================================
  // 10. NoVNC URL 生成
  // ============================================================
  const noVncUrl =
    mappedNoVnc && noVncEnabled
      ? (() => {
          const token = issueNoVncObserverToken({
            noVncPort: mappedNoVnc,
            password: noVncPassword,
          });
          return buildNoVncObserverTokenUrl(resolvedBridge.baseUrl, token);
        })()
      : undefined;

  // ============================================================
  // 11. 返回浏览器上下文
  // ============================================================
  return {
    bridgeUrl: resolvedBridge.baseUrl,
    noVncUrl,
    containerName,
  };
}
