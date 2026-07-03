# OpenClaw 远端审批确认授权机制分析

## 概述

OpenClaw 的命令执行审批机制是一套**多通道、多层级**的设计，允许用户在本地或远端对智能体发起的命令执行请求进行审批确认。核心架构覆盖从本地 IPC 到聊天渠道远端审批的完整链路。

## 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│  审批发起方（Node.js 进程 / Node Service）                         │
│  exec-approvals.ts → requestExecApprovalViaSocket()              │
│         │                                                        │
│         │  Unix 域套接字 (JSONL 协议)                              │
│         ▼                                                        │
│  ┌─────────────────────────────────────────┐                     │
│  │  macOS App — ExecApprovalsSocketServer  │  ◄── 本地 IPC 通道  │
│  │  （监听 UDS，弹窗展示，返回决策）         │                     │
│  └─────────────────────────────────────────┘                     │
│                                                                  │
│  ┌─────────────────────────────────────────┐                     │
│  │  Gateway — 审批广播与汇聚中心            │  ◄── 远端审批通道   │
│  │  exec.approval.requested（广播事件）      │                     │
│  │  exec.approval.resolve   （决策回收）     │                     │
│  └──────────┬──────────┬──────────────────┘                     │
│             │          │                                          │
│      ┌──────┘    ┌─────┘                                         │
│      ▼           ▼                                               │
│  ┌────────┐  ┌─────────┐                                        │
│  │Discord │  │Telegram │   聊天渠道审批客户端                      │
│  └────────┘  └─────────┘                                        │
└──────────────────────────────────────────────────────────────────┘
```

## 三条审批通道

### 通道一：本地 Unix 域套接字（UDS）IPC

这是 `exec-approvals.ts` 中 `requestExecApprovalViaSocket()` 实现的本地审批路径，适用于用户在本机面前的场景。

#### 1.1 通信协议层 — `jsonl-socket.ts`

**文件位置**: `src/infra/jsonl-socket.ts`

底层使用 Node.js `net.Socket` 连接到 `~/.openclaw/exec-approvals.sock`，协议为 JSONL（每行一个 JSON 对象，以 `\n` 分隔）：

**发送消息格式**:
```json
{
  "type": "request",
  "token": "<base64url-token>",
  "id": "<uuid>",
  "request": { /* ExecApprovalRequestPayload */ }
}
```

**接收响应格式**:
```json
{
  "type": "decision",
  "id": "<uuid>",
  "decision": "allow-once" | "allow-always" | "deny"
}
```

**核心实现逻辑**:

```typescript
// jsonl-socket.ts — requestJsonlSocket()
export async function requestJsonlSocket<T>(params: {
  socketPath: string;
  payload: string;
  timeoutMs: number;
  accept: (msg: unknown) => T | null | undefined;
}): Promise<T | null> {
  // 1. 创建 TCP/UDS Socket 客户端
  // 2. 连接到 socketPath
  // 3. 发送 payload + "\n"
  // 4. 逐行读取缓冲区，解析 JSON
  // 5. 用 accept() 回调过滤，匹配则返回
  // 6. 超时返回 null
}
```

**关键特性**:
- 超时保护：默认 15 秒，超时返回 `null`（视为拒绝）
- 错误容忍：socket 错误、JSON 解析失败均返回 `null`
- 行缓冲：支持 TCP 粘包场景下的逐行解析

#### 1.2 服务端 — macOS App `ExecApprovalsSocketServer`

**文件位置**: `apps/macos/Sources/OpenClaw/ExecApprovalsSocket.swift`

Swift 实现的 Unix 域套接字服务器，核心流程：

```
bind() → listen() → accept() → handleClient()
                               ├─ isAllowedPeer(fd)       // 同 UID 校验
                               ├─ 验证 token 匹配
                               ├─ type=="request" → onPrompt() → 弹窗 → 返回 decision
                               └─ type=="exec"    → onExec()   → 执行命令 → 返回结果
```

**`handleClient` 的完整逻辑**:

```swift
private func handleClient(fd: Int32) async {
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    
    // 1. 同 UID 校验
    guard self.isAllowedPeer(fd: fd) else {
        try self.sendApprovalResponse(handle: handle, id: UUID().uuidString, decision: .deny)
        return
    }
    
    // 2. 读取一行 JSONL
    guard let line = try readLineFromHandle(handle, maxBytes: 256_000),
          let data = line.data(using: .utf8) else { return }
    
    // 3. 解析消息类型
    guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = envelope["type"] as? String else { return }
    
    // 4. type == "request" → 审批提示
    if type == "request" {
        let request = try JSONDecoder().decode(ExecApprovalSocketRequest.self, from: data)
        // Token 校验
        guard request.token == self.token else {
            try self.sendApprovalResponse(handle: handle, id: request.id, decision: .deny)
            return
        }
        // 弹窗等待用户决策
        let decision = await self.onPrompt(request.request)
        try self.sendApprovalResponse(handle: handle, id: request.id, decision: decision)
        return
    }
    
    // 5. type == "exec" → 命令执行（需 HMAC 验证）
    if type == "exec" {
        let request = try JSONDecoder().decode(ExecHostSocketRequest.self, from: data)
        let response = await self.handleExecRequest(request)
        try self.sendExecResponse(handle: handle, response: response)
        return
    }
}
```

**安全措施汇总**:

| 安全层 | 实现方式 | 代码位置 |
|--------|----------|----------|
| 同 UID 校验 | `getpeereid()` 检查对端进程 UID | `isAllowedPeer(fd:)` |
| Token 认证 | 请求 token 与 `exec-approvals.json` 中存储值比对 | `handleClient` 中的 `request.token == self.token` |
| HMAC 签名 | `exec` 类型请求使用 `nonce + HMAC + TTL` 三重校验 | `handleExecRequest()` |
| 文件权限 | socket 文件 `0600`，配置文件 `0600` | `bindAndListen()` + `saveExecApprovals()` |
| 防重放 | 时间戳 TTL（10 秒窗口）+ 随机 nonce | `handleExecRequest()` |

**HMAC 验证流程（exec 类型）**:

```swift
private func handleExecRequest(_ request: ExecHostSocketRequest) async -> ExecHostResponse {
    // 1. TTL 检查：请求时间戳与当前时间差不超过 10 秒
    let nowMs = Int(Date().timeIntervalSince1970 * 1000)
    if abs(nowMs - request.ts) > 10000 {
        return errorResponse(code: "INVALID_REQUEST", message: "expired request", reason: "ttl")
    }
    
    // 2. HMAC 验证：用 token 作密钥，对 nonce + ts + requestJson 计算摘要
    let expected = self.hmacHex(nonce: request.nonce, ts: request.ts, requestJson: request.requestJson)
    if expected != request.hmac {
        return errorResponse(code: "INVALID_REQUEST", message: "invalid auth", reason: "hmac")
    }
    
    // 3. 解码并执行
    guard let requestData = request.requestJson.data(using: .utf8),
          let payload = try? JSONDecoder().decode(ExecHostRequest.self, from: requestData) else {
        return errorResponse(code: "INVALID_REQUEST", message: "invalid payload", reason: "json")
    }
    let response = await self.onExec(payload)
    return ExecHostResponse(type: "exec-res", id: request.id, ok: response.ok, ...)
}
```

#### 1.3 用户交互 — `ExecApprovalsPromptPresenter.prompt()`

macOS App 在 MainActor 上弹出原生确认对话框，展示以下信息：

- 命令 + 参数
- 工作目录（cwd）
- 智能体 ID（agentId）
- 解析后的可执行文件路径（resolvedPath）
- 主机 + 策略元数据

用户可选择：
- **Allow once** — 允许本次执行
- **Always allow** — 添加到允许列表 + 允许本次
- **Deny** — 拒绝

---

### 通道二：Gateway 广播 → 远端聊天渠道

这是**真正的"远端"确认**路径，适用于用户不在本机面前的场景。

#### 2.1 Gateway 审批广播机制

当需要审批时，Gateway 通过 WebSocket 协议广播 `exec.approval.requested` 事件给所有 operator 客户端：

```
Gateway ──(WebSocket)──→ macOS App (ExecApprovalsGatewayPrompter)
                      ──→ Discord 审批客户端
                      ──→ Telegram 审批客户端
                      ──→ Control UI
                      ──→ 任何配置了 approvals 的聊天渠道
```

**协议规范**（来自 `docs/gateway/protocol.md`）：

- Gateway 广播 `exec.approval.requested` 事件给所有 operator 客户端
- Operator 客户端通过 `exec.approval.resolve` RPC 方法回传决策（需要 `operator.approvals` 权限）
- 对于 `host=node`，审批请求必须包含 `systemRunPlan` 载荷

#### 2.2 macOS App 的 Gateway 通道 — `ExecApprovalsGatewayPrompter`

**文件位置**: `apps/macos/Sources/OpenClaw/ExecApprovalsGatewayPrompter.swift`

监听 Gateway 推送的 `exec.approval.requested` 事件，判断逻辑：

```
收到 exec.approval.requested 事件
  │
  ├─ shouldAsk == false?
  │   └─ 是 → 按 security 策略自动决定
  │       ├─ security == "full"     → decision = allowOnce
  │       └─ security == "deny"     → decision = deny
  │
  ├─ canPresent == false?（用户不活跃 > 120秒）
  │   └─ 是 → 按 askFallback 兜底决定
  │       ├─ askFallback == "full"       → allowOnce
  │       ├─ askFallback == "deny"       → deny
  │       └─ askFallback == "allowlist"  → 检查允许列表
  │           ├─ 匹配 → allowOnce
  │           └─ 不匹配 → deny
  │
  └─ canPresent == true → 弹窗展示
      └─ 用户选择后调用 exec.approval.resolve
```

**决策回传实现**：

```swift
// 通过 Gateway WebSocket RPC 回传决策
try await GatewayConnection.shared.requestVoid(
    method: .execApprovalResolve,
    params: [
        "id": AnyCodable(request.id),
        "decision": AnyCodable(decision.rawValue),
    ],
    timeoutMs: 10000)
```

**`shouldPresent` 判断细节**：

```swift
private func shouldPresent(request: GatewayApprovalRequest) -> PresentationDecision {
    let mode = AppStateStore.shared.connectionMode
    let activeSession = WebChatManager.shared.activeSessionKey
    let requestSession = request.request.sessionKey
    
    let approvals = ExecApprovalsStore.resolveReadOnly(agentId: request.request.agentId)
    let security = approvals.agent.security
    let ask = approvals.agent.ask
    
    // 1. 根据策略判断是否需要询问
    let shouldAsk = Self.shouldAsk(security: security, ask: ask)
    
    // 2. 根据用户活跃度判断是否能弹出 UI
    //    如果用户最近 120 秒内有输入，则认为可以弹出
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

#### 2.3 Discord 审批客户端 — `DiscordExecApprovalHandler`

**文件位置**: `extensions/discord/src/monitor/exec-approvals.ts`

**启动流程**：

```typescript
async start(): Promise<void> {
    // 1. 检查配置是否启用
    if (!config.enabled || !config.approvers?.length) return;
    
    // 2. 创建 Gateway WebSocket 客户端
    this.gatewayClient = await createOperatorApprovalsGatewayClient({
        config: this.opts.cfg,
        gatewayUrl: this.opts.gatewayUrl,
        clientDisplayName: "Discord Exec Approvals",
        onEvent: (evt) => this.handleGatewayEvent(evt),
    });
    
    // 3. 连接 Gateway
    this.gatewayClient.start();
}
```

**事件处理**：

```typescript
private handleGatewayEvent(evt: EventFrame): void {
    if (evt.event === "exec.approval.requested") {
        // 收到审批请求 → 在 Discord 中发送审批卡片
        void this.handleApprovalRequested(evt.payload);
    } else if (evt.event === "exec.approval.resolved") {
        // 审批已解决 → 更新 Discord 消息状态
        void this.handleApprovalResolved(evt.payload);
    }
}
```

**审批卡片交互**：

- 在 Discord 中发送带按钮的审批卡片（DM 或频道消息）
- 按钮包含 `allow-once`、`allow-always`、`deny` 三种操作
- 只有配置的 `approvers` 才能点击按钮授权
- 点击后调用 `gatewayClient.request("exec.approval.resolve", { id, decision })` 回传决策
- 收到 `exec.approval.resolved` 事件后更新卡片为最终状态

**按钮权限校验**：

```typescript
async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    // 验证用户是否为授权审批者
    const approvers = this.ctx.handler.getApprovers();
    const userId = interaction.userId;
    if (!approvers.some((id) => String(id) === userId)) {
        await interaction.reply({
            content: "⛔ You are not authorized to approve exec requests.",
            ephemeral: true,
        });
        return;
    }
    // 立即确认交互（避免 Discord 交互超时）
    await interaction.acknowledge();
    // 通过 Gateway 回传决策
    await this.ctx.handler.resolveApproval(parsed.approvalId, parsed.action);
}
```

**决策回传**：

```typescript
async resolveApproval(approvalId: string, decision: ExecApprovalDecision): Promise<boolean> {
    await this.gatewayClient.request("exec.approval.resolve", {
        id: approvalId,
        decision,
    });
    return true;
}
```

#### 2.4 Telegram 审批客户端 — `TelegramExecApprovalsHandler`

**文件位置**: `extensions/telegram/src/exec-approvals-handler.ts`

与 Discord 客户端同理，连接 Gateway 后监听事件：

- 收到 `exec.approval.requested` → 在 Telegram 中发送审批提示
- 用户通过 `/approve <id> allow-once|allow-always|deny` 回复决策
- Telegram 默认发送到审批者 DM（`target: "dm"`），也可配置为 `channel` 或 `both`
- 对于 Telegram Forum Topics，审批提示和审批后跟进消息会保持同一 Topic

---

### 通道三：聊天渠道转发 `/approve` 命令

除了专用的审批客户端，任何聊天渠道都可以转发审批提示，用户通过 `/approve` 命令回复。

**配置示例**：

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session",        // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"],  // 子串或正则
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

**用户回复格式**：

```
/approve <approval-id> allow-once
/approve <approval-id> allow-always
/approve <approval-id> deny
```

**共享行为规则**：
- 只有配置的审批者（approvers）可以批准或拒绝
- 请求发起者不需要是审批者
- 当渠道投递启用时，审批提示包含命令文本
- 如果没有任何操作员 UI 或配置的审批客户端可以接受请求，则回退到 `askFallback`

---

## 完整审批流程

```
1. Agent 请求执行命令
   │
2. requiresExecApproval() 判断是否需要审批
   ├─ ask="always" → 需要
   ├─ ask="on-miss" + security="allowlist" + (analysisOk=false || allowlistSatisfied=false) → 需要
   └─ 其他 → 不需要，直接执行
   │
3. 需要审批时，尝试多条路径：
   ├─ 路径A: requestExecApprovalViaSocket()
   │   → 本地 UDS (JSONL) → macOS App 弹窗
   │
   └─ 路径B: Gateway 广播 exec.approval.requested
       → macOS App (GatewayPrompter) → 弹窗或 askFallback
       → Discord 客户端 → 发送审批卡片 + 按钮
       → Telegram 客户端 → 发送审批提示 + /approve
       → Control UI → 内联审批
       → 聊天渠道转发 → /approve 命令
   │
4. 任一通道返回决策 → Gateway 汇聚 exec.approval.resolve
   ├─ allow-once    → 执行本次
   ├─ allow-always  → 写入允许列表 + 执行
   └─ deny          → 拒绝
   │
5. 无任何通道返回（超时 120 秒）
   └─ askFallback 兜底
       ├─ deny      → 拒绝
       ├─ allowlist → 检查允许列表
       └─ full      → 允许
   │
6. 决策结果持久化
   └─ 写入 ~/.openclaw/exec-approvals.json
       ├─ allow-always → 新增 ExecAllowlistEntry
       └─ 已有条目 → 更新 lastUsedAt / lastUsedCommand / lastResolvedPath
```

---

## 安全策略体系

### 三维度策略模型

| 维度 | 值 | 含义 |
|------|-----|------|
| **security** | `deny` | 阻止所有主机执行请求 |
| | `allowlist` | 仅允许在允许列表中的命令 |
| | `full` | 允许所有命令（等同于提权模式） |
| **ask** | `off` | 从不提示 |
| | `on-miss` | 仅在允许列表未匹配时提示 |
| | `always` | 每次命令都提示 |
| **askFallback** | `deny` | 无法交互时拒绝 |
| | `allowlist` | 无法交互时仅允许列表放行 |
| | `full` | 无法交互时允许所有 |

### 配置合并优先级（从高到低）

```
1. overrides（运行时覆盖，如 CLI 参数）
2. agent 自身配置（如 agents.main.security）
3. 通配符 agent 配置（如 agents["*"].security）
4. 全局 defaults（如 defaults.security）
5. 硬编码默认值（deny / on-miss / deny / false）
```

### 允许列表匹配与持久化

- 合并规则：通配符 agent 的列表在前，当前 agent 的列表在后
- 匹配后自动更新 `lastUsedAt`、`lastUsedCommand`、`lastResolvedPath`
- `allow-always` 决策自动将命令模式添加到允许列表并持久化
- 每个条目有唯一 `id`（UUID），支持去重

---

## 关键源码文件索引

| 文件 | 语言 | 职责 |
|------|------|------|
| `src/infra/exec-approvals.ts` | TypeScript | 配置管理、策略解析、本地 IPC 客户端 |
| `src/infra/jsonl-socket.ts` | TypeScript | JSONL 协议 Socket 客户端 |
| `src/infra/exec-approvals-analysis.ts` | TypeScript | 命令静态分析 |
| `src/infra/exec-approvals-allowlist.ts` | TypeScript | 允许列表匹配 |
| `apps/macos/Sources/OpenClaw/ExecApprovalsSocket.swift` | Swift | macOS App Socket 服务器 + 客户端 |
| `apps/macos/Sources/OpenClaw/ExecApprovalsGatewayPrompter.swift` | Swift | macOS App Gateway 审批监听 |
| `apps/macos/Sources/OpenClaw/ExecApprovals.swift` | Swift | macOS App 审批策略解析 |
| `extensions/discord/src/monitor/exec-approvals.ts` | TypeScript | Discord 审批客户端 |
| `extensions/telegram/src/exec-approvals-handler.ts` | TypeScript | Telegram 审批客户端 |

---

## macOS IPC 流程图

```
Gateway ──(WebSocket)──→ Node Service
                              │
                              │  IPC (UDS + Token + HMAC + TTL)
                              ▼
                          Mac App
                         ┌──────────────────────────────┐
                         │  ExecApprovalsSocketServer    │
                         │  ├─ bind + listen (UDS 0600)  │
                         │  ├─ accept → handleClient     │
                         │  │   ├─ type="request"       │
                         │  │   │   → onPrompt()        │
                         │  │   │   → 弹窗决策           │
                         │  │   │   → sendDecision()    │
                         │  │   └─ type="exec"          │
                         │  │       → HMAC 验证          │
                         │  │       → onExec()           │
                         │  │       → 执行命令            │
                         │  │       → sendExecResponse() │
                         │  └─ isAllowedPeer (同 UID)    │
                         └──────────────────────────────┘
```

---

## 安全注意事项

1. **Unix socket 模式 `0600`**：只有文件所有者可以连接
2. **Token 存储在 `exec-approvals.json`**（本身也是 `0600` 权限）
3. **同 UID 对端检查**：`getpeereid()` 确保只有同一用户的进程可以通信
4. **Challenge/Response**：`exec` 类型请求使用 nonce + HMAC(token + request hash) + 短 TTL 防重放
5. **Per-agent 允许列表**：防止一个 agent 的审批泄漏到其他 agent
6. **审批仅适用于授权发送者**：未授权的发送者无法发出 `/exec`
7. **askFallback 兜底**：确保无法交互时不会意外放行
