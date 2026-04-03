# pw-session.ts 浏览器会话管理核心模块分析

## 文件概述

`pw-session.ts` 是 Playwright 浏览器会话管理的核心模块，负责通过 Chrome DevTools Protocol (CDP) 与浏览器进行交互，实现浏览器连接管理、页面状态追踪、页面操作等功能。

**文件路径**: `src/browser/pw-session.ts`

---

## 主要功能模块

### 1. 浏览器连接管理

#### 连接流程图

```
connectBrowser(cdpUrl)
       │
       ▼
┌─────────────────────────────┐
│ 检查缓存 (cachedByCdpUrl)    │ ──存在?──→ 直接返回
└─────────────────────────────┘
       │ 不存在
       ▼
┌─────────────────────────────┐
│ 检查正在连接 (connectingByCdpUrl) │ ──正在连接?──→ await 并返回
└─────────────────────────────┘
       │ 不存在
       ▼
┌─────────────────────────────┐
│    执行连接重试（最多3次）    │
│  • 递增超时: 5s → 7s → 9s   │
│  • 指数退避: 250ms → 500ms   │
│  • rate limit 错误不重试     │
└─────────────────────────────┘
       │
       ▼
┌─────────────────────────────┐
│ 注册断开回调 & 观察浏览器    │
└─────────────────────────────┘
```

**核心特性**:
- **连接缓存**: 相同 CDP URL 不会重复建立连接
- **重试机制**: 最多3次尝试，指数退避延迟
- **Rate Limit 处理**: 检测到 rate limit 错误不重试
- **代理绕过**: 对 loopback CDP 连接绕过代理

---

### 2. 页面状态追踪

#### 状态追踪流程图

```
ensurePageState(page)
       │
       ▼
┌─────────────────────────────┐
│ PageState 已存在? ──是──→ 返回 │
└─────────────────────────────┘
       │ 不存在
       ▼
┌─────────────────────────────┐
│ 创建 PageState 并注册监听器  │
│  • console 消息 (≤500条)    │
│  • pageerror 错误 (≤200条)  │
│  • request/response (≤500条)│
│  • requestfailed 失败       │
└─────────────────────────────┘
```

**事件监听**:
| 事件 | 数据结构 | 限制 |
|------|---------|------|
| `console` | BrowserConsoleMessage | 500条 |
| `pageerror` | BrowserPageError | 200条 |
| `request` | BrowserNetworkRequest | 500条 |
| `response` | 更新 request | - |
| `requestfailed` | 更新 request | - |

---

### 3. 页面查找流程

#### 查找策略流程图

```
findPageByTargetId(browser, targetId, cdpUrl)
                │
                ▼
        ┌───────────────┐
        │ Extension Relay? │──是──→ 通过 HTTP /json/list 查找
        └───────────────┘
                │ 否
                ▼
        ┌───────────────┐
        │ 遍历页面 CDP 查询  │  对每个页面发送 Target.getTargetInfo
        └───────────────┘
                │
                ▼
        ┌───────────────┐
        │ 失败? ──是──→ HTTP /json/list 回退 │
        └───────────────┘
                │
                ▼
        ┌───────────────┐
        │ 单页面降级     │──只有一个页面──→ 返回该页面
        └───────────────┘
```

**查找优先级**:
1. Extension Relay 模式：通过 HTTP /json/list API 查找
2. CDP 直接查询：对每个页面发送 `Target.getTargetInfo`
3. HTTP /json/list 回退
4. 单页面降级：如果只有一个页面则直接返回

---

### 4. Role Refs 管理

#### Role Refs 流程图

```
storeRoleRefsForTarget()
        │
        ▼
┌─────────────────────────────┐
│ 存储到 PageState            │
│ 存储到 roleRefsByTarget (Map)│ LRU 淘汰 (最多50条)
└─────────────────────────────┘

refLocator(page, ref)
        │
        ▼
┌─────────────────────────────┐
│ 标准化 ref (@e1 → e1)       │
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│ e数字格式?                   │
│  • aria 模式 → aria-ref     │
│  • role 模式 → getByRole    │
│ 其他格式 → aria-ref         │
└─────────────────────────────┘
```

**ref 格式支持**:
- `@e1` - role ref 格式（去掉 @ 前缀）
- `ref=e1` - role ref 格式（去掉 ref= 前缀）
- `e1` - role ref 格式
- `aria-ref=xxx` - aria-ref 格式

---

### 5. 强制断开连接

#### 断开流程图

```
forceDisconnectPlaywrightForTarget()
                │
                ▼
        ┌───────────────────────┐
        │ 清除缓存 (cachedByCdpUrl) │
        │ 清除 connecting Promise │
        └───────────────────────┘
                │
                ▼
        ┌───────────────────────┐
        │ tryTerminateExecution │  尝试终止卡住的 JS
        │ (Runtime.terminateExecution) │
        └───────────────────────┘
                │
                ▼
        ┌───────────────────────┐
        │ fire-and-forget       │
        │ browser.close()       │  不 await，避免阻塞
        └───────────────────────┘
```

**问题背景**:
- Playwright 按页面序列化 CDP 命令
- 如果某个操作卡住（如 evaluate），会阻塞该页面的所有后续命令
- 不能安全地取消单个命令，也不希望关闭实际的 Chromium 标签页

**解决方案**:
1. 从缓存中删除连接，使下次调用触发新的 `connectOverCDP`
2. fire-and-forget `browser.close()`（可能卡住但不会阻塞我们）
3. 下次 `connectBrowser()` 创建全新的 CDP WebSocket 连接

**重要**: 不能调用 `Connection.close()`，因为 Playwright 在所有对象间共享单个 Connection，关闭它会破坏整个 Playwright 实例。

---

### 6. 页面操作

| 操作 | 函数 | 说明 |
|------|------|------|
| 列出页面 | `listPagesViaPlaywright()` | 通过 Playwright 连接列出所有页面 |
| 创建页面 | `createPageViaPlaywright()` | 创建新页面并可选导航到 URL |
| 关闭页面 | `closePageByTargetIdViaPlaywright()` | 通过 targetId 关闭页面 |
| 聚焦页面 | `focusPageByTargetIdViaPlaywright()` | 聚焦页面，失败时 CDP 回退 |

---

## 核心数据结构

| 数据结构 | 类型 | 用途 |
|---------|------|------|
| `pageStates` | WeakMap\<Page, PageState\> | 页面级状态（console/errors/requests） |
| `contextStates` | WeakMap\<BrowserContext, ContextState\> | 上下文级状态 |
| `cachedByCdpUrl` | Map\<string, ConnectedBrowser\> | 浏览器连接缓存 |
| `connectingByCdpUrl` | Map\<string, Promise\> | 正在连接中的 Promise |
| `roleRefsByTarget` | Map\<string, RoleRefsCacheEntry\> | Role refs 缓存（LRU） |
| `observedPages` | WeakSet\<Page\> | 已注册事件监听的页面 |
| `observedContexts` | WeakSet\<BrowserContext\> | 已观察的上下文 |

---

## 关键设计模式

### 1. 连接复用
相同 CDP URL 不会重复建立连接，通过 `cachedByCdpUrl` 和 `connectingByCdpUrl` 实现。

### 2. WeakMap 自动清理
使用 `WeakMap` 和 `WeakSet` 存储 Page/BrowserContext 的状态，当对象被 GC 时状态自动清理。

### 3. LRU 缓存
Role refs 缓存使用普通 Map 存储，超过 50 条时淘汰最旧的条目。

### 4. Fire-and-forget
断开连接时不 await，避免在卡住的 CDP 管道上挂起。

### 5. 多重降级策略
页面查找失败时有多种回退方案，确保在各种场景下都能正常工作。

### 6. 观察者模式
通过 `observeBrowser` -> `observeContext` -> `ensurePageState` 层层观察，自动注册事件监听器。

---

## 类型定义

### BrowserConsoleMessage
```typescript
type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
};
```

### BrowserPageError
```typescript
type BrowserPageError = {
  message: string;
  name?: string;
  stack?: string;
  timestamp: string;
};
```

### BrowserNetworkRequest
```typescript
type BrowserNetworkRequest = {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
};
```

### PageState
```typescript
type PageState = {
  console: BrowserConsoleMessage[];
  errors: BrowserPageError[];
  requests: BrowserNetworkRequest[];
  requestIds: WeakMap<Request, string>;
  nextRequestId: number;
  armIdUpload: number;
  armIdDialog: number;
  armIdDownload: number;
  roleRefs?: Record<string, { role: string; name?: string; nth?: number }>;
  roleRefsMode?: "role" | "aria";
  roleRefsFrameSelector?: string;
};
```

---

## 常量配置

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_CONSOLE_MESSAGES` | 500 | 控制台消息最大条数 |
| `MAX_PAGE_ERRORS` | 200 | 页面错误最大条数 |
| `MAX_NETWORK_REQUESTS` | 500 | 网络请求最大条数 |
| `MAX_ROLE_REFS_CACHE` | 50 | Role refs 缓存最大条数 |

---

## 导出函数清单

| 函数 | 导出类型 | 说明 |
|------|---------|------|
| `ensurePageState` | export | 确保页面状态存在 |
| `ensureContextState` | export | 确保上下文状态存在 |
| `rememberRoleRefsForTarget` | export | 记住目标页面的 role refs |
| `storeRoleRefsForTarget` | export | 存储页面 role refs |
| `restoreRoleRefsForTarget` | export | 恢复目标页面的 role refs |
| `getPageForTargetId` | export | 获取目标页面 |
| `refLocator` | export | 根据 ref 字符串获取定位器 |
| `closePlaywrightBrowserConnection` | export | 关闭浏览器连接 |
| `forceDisconnectPlaywrightForTarget` | export | 强制断开目标连接 |
| `listPagesViaPlaywright` | export | 列出所有页面 |
| `createPageViaPlaywright` | export | 创建新页面 |
| `closePageByTargetIdViaPlaywright` | export | 关闭指定页面 |
| `focusPageByTargetIdViaPlaywright` | export | 聚焦指定页面 |

---

## 依赖关系

```
pw-session.ts
├── playwright-core (Browser, BrowserContext, Page, Request, Response)
├── ./cdp-proxy-bypass.js (withNoProxyForCdpUrl)
├── ./cdp.helpers.js (appendCdpPath, fetchJson, getHeadersWithAuth, etc.)
├── ./cdp.js (normalizeCdpWsUrl)
├── ./chrome.js (getChromeWebSocketUrl)
├── ./errors.js (BrowserTabNotFoundError)
├── ./navigation-guard.js (assertBrowserNavigation*)
├── ./pw-session.page-cdp.js (isExtensionRelayCdpEndpoint, withPageScopedCdpClient)
├── ../infra/errors.js (formatErrorMessage)
└── ../infra/net/ssrf.js (SsrFPolicy)
```
