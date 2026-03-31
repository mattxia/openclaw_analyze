/**
 * control-auth.ts - 浏览器控制服务身份认证模块
 *
 * 核心功能：管理浏览器控制服务的身份认证，防止未授权访问浏览器控制接口
 * 主要职责：
 * 1. 从配置和环境变量中解析认证信息
 * 2. 在未配置认证时自动生成安全令牌
 * 3. 兼容Gateway的统一认证体系，保持认证逻辑一致性
 *
 * 认证优先级：显式配置的认证 > 自动生成的令牌 > 无认证（仅特定模式下）
 */

// 导入配置类型
import type { OpenClawConfig } from "../config/config.js";
// 导入配置加载工具
import { loadConfig } from "../config/config.js";
// 导入网关认证解析工具
import { resolveGatewayAuth } from "../gateway/auth.js";
// 导入网关启动认证生成工具
import { ensureGatewayStartupAuth } from "../gateway/startup-auth.js";

/**
 * 浏览器控制认证信息类型
 * 支持两种认证方式：Bearer Token和Password密码认证
 */
export type BrowserControlAuth = {
  token?: string; // Bearer认证令牌
  password?: string; // 密码认证
};

/**
 * 解析浏览器控制认证信息
 * 复用Gateway的认证解析逻辑，保持整个系统认证逻辑一致性
 *
 * @param cfg - OpenClaw配置对象
 * @param env - 环境变量对象，默认使用process.env
 * @returns 标准化的浏览器控制认证信息
 */
export function resolveBrowserControlAuth(
  cfg: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): BrowserControlAuth {
  // 复用网关的认证解析逻辑，支持从配置和环境变量中提取认证信息
  const auth = resolveGatewayAuth({
    authConfig: cfg?.gateway?.auth,
    env,
    tailscaleMode: cfg?.gateway?.tailscale?.mode,
  });

  // 清理和标准化认证信息
  const token = typeof auth.token === "string" ? auth.token.trim() : "";
  const password = typeof auth.password === "string" ? auth.password.trim() : "";

  return {
    token: token || undefined,
    password: password || undefined,
  };
}

/**
 * 判断是否需要自动生成浏览器认证信息
 * 测试环境下不自动生成认证，避免测试用例需要处理认证逻辑
 *
 * @param env - 环境变量对象
 * @returns 是否需要自动生成认证
 */
function shouldAutoGenerateBrowserAuth(env: NodeJS.ProcessEnv): boolean {
  // Node.js测试环境不生成
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "test") {
    return false;
  }
  // Vitest测试环境不生成
  const vitest = (env.VITEST ?? "").trim().toLowerCase();
  if (vitest && vitest !== "0" && vitest !== "false" && vitest !== "off") {
    return false;
  }
  // 其他环境都需要自动生成
  return true;
}

/**
 * 确保浏览器控制有有效的认证信息
 * 核心逻辑：
 * 1. 优先使用用户显式配置的认证信息
 * 2. 无配置时，非测试环境自动生成安全令牌
 * 3. 特定认证模式下不自动生成（password/none/trusted-proxy）
 * 4. 二次读取最新配置，避免并发配置修改导致的竞态问题
 *
 * @param params - 参数
 * @param params.cfg - OpenClaw配置对象
 * @param params.env - 环境变量对象
 * @returns 认证信息和生成的令牌（如果自动生成了的话）
 */
export async function ensureBrowserControlAuth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  auth: BrowserControlAuth;
  generatedToken?: string; // 自动生成的令牌（如果有）
}> {
  const env = params.env ?? process.env;

  // 第一步：解析现有配置中的认证信息
  const auth = resolveBrowserControlAuth(params.cfg, env);
  // 已有认证信息，直接返回
  if (auth.token || auth.password) {
    return { auth };
  }
  // 测试环境不需要自动生成，返回空认证
  if (!shouldAutoGenerateBrowserAuth(env)) {
    return { auth };
  }

  // 检查认证模式，特定模式下不自动生成认证
  // 显式配置了password模式，即使用户未设置密码也不自动生成
  if (params.cfg.gateway?.auth?.mode === "password") {
    return { auth };
  }
  // 显式关闭了认证，不自动生成
  if (params.cfg.gateway?.auth?.mode === "none") {
    return { auth };
  }
  // 信任代理模式，由代理层处理认证，不自动生成
  if (params.cfg.gateway?.auth?.mode === "trusted-proxy") {
    return { auth };
  }

  // 第二步：重新读取最新配置，避免与其他配置写入进程发生竞态
  const latestCfg = loadConfig();
  const latestAuth = resolveBrowserControlAuth(latestCfg, env);
  // 检查最新配置是否已有认证
  if (latestAuth.token || latestAuth.password) {
    return { auth: latestAuth };
  }
  // 再次检查认证模式
  if (latestCfg.gateway?.auth?.mode === "password") {
    return { auth: latestAuth };
  }
  if (latestCfg.gateway?.auth?.mode === "none") {
    return { auth: latestAuth };
  }
  if (latestCfg.gateway?.auth?.mode === "trusted-proxy") {
    return { auth: latestAuth };
  }

  // 第三步：自动生成网关启动认证，并持久化到配置文件
  const ensured = await ensureGatewayStartupAuth({
    cfg: latestCfg,
    env,
    persist: true, // 持久化生成的认证信息到配置文件
  });

  // 标准化返回格式
  const ensuredAuth = {
    token: ensured.auth.token,
    password: ensured.auth.password,
  };

  return {
    auth: ensuredAuth,
    generatedToken: ensured.generatedToken, // 返回生成的令牌，便于日志和提示
  };
}
