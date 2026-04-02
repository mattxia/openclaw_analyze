// ============================================================
// bridge-server.ts - 浏览器桥接服务器模块
//
// 功能说明：
// 本模块负责启动和管理浏览器桥接服务器（Browser Bridge Server）。
// 桥接服务器是一个Express HTTP服务器，提供浏览器控制API端点，
// 用于在沙箱环境和宿主机之间路由浏览器控制请求。
//
// 核心概念：
// - Bridge Server：浏览器桥接服务器，运行在127.0.0.1上，提供REST API
// - Auth：基于token和password的认证机制
// - noVNC Observer：用于在沙箱中观察浏览器的VNC观察器
//
// 架构位置：
// 这是浏览器控制服务层的核心组件，位于:
//   CLI/API -> Gateway -> Bridge Server -> Browser CDP
//
// 作者：OpenClaw分析
// ============================================================

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { isLoopbackHost } from "../gateway/net.js";
import { deleteBridgeAuthForPort, setBridgeAuthForPort } from "./bridge-auth-registry.js";
import type { ResolvedBrowserConfig } from "./config.js";
import { registerBrowserRoutes } from "./routes/index.js";
import type { BrowserRouteRegistrar } from "./routes/types.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
  type ProfileContext,
} from "./server-context.js";
import {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./server-middleware.js";

/**
 * 浏览器桥接服务器实例类型
 * 包含服务器信息、端口、基础URL和状态
 */
export type BrowserBridge = {
  server: Server; // HTTP服务器实例
  port: number; // 监听端口
  baseUrl: string; // 基础URL（http://127.0.0.1:port）
  state: BrowserServerState; // 服务器状态
};

/**
 * noVNC观察器解析结果类型
 * 用于在沙箱中通过noVNC观察浏览器的VNC连接信息
 */
type ResolvedNoVncObserver = {
  noVncPort: number; // noVNC端口号
  password?: string; // VNC密码（可选）
};

/**
 * 生成noVNC引导HTML页面
 *
 * 功能说明：
 * 生成一个自动跳转到noVNC观察器的HTML页面。
 * 用于在沙箱环境中通过浏览器观察远程VNC会话。
 *
 * @param params - noVNC参数
 * @param params.noVncPort - noVNC服务端口
 * @param params.password - VNC密码（可选）
 * @returns HTML页面字符串
 */
function buildNoVncBootstrapHtml(params: ResolvedNoVncObserver): string {
  const hash = new URLSearchParams({
    autoconnect: "1",
    resize: "remote",
  });
  if (params.password?.trim()) {
    hash.set("password", params.password);
  }
  const targetUrl = `http://127.0.0.1:${params.noVncPort}/vnc.html#${hash.toString()}`;
  const encodedTarget = JSON.stringify(targetUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>OpenClaw noVNC Observer</title>
</head>
<body>
  <p>Opening sandbox observer...</p>
  <script>
    const target = ${encodedTarget};
    window.location.replace(target);
  </script>
</body>
</html>`;
}

/**
 * 启动浏览器桥接服务器
 *
 * 功能说明：
 * 创建并启动一个Express HTTP服务器，作为浏览器控制的桥接层。
 * 该服务器：
 * 1. 只能绑定到127.0.0.1（loopback）地址，确保安全
 * 2. 提供基于token/password的认证
 * 3. 注册浏览器控制路由
 * 4. 可选提供noVNC观察器端点
 *
 * 启动流程：
 * 1. 参数校验（host必须为loopback）
 * 2. 创建Express应用
 * 3. 安装中间件（通用中间件、认证中间件）
 * 4. 创建路由上下文
 * 5. 注册浏览器路由
 * 6. 启动HTTP服务器
 * 7. 注册认证信息到bridge-auth-registry
 * 8. 返回服务器实例信息
 *
 * @param params - 启动参数
 * @param params.resolved - 已解析的浏览器配置
 * @param params.host - 监听主机（必须为127.0.0.1或localhost）
 * @param params.port - 监听端口（0表示自动分配）
 * @param params.authToken - 认证token（可选）
 * @param params.authPassword - 认证密码（可选，至少提供一个）
 * @param params.onEnsureAttachTarget - 附加目标时的回调
 * @param params.resolveSandboxNoVncToken - noVNC token解析函数（可选）
 * @returns 包含服务器信息的BrowserBridge对象
 *
 * @throws Error 如果host不是loopback地址或缺少认证信息
 */
export async function startBrowserBridgeServer(params: {
  resolved: ResolvedBrowserConfig;
  host?: string;
  port?: number;
  authToken?: string;
  authPassword?: string;
  onEnsureAttachTarget?: (profile: ProfileContext["profile"]) => Promise<void>;
  resolveSandboxNoVncToken?: (token: string) => ResolvedNoVncObserver | null;
}): Promise<BrowserBridge> {
  // ---- 1. 参数校验：host必须为loopback地址 ----
  const host = params.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(`bridge server must bind to loopback host (got ${host})`);
  }
  // ---- 2. 端口：0表示让系统自动分配端口 ----
  const port = params.port ?? 0;

  // ---- 3. 创建Express应用 ----
  const app = express();

  // ---- 4. 安装通用中间件（如日志、CORS等） ----
  installBrowserCommonMiddleware(app);

  // ---- 5. 可选：注册noVNC引导路由 ----
  // 当提供了resolveSandboxNoVncToken函数时，注册/sandbox/novnc端点
  if (params.resolveSandboxNoVncToken) {
    app.get("/sandbox/novnc", (req, res) => {
      // 禁用缓存，确保每次获取都是最新的
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Referrer-Policy", "no-referrer");

      // 解析token参数
      const rawToken = typeof req.query?.token === "string" ? req.query.token.trim() : "";
      if (!rawToken) {
        res.status(400).send("Missing token");
        return;
      }

      // 解析noVNC观察器信息
      const resolved = params.resolveSandboxNoVncToken?.(rawToken);
      if (!resolved) {
        res.status(404).send("Invalid or expired token");
        return;
      }

      // 返回自动跳转HTML
      res.type("html").status(200).send(buildNoVncBootstrapHtml(resolved));
    });
  }

  // ---- 6. 认证配置：必须提供token或password ----
  const authToken = params.authToken?.trim() || undefined;
  const authPassword = params.authPassword?.trim() || undefined;
  if (!authToken && !authPassword) {
    throw new Error("bridge server requires auth (authToken/authPassword missing)");
  }

  // ---- 7. 安装认证中间件 ----
  installBrowserAuthMiddleware(app, { token: authToken, password: authPassword });

  // ---- 8. 创建服务器状态对象 ----
  const state: BrowserServerState = {
    server: null as unknown as Server,
    port,
    resolved: params.resolved,
    profiles: new Map(), // 各profile的浏览器实例
  };

  // ---- 9. 创建路由上下文（包含状态访问和回调） ----
  const ctx = createBrowserRouteContext({
    getState: () => state,
    onEnsureAttachTarget: params.onEnsureAttachTarget,
  });

  // ---- 10. 注册所有浏览器控制路由 ----
  registerBrowserRoutes(app as unknown as BrowserRouteRegistrar, ctx);

  // ---- 11. 启动HTTP服务器 ----
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.once("error", reject);
  });

  // ---- 12. 获取实际分配的端口 ----
  const address = server.address() as AddressInfo | null;
  const resolvedPort = address?.port ?? port;

  // ---- 13. 更新状态 ----
  state.server = server;
  state.port = resolvedPort;
  state.resolved.controlPort = resolvedPort; // 将控制端口写回配置

  // ---- 14. 注册认证信息到全局registry（用于跨进程通信） ----
  setBridgeAuthForPort(resolvedPort, { token: authToken, password: authPassword });

  // ---- 15. 构建返回结果 ----
  const baseUrl = `http://${host}:${resolvedPort}`;
  return { server, port: resolvedPort, baseUrl, state };
}

/**
 * 停止浏览器桥接服务器
 *
 * 功能说明：
 * 优雅地关闭浏览器桥接服务器。
 *
 * 关闭流程：
 * 1. 从bridge-auth-registry删除认证信息
 * 2. 关闭HTTP服务器
 *
 * @param server - 要关闭的HTTP服务器实例
 * @returns Promise<void>
 */
export async function stopBrowserBridgeServer(server: Server): Promise<void> {
  // ---- 1. 从registry中删除认证信息 ----
  try {
    const address = server.address() as AddressInfo | null;
    if (address?.port) {
      deleteBridgeAuthForPort(address.port);
    }
  } catch {
    // ignore errors during cleanup
  }
  // ---- 2. 关闭HTTP服务器 ----
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
