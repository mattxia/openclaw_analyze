# OpenClaw 工具调用权限与用户确认机制分析

OpenClaw的工具调用采用**"四层校验机制"**，在工具执行前依次进行存在性校验、策略校验、安全分级校验和用户确认审批，确保工具调用安全可控，既避免恶意操作，又减少不必要的用户打扰。

---

## 🔍 整体校验流程总览
```
LLM生成工具调用 → 【第一层：基础校验】 → 【第二层：策略校验】 → 【第三层：安全分级】 → 【第四层：用户确认】 → 执行工具 → 返回结果
                                        ↓                        ↓
                                      拒绝执行                需要用户确认
                                        ↓                        ↓
                                  返回错误给LLM              弹出确认对话框
                                                                 ↓
                                                            用户批准/拒绝
                                                                 ↓
                                                         执行工具/拒绝执行
```

---

## 📋 分层校验机制详解

### 📍 第一层：基础存在性校验
**核心目标**：确保调用的工具真实存在且符合基本格式要求
**校验逻辑**：
1. 检查工具名称是否在系统内置/注册的工具列表中
2. 校验工具参数是否符合JSON Schema定义
3. 检查参数是否存在格式错误、必填参数缺失等问题
4. 校验不通过直接返回错误，要求LLM修正

**关键代码片段**（工具存在性校验）：
```typescript
// 来自 src/agents/pi-tools.ts
const ALLOWED_TOOLS = new Set([
  "read", "write", "exec", "web_search", "skill_search", 
  "memory_search", "sessions_spawn", "browser_navigate",
  // ... 其他可用工具
]);

function validateToolCall(toolCall: ToolCall): ValidationResult {
  // 1. 检查工具是否存在
  if (!ALLOWED_TOOLS.has(toolCall.name)) {
    return {
      valid: false,
      error: `工具 "${toolCall.name}" 不存在，可用工具：${Array.from(ALLOWED_TOOLS).join(", ")}`
    };
  }
  
  // 2. 校验参数Schema
  const schema = TOOL_SCHEMAS[toolCall.name];
  const paramValidation = schema.validate(toolCall.parameters);
  if (!paramValidation.valid) {
    return {
      valid: false,
      error: `参数错误：${paramValidation.error.message}`
    };
  }
  
  return { valid: true };
}
```

---

### 📍 第二层：策略白名单校验
**核心目标**：根据系统配置和会话权限，过滤掉当前会话不允许使用的工具
**校验逻辑**：
1. 全局工具策略：`tools.allow`和`tools.deny`配置的全局白/黑名单
2. Agent级策略：每个Agent独立的工具权限配置
3. 会话级策略：根据会话类型（沙箱/普通/管理员）应用不同策略
4. 子Agent限制：子Agent默认禁止调用系统级工具（如gateway配置、cron等）

**关键代码片段**（策略匹配）：
```typescript
// 来自 src/agents/pi-tools.policy.ts
function makeToolPolicyMatcher(policy: SandboxToolPolicy) {
  const deny = compileGlobPatterns({
    raw: expandToolGroups(policy.deny ?? []),
    normalize: normalizeToolName,
  });
  const allow = compileGlobPatterns({
    raw: expandToolGroups(policy.allow ?? []),
    normalize: normalizeToolName,
  });
  return (name: string) => {
    const normalized = normalizeToolName(name);
    if (matchesAnyGlobPattern(normalized, deny)) return false; // 黑名单优先
    if (allow.length === 0) return true; // 无白名单默认允许
    return matchesAnyGlobPattern(normalized, allow); // 匹配白名单
  };
}

// 子Agent默认禁止工具列表
const SUBAGENT_TOOL_DENY_ALWAYS = [
  "gateway", "agents_list", "whatsapp_login", "session_status", "cron",
  "memory_search", "memory_get", "sessions_send"
];
```

**相关文件**：
- [src/agents/pi-tools.policy.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-tools.policy.ts) - 工具策略核心实现

---

### 📍 第三层：安全分级校验
**核心目标**：根据工具的安全风险等级，判断是否需要用户确认
**工具安全分级**：

| 安全等级 | 工具示例 | 风险说明 | 默认处理 |
|----------|----------|----------|----------|
| 安全工具 | `read`, `web_search`, `skill_search`, `diffs` | 仅读取数据，无修改/执行权限 | 无需确认，直接执行 |
| 低风险工具 | `write`(仅修改工作区文件), `browser_navigate` | 有修改操作，但范围可控 | 首次调用需要确认，可加入白名单 |
| 中风险工具 | `exec`(非白名单命令), `delete`(删除文件) | 可能修改系统/删除数据 | 必须用户确认 |
| 高风险工具 | `exec`(系统级命令), `gateway_config`, `system_update` | 可能影响系统稳定性/安全 | 必须管理员权限 + 用户确认 |

**关键判断逻辑**：
```typescript
// 来自 src/agents/tools/exec-policy.ts
function getToolRiskLevel(toolName: string, params: any): RiskLevel {
  switch (toolName) {
    case "read":
    case "web_search":
    case "skill_search":
      return "safe"; // 无需确认
      
    case "write":
      // 仅修改工作区文件为低风险，修改系统文件为高风险
      return isPathInsideWorkspace(params.path) ? "low" : "high";
      
    case "delete":
      return "medium"; // 删除文件需要确认
      
    case "exec":
      // 白名单命令直接允许，否则需要确认
      return isInExecAllowlist(params.command) ? "safe" : "medium";
      
    case "gateway":
    case "system_update":
      return "high"; // 系统操作需要管理员确认
      
    default:
      return "low";
  }
}
```

---

### 📍 第四层：用户确认审批流程
**核心目标**：对中高风险工具调用，要求用户手动确认后才能执行
**触发条件**：
1. 工具风险等级为`medium`或`high`
2. 工具不在用户配置的永久允许列表中
3. 非管理员会话调用高风险工具

#### 完整审批流程：
```
工具调用风险等级≥medium → 检查是否在永久白名单 → 是→直接执行
                                        ↓ 否
                                    生成审批请求
                                        ↓
                          向客户端推送`exec.approval.requested`事件
                                        ↓
                          客户端弹出确认对话框，包含：
                          • 工具名称 + 参数
                          • 风险等级说明
                          • 操作建议
                                        ↓
                          用户选择操作：
                          • Allow once → 执行本次调用
                          • Always allow → 加入白名单+执行
                          • Deny → 拒绝执行
                                        ↓
                          执行工具/返回拒绝信息给LLM
```

**关键代码片段**（审批触发逻辑）：
```typescript
// 来自 src/infra/exec-approvals.ts
async function requireApproval(toolCall: ToolCall, context: SessionContext): Promise<ApprovalResult> {
  // 1. 检查是否需要审批
  const riskLevel = getToolRiskLevel(toolCall.name, toolCall.parameters);
  if (riskLevel === "safe") return { approved: true };
  
  // 2. 检查是否在永久允许列表
  if (isInPermanentAllowlist(toolCall, context.userId)) {
    return { approved: true };
  }
  
  // 3. 创建审批请求
  const approvalId = generateApprovalId();
  await broadcastApprovalRequest({
    id: approvalId,
    tool: toolCall.name,
    parameters: toolCall.parameters,
    riskLevel,
    sessionId: context.sessionId,
    timestamp: Date.now()
  });
  
  // 4. 等待用户响应（超时300秒）
  const response = await waitForApprovalResponse(approvalId, 300_000);
  
  if (response.action === "allow-always") {
    // 添加到永久白名单
    addToPermanentAllowlist(toolCall, context.userId);
  }
  
  return {
    approved: response.action === "allow-once" || response.action === "allow-always",
    reason: response.reason
  };
}
```

**相关文件**：
- [src/infra/exec-approvals.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-approvals.ts) - 审批逻辑实现
- [src/gateway/server-methods/exec-approvals.ts](file:///d:/prj/openclaw_analyze/src/gateway/server-methods/exec-approvals.ts) - 审批API接口

---

## ⚙️ 可配置的审批策略
用户可以通过`openclaw.json`调整审批行为：
```json5
{
  "tools": {
    "exec": {
      "approval": {
        "mode": "on_miss", // always/on_miss/never
        // always：所有exec调用都需要确认
        // on_miss：仅不在白名单的命令需要确认
        // never：无需确认（不推荐）
        "default_allowlist": ["jq", "grep", "cut", "sort", "uniq", "head", "tail"], // 默认安全命令
        "timeout": 300 // 审批超时时间（秒）
      }
    },
    "allow": ["read", "web_search", "skill_search"], // 全局允许工具
    "deny": ["system_update", "gateway_config"] // 全局禁止工具
  }
}
```

---

## 📋 审批用户界面
客户端收到审批请求后会弹出确认对话框，包含：
- 🔴 风险等级提示（高/中/低风险）
- 🛠️ 工具名称和完整参数
- 📍 执行路径/影响范围
- ⏱️ 超时倒计时
- 操作按钮：
  - 【仅允许一次】：执行本次调用
  - 【始终允许】：添加到白名单，后续同类调用无需确认
  - 【拒绝】：阻止执行

---

## 🚩 拒绝执行后的处理
当工具调用被拒绝时，系统会返回明确的错误信息给LLM，引导其调整方案：
```
<|ToolCallDenied|>
原因：用户拒绝执行命令 "rm -rf /"
风险等级：高危
建议：请换用更安全的方式完成需求，或向用户申请权限。
<|ToolCallDeniedEnd|>
```

LLM会根据错误信息调整策略，比如换用其他工具、拆分操作步骤，或向用户说明需要权限。

---

## 🔗 核心实现文件汇总
| 文件路径 | 核心功能 |
|----------|----------|
| [src/agents/pi-tools.policy.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-tools.policy.ts) | 工具权限策略匹配 |
| [src/infra/exec-approvals.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-approvals.ts) | 执行审批核心逻辑 |
| [src/gateway/server-methods/exec-approvals.ts](file:///d:/prj/openclaw_analyze/src/gateway/server-methods/exec-approvals.ts) | 审批API接口实现 |
| [src/agents/tools/exec-policy.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/exec-policy.ts) | 工具风险等级评估 |
| [src/agents/pi-tools.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-tools.ts) | 工具基础定义与参数校验 |

这种分级校验机制在安全性和用户体验之间取得了平衡，既防止了高危操作的误执行，又避免了频繁弹窗打扰用户。
