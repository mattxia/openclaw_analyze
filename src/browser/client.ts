import { fetchBrowserJson } from "./client-fetch.js";

/**
 * 浏览器传输协议类型
 * cdp: Chrome DevTools Protocol
 * chrome-mcp: Chrome Message Channel Protocol
 */
export type BrowserTransport = "cdp" | "chrome-mcp";

/**
 * 浏览器运行状态信息
 */
export type BrowserStatus = {
  enabled: boolean; // 浏览器是否启用
  profile?: string; // 当前使用的配置文件名称
  driver?: "openclaw" | "extension" | "existing-session"; // 浏览器驱动类型
  transport?: BrowserTransport; // 传输协议类型
  running: boolean; // 浏览器是否正在运行
  cdpReady?: boolean; // CDP协议是否准备就绪
  cdpHttp?: boolean; // CDP是否使用HTTP协议
  pid: number | null; // 浏览器进程ID
  cdpPort: number | null; // CDP监听端口
  cdpUrl?: string | null; // CDP服务地址
  chosenBrowser: string | null; // 用户选择的浏览器类型
  detectedBrowser?: string | null; // 自动检测到的浏览器类型
  detectedExecutablePath?: string | null; // 自动检测到的浏览器可执行文件路径
  detectError?: string | null; // 浏览器检测过程中的错误信息
  userDataDir: string | null; // 用户数据目录路径
  color: string; // 浏览器配置对应的标识颜色
  headless: boolean; // 是否使用无头模式
  noSandbox?: boolean; // 是否禁用沙箱模式
  executablePath?: string | null; // 浏览器可执行文件路径
  attachOnly: boolean; // 是否仅附加到现有浏览器会话
};

/**
 * 浏览器配置文件状态信息
 */
export type ProfileStatus = {
  name: string; // 配置文件名称
  transport?: BrowserTransport; // 传输协议类型
  cdpPort: number | null; // CDP监听端口
  cdpUrl: string | null; // CDP服务地址
  color: string; // 配置文件标识颜色
  driver: "openclaw" | "extension" | "existing-session"; // 驱动类型
  running: boolean; // 配置文件对应的浏览器是否正在运行
  tabCount: number; // 打开的标签页数量
  isDefault: boolean; // 是否为默认配置文件
  isRemote: boolean; // 是否为远程浏览器会话
  missingFromConfig?: boolean; // 配置文件是否在配置中缺失
  reconcileReason?: string | null; // 配置同步调整的原因说明
};

/**
 * 浏览器配置文件重置结果
 */
export type BrowserResetProfileResult = {
  ok: true; // 操作是否成功
  moved: boolean; // 配置文件是否已移动
  from: string; // 原配置文件路径
  to?: string; // 新配置文件路径
};

/**
 * 浏览器标签页信息
 */
export type BrowserTab = {
  targetId: string; // CDP目标ID
  title: string; // 标签页标题
  url: string; // 标签页当前URL
  wsUrl?: string; // WebSocket连接地址
  type?: string; // 目标类型
};

/**
 * 页面快照ARIA节点信息
 */
export type SnapshotAriaNode = {
  ref: string; // 节点引用标识
  role: string; // ARIA角色
  name: string; // 节点名称
  value?: string; // 节点值
  description?: string; // 节点描述
  backendDOMNodeId?: number; // 后端DOM节点ID
  depth: number; // 节点在DOM树中的深度
};

/**
 * 页面快照返回结果
 */
export type SnapshotResult =
  | {
      ok: true; // 操作是否成功
      format: "aria"; // 快照格式：ARIA结构化数据
      targetId: string; // 目标标签页ID
      url: string; // 页面URL
      nodes: SnapshotAriaNode[]; // ARIA节点列表
    }
  | {
      ok: true; // 操作是否成功
      format: "ai"; // 快照格式：AI友好的文本格式
      targetId: string; // 目标标签页ID
      url: string; // 页面URL
      snapshot: string; // 快照文本内容
      truncated?: boolean; // 内容是否被截断
      refs?: Record<string, { role: string; name?: string; nth?: number }>; // 节点引用映射
      stats?: {
        // 快照统计信息
        lines: number; // 文本行数
        chars: number; // 字符数量
        refs: number; // 引用节点数量
        interactive: number; // 可交互元素数量
      };
      labels?: boolean; // 是否包含标签信息
      labelsCount?: number; // 标签数量
      labelsSkipped?: number; // 跳过的标签数量
      imagePath?: string; // 截图文件路径
      imageType?: "png" | "jpeg"; // 截图文件格式
    };

/**
 * 构建包含配置文件参数的查询字符串
 * @param profile - 配置文件名称
 * @returns 编码后的查询字符串
 */
function buildProfileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}

/**
 * 拼接基础URL和请求路径
 * @param baseUrl - 基础API地址
 * @param path - 请求路径
 * @returns 完整的请求URL
 */
function withBaseUrl(baseUrl: string | undefined, path: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return path;
  }
  return `${trimmed.replace(/\/$/, "")}${path}`;
}

/**
 * 获取浏览器运行状态
 * @param baseUrl - 基础API地址
 * @param opts - 可选参数，包含配置文件名称
 * @returns 浏览器状态信息
 */
export async function browserStatus(
  baseUrl?: string,
  opts?: { profile?: string },
): Promise<BrowserStatus> {
  const q = buildProfileQuery(opts?.profile);
  return await fetchBrowserJson<BrowserStatus>(withBaseUrl(baseUrl, `/${q}`), {
    timeoutMs: 1500,
  });
}

/**
 * 获取所有浏览器配置文件列表
 * @param baseUrl - 基础API地址
 * @returns 配置文件状态列表
 */
export async function browserProfiles(baseUrl?: string): Promise<ProfileStatus[]> {
  const res = await fetchBrowserJson<{ profiles: ProfileStatus[] }>(
    withBaseUrl(baseUrl, `/profiles`),
    {
      timeoutMs: 3000,
    },
  );
  return res.profiles ?? [];
}

/**
 * 启动浏览器
 * @param baseUrl - 基础API地址
 * @param opts - 可选参数，包含配置文件名称
 */
export async function browserStart(baseUrl?: string, opts?: { profile?: string }): Promise<void> {
  const q = buildProfileQuery(opts?.profile);
  await fetchBrowserJson(withBaseUrl(baseUrl, `/start${q}`), {
    method: "POST",
    timeoutMs: 15000,
  });
}

/**
 * 停止浏览器
 * @param baseUrl - 基础API地址
 * @param opts - 可选参数，包含配置文件名称
 */
export async function browserStop(baseUrl?: string, opts?: { profile?: string }): Promise<void> {
  const q = buildProfileQuery(opts?.profile);
  await fetchBrowserJson(withBaseUrl(baseUrl, `/stop${q}`), {
    method: "POST",
    timeoutMs: 15000,
  });
}

/**
 * 重置浏览器配置文件
 * @param baseUrl - 基础API地址
 * @param opts - 可选参数，包含配置文件名称
 * @returns 重置结果信息
 */
export async function browserResetProfile(
  baseUrl?: string,
  opts?: { profile?: string },
): Promise<BrowserResetProfileResult> {
  const q = buildProfileQuery(opts?.profile);
  return await fetchBrowserJson<BrowserResetProfileResult>(
    withBaseUrl(baseUrl, `/reset-profile${q}`),
    {
      method: "POST",
      timeoutMs: 20000,
    },
  );
}

/**
 * 创建浏览器配置文件结果
 */
export type BrowserCreateProfileResult = {
  ok: true; // 操作是否成功
  profile: string; // 新创建的配置文件名称
  transport?: BrowserTransport; // 传输协议类型
  cdpPort: number | null; // CDP监听端口
  cdpUrl: string | null; // CDP服务地址
  color: string; // 配置文件标识颜色
  isRemote: boolean; // 是否为远程浏览器会话
};

/**
 * 创建新的浏览器配置文件
 * @param baseUrl - 基础API地址
 * @param opts - 配置文件参数
 * @returns 新配置文件信息
 */
export async function browserCreateProfile(
  baseUrl: string | undefined,
  opts: {
    name: string;
    color?: string;
    cdpUrl?: string;
    driver?: "openclaw" | "extension" | "existing-session";
  },
): Promise<BrowserCreateProfileResult> {
  return await fetchBrowserJson<BrowserCreateProfileResult>(
    withBaseUrl(baseUrl, `/profiles/create`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: opts.name,
        color: opts.color,
        cdpUrl: opts.cdpUrl,
        driver: opts.driver,
      }),
      timeoutMs: 10000,
    },
  );
}

/**
 * 删除浏览器配置文件结果
 */
export type BrowserDeleteProfileResult = {
  ok: true; // 操作是否成功
  profile: string; // 被删除的配置文件名称
  deleted: boolean; // 是否成功删除
};

/**
 * 删除浏览器配置文件
 * @param baseUrl - 基础API地址
 * @param profile - 要删除的配置文件名称
 * @returns 删除结果信息
 */
export async function browserDeleteProfile(
  baseUrl: string | undefined,
  profile: string,
): Promise<BrowserDeleteProfileResult> {
  return await fetchBrowserJson<BrowserDeleteProfileResult>(
    withBaseUrl(baseUrl, `/profiles/${encodeURIComponent(profile)}`),
    {
      method: "DELETE",
      timeoutMs: 20000,
    },
  );
}

/**
 * 获取浏览器标签页列表
 * @param baseUrl - 基础API地址
 * @param opts - 可选参数，包含配置文件名称
 * @returns 标签页信息列表
 */
export async function browserTabs(
  baseUrl?: string,
  opts?: { profile?: string },
): Promise<BrowserTab[]> {
  const q = buildProfileQuery(opts?.profile);
  const res = await fetchBrowserJson<{ running: boolean; tabs: BrowserTab[] }>(
    withBaseUrl(baseUrl, `/tabs${q}`),
    { timeoutMs: 3000 },
  );
  return res.tabs ?? [];
}

/**
 * 打开新的标签页
 * @param baseUrl - 基础API地址
 * @param url - 要打开的URL
 * @param opts - 可选参数，包含配置文件名称
 * @returns 新打开的标签页信息
 */
export async function browserOpenTab(
  baseUrl: string | undefined,
  url: string,
  opts?: { profile?: string },
): Promise<BrowserTab> {
  const q = buildProfileQuery(opts?.profile);
  return await fetchBrowserJson<BrowserTab>(withBaseUrl(baseUrl, `/tabs/open${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    timeoutMs: 15000,
  });
}

/**
 * 聚焦到指定标签页
 * @param baseUrl - 基础API地址
 * @param targetId - 目标标签页ID
 * @param opts - 可选参数，包含配置文件名称
 */
export async function browserFocusTab(
  baseUrl: string | undefined,
  targetId: string,
  opts?: { profile?: string },
): Promise<void> {
  const q = buildProfileQuery(opts?.profile);
  await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs/focus${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId }),
    timeoutMs: 5000,
  });
}

/**
 * 关闭指定标签页
 * @param baseUrl - 基础API地址
 * @param targetId - 目标标签页ID
 * @param opts - 可选参数，包含配置文件名称
 */
export async function browserCloseTab(
  baseUrl: string | undefined,
  targetId: string,
  opts?: { profile?: string },
): Promise<void> {
  const q = buildProfileQuery(opts?.profile);
  await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs/${encodeURIComponent(targetId)}${q}`), {
    method: "DELETE",
    timeoutMs: 5000,
  });
}

/**
 * 执行标签页批量操作
 * @param baseUrl - 基础API地址
 * @param opts - 操作参数，包含操作类型、索引和配置文件名称
 * @returns 操作结果
 */
export async function browserTabAction(
  baseUrl: string | undefined,
  opts: {
    action: "list" | "new" | "close" | "select";
    index?: number;
    profile?: string;
  },
): Promise<unknown> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson(withBaseUrl(baseUrl, `/tabs/action${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: opts.action,
      index: opts.index,
    }),
    timeoutMs: 10_000,
  });
}

/**
 * 获取页面快照
 * @param baseUrl - 基础API地址
 * @param opts - 快照参数
 * @returns 页面快照结果，支持ARIA结构化格式或AI友好文本格式
 */
export async function browserSnapshot(
  baseUrl: string | undefined,
  opts: {
    format?: "aria" | "ai"; // 快照格式
    targetId?: string; // 目标标签页ID
    limit?: number; // 节点数量限制
    maxChars?: number; // 最大字符数限制
    refs?: "role" | "aria"; // 引用生成方式
    interactive?: boolean; // 是否只包含可交互元素
    compact?: boolean; // 是否使用紧凑格式
    depth?: number; // DOM树遍历深度
    selector?: string; // CSS选择器，只快照指定元素
    frame?: string; // iframe选择器
    labels?: boolean; // 是否包含标签信息
    mode?: "efficient"; // 运行模式
    profile?: string; // 配置文件名称
  },
): Promise<SnapshotResult> {
  const q = new URLSearchParams();
  if (opts.format) {
    q.set("format", opts.format);
  }
  if (opts.targetId) {
    q.set("targetId", opts.targetId);
  }
  if (typeof opts.limit === "number") {
    q.set("limit", String(opts.limit));
  }
  if (typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars)) {
    q.set("maxChars", String(opts.maxChars));
  }
  if (opts.refs === "aria" || opts.refs === "role") {
    q.set("refs", opts.refs);
  }
  if (typeof opts.interactive === "boolean") {
    q.set("interactive", String(opts.interactive));
  }
  if (typeof opts.compact === "boolean") {
    q.set("compact", String(opts.compact));
  }
  if (typeof opts.depth === "number" && Number.isFinite(opts.depth)) {
    q.set("depth", String(opts.depth));
  }
  if (opts.selector?.trim()) {
    q.set("selector", opts.selector.trim());
  }
  if (opts.frame?.trim()) {
    q.set("frame", opts.frame.trim());
  }
  if (opts.labels === true) {
    q.set("labels", "1");
  }
  if (opts.mode) {
    q.set("mode", opts.mode);
  }
  if (opts.profile) {
    q.set("profile", opts.profile);
  }
  return await fetchBrowserJson<SnapshotResult>(withBaseUrl(baseUrl, `/snapshot?${q.toString()}`), {
    timeoutMs: 20000,
  });
}

// 更多操作功能请查看 client-actions.ts 文件
