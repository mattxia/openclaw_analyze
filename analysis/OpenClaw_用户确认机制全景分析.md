# OpenClaw 用户确认机制全景分析

OpenClaw 中需要用户确认的场景分为 **四大类**，每类都有独立的触发条件、审批流程和代码实现。

---

## 一、Exec 命令审批（核心机制，最复杂）

### 1.1 触发条件

当 Agent 要执行 shell 命令时，系统会根据 **三层策略** 决定是否需要用户确认：

| 策略维度 | 值 | 含义 |
|----------|-----|------|
| **security** | `deny` | 拒绝所有执行 |
| | `allowlist` | 仅允许白名单中的命令，其余需审批 |
| | `full` | 完全信任，无需审批 |
| **ask** | `always` | 每次执行都要用户确认 |
| | `on-miss` | 命令不在白名单时才需确认（**默认值**） |
| | `off` | 从不询问 |
| **elevated** | `full` | 提权 + 跳过审批 |
| | `ask`/`on` | 提权但保留审批 |
| | `off` | 不提权 |

**核心判断函数** `src/infra/exec-approvals.ts:484`：

```typescript
export function requiresExecApproval(params: {
  ask: ExecAsk;
  security: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
}): boolean {
  return (
    params.ask === "always" ||
    (params.ask === "on-miss" &&
      params.security === "allowlist" &&
      (!params.analysisOk || !params.allowlistSatisfied))
  );
}
```

**额外触发条件**（即使白名单满足也需审批）：
- 命令包含 **heredoc** (`<<`)
- 命令被检测为 **混淆/obfuscation**（obfuscation detection）

代码位置：`src/agents/bash-tools.exec-host-gateway.ts:129`

### 1.2 完整审批流程

```
Agent 调用 exec 工具
    ↓
解析 security / ask / elevated 参数
    ↓
[白名单分析] evaluateShellAllowlist()
    ├── safeBins 检查（jq/grep/cut 等安全二进制）
    ├── allowlist 模式匹配
    └── skills 自动允许（如果 autoAllowSkills=true）
    ↓
requiresExecApproval() 判断是否需要审批
    ↓ 需要
创建审批请求 → 注册到 ExecApprovalManager
    ↓
广播 exec.approval.requested 事件
    ↓
┌─────────────────────────────────────────┐
│         审批客户端接收并展示给用户         │
│  1. macOS App (原生弹窗)                │
│  2. Control UI / Web UI                 │
│  3. Discord (按钮交互)                   │
│  4. Telegram (内联按钮)                  │
│  5. 聊天渠道 /approve 命令               │
│  6. TUI 终端界面                         │
└─────────────────────────────────────────┘
    ↓
用户选择：
  • allow-once → 执行本次
  • allow-always → 加入白名单 + 执行
  • deny → 拒绝
    ↓
调用 exec.approval.resolve
    ↓
广播 exec.approval.resolved
    ↓
执行命令或返回拒绝信息
```

### 1.3 关键文件与代码

| 文件 | 作用 |
|------|------|
| `src/infra/exec-approvals.ts` | 审批核心：类型定义、策略解析、`requiresExecApproval()`、白名单管理 |
| `src/infra/exec-approvals-allowlist.ts` | 白名单评估：`evaluateShellAllowlist()`、safeBins、skillBins |
| `src/infra/exec-approval-reply.ts` | 审批消息构建：`/approve` 命令格式化、审批不可用时的提示 |
| `src/infra/exec-approval-forwarder.ts` | 审批转发：将审批请求转发到 Discord/Telegram 等聊天渠道 |
| `src/infra/exec-approval-surface.ts` | 审批发起面判断：Discord/Telegram 是否启用审批客户端 |
| `src/agents/bash-tools.exec.ts` | exec 工具定义：解析 security/ask/elevated 参数，触发审批流程 |
| `src/agents/bash-tools.exec-host-gateway.ts` | Gateway 主机审批：`processGatewayAllowlist()` 完整审批逻辑 |
| `src/node-host/exec-policy.ts` | 节点主机审批策略：`evaluateSystemRunPolicy()` |
| `src/gateway/server-methods/exec-approval.ts` | Gateway RPC 接口：`exec.approval.request`、`exec.approval.resolve` |
| `src/auto-reply/reply/commands-approve.ts` | `/approve` 聊天命令处理器 |
| `src/infra/exec-host.ts` | 主机执行通信：通过 Unix Socket + HMAC 鉴权发送执行请求 |

### 1.4 exec 工具中的策略解析与审批触发

`src/agents/bash-tools.exec.ts` 中 `createExecTool()` 工厂函数的执行逻辑：

```typescript
// 解析 security 策略
const configuredSecurity = defaults?.security ?? (host === "sandbox" ? "deny" : "allowlist");
const requestedSecurity = normalizeExecSecurity(params.security);
let security = minSecurity(configuredSecurity, requestedSecurity ?? configuredSecurity);

// elevated + full 模式完全绕过安全检查
if (elevatedRequested && elevatedMode === "full") {
  security = "full";
}

// 解析 ask 策略
const configuredAsk = defaults?.ask ?? loadExecApprovals().defaults?.ask ?? "on-miss";
const requestedAsk = normalizeExecAsk(params.ask);
let ask = maxAsk(configuredAsk, requestedAsk ?? configuredAsk);

// elevated + full 模式完全绕过审批
const bypassApprovals = elevatedRequested && elevatedMode === "full";
if (bypassApprovals) {
  ask = "off";
}
```

Gateway 主机执行时，进入 `processGatewayAllowlist()` 进行完整的白名单分析和审批判断：

```typescript
// src/agents/bash-tools.exec-host-gateway.ts
const requiresAsk =
  requiresExecApproval({
    ask: hostAsk,
    security: hostSecurity,
    analysisOk,
    allowlistSatisfied,
  }) ||
  requiresHeredocApproval ||
  obfuscation.detected;

if (requiresAsk) {
  // 创建审批请求，注册到 ExecApprovalManager
  // 广播 exec.approval.requested 事件
  // 等待用户决策...
}
```

### 1.5 macOS App 原生审批

macOS 配套应用通过 Gateway WebSocket 监听 `exec.approval.requested` 事件，展示原生弹窗：

`apps/macos/Sources/OpenClaw/ExecApprovalsGatewayPrompter.swift:67-83`：

```swift
let decision = ExecApprovalsPromptPresenter.prompt(request.request)
try await GatewayConnection.shared.requestVoid(
    method: .execApprovalResolve,
    params: [
        "id": AnyCodable(request.id),
        "decision": AnyCodable(decision.rawValue),
    ],
    timeoutMs: 10000)
```

展示决策逻辑 `apps/macos/Sources/OpenClaw/ExecApprovals.swift:746-755`：

```swift
static func requiresAsk(
    ask: ExecAsk,
    security: ExecSecurity,
    allowlistMatch: ExecAllowlistEntry?,
    skillAllow: Bool) -> Bool
{
    if ask == .always { return true }
    if ask == .onMiss, security == .allowlist, allowlistMatch == nil, !skillAllow { return true }
    return false
}
```

macOS 展示决策还考虑当前活跃会话和用户最近输入时间：

```swift
private func shouldPresent(request: GatewayApprovalRequest) -> PresentationDecision {
    let approvals = ExecApprovalsStore.resolveReadOnly(agentId: request.request.agentId)
    let security = approvals.agent.security
    let ask = approvals.agent.ask

    let shouldAsk = Self.shouldAsk(security: security, ask: ask)

    // 判断是否可以展示：需要当前活跃会话匹配 + 用户在 120 秒内有输入
    let canPresent = shouldAsk && Self.shouldPresent(
        mode: mode,
        activeSession: activeSession,
        requestSession: requestSession,
        lastInputSeconds: Self.lastInputSeconds(),
        thresholdSeconds: 120)

    return PresentationDecision(
        shouldAsk: shouldAsk,
        canPresent: canPresent,
        security: security,
        askFallback: approvals.agent.askFallback,
        allowlist: approvals.allowlist)
}
```

### 1.6 审批超时与回退

- 默认超时：**120秒**（`DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 120_000`）
- 超时后按 `askFallback` 策略处理（默认 `deny`）
- 如果没有可用的审批客户端（无 UI、无聊天渠道），也按 `askFallback` 回退
- `askFallback=allowlist` 时超时会尝试白名单匹配，匹配则自动放行

回退逻辑 `apps/macos/Sources/OpenClaw/ExecApprovalsGatewayPrompter.swift:139-150`：

```swift
private static func fallbackDecision(
    request: ExecApprovalPromptRequest,
    askFallback: ExecSecurity,
    allowlist: [ExecAllowlistEntry]) -> ExecApprovalDecision
{
    guard askFallback == .allowlist else {
        return askFallback == .full ? .allowOnce : .deny
    }
    let resolution = self.fallbackResolution(for: request)
    let match = ExecAllowlistMatcher.match(entries: allowlist, resolution: resolution)
    return match == nil ? .deny : .allowOnce
}
```

### 1.7 审批转发到聊天渠道

审批请求可以转发到 Discord/Telegram 等聊天渠道，用户通过 `/approve` 命令回复：

`src/auto-reply/reply/commands-approve.ts` 中的 `/approve` 命令解析：

```typescript
const DECISION_ALIASES: Record<string, "allow-once" | "allow-always" | "deny"> = {
  allow: "allow-once",
  once: "allow-once",
  "allow-once": "allow-once",
  always: "allow-always",
  "allow-always": "allow-always",
  deny: "deny",
  reject: "deny",
  block: "deny",
};
```

用户在聊天中回复格式：
```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

审批转发配置：
```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"],
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

### 1.8 审批消息格式

`src/infra/exec-approval-reply.ts` 中 `buildExecApprovalPendingReplyPayload()` 生成的审批提示消息格式：

```
Approval required.
Run:
```txt
/approve <slug> allow-once
```
Pending command:
```sh
<command>
```
Other options:
```txt
/approve <slug> allow-always
/approve <slug> deny
```

Host: gateway
CWD: /path/to/dir
Expires in: 120s
Full id: `<full-approval-id>`
```

### 1.9 白名单评估机制

`src/infra/exec-approvals-allowlist.ts` 中的白名单评估涵盖多个维度：

```typescript
function evaluateSegments(
  segments: ExecCommandSegment[],
  params: ExecAllowlistContext,
): { satisfied: boolean; segmentSatisfiedBy: ExecSegmentSatisfiedBy[] }
```

每个命令段（`;` `&&` `||` 分隔）独立评估，通过以下三种方式之一满足：

1. **allowlist 匹配**：命令路径与 allowlist 中的 glob 模式匹配
2. **safeBins**：命令是已知安全二进制（如 jq、grep）且在受信任路径下，且参数通过 hardened profile 验证
3. **skills 自动允许**：`autoAllowSkills=true` 且命令来自已注册的 skill 二进制

### 1.10 节点主机审批策略

`src/node-host/exec-policy.ts` 中的 `evaluateSystemRunPolicy()` 在节点主机上执行额外的策略判断：

```typescript
export function evaluateSystemRunPolicy(params: {
  security: ExecSecurity;
  ask: ExecAsk;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  approvalDecision: ExecApprovalDecision;
  approved?: boolean;
  isWindows: boolean;
  cmdInvocation: boolean;
  shellWrapperInvocation: boolean;
}): SystemRunPolicyDecision {
  // shell wrapper（sh -c / bash -c / cmd.exe /c）在 allowlist 模式下被阻止
  const shellWrapperBlocked = params.security === "allowlist" && params.shellWrapperInvocation;

  // security=deny 直接拒绝
  if (params.security === "deny") {
    return { allowed: false, eventReason: "security=deny", ... };
  }

  // 需要审批但未获批准
  const requiresAsk = requiresExecApproval({...});
  if (requiresAsk && !approvedByAsk) {
    return { allowed: false, eventReason: "approval-required", ... };
  }

  // allowlist 不满足且未获批准
  if (params.security === "allowlist" && (!analysisOk || !allowlistSatisfied) && !approvedByAsk) {
    return { allowed: false, eventReason: "allowlist-miss", ... };
  }

  return { allowed: true, ... };
}
```

---

## 二、ACP（Agent Client Protocol）工具调用审批

### 2.1 触发条件

当外部 ACP 客户端调用工具时，系统根据工具类型决定是否需要用户确认：

`src/security/dangerous-tools.ts:28-39`：

```typescript
export const DANGEROUS_ACP_TOOL_NAMES = [
  "exec", "spawn", "shell",
  "sessions_spawn", "sessions_send",
  "gateway",
  "fs_write", "fs_delete", "fs_move",
  "apply_patch",
] as const;

export const DANGEROUS_ACP_TOOLS = new Set<string>(DANGEROUS_ACP_TOOL_NAMES);
```

**自动批准的安全工具**：`read`、`search`、`web_search`、`memory_search`

```typescript
const SAFE_AUTO_APPROVE_TOOL_IDS = new Set(["read", "search", "web_search", "memory_search"]);
```

另外，Gateway HTTP 接口默认拒绝的高风险工具：

```typescript
export const DEFAULT_GATEWAY_HTTP_TOOL_DENY = [
  "sessions_spawn",
  "sessions_send",
  "cron",
  "gateway",
  "whatsapp_login",
] as const;
```

### 2.2 审批流程

`src/acp/client.ts` 中 `resolvePermissionRequest()` 函数：

```typescript
export async function resolvePermissionRequest(
  params: RequestPermissionRequest,
  deps: PermissionResolverDeps = {},
): Promise<RequestPermissionResponse> {
  const toolName = resolveToolNameForPermission(params);
  const autoApproveAllowed = shouldAutoApproveToolCall(params, toolName, toolTitle, cwd);
  const promptRequired = !toolName || !autoApproveAllowed || DANGEROUS_ACP_TOOLS.has(toolName);

  if (!promptRequired) {
    // 自动批准安全工具
    return selectedPermission(allowOption.optionId);
  }

  // 需要用户确认：弹出终端提示
  const approved = await prompt(toolName, toolTitle);

  if (approved && allowOption) {
    return selectedPermission(allowOption.optionId);
  }
  if (!approved && rejectOption) {
    return selectedPermission(rejectOption.optionId);
  }

  return cancelledPermission();
}
```

### 2.3 终端交互式确认

`src/acp/client.ts:210-232`：

```typescript
function promptUserPermission(toolName: string | undefined, toolTitle?: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    console.error(`[permission denied] ${toolName ?? "unknown"}: non-interactive terminal`);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    const timeout = setTimeout(() => {
      console.error(`\n[permission timeout] denied: ${toolName ?? "unknown"}`);
      finish(false);
    }, 30_000);

    const label = toolTitle
      ? toolName
        ? `${toolTitle} (${toolName})`
        : toolTitle
      : (toolName ?? "unknown tool");
    rl.question(`\n[permission] Allow "${label}"? (y/N) `, (answer) => {
      const approved = answer.trim().toLowerCase() === "y";
      console.error(`[permission ${approved ? "approved" : "denied"}] ${toolName ?? "unknown"}`);
      finish(approved);
    });
  });
}
```

**特点**：
- 非交互式终端直接拒绝
- 30秒超时自动拒绝
- 用户输入 `y` 批准，其他输入均拒绝

### 2.4 关键文件

| 文件 | 作用 |
|------|------|
| `src/security/dangerous-tools.ts` | 定义危险工具列表 `DANGEROUS_ACP_TOOLS` 和 HTTP 拒绝列表 |
| `src/acp/client.ts` | ACP 权限解析：`resolvePermissionRequest()`、终端提示、自动批准逻辑 |
| `src/acp/policy.ts` | ACP 策略：是否启用、Agent 白名单、dispatch 控制 |

### 2.5 ACP 策略控制

`src/acp/policy.ts`：

```typescript
export function isAcpEnabledByPolicy(cfg: OpenClawConfig): boolean {
  return cfg.acp?.enabled !== false;
}

export function isAcpAgentAllowedByPolicy(cfg: OpenClawConfig, agentId: string): boolean {
  const allowed = (cfg.acp?.allowedAgents ?? [])
    .map((entry) => normalizeAgentId(entry))
    .filter(Boolean);
  if (allowed.length === 0) {
    return true;
  }
  return allowed.includes(normalizeAgentId(agentId));
}
```

---

## 三、设备配对确认

### 3.1 触发条件

新设备（手机、其他电脑）首次连接 Gateway 时，需要操作员确认配对请求。

### 3.2 审批流程

```
设备发送配对请求（publicKey + deviceId + displayName）
    ↓
生成 DevicePairingPendingRequest，存入 pending 列表
    ↓
通过 Gateway 广播给操作员客户端
    ↓
操作员在 Web UI / macOS App 中确认
    ↓
配对通过 → 生成 DeviceAuthToken → 设备获得访问权限
配对拒绝 → 删除 pending 请求
```

### 3.3 关键数据结构

`src/infra/device-pairing.ts`：

```typescript
export type DevicePairingPendingRequest = {
  requestId: string;
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  silent?: boolean;
  isRepair?: boolean;
  ts: number;
};

export type PairedDevice = {
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  approvedScopes?: string[];
  remoteIp?: string;
  tokens?: Record<string, DeviceAuthToken>;
  createdAtMs: number;
  approvedAtMs: number;
};
```

### 3.4 关键文件

| 文件 | 作用 |
|------|------|
| `src/infra/device-pairing.ts` | 设备配对核心：`DevicePairingPendingRequest`、`PairedDevice`、token 生成 |
| `src/pairing/pairing-store.ts` | 配对状态存储 |
| `src/pairing/pairing-messages.ts` | 配对消息处理 |
| `src/pairing/pairing-token.ts` | 配对 token 生成与验证 |

---

## 四、Tlon 频道社交审批

### 4.1 触发条件

Tlon（Urbit 协议）扩展中，当未知用户尝试与机器人交互时：

- **DM（私聊）**：陌生 ship 发送私信
- **Channel mention**：陌生 ship 在频道中 @提及机器人
- **Group invite**：陌生 ship 邀请机器人加入群组

### 4.2 审批流程

```
陌生 ship 发起交互
    ↓
创建 PendingApproval（type: dm/channel/group）
    ↓
通知机器人所有者（格式化审批请求）
    ↓
所有者回复 "approve"/"deny"/"block"
    ↓
approve → 允许交互
deny → 拒绝本次
block → 永久拉黑该 ship
```

`extensions/tlon/src/monitor/approval.ts`：

```typescript
export function formatApprovalRequest(approval: PendingApproval): string {
  const preview = approval.messagePreview ? `\n"${truncate(approval.messagePreview, 100)}"` : "";

  switch (approval.type) {
    case "dm":
      return (
        `New DM request from ${approval.requestingShip}:${preview}\n\n` +
        `Reply "approve", "deny", or "block" (ID: ${approval.id})`
      );
    case "channel":
      return (
        `${approval.requestingShip} mentioned you in ${approval.channelNest}:${preview}\n\n` +
        `Reply "approve", "deny", or "block"\n(ID: ${approval.id})`
      );
    case "group":
      return (
        `Group invite from ${approval.requestingShip} to join ${approval.groupFlag}\n\n` +
        `Reply "approve", "deny", or "block"\n(ID: ${approval.id})`
      );
  }
}
```

审批响应解析：

```typescript
export function parseApprovalResponse(text: string): ApprovalResponse | null {
  const trimmed = text.trim().toLowerCase();
  const match = trimmed.match(/^(approve|deny|block)(?:\s+(.+))?$/);
  if (!match) { return null; }
  const action = match[1] as "approve" | "deny" | "block";
  const id = match[2]?.trim();
  return { action, id };
}
```

### 4.3 关键文件

| 文件 | 作用 |
|------|------|
| `extensions/tlon/src/monitor/approval.ts` | Tlon 审批核心：类型定义、请求创建、响应解析、格式化 |

---

## 五、其他确认场景

### 5.1 macOS 系统权限确认

`apps/macos/Sources/OpenClaw/PermissionManager.swift` 触发 macOS TCC 权限弹窗：

- **Automation 权限**（AppleScript / 辅助功能控制）
- **屏幕录制权限**（`CGRequestScreenCaptureAccess()`）

```swift
@MainActor
static func requestAuthorization() async {
    _ = self.isAuthorized() // 首次调用触发系统对话框
    // 打开系统设置帮助用户
    let urlStrings = [
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
        "x-apple.systempreferences:com.apple.preference.security",
    ]
    for candidate in urlStrings {
        if let url = URL(string: candidate), NSWorkspace.shared.open(url) {
            break
        }
    }
}
```

### 5.2 Gateway TLS 信任确认

`apps/ios/Sources/Gateway/GatewayConnectionController.swift:242-285`：首次 TLS 连接时的证书指纹确认（TOFU - Trust On First Use）：

```swift
func acceptPendingTrustPrompt() async {
    guard let pending = self.pendingTrustConnect,
          let prompt = self.pendingTrustPrompt,
          pending.stableID == prompt.stableID
    else { return }
    GatewayTLSStore.saveFingerprint(prompt.fingerprintSha256, stableID: pending.stableID)
    self.clearPendingTrustPrompt()
    // 使用保存的指纹重新连接...
}
```

### 5.3 Setup/Onboarding 交互式确认

CLI 配置向导中通过 `WizardPrompter` 进行各种确认（如保留已有配置、输入密钥等），见 `src/wizard/` 目录下的文件：

- `src/wizard/onboarding.ts` — 入门向导主流程
- `src/wizard/prompts.ts` — 提示构建
- `src/wizard/clack-prompter.ts` — 交互式终端提示器

---

## 六、Elevated 模式与审批的关系

Elevated（提权）是 exec 工具的专属逃逸通道，与审批机制紧密关联：

| Elevated 模式 | 行为 | 审批影响 |
|---------------|------|----------|
| `off` | 不提权，在沙箱中执行 | 正常审批流程 |
| `ask`/`on` | 提权到主机执行 | **保留审批流程** |
| `full` | 提权到主机执行 | **跳过审批**（security=full, ask=off） |

关键代码 `src/agents/bash-tools.exec.ts`：

```typescript
const elevatedRequested = elevatedMode !== "off";

if (elevatedRequested) {
  host = "gateway";  // 强制在主机执行
}

if (elevatedRequested && elevatedMode === "full") {
  security = "full";  // 完全信任
}

const bypassApprovals = elevatedRequested && elevatedMode === "full";
if (bypassApprovals) {
  ask = "off";  // 跳过审批
}
```

Elevated 的可用性还受以下门控约束：
- `tools.elevated.enabled`（功能开关）
- `tools.elevated.allowFrom.<provider>`（发送者白名单）
- `agents.list[].tools.elevated.enabled`（每 Agent 门控）
- `agents.list[].tools.elevated.allowFrom`（每 Agent 白名单）

---

## 七、整体架构总结

```
┌───────────────────────────────────────────────────────────────┐
│                      用户确认场景总览                           │
├──────────────────┬──────────────────┬─────────────────────────┤
│  Exec 命令审批    │  ACP 工具审批     │  设备配对 / 社交审批     │
│  (最核心最复杂)   │  (自动化接口)     │  (连接/交互控制)         │
├──────────────────┼──────────────────┼─────────────────────────┤
│ security=deny    │ DANGEROUS_ACP_   │ DevicePairingPending    │
│ security=allowlist│ TOOLS.has(name)  │ Tlon Approval           │
│ ask=always       │ 自动批准安全工具   │ TLS TOFU                │
│ ask=on-miss      │ 终端 y/N 确认     │ macOS TCC               │
│ heredoc/混淆命令  │                  │                         │
├──────────────────┼──────────────────┼─────────────────────────┤
│ 审批客户端:       │ 终端交互式提示     │ Web UI / macOS App      │
│ • macOS App弹窗  │                  │ 聊天回复                 │
│ • Web UI        │                  │                         │
│ • Discord 按钮   │                  │                         │
│ • Telegram 按钮  │                  │                         │
│ • /approve 命令  │                  │                         │
│ • TUI            │                  │                         │
├──────────────────┼──────────────────┼─────────────────────────┤
│ 超时: 120s       │ 超时: 30s        │ 超时: 5min              │
│ 回退: deny       │ 回退: deny       │ 回退: 过期清理           │
└──────────────────┴──────────────────┴─────────────────────────┘
```

**核心设计原则**：

1. **分层校验**：security → allowlist → ask → 用户确认，逐层过滤
2. **可配置性**：所有策略均可通过 `openclaw.json` 或 `exec-approvals.json` 调整
3. **多客户端审批**：审批请求可同时推送到多个 UI 表面，任一客户端均可处理
4. **优雅降级**：无可用审批客户端时按 `askFallback` 回退（默认拒绝）
5. **白名单持久化**：`allow-always` 决策会写入白名单，后续同类命令自动放行
6. **每 Agent 隔离**：白名单和策略按 Agent 隔离，防止审批跨 Agent 泄漏
7. **混淆检测**：即使白名单满足，混淆命令和 heredoc 仍需显式审批

---

## 八、关键文件索引

### Exec 审批核心
- `src/infra/exec-approvals.ts` — 类型定义、策略解析、白名单管理
- `src/infra/exec-approvals-allowlist.ts` — 白名单评估
- `src/infra/exec-approval-reply.ts` — 审批消息构建
- `src/infra/exec-approval-forwarder.ts` — 审批转发到聊天渠道
- `src/infra/exec-approval-surface.ts` — 审批发起面判断
- `src/infra/exec-approval-command-display.ts` — 命令显示文本处理
- `src/infra/exec-approval-session-target.ts` — 审批会话目标解析
- `src/infra/exec-host.ts` — 主机执行通信（Unix Socket + HMAC）
- `src/infra/exec-safe-bin-runtime-policy.ts` — 安全二进制运行时策略
- `src/infra/exec-command-resolution.ts` — 命令解析
- `src/infra/system-run-approval-binding.ts` — 审批绑定
- `src/infra/system-run-approval-context.ts` — 审批上下文

### exec 工具实现
- `src/agents/bash-tools.exec.ts` — exec 工具工厂函数
- `src/agents/bash-tools.exec-host-gateway.ts` — Gateway 主机审批
- `src/agents/bash-tools.exec-host-node.ts` — Node 主机审批
- `src/agents/bash-tools.exec-approval-request.ts` — 审批请求注册
- `src/agents/bash-tools.exec-host-shared.ts` — 审批共享逻辑
- `src/agents/bash-tools.exec-runtime.ts` — 运行时参数处理

### Gateway 服务端
- `src/gateway/server-methods/exec-approval.ts` — RPC 接口
- `src/gateway/exec-approval-manager.ts` — 审批管理器

### 聊天命令
- `src/auto-reply/reply/commands-approve.ts` — `/approve` 命令

### ACP 审批
- `src/acp/client.ts` — ACP 权限解析与终端提示
- `src/acp/policy.ts` — ACP 策略控制
- `src/security/dangerous-tools.ts` — 危险工具列表

### 设备配对
- `src/infra/device-pairing.ts` — 设备配对核心
- `src/pairing/pairing-store.ts` — 配对存储
- `src/pairing/pairing-messages.ts` — 配对消息

### macOS/iOS 客户端
- `apps/macos/Sources/OpenClaw/ExecApprovals.swift` — macOS 审批核心
- `apps/macos/Sources/OpenClaw/ExecApprovalsGatewayPrompter.swift` — macOS Gateway 审批提示
- `apps/macos/Sources/OpenClaw/PermissionManager.swift` — macOS 系统权限
- `apps/ios/Sources/Gateway/GatewayConnectionController.swift` — iOS TLS 信任确认

### Tlon 扩展
- `extensions/tlon/src/monitor/approval.ts` — Tlon 社交审批

### Discord/Telegram 审批客户端
- `extensions/discord/src/monitor/exec-approvals.ts` — Discord 审批客户端
- `extensions/telegram/src/exec-approvals-handler.ts` — Telegram 审批客户端
