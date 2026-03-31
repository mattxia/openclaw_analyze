/**
 * navigation-guard.ts - 浏览器导航安全防护模块
 * 
 * 核心功能：防止SSRF（服务器端请求伪造）攻击，限制浏览器导航到不安全的地址
 * 安全防护范围：
 * 1. 协议限制：仅允许http/https协议和about:blank
 * 2. 内网访问控制：根据SSRF策略决定是否允许访问内网地址
 * 3. 重定向链校验：检查所有跳转的URL都符合安全策略
 * 4. 代理环境检测：存在系统代理时严格限制导航，防止绕过SSRF防护
 * 
 * 所有浏览器导航操作（open/navigate等）都必须经过本模块的校验
 */

// 导入代理环境检测工具
import { hasProxyEnvConfigured } from "../infra/net/proxy-env.js";
// 导入SSRF防护相关工具
import {
  isPrivateNetworkAllowedByPolicy, // 检查策略是否允许访问内网
  resolvePinnedHostnameWithPolicy,  // 根据SSRF策略解析主机名，检查是否为内网地址
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";

/**
 * 允许的网络导航协议列表
 * 仅允许HTTP/HTTPS协议，防止file:///、ftp://等危险协议被滥用
 */
const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
/**
 * 允许的非网络URL列表
 * about:blank是唯一允许的空白页，用于初始化浏览器标签页
 */
const SAFE_NON_NETWORK_URLS = new Set(["about:blank"]);

/**
 * 判断是否是允许的非网络导航地址
 * @param parsed - 解析后的URL对象
 * @returns 是否允许导航
 */
function isAllowedNonNetworkNavigationUrl(parsed: URL): boolean {
  // 非网络导航地址必须显式允许，仅支持about:blank作为初始化URL
  return SAFE_NON_NETWORK_URLS.has(parsed.href);
}

/**
 * 浏览器导航URL不合法自定义错误类
 * 所有导航校验失败的错误都使用此类型，便于上层统一捕获处理
 */
export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBrowserNavigationUrlError";
  }
}

/**
 * 浏览器导航策略配置选项类型
 */
export type BrowserNavigationPolicyOptions = {
  ssrfPolicy?: SsrFPolicy; // SSRF防护策略配置
};

/**
 * 浏览器导航请求对象接口
 * 适配不同的请求对象，统一获取URL和重定向链的接口
 */
export type BrowserNavigationRequestLike = {
  url(): string; // 获取当前请求的URL
  redirectedFrom(): BrowserNavigationRequestLike | null; // 获取上一个重定向的请求
};

/**
 * 创建浏览器导航策略配置的工具函数
 * @param ssrfPolicy - SSRF策略配置
 * @returns 标准化的导航策略选项
 */
export function withBrowserNavigationPolicy(
  ssrfPolicy?: SsrFPolicy,
): BrowserNavigationPolicyOptions {
  return ssrfPolicy ? { ssrfPolicy } : {};
}

/**
 * 判断是否需要检查浏览器导航重定向
 * 当SSRF策略禁止访问内网时，必须检查所有重定向，防止通过重定向绕过SSRF防护
 * @param ssrfPolicy - SSRF策略配置
 * @returns 是否需要检查重定向
 */
export function requiresInspectableBrowserNavigationRedirects(ssrfPolicy?: SsrFPolicy): boolean {
  return !isPrivateNetworkAllowedByPolicy(ssrfPolicy);
}

/**
 * 导航前校验：断言浏览器导航地址是合法的
 * 核心安全校验函数，所有导航操作前必须调用
 * 校验流程：
 * 1. URL格式校验
 * 2. 协议校验（仅允许http/https/about:blank）
 * 3. 代理环境检测（系统代理存在且禁止内网访问时拦截）
 * 4. SSRF校验（检查主机名是否解析为内网地址）
 * 
 * @param opts - 校验参数
 * @param opts.url - 要导航的URL
 * @param opts.lookupFn - 自定义DNS解析函数（可选，用于测试）
 * @param opts.ssrfPolicy - SSRF防护策略
 * @throws 校验失败时抛出InvalidBrowserNavigationUrlError
 */
export async function assertBrowserNavigationAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  // 空URL校验
  const rawUrl = String(opts.url ?? "").trim();
  if (!rawUrl) {
    throw new InvalidBrowserNavigationUrlError("url is required");
  }

  // URL格式校验
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${rawUrl}`);
  }

  // 协议校验
  if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    // 检查是否是允许的非网络URL
    if (isAllowedNonNetworkNavigationUrl(parsed)) {
      return;
    }
    throw new InvalidBrowserNavigationUrlError(
      `Navigation blocked: unsupported protocol "${parsed.protocol}"`,
    );
  }

  // 代理环境安全检测：
  // 当系统配置了代理时，浏览器会使用代理路由，可能绕过导航前的DNS检查，导致SSRF防护失效
  // 因此在严格模式（禁止内网访问）下，如果存在系统代理，直接拦截导航
  if (hasProxyEnvConfigured() && !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: strict browser SSRF policy cannot be enforced while env proxy variables are set",
    );
  }

  // SSRF校验：解析主机名并检查是否符合SSRF策略（是否允许访问内网地址）
  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    lookupFn: opts.lookupFn,
    policy: opts.ssrfPolicy,
  });
}

/**
 * 导航后校验：断言最终页面URL是合法的
 * 容错性更高，只校验网络URL和about:blank，避免误拦截浏览器内部错误页（如chrome-error://）
 * 用于导航完成后对最终URL的二次校验
 * 
 * @param opts - 校验参数
 * @param opts.url - 导航完成后的最终URL
 * @param opts.lookupFn - 自定义DNS解析函数
 * @param opts.ssrfPolicy - SSRF防护策略
 */
export async function assertBrowserNavigationResultAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = String(opts.url ?? "").trim();
  if (!rawUrl) {
    return;
  }

  // URL解析失败直接返回（可能是浏览器内部特殊URL）
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }

  // 仅对网络URL和允许的非网络URL进行校验
  if (
    NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol) ||
    isAllowedNonNetworkNavigationUrl(parsed)
  ) {
    await assertBrowserNavigationAllowed(opts);
  }
}

/**
 * 重定向链校验：断言整个重定向链中的所有URL都是合法的
 * 防止通过中间重定向跳转到内网地址绕过SSRF防护
 * 校验顺序：从最初的URL到最终的URL依次校验
 * 
 * @param opts - 校验参数
 * @param opts.request - 导航请求对象，包含重定向链信息
 * @param opts.lookupFn - 自定义DNS解析函数
 * @param opts.ssrfPolicy - SSRF防护策略
 */
export async function assertBrowserNavigationRedirectChainAllowed(
  opts: {
    request?: BrowserNavigationRequestLike | null;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  // 收集完整的重定向链
  const chain: string[] = [];
  let current = opts.request ?? null;
  while (current) {
    chain.push(current.url());
    current = current.redirectedFrom();
  }

  // 从重定向的起点到终点依次校验所有URL（反转数组，从最早的请求开始校验）
  for (const url of chain.toReversed()) {
    await assertBrowserNavigationAllowed({
      url,
      lookupFn: opts.lookupFn,
      ssrfPolicy: opts.ssrfPolicy,
    });
  }
}
