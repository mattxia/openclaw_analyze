import type { Server } from "node:http";
import express from "express";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveBrowserConfig } from "./config.js";
import { ensureBrowserControlAuth, resolveBrowserControlAuth } from "./control-auth.js";
import { registerBrowserRoutes } from "./routes/index.js";
import type { BrowserRouteRegistrar } from "./routes/types.js";
import { createBrowserRuntimeState, stopBrowserRuntime } from "./runtime-lifecycle.js";
import { type BrowserServerState, createBrowserRouteContext } from "./server-context.js";
import {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./server-middleware.js";

// 浏览器控制服务全局状态单例，保证服务只启动一次
let state: BrowserServerState | null = null;
// 浏览器子系统日志实例
const log = createSubsystemLogger("browser");
// 服务模块专用日志实例
const logServer = log.child("server");

/**
 * 从配置文件启动浏览器控制HTTP服务
 * @returns 启动成功返回服务状态对象，失败返回null
 */
export async function startBrowserControlServerFromConfig(): Promise<BrowserServerState | null> {
  // 单例检查：服务已启动直接返回现有状态
  if (state) {
    return state;
  }

  // 加载全局配置
  const cfg = loadConfig();
  // 解析并标准化浏览器配置
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  // 浏览器模块未启用，直接返回
  if (!resolved.enabled) {
    return null;
  }

  // 解析浏览器控制认证配置
  let browserAuth = resolveBrowserControlAuth(cfg);
  // 认证引导是否失败标记
  let browserAuthBootstrapFailed = false;
  try {
    // 确保认证配置有效，自动生成缺失的认证令牌
    const ensured = await ensureBrowserControlAuth({ cfg });
    browserAuth = ensured.auth;
    // 如果自动生成了令牌，日志提示
    if (ensured.generatedToken) {
      logServer.info("No browser auth configured; generated gateway.auth.token automatically.");
    }
  } catch (err) {
    // 认证配置失败，记录警告
    logServer.warn(`failed to auto-configure browser auth: ${String(err)}`);
    browserAuthBootstrapFailed = true;
  }

  // 安全失败原则：认证引导失败且没有可用的认证配置时，不启动服务
  if (browserAuthBootstrapFailed && !browserAuth.token && !browserAuth.password) {
    logServer.error(
      "browser control startup aborted: authentication bootstrap failed and no fallback auth is configured.",
    );
    return null;
  }

  // 创建Express应用实例
  const app = express();
  // 安装通用中间件（CORS、JSON解析、日志等）
  installBrowserCommonMiddleware(app);
  // 安装认证中间件，验证所有请求的身份
  installBrowserAuthMiddleware(app, browserAuth);

  // 创建路由上下文，提供服务状态访问和配置刷新能力
  const ctx = createBrowserRouteContext({
    getState: () => state,
    refreshConfigFromDisk: true,
  });
  // 注册所有浏览器控制路由
  registerBrowserRoutes(app as unknown as BrowserRouteRegistrar, ctx);

  // 获取配置的服务端口
  const port = resolved.controlPort;
  // 启动HTTP服务器，绑定到127.0.0.1仅本地访问
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  }).catch((err) => {
    // 端口绑定失败，记录错误日志
    logServer.error(`openclaw browser server failed to bind 127.0.0.1:${port}: ${String(err)}`);
    return null;
  });

  // 服务器启动失败，返回null
  if (!server) {
    return null;
  }

  // 创建浏览器运行时状态，管理浏览器进程、会话等资源
  state = await createBrowserRuntimeState({
    server,
    port,
    resolved,
    onWarn: (message) => logServer.warn(message),
  });

  // 记录服务启动成功日志，显示认证模式
  const authMode = browserAuth.token ? "token" : browserAuth.password ? "password" : "off";
  logServer.info(`Browser control listening on http://127.0.0.1:${port}/ (auth=${authMode})`);
  return state;
}

/**
 * 停止浏览器控制服务，清理所有资源
 */
export async function stopBrowserControlServer(): Promise<void> {
  const current = state;
  // 停止浏览器运行时，关闭浏览器进程、清理会话、关闭HTTP服务器
  await stopBrowserRuntime({
    current,
    getState: () => state,
    // 清空全局状态引用
    clearState: () => {
      state = null;
    },
    closeServer: true,
    onWarn: (message) => logServer.warn(message),
  });
}
