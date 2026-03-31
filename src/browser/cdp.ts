import type { SsrFPolicy } from "../infra/net/ssrf.js";
import {
  appendCdpPath,
  fetchJson,
  isLoopbackHost,
  isWebSocketUrl,
  withCdpSocket,
} from "./cdp.helpers.js";
import { assertBrowserNavigationAllowed, withBrowserNavigationPolicy } from "./navigation-guard.js";

// 导出CDP工具函数到外部使用
export {
  appendCdpPath,
  fetchJson,
  fetchOk,
  getHeadersWithAuth,
  isWebSocketUrl,
} from "./cdp.helpers.js";

/**
 * 标准化CDP WebSocket URL，修复容器化环境中的地址问题
 * @param wsUrl CDP返回的原始WebSocket地址
 * @param cdpUrl 用户配置的CDP服务地址
 * @returns 标准化后的可访问WebSocket地址
 */
export function normalizeCdpWsUrl(wsUrl: string, cdpUrl: string): string {
  const ws = new URL(wsUrl);
  const cdp = new URL(cdpUrl);
  // 处理通配符绑定地址：容器化浏览器(如browserless)会在/json/version中返回ws://0.0.0.0:<内部端口>
  // 需要重写为外部可访问的cdpUrl的主机和端口
  const isWildcardBind = ws.hostname === "0.0.0.0" || ws.hostname === "[::]";
  // 如果WebSocket地址是回环地址或通配符，而CDP地址不是回环地址，则重写主机端口
  if ((isLoopbackHost(ws.hostname) || isWildcardBind) && !isLoopbackHost(cdp.hostname)) {
    ws.hostname = cdp.hostname;
    const cdpPort = cdp.port || (cdp.protocol === "https:" ? "443" : "80");
    if (cdpPort) {
      ws.port = cdpPort;
    }
    // 同步协议：HTTPS对应WSS，HTTP对应WS
    ws.protocol = cdp.protocol === "https:" ? "wss:" : "ws:";
  }
  // CDP是HTTPS的话强制使用WSS协议
  if (cdp.protocol === "https:" && ws.protocol === "ws:") {
    ws.protocol = "wss:";
  }
  // 同步认证信息：如果CDP地址有用户名密码，自动添加到WebSocket地址
  if (!ws.username && !ws.password && (cdp.username || cdp.password)) {
    ws.username = cdp.username;
    ws.password = cdp.password;
  }
  // 同步查询参数：CDP地址的查询参数自动追加到WebSocket地址
  for (const [key, value] of cdp.searchParams.entries()) {
    if (!ws.searchParams.has(key)) {
      ws.searchParams.append(key, value);
    }
  }
  return ws.toString();
}

/**
 * 获取PNG格式的页面截图
 * @param opts.wsUrl CDP WebSocket地址
 * @param opts.fullPage 是否截取全屏
 * @returns 截图Buffer
 */
export async function captureScreenshotPng(opts: {
  wsUrl: string;
  fullPage?: boolean;
}): Promise<Buffer> {
  return await captureScreenshot({
    wsUrl: opts.wsUrl,
    fullPage: opts.fullPage,
    format: "png",
  });
}

/**
 * 通用页面截图函数，支持PNG/JPEG格式、全屏截取
 * @param opts.wsUrl CDP WebSocket地址
 * @param opts.fullPage 是否截取全屏（包含滚动区域）
 * @param opts.format 截图格式，默认png
 * @param opts.quality JPEG质量，0-100，默认85
 * @returns 截图Buffer
 */
export async function captureScreenshot(opts: {
  wsUrl: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number; // jpeg only (0..100)
}): Promise<Buffer> {
  // 使用CDP Socket连接执行操作，自动管理连接生命周期
  return await withCdpSocket(opts.wsUrl, async (send) => {
    // 启用Page域
    await send("Page.enable");

    // 全屏截取需要先获取页面尺寸，设置裁剪区域
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    if (opts.fullPage) {
      // 获取页面布局尺寸
      const metrics = (await send("Page.getLayoutMetrics")) as {
        cssContentSize?: { width?: number; height?: number };
        contentSize?: { width?: number; height?: number };
      };
      const size = metrics?.cssContentSize ?? metrics?.contentSize;
      const width = Number(size?.width ?? 0);
      const height = Number(size?.height ?? 0);
      // 尺寸有效时设置全屏裁剪区域
      if (width > 0 && height > 0) {
        clip = { x: 0, y: 0, width, height, scale: 1 };
      }
    }

    // 处理格式和质量参数
    const format = opts.format ?? "png";
    const quality =
      format === "jpeg" ? Math.max(0, Math.min(100, Math.round(opts.quality ?? 85))) : undefined;

    // 调用CDP截图命令
    const result = (await send("Page.captureScreenshot", {
      format,
      ...(quality !== undefined ? { quality } : {}),
      fromSurface: true, // 从合成表面截图，保证正确性
      captureBeyondViewport: true, // 允许截取视口外内容
      ...(clip ? { clip } : {}),
    })) as { data?: string };

    // 解析base64数据返回Buffer
    const base64 = result?.data;
    if (!base64) {
      throw new Error("Screenshot failed: missing data");
    }
    return Buffer.from(base64, "base64");
  });
}

/**
 * 通过CDP创建新的浏览器标签页（Target）
 * @param opts.cdpUrl CDP服务地址，可以是HTTP或WebSocket地址
 * @param opts.url 新标签页要打开的URL
 * @param opts.ssrfPolicy SSRF防护策略，可选
 * @returns 创建成功的标签页ID
 */
export async function createTargetViaCdp(opts: {
  cdpUrl: string;
  url: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ targetId: string }> {
  // 先校验URL安全性，防止SSRF攻击
  await assertBrowserNavigationAllowed({
    url: opts.url,
    ...withBrowserNavigationPolicy(opts.ssrfPolicy),
  });

  let wsUrl: string;
  // 直接是WebSocket地址的话跳过发现步骤
  if (isWebSocketUrl(opts.cdpUrl)) {
    // 直接WebSocket地址，跳过/json/version发现流程
    wsUrl = opts.cdpUrl;
  } else {
    // 标准HTTP(S) CDP端点，通过/json/version接口获取WebSocket地址
    const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
      appendCdpPath(opts.cdpUrl, "/json/version"),
      1500,
    );
    const wsUrlRaw = String(version?.webSocketDebuggerUrl ?? "").trim();
    // 标准化WebSocket地址，处理容器化环境的地址问题
    wsUrl = wsUrlRaw ? normalizeCdpWsUrl(wsUrlRaw, opts.cdpUrl) : "";
    if (!wsUrl) {
      throw new Error("CDP /json/version missing webSocketDebuggerUrl");
    }
  }

  // 连接CDP创建新标签页
  return await withCdpSocket(wsUrl, async (send) => {
    const created = (await send("Target.createTarget", { url: opts.url })) as {
      targetId?: string;
    };
    const targetId = String(created?.targetId ?? "").trim();
    if (!targetId) {
      throw new Error("CDP Target.createTarget returned no targetId");
    }
    return { targetId };
  });
}

/**
 * CDP返回的远程对象类型定义
 */
export type CdpRemoteObject = {
  type: string; // 对象类型
  subtype?: string; // 子类型
  value?: unknown; // 序列化后的值
  description?: string; // 描述信息
  unserializableValue?: string; // 不可序列化值的描述
  preview?: unknown; // 预览信息
};

/**
 * CDP执行异常详情类型定义
 */
export type CdpExceptionDetails = {
  text?: string; // 异常文本
  lineNumber?: number; // 行号
  columnNumber?: number; // 列号
  exception?: CdpRemoteObject; // 异常对象
  stackTrace?: unknown; // 堆栈跟踪
};

/**
 * 在页面中执行JavaScript代码
 * @param opts.wsUrl CDP WebSocket地址
 * @param opts.expression 要执行的JS表达式
 * @param opts.awaitPromise 是否等待Promise完成，默认false
 * @param opts.returnByValue 是否按值返回结果，默认true
 * @returns 执行结果和异常信息
 */
export async function evaluateJavaScript(opts: {
  wsUrl: string;
  expression: string;
  awaitPromise?: boolean;
  returnByValue?: boolean;
}): Promise<{
  result: CdpRemoteObject;
  exceptionDetails?: CdpExceptionDetails;
}> {
  return await withCdpSocket(opts.wsUrl, async (send) => {
    // 启用Runtime域，忽略可能的错误（可能已经启用）
    await send("Runtime.enable").catch(() => {});
    // 调用CDP执行JS
    const evaluated = (await send("Runtime.evaluate", {
      expression: opts.expression,
      awaitPromise: Boolean(opts.awaitPromise),
      returnByValue: opts.returnByValue ?? true,
      userGesture: true, // 模拟用户手势，绕过部分页面限制
      includeCommandLineAPI: true, // 包含命令行API
    })) as {
      result?: CdpRemoteObject;
      exceptionDetails?: CdpExceptionDetails;
    };

    const result = evaluated?.result;
    if (!result) {
      throw new Error("CDP Runtime.evaluate returned no result");
    }
    return { result, exceptionDetails: evaluated.exceptionDetails };
  });
}

/**
 * 格式化后的ARIA快照节点类型，用于LLM理解页面结构
 */
export type AriaSnapshotNode = {
  ref: string; // 节点唯一引用ID，用于后续操作定位
  role: string; // ARIA角色
  name: string; // 可访问性名称
  value?: string; // 节点值
  description?: string; // 描述信息
  backendDOMNodeId?: number; // 后端DOM节点ID
  depth: number; // 节点在树中的深度
};

/**
 * CDP返回的原始AX树节点类型
 */
export type RawAXNode = {
  nodeId?: string; // 节点ID
  role?: { value?: string }; // 角色
  name?: { value?: string }; // 名称
  value?: { value?: string }; // 值
  description?: { value?: string }; // 描述
  childIds?: string[]; // 子节点ID列表
  backendDOMNodeId?: number; // 后端DOM节点ID
};

/**
 * 提取AX节点属性值的工具函数
 * @param v CDP返回的属性对象，格式为{ value: xxx }
 * @returns 提取后的字符串值
 */
function axValue(v: unknown): string {
  if (!v || typeof v !== "object") {
    return "";
  }
  const value = (v as { value?: unknown }).value;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

/**
 * 格式化原始ARIA树为LLM友好的结构化节点列表
 * @param nodes CDP返回的原始AX节点数组
 * @param limit 最大返回节点数，防止返回过多数据
 * @returns 格式化后的ARIA快照节点数组
 */
export function formatAriaSnapshot(nodes: RawAXNode[], limit: number): AriaSnapshotNode[] {
  // 建立节点ID到节点的映射表
  const byId = new Map<string, RawAXNode>();
  for (const n of nodes) {
    if (n.nodeId) {
      byId.set(n.nodeId, n);
    }
  }

  // 启发式选择根节点：找一个没有被其他节点引用为子节点的节点，否则取第一个节点
  const referenced = new Set<string>();
  for (const n of nodes) {
    for (const c of n.childIds ?? []) {
      referenced.add(c);
    }
  }
  const root = nodes.find((n) => n.nodeId && !referenced.has(n.nodeId)) ?? nodes[0];
  if (!root?.nodeId) {
    return [];
  }

  // 深度优先遍历树结构，生成格式化节点
  const out: AriaSnapshotNode[] = [];
  const stack: Array<{ id: string; depth: number }> = [{ id: root.nodeId, depth: 0 }];
  while (stack.length && out.length < limit) {
    const popped = stack.pop();
    if (!popped) {
      break;
    }
    const { id, depth } = popped;
    const n = byId.get(id);
    if (!n) {
      continue;
    }
    // 提取节点属性
    const role = axValue(n.role);
    const name = axValue(n.name);
    const value = axValue(n.value);
    const description = axValue(n.description);
    // 生成唯一引用ID，格式为ax+序号
    const ref = `ax${out.length + 1}`;
    // 构造输出节点
    out.push({
      ref,
      role: role || "unknown",
      name: name || "",
      ...(value ? { value } : {}),
      ...(description ? { description } : {}),
      ...(typeof n.backendDOMNodeId === "number" ? { backendDOMNodeId: n.backendDOMNodeId } : {}),
      depth,
    });

    // 子节点逆序入栈，保证遍历顺序正确
    const children = (n.childIds ?? []).filter((c) => byId.has(c));
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) {
        stack.push({ id: child, depth: depth + 1 });
      }
    }
  }

  return out;
}

/**
 * 获取页面的ARIA可访问性快照，用于LLM理解页面结构
 * @param opts.wsUrl CDP WebSocket地址
 * @param opts.limit 最大返回节点数，默认500
 * @returns 格式化后的ARIA节点列表
 */
export async function snapshotAria(opts: {
  wsUrl: string;
  limit?: number;
}): Promise<{ nodes: AriaSnapshotNode[] }> {
  // 限制节点数在1-2000之间
  const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 500)));
  return await withCdpSocket(opts.wsUrl, async (send) => {
    // 启用Accessibility域，忽略错误
    await send("Accessibility.enable").catch(() => {});
    // 获取完整的AX树
    const res = (await send("Accessibility.getFullAXTree")) as {
      nodes?: RawAXNode[];
    };
    const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
    // 格式化节点返回
    return { nodes: formatAriaSnapshot(nodes, limit) };
  });
}

/**
 * 获取页面DOM结构快照，比ARIA快照更详细，包含更多DOM属性
 * @param opts.wsUrl CDP WebSocket地址
 * @param opts.limit 最大返回节点数，默认800
 * @param opts.maxTextChars 每个节点最大文本长度，默认220
 * @returns 格式化后的DOM节点列表
 */
export async function snapshotDom(opts: {
  wsUrl: string;
  limit?: number;
  maxTextChars?: number;
}): Promise<{
  nodes: DomSnapshotNode[];
}> {
  // 限制节点数在1-5000之间
  const limit = Math.max(1, Math.min(5000, Math.floor(opts.limit ?? 800)));
  // 限制文本长度在0-5000之间
  const maxTextChars = Math.max(0, Math.min(5000, Math.floor(opts.maxTextChars ?? 220)));

  // 注入到页面执行的JS代码，遍历DOM生成节点列表
  const expression = `(() => {
    const maxNodes = ${JSON.stringify(limit)};
    const maxText = ${JSON.stringify(maxTextChars)};
    const nodes = [];
    const root = document.documentElement;
    if (!root) return { nodes };
    // 深度优先遍历栈
    const stack = [{ el: root, depth: 0, parentRef: null }];
    while (stack.length && nodes.length < maxNodes) {
      const cur = stack.pop();
      const el = cur.el;
      // 只处理元素节点
      if (!el || el.nodeType !== 1) continue;
      // 生成唯一引用ID，格式为n+序号
      const ref = "n" + String(nodes.length + 1);
      const tag = (el.tagName || "").toLowerCase();
      const id = el.id ? String(el.id) : undefined;
      const className = el.className ? String(el.className).slice(0, 300) : undefined;
      const role = el.getAttribute && el.getAttribute("role") ? String(el.getAttribute("role")) : undefined;
      const name = el.getAttribute && el.getAttribute("aria-label") ? String(el.getAttribute("aria-label")) : undefined;
      // 提取文本内容，超长截断
      let text = "";
      try { text = String(el.innerText || "").trim(); } catch {}
      if (maxText && text.length > maxText) text = text.slice(0, maxText) + "…";
      const href = (el.href !== undefined && el.href !== null) ? String(el.href) : undefined;
      const type = (el.type !== undefined && el.type !== null) ? String(el.type) : undefined;
      const value = (el.value !== undefined && el.value !== null) ? String(el.value).slice(0, 500) : undefined;
      // 构造节点对象
      nodes.push({
        ref,
        parentRef: cur.parentRef,
        depth: cur.depth,
        tag,
        ...(id ? { id } : {}),
        ...(className ? { className } : {}),
        ...(role ? { role } : {}),
        ...(name ? { name } : {}),
        ...(text ? { text } : {}),
        ...(href ? { href } : {}),
        ...(type ? { type } : {}),
        ...(value ? { value } : {}),
      });
      // 子节点逆序入栈，保证遍历顺序正确
      const children = el.children ? Array.from(el.children) : [];
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ el: children[i], depth: cur.depth + 1, parentRef: ref });
      }
    }
    return { nodes };
  })()`;

  // 在页面中执行JS获取DOM结构
  const evaluated = await evaluateJavaScript({
    wsUrl: opts.wsUrl,
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = evaluated.result?.value;
  if (!value || typeof value !== "object") {
    return { nodes: [] };
  }
  const nodes = (value as { nodes?: unknown }).nodes;
  return { nodes: Array.isArray(nodes) ? (nodes as DomSnapshotNode[]) : [] };
}

/**
 * DOM快照节点类型定义
 */
export type DomSnapshotNode = {
  ref: string; // 节点唯一引用ID
  parentRef: string | null; // 父节点引用ID
  depth: number; // 节点深度
  tag: string; // 标签名
  id?: string; // id属性
  className?: string; // class属性
  role?: string; // role属性
  name?: string; // aria-label属性
  text?: string; // 文本内容
  href?: string; // 链接地址
  type?: string; // 输入框类型
  value?: string; // 输入框值
};

/**
 * 获取页面文本或HTML内容
 * @param opts.wsUrl CDP WebSocket地址
 * @param opts.format 返回格式，text为纯文本，html为完整HTML
 * @param opts.maxChars 最大返回字符数，默认200000
 * @param opts.selector 可选CSS选择器，只获取匹配元素的内容
 * @returns 页面内容字符串
 */
export async function getDomText(opts: {
  wsUrl: string;
  format: "html" | "text";
  maxChars?: number;
  selector?: string;
}): Promise<{ text: string }> {
  // 限制最大字符数在0-5,000,000之间
  const maxChars = Math.max(0, Math.min(5_000_000, Math.floor(opts.maxChars ?? 200_000)));
  // 序列化选择器表达式
  const selectorExpr = opts.selector ? JSON.stringify(opts.selector) : "null";

  // 注入到页面执行的JS代码，获取指定内容
  const expression = `(() => {
    const fmt = ${JSON.stringify(opts.format)};
    const max = ${JSON.stringify(maxChars)};
    const sel = ${selectorExpr};
    const pick = sel ? document.querySelector(sel) : null;
    let out = "";
    if (fmt === "text") {
      // 纯文本格式，优先取body内容
      const el = pick || document.body || document.documentElement;
      try { out = String(el && el.innerText ? el.innerText : ""); } catch { out = ""; }
    } else {
      // HTML格式,优先取html根元素
      const el = pick || document.documentElement;
      try { out = String(el && el.outerHTML ? el.outerHTML : ""); } catch { out = ""; }
    }
    // 超长内容截断
    if (max && out.length > max) out = out.slice(0, max) + "\\n<!-- …truncated… -->";
    return out;
  })()`;

  // 执行JS获取内容
  const evaluated = await evaluateJavaScript({
    wsUrl: opts.wsUrl,
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  // 处理返回结果，保证返回字符串
  const textValue = (evaluated.result?.value ?? "") as unknown;
  const text =
    typeof textValue === "string"
      ? textValue
      : typeof textValue === "number" || typeof textValue === "boolean"
        ? String(textValue)
        : "";
  return { text };
}

/**
 * 在页面中执行CSS选择器查询，返回匹配元素的详细信息
 * @param opts.wsUrl CDP WebSocket地址
 * @param opts.selector CSS选择器
 * @param opts.limit 最大返回匹配数，默认20
 * @param opts.maxTextChars 每个元素最大文本长度，默认500
 * @param opts.maxHtmlChars 每个元素最大HTML长度，默认1500
 * @returns 匹配元素列表
 */
export async function querySelector(opts: {
  wsUrl: string;
  selector: string;
  limit?: number;
  maxTextChars?: number;
  maxHtmlChars?: number;
}): Promise<{
  matches: QueryMatch[];
}> {
  // 限制匹配数在1-200之间
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 20)));
  // 限制文本长度在0-5000之间
  const maxText = Math.max(0, Math.min(5000, Math.floor(opts.maxTextChars ?? 500)));
  // 限制HTML长度在0-20000之间
  const maxHtml = Math.max(0, Math.min(20000, Math.floor(opts.maxHtmlChars ?? 1500)));

  // 注入到页面执行的JS代码，执行选择器查询并提取元素信息
  const expression = `(() => {
    const sel = ${JSON.stringify(opts.selector)};
    const lim = ${JSON.stringify(limit)};
    const maxText = ${JSON.stringify(maxText)};
    const maxHtml = ${JSON.stringify(maxHtml)};
    // 执行查询并截断结果
    const els = Array.from(document.querySelectorAll(sel)).slice(0, lim);
    // 提取每个匹配元素的信息
    return els.map((el, i) => {
      const tag = (el.tagName || "").toLowerCase();
      const id = el.id ? String(el.id) : undefined;
      const className = el.className ? String(el.className).slice(0, 300) : undefined;
      // 提取文本内容，超长截断
      let text = "";
      try { text = String(el.innerText || "").trim(); } catch {}
      if (maxText && text.length > maxText) text = text.slice(0, maxText) + "…";
      const value = (el.value !== undefined && el.value !== null) ? String(el.value).slice(0, 500) : undefined;
      const href = (el.href !== undefined && el.href !== null) ? String(el.href) : undefined;
      // 提取HTML内容，超长截断
      let outerHTML = "";
      try { outerHTML = String(el.outerHTML || ""); } catch {}
      if (maxHtml && outerHTML.length > maxHtml) outerHTML = outerHTML.slice(0, maxHtml) + "…";
      return {
        index: i + 1,
        tag,
        ...(id ? { id } : {}),
        ...(className ? { className } : {}),
        ...(text ? { text } : {}),
        ...(value ? { value } : {}),
        ...(href ? { href } : {}),
        ...(outerHTML ? { outerHTML } : {}),
      };
    });
  })()`;

  // 执行JS获取查询结果
  const evaluated = await evaluateJavaScript({
    wsUrl: opts.wsUrl,
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const matches = evaluated.result?.value;
  return { matches: Array.isArray(matches) ? (matches as QueryMatch[]) : [] };
}

/**
 * CSS选择器查询结果类型定义
 */
export type QueryMatch = {
  index: number; // 匹配序号，从1开始
  tag: string; // 元素标签名
  id?: string; // 元素id属性
  className?: string; // 元素class属性
  text?: string; // 元素文本内容
  value?: string; // 元素value属性（输入框等）
  href?: string; // 元素href属性（链接等）
  outerHTML?: string; // 元素完整HTML代码
};
