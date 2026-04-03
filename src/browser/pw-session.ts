/**
 * @file pw-session.ts
 *
 * @desc Playwright 浏览器会话管理核心模块
 *
 * ## 主要功能
 *
 * ### 1. 浏览器连接管理
 * - `connectBrowser()`: 通过 Chrome DevTools Protocol (CDP) WebSocket 连接浏览器
 * - 支持连接重试机制（最多3次）
 * - 连接缓存：相同 CDP URL 不会重复建立连接
 * - `closePlaywrightBrowserConnection()`: 关闭浏览器连接
 * - `forceDisconnectPlaywrightForTarget()`: 强制断开目标连接（用于取消卡住的操�)
 *
 * ### 2. 页面状态追踪
 * - `ensurePageState()`: 为每个页面维护状态快照
 *   - console 消息（最多500条）
 *   - 页面错误（最多200条）
 *   - 网络请求（最多500条）
 *   - ARIA role refs（用于 UI 元素定位）
 *
 * ### 3. 页面查找与解析
 * - `findPageByTargetId()`: 通过 targetId 查找对应页面
 * - `getPageForTargetId()`: 获取目标页面或返回第一个页面
 * - `resolvePageByTargetIdOrThrow()`: 解析页面，不存在则抛出异常
 * - `pageTargetId()`: 获取页面的 CDP targetId
 *
 * ### 4. 页面操作
 * - `listPagesViaPlaywright()`: 列出所有页面/标签页
 * - `createPageViaPlaywright()`: 创建新页面/标签页
 * - `closePageByTargetIdViaPlaywright()`: 关闭指定页面
 * - `focusPageByTargetIdViaPlaywright()`: 聚焦指定页面
 *
 * ### 5. Role Refs 管理
 * - `storeRoleRefsForTarget()`: 存储页面的 ARIA role refs 缓存
 * - `restoreRoleRefsForTarget()`: 恢复缓存的 role refs
 * - `refLocator()`: 根据 ref 字符串获取 Playwright 定位器
 *
 * ### 6. CDP 执行终止
 * - `tryTerminateExecutionViaCdp()`: 尝试通过 CDP 终止卡住的 JavaScript 执行
 * - 用于解除页面卡死状态而不关闭整个浏览器
 *
 * ## 关键数据结构
 *
 * - `PageState`: 存储页面级状态（控制台、错误、请求、role refs）
 * - `ContextState`: 存储浏览器上下文级状态（trace 是否激活）
 * - `ConnectedBrowser`: 存储已连接浏览器信息及断开回调
 *
 * ## 缓存策略
 *
 * - 浏览器连接缓存: `cachedByCdpUrl` + `connectingByCdpUrl`
 * - Role refs 缓存: `roleRefsByTarget`（最多50条，LRU 淘汰）
 * - 弱引用状态存储: `pageStates`、`contextStates` 使用 WeakMap
 */

import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Page,
  Request,
  Response,
} from "playwright-core";
import { chromium } from "playwright-core";
import { formatErrorMessage } from "../infra/errors.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { withNoProxyForCdpUrl } from "./cdp-proxy-bypass.js";
import {
  appendCdpPath,
  fetchJson,
  getHeadersWithAuth,
  normalizeCdpHttpBaseForJsonEndpoints,
  withCdpSocket,
} from "./cdp.helpers.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import { getChromeWebSocketUrl } from "./chrome.js";
import { BrowserTabNotFoundError } from "./errors.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { isExtensionRelayCdpEndpoint, withPageScopedCdpClient } from "./pw-session.page-cdp.js";

/**
 * 浏览器控制台消息结构
 * 捕获页面 console.log() 等输出
 */
export type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
};

/**
 * 页面错误结构
 * 捕获未处理的 JavaScript 异常
 */
export type BrowserPageError = {
  message: string;
  name?: string;
  stack?: string;
  timestamp: string;
};

/**
 * 网络请求结构
 * 记录页面发出的 HTTP 请求
 */
export type BrowserNetworkRequest = {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
};

type SnapshotForAIResult = { full: string; incremental?: string };
type SnapshotForAIOptions = { timeout?: number; track?: string };

/**
 * AI 快照功能接口
 * 用于页面 DOM 快照提取
 */
export type WithSnapshotForAI = {
  _snapshotForAI?: (options?: SnapshotForAIOptions) => Promise<SnapshotForAIResult>;
};

type TargetInfoResponse = {
  targetInfo?: {
    targetId?: string;
  };
};

/**
 * 已连接的浏览器实例包装
 * 包含浏览器实例、CDP URL 和断开连接回调
 */
type ConnectedBrowser = {
  browser: Browser;
  cdpUrl: string;
  onDisconnected?: () => void;
};

/**
 * 页面状态存储
 * 使用 WeakMap 关联 Page 实例，实现自动垃圾回收
 */
type PageState = {
  console: BrowserConsoleMessage[]; // 控制台消息列表
  errors: BrowserPageError[]; // 页面错误列表
  requests: BrowserNetworkRequest[]; // 网络请求列表
  requestIds: WeakMap<Request, string>; // Request 对象到 ID 的映射
  nextRequestId: number; // 自增请求 ID
  armIdUpload: number; // Dialog 处理 ID 计数器
  armIdDialog: number; // Dialog 处理 ID 计数器
  armIdDownload: number; // Download 处理 ID 计数器
  /**
   * 从最后一次 role snapshot 中获取的基于角色的引用（如 e1/e2）。
   * Mode "role" refs 从 ariaSnapshot 生成，通过 getByRole 解析。
   * Mode "aria" refs 是 Playwright aria-ref id，通过 `aria-ref=...` 解析。
   */
  roleRefs?: Record<string, { role: string; name?: string; nth?: number }>;
  roleRefsMode?: "role" | "aria"; // role refs 的解析模式
  roleRefsFrameSelector?: string; // 如果 refs 来自 iframe，存储 frame 选择器
};

type RoleRefs = NonNullable<PageState["roleRefs"]>;
type RoleRefsCacheEntry = {
  refs: RoleRefs;
  frameSelector?: string;
  mode?: NonNullable<PageState["roleRefsMode"]>;
};

/**
 * 浏览器上下文状态
 */
type ContextState = {
  traceActive: boolean; // 是否正在录制 trace
};

/**
 * 弱引用状态存储
 * 使用 WeakMap/WeakSet 实现 Page/BrowserContext 的状态关联
 * 当对象被垃圾回收时，关联状态自动清除
 */
const pageStates = new WeakMap<Page, PageState>();
const contextStates = new WeakMap<BrowserContext, ContextState>();
const observedContexts = new WeakSet<BrowserContext>();
const observedPages = new WeakSet<Page>();

/**
 * Role refs 缓存
 * 使用普通 Map 存储，因为 targetId 是字符串而非对象引用
 * 用于在跨请求保持 role refs 稳定性
 */
const roleRefsByTarget = new Map<string, RoleRefsCacheEntry>();
const MAX_ROLE_REFS_CACHE = 50;

/**
 * 消息/错误/请求数量限制
 * 防止内存泄漏，限制历史记录大小
 */
const MAX_CONSOLE_MESSAGES = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;

/**
 * 浏览器连接缓存
 * 避免同一 CDP URL 重复建立连接
 */
const cachedByCdpUrl = new Map<string, ConnectedBrowser>();
/**
 * 正在连接中的 Promise 缓存
 * 防止并发连接同一 URL
 */
const connectingByCdpUrl = new Map<string, Promise<ConnectedBrowser>>();

/**
 * 标准化 CDP URL
 * 移除末尾斜杠，保持一致性
 */
function normalizeCdpUrl(raw: string) {
  return raw.replace(/\/$/, "");
}

/**
 * 通过 ID 查找网络请求记录
 * 从后向前遍历（最近添加的更可能匹配）
 */
function findNetworkRequestById(state: PageState, id: string): BrowserNetworkRequest | undefined {
  for (let i = state.requests.length - 1; i >= 0; i -= 1) {
    const candidate = state.requests[i];
    if (candidate && candidate.id === id) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * 生成 role refs 缓存的键
 * 组合 CDP URL 和 targetId
 */
function roleRefsKey(cdpUrl: string, targetId: string) {
  return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}

/**
 * 记住目标页面的 role refs
 * 缓存到 Map 中，支持跨 Page 对象恢复
 * 使用 LRU 策略，超过 MAX_ROLE_REFS_CACHE 条目时淘汰最旧的
 */
export function rememberRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode?: NonNullable<PageState["roleRefsMode"]>;
}): void {
  const targetId = opts.targetId.trim();
  if (!targetId) {
    return;
  }
  roleRefsByTarget.set(roleRefsKey(opts.cdpUrl, targetId), {
    refs: opts.refs,
    ...(opts.frameSelector ? { frameSelector: opts.frameSelector } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
    const first = roleRefsByTarget.keys().next();
    if (first.done) {
      break;
    }
    roleRefsByTarget.delete(first.value);
  }
}

/**
 * 存储页面 role refs
 * 同时写入 PageState 和全局缓存
 */
export function storeRoleRefsForTarget(opts: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode: NonNullable<PageState["roleRefsMode"]>;
}): void {
  const state = ensurePageState(opts.page);
  state.roleRefs = opts.refs;
  state.roleRefsFrameSelector = opts.frameSelector;
  state.roleRefsMode = opts.mode;
  if (!opts.targetId?.trim()) {
    return;
  }
  rememberRoleRefsForTarget({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: opts.refs,
    frameSelector: opts.frameSelector,
    mode: opts.mode,
  });
}

/**
 * 恢复目标页面的 role refs
 * 从全局缓存中查找并应用到 PageState
 */
export function restoreRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  page: Page;
}): void {
  const targetId = opts.targetId?.trim() || "";
  if (!targetId) {
    return;
  }
  const cached = roleRefsByTarget.get(roleRefsKey(opts.cdpUrl, targetId));
  if (!cached) {
    return;
  }
  const state = ensurePageState(opts.page);
  if (state.roleRefs) {
    return;
  }
  state.roleRefs = cached.refs;
  state.roleRefsFrameSelector = cached.frameSelector;
  state.roleRefsMode = cached.mode;
}

/**
 * 确保页面状态存在
 * 如果页面尚未被追踪，创建新的 PageState 并注册事件监听器
 * 使用 WeakMap 存储，当 Page 对象被 GC 时状态自动清理
 */
export function ensurePageState(page: Page): PageState {
  const existing = pageStates.get(page);
  if (existing) {
    return existing;
  }

  const state: PageState = {
    console: [],
    errors: [],
    requests: [],
    requestIds: new WeakMap(),
    nextRequestId: 0,
    armIdUpload: 0,
    armIdDialog: 0,
    armIdDownload: 0,
  };
  pageStates.set(page, state);

  // 仅当页面未被观察时才注册事件监听器
  if (!observedPages.has(page)) {
    observedPages.add(page);
    // 监听控制台消息
    page.on("console", (msg: ConsoleMessage) => {
      const entry: BrowserConsoleMessage = {
        type: msg.type(),
        text: msg.text(),
        timestamp: new Date().toISOString(),
        location: msg.location(),
      };
      state.console.push(entry);
      if (state.console.length > MAX_CONSOLE_MESSAGES) {
        state.console.shift();
      }
    });
    // 监听页面错误
    page.on("pageerror", (err: Error) => {
      state.errors.push({
        message: err?.message ? String(err.message) : String(err),
        name: err?.name ? String(err.name) : undefined,
        stack: err?.stack ? String(err.stack) : undefined,
        timestamp: new Date().toISOString(),
      });
      if (state.errors.length > MAX_PAGE_ERRORS) {
        state.errors.shift();
      }
    });
    // 监听请求发起
    page.on("request", (req: Request) => {
      state.nextRequestId += 1;
      const id = `r${state.nextRequestId}`;
      state.requestIds.set(req, id);
      state.requests.push({
        id,
        timestamp: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
      });
      if (state.requests.length > MAX_NETWORK_REQUESTS) {
        state.requests.shift();
      }
    });
    // 监听响应接收
    page.on("response", (resp: Response) => {
      const req = resp.request();
      const id = state.requestIds.get(req);
      if (!id) {
        return;
      }
      const rec = findNetworkRequestById(state, id);
      if (!rec) {
        return;
      }
      rec.status = resp.status();
      rec.ok = resp.ok();
    });
    // 监听请求失败
    page.on("requestfailed", (req: Request) => {
      const id = state.requestIds.get(req);
      if (!id) {
        return;
      }
      const rec = findNetworkRequestById(state, id);
      if (!rec) {
        return;
      }
      rec.failureText = req.failure()?.errorText;
      rec.ok = false;
    });
    // 监听页面关闭，清理状态
    page.on("close", () => {
      pageStates.delete(page);
      observedPages.delete(page);
    });
  }

  return state;
}

/**
 * 观察浏览器上下文
 * 确保上下文状态存在，并追踪其中的所有页面
 * 新页面创建时自动注册页面状态
 */
function observeContext(context: BrowserContext) {
  if (observedContexts.has(context)) {
    return;
  }
  observedContexts.add(context);
  ensureContextState(context);

  for (const page of context.pages()) {
    ensurePageState(page);
  }
  context.on("page", (page) => ensurePageState(page));
}

/**
 * 确保浏览器上下文状态存在
 */
export function ensureContextState(context: BrowserContext): ContextState {
  const existing = contextStates.get(context);
  if (existing) {
    return existing;
  }
  const state: ContextState = { traceActive: false };
  contextStates.set(context, state);
  return state;
}

/**
 * 观察浏览器
 * 遍历所有上下文并观察它们
 */
function observeBrowser(browser: Browser) {
  for (const context of browser.contexts()) {
    observeContext(context);
  }
}

/**
 * 连接浏览器（通过 CDP WebSocket）
 *
 * 连接流程：
 * 1. 检查缓存 - 已有连接直接返回
 * 2. 检查正在连接 - 避免重复连接
 * 3. 执行连接重试 - 最多3次尝试
 * 4. 注册断开回调 - 清理缓存
 * 5. 开始观察浏览器 - 追踪页面变化
 *
 * 重试机制：
 * - 首次失败后等待 250ms
 * - 后续每次失败增加 250ms 延迟
 * - 跳过 rate limit 错误，不重试
 *
 * @param cdpUrl - Chrome DevTools Protocol WebSocket URL
 * @returns 已连接的浏览器实例和元数据
 */
async function connectBrowser(cdpUrl: string): Promise<ConnectedBrowser> {
  const normalized = normalizeCdpUrl(cdpUrl);
  const cached = cachedByCdpUrl.get(normalized);
  if (cached) {
    return cached;
  }
  const connecting = connectingByCdpUrl.get(normalized);
  if (connecting) {
    return await connecting;
  }

  const connectWithRetry = async (): Promise<ConnectedBrowser> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // 递增超时时间：5000ms -> 7000ms -> 9000ms
        const timeout = 5000 + attempt * 2000;
        // 尝试获取 WebSocket URL 或使用原始端点
        const wsUrl = await getChromeWebSocketUrl(normalized, timeout).catch(() => null);
        const endpoint = wsUrl ?? normalized;
        const headers = getHeadersWithAuth(endpoint);
        // 对 loopback CDP 连接绕过代理 (#31219)
        const browser = await withNoProxyForCdpUrl(endpoint, () =>
          chromium.connectOverCDP(endpoint, { timeout, headers }),
        );
        // 断开连接回调：清理缓存
        const onDisconnected = () => {
          const current = cachedByCdpUrl.get(normalized);
          if (current?.browser === browser) {
            cachedByCdpUrl.delete(normalized);
          }
        };
        const connected: ConnectedBrowser = { browser, cdpUrl: normalized, onDisconnected };
        cachedByCdpUrl.set(normalized, connected);
        browser.on("disconnected", onDisconnected);
        // 开始观察浏览器及其页面
        observeBrowser(browser);
        return connected;
      } catch (err) {
        lastErr = err;
        // 不要重试 rate limit 错误；重试会加剧 429 问题
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("rate limit")) {
          break;
        }
        // 指数退避：250ms -> 500ms -> 750ms
        const delay = 250 + attempt * 250;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (lastErr instanceof Error) {
      throw lastErr;
    }
    const message = lastErr ? formatErrorMessage(lastErr) : "CDP connect failed";
    throw new Error(message);
  };

  // 使用 finally 确保连接完成后清理 connecting 缓存
  const pending = connectWithRetry().finally(() => {
    connectingByCdpUrl.delete(normalized);
  });
  connectingByCdpUrl.set(normalized, pending);

  return await pending;
}

/**
 * 获取浏览器所有页面
 * 从所有浏览器上下文中收集页面
 */
async function getAllPages(browser: Browser): Promise<Page[]> {
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());
  return pages;
}

/**
 * 获取页面的 CDP targetId
 * 通过创建新的 CDP session 发送 Target.getTargetInfo 命令
 */
async function pageTargetId(page: Page): Promise<string | null> {
  const session = await page.context().newCDPSession(page);
  try {
    const info = (await session.send("Target.getTargetInfo")) as TargetInfoResponse;
    const targetId = String(info?.targetInfo?.targetId ?? "").trim();
    return targetId || null;
  } finally {
    await session.detach().catch(() => {});
  }
}

/**
 * 通过目标列表匹配页面
 * 处理多个页面 URL 相同的情况
 */
function matchPageByTargetList(
  pages: Page[],
  targets: Array<{ id: string; url: string; title?: string }>,
  targetId: string,
): Page | null {
  const target = targets.find((entry) => entry.id === targetId);
  if (!target) {
    return null;
  }

  // 精确 URL 匹配
  const urlMatch = pages.filter((page) => page.url() === target.url);
  if (urlMatch.length === 1) {
    return urlMatch[0] ?? null;
  }
  // 多个页面相同 URL：使用索引匹配
  if (urlMatch.length > 1) {
    const sameUrlTargets = targets.filter((entry) => entry.url === target.url);
    if (sameUrlTargets.length === urlMatch.length) {
      const idx = sameUrlTargets.findIndex((entry) => entry.id === targetId);
      if (idx >= 0 && idx < urlMatch.length) {
        return urlMatch[idx] ?? null;
      }
    }
  }
  return null;
}

/**
 * 通过 Target.list API 查找页面
 * 使用 HTTP JSON 端点获取目标列表
 */
async function findPageByTargetIdViaTargetList(
  pages: Page[],
  targetId: string,
  cdpUrl: string,
): Promise<Page | null> {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(cdpUrl);
  const targets = await fetchJson<
    Array<{
      id: string;
      url: string;
      title?: string;
    }>
  >(appendCdpPath(cdpHttpBase, "/json/list"), 2000);
  return matchPageByTargetList(pages, targets, targetId);
}

/**
 * 通过 targetId 查找页面
 *
 * 查找策略（按优先级）：
 * 1. Extension Relay 模式：通过 HTTP /json/list API 查找
 * 2. CDP 直接查询：对每个页面发送 Target.getTargetInfo
 * 3. HTTP /json/list 回退
 * 4. 单页面降级：如果只有一个页面则直接返回
 */
async function findPageByTargetId(
  browser: Browser,
  targetId: string,
  cdpUrl?: string,
): Promise<Page | null> {
  const pages = await getAllPages(browser);
  // 检查是否为 Extension Relay 端点
  const isExtensionRelay = cdpUrl
    ? await isExtensionRelayCdpEndpoint(cdpUrl).catch(() => false)
    : false;
  // Extension Relay 模式：优先使用 HTTP API
  if (cdpUrl && isExtensionRelay) {
    try {
      const matched = await findPageByTargetIdViaTargetList(pages, targetId, cdpUrl);
      if (matched) {
        return matched;
      }
    } catch {
      // 忽略 fetch 错误，降级到单页面回退
    }
    return pages.length === 1 ? (pages[0] ?? null) : null;
  }

  let resolvedViaCdp = false;
  // 遍历所有页面，尝试通过 CDP 获取 targetId
  for (const page of pages) {
    let tid: string | null = null;
    try {
      tid = await pageTargetId(page);
      resolvedViaCdp = true;
    } catch {
      tid = null;
    }
    if (tid && tid === targetId) {
      return page;
    }
  }
  // CDP 查询失败，尝试 HTTP API 作为回退
  if (cdpUrl) {
    try {
      return await findPageByTargetIdViaTargetList(pages, targetId, cdpUrl);
    } catch {
      // 忽略错误
    }
  }
  // 如果从未通过 CDP 解析成功，且只有一个页面，返回该页面
  if (!resolvedViaCdp && pages.length === 1) {
    return pages[0] ?? null;
  }
  return null;
}

/**
 * 通过 targetId 解析页面，不存在则抛出异常
 */
async function resolvePageByTargetIdOrThrow(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<Page> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!page) {
    throw new BrowserTabNotFoundError();
  }
  return page;
}

/**
 * 获取目标页面
 * 如果未指定 targetId，返回第一个页面
 * 找不到页面时，Extension Relay 单页面场景会返回唯一页面作为降级
 */
export async function getPageForTargetId(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<Page> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = await getAllPages(browser);
  if (!pages.length) {
    throw new Error("No pages available in the connected browser.");
  }
  const first = pages[0];
  if (!opts.targetId) {
    return first;
  }
  const found = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!found) {
    // Extension relays 会阻止 CDP attachment APIs（如 Target.attachToBrowserTarget），
    // 这导致无法通过 newCDPSession() 解析页面 targetId。
    // 如果 Playwright 只暴露了一个 Page，作为最佳 effort 回退使用它。
    if (pages.length === 1) {
      return first;
    }
    throw new BrowserTabNotFoundError();
  }
  return found;
}

/**
 * 根据 ref 字符串获取 Playwright 定位器
 *
 * ref 格式支持：
 * - `@e1` - role ref 格式（去掉 @ 前缀）
 * - `ref=e1` - role ref 格式（去掉 ref= 前缀）
 * - `e1` - role ref 格式
 * - `aria-ref=xxx` - aria-ref 格式
 *
 * role ref 解析：
 * - mode "role": 通过 getByRole 解析
 * - mode "aria": 通过 aria-ref 属性解析
 */
export function refLocator(page: Page, ref: string) {
  // 标准化 ref 格式
  const normalized = ref.startsWith("@")
    ? ref.slice(1)
    : ref.startsWith("ref=")
      ? ref.slice(4)
      : ref;

  // e数字格式 → role ref
  if (/^e\d+$/.test(normalized)) {
    const state = pageStates.get(page);
    // aria 模式：使用 aria-ref 属性
    if (state?.roleRefsMode === "aria") {
      const scope = state.roleRefsFrameSelector
        ? page.frameLocator(state.roleRefsFrameSelector)
        : page;
      return scope.locator(`aria-ref=${normalized}`);
    }
    // role 模式：使用 getByRole
    const info = state?.roleRefs?.[normalized];
    if (!info) {
      throw new Error(
        `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
      );
    }
    const scope = state?.roleRefsFrameSelector
      ? page.frameLocator(state.roleRefsFrameSelector)
      : page;
    const locAny = scope as unknown as {
      getByRole: (
        role: never,
        opts?: { name?: string; exact?: boolean },
      ) => ReturnType<Page["getByRole"]>;
    };
    const locator = info.name
      ? locAny.getByRole(info.role as never, { name: info.name, exact: true })
      : locAny.getByRole(info.role as never);
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }

  // 默认：使用 aria-ref 属性定位
  return page.locator(`aria-ref=${normalized}`);
}

/**
 * 关闭 Playwright 浏览器连接
 *
 * @param opts.cdpUrl - 如果指定，只关闭该 URL 的连接；否则关闭所有缓存连接
 */
export async function closePlaywrightBrowserConnection(opts?: { cdpUrl?: string }): Promise<void> {
  const normalized = opts?.cdpUrl ? normalizeCdpUrl(opts.cdpUrl) : null;

  // 关闭指定 URL 的连接
  if (normalized) {
    const cur = cachedByCdpUrl.get(normalized);
    cachedByCdpUrl.delete(normalized);
    connectingByCdpUrl.delete(normalized);
    if (!cur) {
      return;
    }
    // 移除断开监听器，防止重复回调
    if (cur.onDisconnected && typeof cur.browser.off === "function") {
      cur.browser.off("disconnected", cur.onDisconnected);
    }
    await cur.browser.close().catch(() => {});
    return;
  }

  // 关闭所有缓存的连接
  const connections = Array.from(cachedByCdpUrl.values());
  cachedByCdpUrl.clear();
  connectingByCdpUrl.clear();
  for (const cur of connections) {
    if (cur.onDisconnected && typeof cur.browser.off === "function") {
      cur.browser.off("disconnected", cur.onDisconnected);
    }
    await cur.browser.close().catch(() => {});
  }
}

/**
 * 检查 CDP Socket 是否需要 Target.attachToTarget
 * 某些路径（如 /cdp, /devtools/browser/）需要先附加到目标
 */
function cdpSocketNeedsAttach(wsUrl: string): boolean {
  try {
    const pathname = new URL(wsUrl).pathname;
    return (
      pathname === "/cdp" || pathname.endsWith("/cdp") || pathname.includes("/devtools/browser/")
    );
  } catch {
    return false;
  }
}

/**
 * 尝试通过 CDP 终止卡住的 JavaScript 执行
 *
 * 用途：解除页面卡死状态（如无限循环的 evaluate）
 * 而不关闭整个浏览器连接
 *
 * 流程：
 * 1. 获取目标的 WebSocket URL
 * 2. 必要时先 attach 到目标
 * 3. 发送 Runtime.terminateExecution 命令
 * 4. 分离 CDP session
 */
async function tryTerminateExecutionViaCdp(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(opts.cdpUrl);
  const listUrl = appendCdpPath(cdpHttpBase, "/json/list");

  // 获取目标列表
  const pages = await fetchJson<
    Array<{
      id?: string;
      webSocketDebuggerUrl?: string;
    }>
  >(listUrl, 2000).catch(() => null);
  if (!pages || pages.length === 0) {
    return;
  }

  // 查找目标
  const target = pages.find((p) => String(p.id ?? "").trim() === opts.targetId);
  const wsUrlRaw = String(target?.webSocketDebuggerUrl ?? "").trim();
  if (!wsUrlRaw) {
    return;
  }
  const wsUrl = normalizeCdpWsUrl(wsUrlRaw, cdpHttpBase);
  const needsAttach = cdpSocketNeedsAttach(wsUrl);

  // 超时包装器
  const runWithTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("CDP command timed out")), ms);
    });
    try {
      return await Promise.race([work, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  // 执行终止
  await withCdpSocket(
    wsUrl,
    async (send) => {
      let sessionId: string | undefined;
      try {
        // 必要时先附加到目标
        if (needsAttach) {
          const attached = (await runWithTimeout(
            send("Target.attachToTarget", { targetId: opts.targetId, flatten: true }),
            1500,
          )) as { sessionId?: unknown };
          if (typeof attached?.sessionId === "string" && attached.sessionId.trim()) {
            sessionId = attached.sessionId;
          }
        }
        // 发送终止执行命令
        await runWithTimeout(send("Runtime.terminateExecution", undefined, sessionId), 1500);
        if (sessionId) {
          // 最佳 effort 清理
          void send("Target.detachFromTarget", { sessionId }).catch(() => {});
        }
      } catch {
        // 最佳 effort；忽略错误
      }
    },
    { handshakeTimeoutMs: 2000 },
  ).catch(() => {});
}

/**
 * 强制断开 Playwright 到目标页面的连接
 *
 * 背景：Playwright 按页面序列化 CDP 命令。
 * 如果某个操作卡住（如 evaluate），会阻塞该页面的所有后续命令。
 * 我们不能安全地取消单个命令，也不希望关闭实际的 Chromium 标签页。
 *
 * 解决方案：断开 Playwright 的 CDP 连接，使进行中的命令快速失败，
 * 下一个请求会透明地重新连接。
 *
 * 重要：不能调用 Connection.close()，因为 Playwright 在所有对象间共享单个 Connection。
 * 关闭它会破坏整个 Playwright 实例，导致无法重新连接。
 *
 * 具体步骤：
 * 1. 从缓存中删除连接，使下次调用触发新的 connectOverCDP
 * 2. fire-and-forget browser.close()（可能卡住但不会阻塞我们）
 * 3. 下次 connectBrowser() 创建全新的 CDP WebSocket 连接
 *
 * 旧的 browser.close() 最终会在浏览器内 evaluate 超时或旧连接被 GC 时解决，
 * 不会影响新连接。
 */
export async function forceDisconnectPlaywrightForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  reason?: string;
}): Promise<void> {
  const normalized = normalizeCdpUrl(opts.cdpUrl);
  const cur = cachedByCdpUrl.get(normalized);
  if (!cur) {
    return;
  }
  cachedByCdpUrl.delete(normalized);
  // 清除正在连接中的 Promise，使下次调用执行全新的 connectOverCDP
  connectingByCdpUrl.delete(normalized);
  // 移除"断开连接"监听器，防止旧的浏览器清理与新连接竞争
  if (cur.onDisconnected && typeof cur.browser.off === "function") {
    cur.browser.off("disconnected", cur.onDisconnected);
  }

  // 最佳 effort：在断开 Playwright CDP 连接之前，先终止卡住的 JS 来解除阻塞
  const targetId = opts.targetId?.trim() || "";
  if (targetId) {
    await tryTerminateExecutionViaCdp({ cdpUrl: normalized, targetId }).catch(() => {});
  }

  // Fire-and-forget：不 await，因为 browser.close() 可能在卡住的 CDP 管道上挂起
  cur.browser.close().catch(() => {});
}

/**
 * 通过 Playwright 连接列出所有页面/标签页
 * 用于远程 profile，因为 HTTP-based /json/list 是短暂的
 */
export async function listPagesViaPlaywright(opts: { cdpUrl: string }): Promise<
  Array<{
    targetId: string;
    title: string;
    url: string;
    type: string;
  }>
> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = await getAllPages(browser);
  const results: Array<{
    targetId: string;
    title: string;
    url: string;
    type: string;
  }> = [];

  for (const page of pages) {
    const tid = await pageTargetId(page).catch(() => null);
    if (tid) {
      results.push({
        targetId: tid,
        title: await page.title().catch(() => ""),
        url: page.url(),
        type: "page",
      });
    }
  }
  return results;
}

/**
 * 使用 Playwright 连接创建新页面/标签页
 * 用于远程 profile，因为 HTTP-based /json/new 是短暂的
 * 返回新页面的 targetId 和元数据
 *
 * 流程：
 * 1. 连接浏览器
 * 2. 获取或创建浏览器上下文
 * 3. 创建新页面
 * 4. 可选：导航到指定 URL（带 SSRF 检查）
 * 5. 返回页面元数据
 */
export async function createPageViaPlaywright(opts: {
  cdpUrl: string;
  url: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{
  targetId: string;
  title: string;
  url: string;
  type: string;
}> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  ensureContextState(context);

  const page = await context.newPage();
  ensurePageState(page);

  // 导航到 URL
  const targetUrl = opts.url.trim() || "about:blank";
  if (targetUrl !== "about:blank") {
    const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy);
    // SSRF 检查：导航前验证 URL
    await assertBrowserNavigationAllowed({
      url: targetUrl,
      ...navigationPolicy,
    });
    // 执行导航
    const response = await page.goto(targetUrl, { timeout: 30_000 }).catch(() => {
      // 某些 URL 导航可能失败，但页面仍然被创建
      return null;
    });
    // 验证重定向链
    await assertBrowserNavigationRedirectChainAllowed({
      request: response?.request(),
      ...navigationPolicy,
    });
    // 验证最终结果
    await assertBrowserNavigationResultAllowed({
      url: page.url(),
      ...navigationPolicy,
    });
  }

  // 获取页面的 targetId
  const tid = await pageTargetId(page).catch(() => null);
  if (!tid) {
    throw new Error("Failed to get targetId for new page");
  }

  return {
    targetId: tid,
    title: await page.title().catch(() => ""),
    url: page.url(),
    type: "page",
  };
}

/**
 * 通过 targetId 关闭页面/标签页
 * 用于远程 profile，因为 HTTP-based /json/close 是短暂的
 */
export async function closePageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  const page = await resolvePageByTargetIdOrThrow(opts);
  await page.close();
}

/**
 * 通过 targetId 聚焦页面/标签页
 * 用于远程 profile，因为 HTTP-based /json/activate 可能是短暂的
 *
 * 聚焦策略：
 * 1. 首先尝试 page.bringToFront()
 * 2. 如果失败，尝试通过 CDP 直接发送 Page.bringToFront 命令
 */
export async function focusPageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  const page = await resolvePageByTargetIdOrThrow(opts);
  try {
    await page.bringToFront();
  } catch (err) {
    try {
      // CDP 回退：直接通过 CDP 命令聚焦
      await withPageScopedCdpClient({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: opts.targetId,
        fn: async (send) => {
          await send("Page.bringToFront");
        },
      });
      return;
    } catch {
      throw err;
    }
  }
}
