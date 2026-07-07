# OpenClaw 文件删除/修改确认机制分析

## 一、确认机制概述

OpenClaw 对文件操作有多层防护机制，从命令执行审批到文件系统边界保护，形成纵深防御：

1. **ACP 权限确认** — 交互式终端用户确认（工具调用层）
2. **执行审批策略** — 通过 Unix 域套接字的策略审批系统（命令执行层）
3. **文件系统边界保护** — 工作区路径强制、符号链接阻断、TOCTOU 防护（文件 API 层）
4. **Safe Bin 加固 Profile** — 安全命令的参数级白名单限制（参数约束层）

---

## 二、危险工具定义

**文件位置**: [src/security/dangerous-tools.ts](file:///d:/prj/openclaw_analyze/src/security/dangerous-tools.ts)

在 ACP 模式下，以下工具始终需要用户显式批准：

```typescript
export const DANGEROUS_ACP_TOOL_NAMES = [
  "exec", // 执行 Shell 命令
  "spawn", // 生成新进程
  "shell", // Shell 交互
  "sessions_spawn", // 会话生成
  "sessions_send", // 会话发送
  "gateway", // 网关操作
  "fs_write", // 文件写入
  "fs_delete", // 文件删除
  "fs_move", // 文件移动
  "apply_patch", // 应用补丁
] as const;
```

Gateway HTTP 接口默认拒绝的高风险工具：

```typescript
export const DEFAULT_GATEWAY_HTTP_TOOL_DENY = [
  "sessions_spawn", // 远程 RCE
  "sessions_send", // 跨会话注入
  "cron", // 持久化自动化控制面
  "gateway", // 网关重配置
  "whatsapp_login", // 交互式登录
] as const;
```

自动批准的安全工具（无需确认）：

```typescript
const SAFE_AUTO_APPROVE_TOOL_IDS = new Set([
  "read", // 只读操作
  "search", // 搜索
  "web_search", // 网络搜索
  "memory_search", // 内存搜索
]);
```

---

## 三、ACP 交互式确认流程

**文件位置**: [src/acp/client.ts:234-322](file:///d:/prj/openclaw_analyze/src/acp/client.ts#L234-L322)

### 3.1 用户权限提示函数

```typescript
function promptUserPermission(toolName: string | undefined, toolTitle?: string): Promise<boolean> {
  // 非交互式终端直接拒绝
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

    // 30秒超时自动拒绝
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

### 3.2 权限决策流程

```typescript
export async function resolvePermissionRequest(params: RequestPermissionRequest, deps = {}) {
  const toolName = resolveToolNameForPermission(params);
  const autoApproveAllowed = shouldAutoApproveToolCall(params, toolName, toolTitle, cwd);

  // 危险工具或未知名工具必须提示
  const promptRequired = !toolName || !autoApproveAllowed || DANGEROUS_ACP_TOOLS.has(toolName);

  if (!promptRequired) {
    return selectedPermission(allowOption.optionId); // 自动批准安全工具
  }

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

**关键特性**：

- 非交互式终端直接拒绝（后台服务无法绕过）
- 30 秒超时自动拒绝
- 用户输入 `y` 批准，其他输入均拒绝
- `fs_delete`、`fs_write`、`fs_move` 等始终需要显式确认

---

## 四、执行审批策略系统

**文件位置**: [src/infra/exec-approvals.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-approvals.ts)

### 4.1 安全策略类型

```typescript
// 安全策略
export type ExecSecurity =
  | "deny" // 完全拒绝执行
  | "allowlist" // 仅允许列表中的命令
  | "full"; // 完全放行，无需审批

// 询问策略
export type ExecAsk =
  | "off" // 从不询问
  | "on-miss" // 未命中列表时询问
  | "always"; // 总是询问

// 审批决策类型
export type ExecApprovalDecision =
  | "allow-once" // 仅允许本次
  | "allow-always" // 永久允许（加入白名单）
  | "deny"; // 拒绝
```

### 4.2 默认策略值

```typescript
const DEFAULT_SECURITY: ExecSecurity = "deny"; // 配置文件兜底为拒绝
const DEFAULT_ASK: ExecAsk = "on-miss"; // 未命中时询问
const DEFAULT_ASK_FALLBACK: ExecSecurity = "deny"; // 回退策略为拒绝
```

> **重要**：运行时 gateway 主机默认 `security=allowlist`（见 `bash-tools.exec.ts` 中 `host === "sandbox" ? "deny" : "allowlist"`），沙箱环境默认 `security=deny`。

### 4.3 审批决策判断

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

### 4.4 额外强制审批条件

即使白名单满足，以下情况仍需审批（[bash-tools.exec-host-gateway.ts:128-136](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-host-gateway.ts#L128-L136)）：

```typescript
const requiresAsk =
  requiresExecApproval({
    ask: hostAsk,
    security: hostSecurity,
    analysisOk,
    allowlistSatisfied,
  }) ||
  requiresHeredocApproval || // 包含 heredoc (<<)
  obfuscation.detected; // 检测到命令混淆
```

### 4.5 审批超时与回退

- 默认超时：**120 秒**（`DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 120_000`）
- 超时后按 `askFallback` 策略处理（默认 `deny`）
- 无可用审批客户端时也按 `askFallback` 回退

### 4.6 配置文件权限保护

审批配置文件以 `0o600` 权限写入（仅所有者可读写），防止其他用户篡改白名单：

```typescript
export function saveExecApprovals(file: ExecApprovalsFile) {
  const filePath = resolveExecApprovalsPath();
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
}
```

---

## 五、Gateway 上 `rm` 命令的多层过滤机制

### 5.1 默认安全命令列表 (Safe Bins)

**文件位置**: [src/infra/exec-command-resolution.ts:9](file:///d:/prj/openclaw_analyze/src/infra/exec-command-resolution.ts#L9)

```typescript
export const DEFAULT_SAFE_BINS = ["jq", "cut", "uniq", "head", "tail", "tr", "wc"];
```

> **重要**: `rm` 不在此列表中，执行任何 `rm` 相关命令都需要用户审批确认。

### 5.2 Shell 语法静态分析

**文件位置**: [src/infra/exec-approvals-analysis.ts:38-52](file:///d:/prj/openclaw_analyze/src/infra/exec-approvals-analysis.ts#L38-L52)

禁止以下危险构造：

```typescript
const DISALLOWED_PIPELINE_TOKENS = new Set([">", "<", "`", "\n", "\r", "(", ")"]);

// 额外禁止 $() 命令替换
if (ch === "$" && next === "(") {
  return { ok: false, reason: "unsupported shell token: $()", segments: [] };
}
```

**Windows 额外禁止**：

```typescript
const WINDOWS_UNSUPPORTED_TOKENS = new Set([
  "&",
  "|",
  "<",
  ">",
  "^",
  "(",
  ")",
  "%",
  "!",
  "\n",
  "\r",
]);
```

### 5.3 命令链接分段验证

**文件位置**: [src/infra/exec-approvals-allowlist.ts:551-600](file:///d:/prj/openclaw_analyze/src/infra/exec-approvals-allowlist.ts#L551-L600)

命令会按 `&&`、`||`、`;` 拆分，**每个分段都需要独立通过验证**：

```bash
# 以下命令会被拆分为 3 个独立分段检查
echo "cleaning" && rm -rf /tmp/* && echo "done"
# 分段 1: echo "cleaning"  -> 可能通过
# 分段 2: rm -rf /tmp/*    -> 需要审批
# 分段 3: echo "done"      -> 可能通过
```

只要任一分段未通过，整个命令链的 `allowlistSatisfied` 即为 `false`。

### 5.4 可执行文件路径信任验证

**文件位置**: [src/infra/exec-safe-bin-trust.ts:6](file:///d:/prj/openclaw_analyze/src/infra/exec-safe-bin-trust.ts#L6)

仅信任以下目录的可执行文件：

```typescript
const DEFAULT_SAFE_BIN_TRUSTED_DIRS = ["/bin", "/usr/bin"];
```

来自 `/tmp`、`/home` 等目录的可执行文件不会被信任。信任目录不会从 `PATH` 派生（防止环境变量篡改）：

```typescript
// Trust is explicit only. Do not derive from PATH, which is user/environment controlled.
```

### 5.5 Shell 包装器递归解析

**文件位置**: [src/infra/exec-wrapper-resolution.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-wrapper-resolution.ts)

系统会自动穿透以下包装器，检查内部命令：

| 包装器类型         | 示例                                                                  | 处理方式             |
| ------------------ | --------------------------------------------------------------------- | -------------------- |
| Shell 包装器       | `bash -c "rm /data"`、`zsh -lc "rm -rf /tmp"`                         | 递归解析内部命令     |
| 分发包装器（透明） | `nice rm /tmp`, `timeout 10s rm /tmp`, `nohup`, `stdbuf`              | 穿透后检查内部命令   |
| 分发包装器（阻断） | `sudo rm /tmp`, `doas rm /tmp`, `chrt`, `ionice`, `setsid`, `taskset` | `policyBlocked=true` |
| 复用器包装器       | `busybox rm /tmp`                                                     | 递归解析             |

> **递归深度最多 4 层**（`MAX_DISPATCH_WRAPPER_DEPTH = 4`），每层都验证内部的 `rm` 命令。

**sudo/doas 阻断逻辑**（[exec-wrapper-resolution.ts:436-441](file:///d:/prj/openclaw_analyze/src/infra/exec-wrapper-resolution.ts#L436-L441)）：

```typescript
case "chrt":
case "doas":
case "ionice":
case "setsid":
case "sudo":
case "taskset":
  return blockDispatchWrapper(wrapper);
```

当 `policyBlocked=true` 时，[exec-approvals-allowlist.ts:212-214](file:///d:/prj/openclaw_analyze/src/infra/exec-approvals-allowlist.ts#L212-L214) 中该分段的 `allowlistSatisfied` 永远为 `false`，因此在默认 `allowlist` 模式下**强制触发用户审批**。

### 5.6 混淆检测

**文件位置**: [src/infra/exec-obfuscation-detect.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-obfuscation-detect.ts)

检测编码/混淆命令（不可见 Unicode 字符、Base64 编码等），即使白名单满足也强制审批：

```typescript
// bash-tools.exec-host-gateway.ts:105-108
const obfuscation = detectCommandObfuscation(params.command);
if (obfuscation.detected) {
  logInfo(`exec: obfuscation detected (gateway): ${obfuscation.reasons.join(", ")}`);
  params.warnings.push(`⚠️ Obfuscated command detected: ${obfuscation.reasons.join("; ")}`);
}
```

### 5.7 Heredoc 审批要求

**文件位置**: [bash-tools.exec-host-gateway.ts:123-141](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-host-gateway.ts#L123-L141)

在 `allowlist` 模式下，即使白名单满足，包含 heredoc (`<<`) 的命令仍需显式审批，因为 heredoc 可隐藏任意内容：

```typescript
const hasHeredocSegment = allowlistEval.segments.some((segment) =>
  segment.argv.some((token) => token.startsWith("<<")),
);
const requiresHeredocApproval =
  hostSecurity === "allowlist" && analysisOk && allowlistSatisfied && hasHeredocSegment;
```

---

## 六、Safe Bin 加固 Profile（参数级约束）

**文件位置**: [src/infra/exec-safe-bin-policy-profiles.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-safe-bin-policy-profiles.ts)

每个安全命令都有严格的参数白名单，禁用所有文件系统相关的 flag，确保 safe bins 只能处理 stdin 数据：

| 命令   | 禁用的 Flag                                                                                               | 约束                                  |
| ------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `jq`   | `--from-file`、`-f`、`--rawfile`、`--slurpfile`、`--argfile`、`--library-path`、`-L`                      | `maxPositional: 1`                    |
| `grep` | `--file`、`-f`、`--recursive`、`-r`、`-R`、`--exclude-from`、`--dereference-recursive`                    | `maxPositional: 0`（强制 stdin-only） |
| `sort` | `--output`、`-o`、`--files0-from`、`--compress-program`、`--random-source`、`--temporary-directory`、`-T` | `maxPositional: 0`                    |
| `cut`  | 无文件 flag                                                                                               | `maxPositional: 0`                    |
| `head` | 无文件 flag                                                                                               | `maxPositional: 0`                    |
| `tail` | 无文件 flag                                                                                               | `maxPositional: 0`                    |
| `tr`   | 无                                                                                                        | `minPositional: 1, maxPositional: 2`  |
| `wc`   | `--files0-from`                                                                                           | `maxPositional: 0`                    |

> 这意味着即使攻击者尝试用 `grep --file=/etc/passwd` 读取敏感文件，也会被 safe bin profile 拦截。

---

## 七、文件系统边界保护（fs-safe.ts）

**文件位置**: [src/infra/fs-safe.ts](file:///d:/prj/openclaw_analyze/src/infra/fs-safe.ts)

这是 Shell 命令审批之外的**第二道防线**，为 OpenClaw 内部所有文件 API 提供边界保护：

### 7.1 工作区边界强制

`openFileWithinRoot`、`readFileWithinRoot`、`writeFileWithinRoot` 等所有文件 API 都通过 `isPathInside()` 检查路径是否在允许的 root 目录内：

```typescript
async function resolvePathWithinRoot(params: {
  rootDir: string;
  relativePath: string;
}): Promise<{ rootReal: string; rootWithSep: string; resolved: string }> {
  const rootReal = await fs.realpath(params.rootDir);
  const rootWithSep = ensureTrailingSep(rootReal);
  const expanded = await expandRelativePathWithHome(params.relativePath);
  const resolved = path.resolve(rootWithSep, expanded);
  if (!isPathInside(rootWithSep, resolved)) {
    throw new SafeOpenError("outside-workspace", "file is outside workspace root");
  }
  return { rootReal, rootWithSep, resolved };
}
```

### 7.2 符号链接阻断

使用 `O_NOFOLLOW` 标志打开文件，并检查 `lstat.isSymbolicLink()`，防止符号链接攻击：

```typescript
const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const OPEN_READ_FLAGS = fsConstants.O_RDONLY | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_WRITE_CREATE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
```

### 7.3 硬链接拒绝

`stat.nlink > 1` 时拒绝操作，防止硬链接攻击：

```typescript
if (stat.nlink > 1) {
  throw new SafeOpenError("invalid-path", "hardlinked path not allowed");
}
```

### 7.4 TOCTOU 防护

操作前后通过 `sameFileIdentity()` 比对 `dev/ino`，防止时间窗口竞态攻击：

```typescript
if (!sameFileIdentity(stat, lstat)) {
  throw new SafeOpenError("path-mismatch", "path changed during read");
}
// ... 操作后再次验证
if (!sameFileIdentity(stat, realStat)) {
  throw new SafeOpenError("path-mismatch", "path mismatch");
}
```

### 7.5 原子写入

使用临时文件 + `rename` 模式进行原子写入，写入后 `verifyAtomicWriteResult()` 验证目标文件身份：

```typescript
export async function writeFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  data: string | Buffer;
  encoding?: BufferEncoding;
  mkdir?: boolean;
}): Promise<void> {
  // 1. 解析并验证目标路径在 root 内
  const pinned = await resolvePinnedWriteTargetWithinRoot({...});
  // 2. 通过 pinned write helper 原子写入
  const identity = await runPinnedWriteHelper({...});
  // 3. 写入后验证文件身份未被篡改
  await verifyAtomicWriteResult({
    rootDir: params.rootDir,
    targetPath: pinned.targetPath,
    expectedIdentity: identity,
  });
}
```

### 7.6 路径别名逃逸检测

```typescript
await assertNoPathAliasEscape({
  absolutePath: resolved,
  rootPath: rootReal,
  boundaryLabel: "root",
});
```

---

## 八、审批消息构建

**文件位置**: [src/agents/bash-tools.exec-runtime.ts:346-382](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts#L346-L382)

````typescript
export function buildApprovalPendingMessage(params: {
  warningText?: string;
  approvalSlug: string;
  approvalId: string;
  command: string;
  cwd: string;
  host: "gateway" | "node";
  nodeId?: string;
}) {
  // 动态选择代码块标记，避免与命令内容冲突
  let fence = "```";
  while (params.command.includes(fence)) {
    fence += "`";
  }
  const commandBlock = `${fence}sh\n${params.command}\n${fence}`;

  const lines: string[] = [
    `Approval required (id ${params.approvalSlug}, full ${params.approvalId}).`,
    `Host: ${params.host}`,
    `CWD: ${params.cwd}`,
    "Command:",
    commandBlock,
    "Mode: foreground (interactive approvals available).",
    `Reply with: /approve ${params.approvalSlug} allow-once|allow-always|deny`,
  ];

  return lines.join("\n");
}
````

---

## 九、`rm` 命令实际执行流程

```
Agent 执行 rm -f /tmp/cache.txt
        |
        v
  +--------------------+
  | Shell 语法分析     |   <- 检查重定向、命令替换等
  +--------------------+
        | 通过
        v
  +--------------------+
  | 解析可执行文件     |   <- /bin/rm
  +--------------------+
        |
        v
  +--------------------+
  | 检查 Safe Bin      |   <- rm 不在 DEFAULT_SAFE_BINS
  +--------------------+
        | 不匹配
        v
  +--------------------+
  | 检查 Allowlist     |   <- 无匹配条目
  +--------------------+
        | 不匹配
        v
  +--------------------+
  | 混淆/Heredoc 检查  |   <- 额外强制审批条件
  +--------------------+
        |
        v
  +--------------------+
  | 触发用户审批       |   <- 弹出确认对话框
  +--------------------+
        |
        +-- 用户批准 -> 执行命令
        +-- 用户拒绝 -> 中止执行
        +-- 超时     -> 按 askFallback 回退（默认 deny）
```

---

## 十、Allow Always 持久化处理

**文件位置**: [src/infra/exec-approvals-allowlist.ts:507-525](file:///d:/prj/openclaw_analyze/src/infra/exec-approvals-allowlist.ts#L507-L525)

当用户选择 "Allow Always" 时，系统会：

1. 递归穿透所有 Shell 包装器
2. 解析内部真实的可执行路径（如 `/bin/rm`）
3. 将该路径持久化到 Agent 的 allowlist 中

```typescript
export function resolveAllowAlwaysPatterns(params: {
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): string[] {
  const patterns = new Set<string>();
  for (const segment of params.segments) {
    collectAllowAlwaysPatterns({
      segment,
      depth: 0, // 最多递归 4 层
      out: patterns,
    });
  }
  return Array.from(patterns);
}
```

---

## 十一、常见场景验证结果

| 命令                             | 是否需要审批 | 原因                                     |
| -------------------------------- | ------------ | ---------------------------------------- |
| `rm file.txt`                    | 是           | rm 不是 Safe Bin                         |
| `rm -rf /tmp/*`                  | 是           | 同上                                     |
| `bash -c "rm /data"`             | 是           | 穿透后仍是 rm                            |
| `sudo rm /root/file`             | 是           | sudo 被 policyBlocked，白名单无法满足    |
| `doas rm /root/file`             | 是           | doas 被 policyBlocked，白名单无法满足    |
| `nice rm /tmp/file`              | 是           | nice 是透明包装器，穿透后仍是 rm         |
| `timeout 10s rm /tmp/file`       | 是           | timeout 是透明包装器，穿透后仍是 rm      |
| `echo "hello" && rm /tmp/a`      | 是           | 命令链中 rm 未通过                       |
| `echo x && rm y && echo z`       | 是           | 链中任一段未通过则整体需审批             |
| `rm /tmp/file` (已 allow always) | 否           | 在 Allowlist 中                          |
| `jq .foo file.json`              | 否           | jq 在 Safe Bins                          |
| `grep -f /etc/passwd`            | 是           | `--file` flag 被 Safe Bin Profile 禁用   |
| `sort -o /tmp/out`               | 是           | `--output` flag 被 Safe Bin Profile 禁用 |
| 包含 heredoc 的命令              | 是           | allowlist 模式下 heredoc 强制审批        |
| 混淆命令 (Unicode/编码)          | 是           | 混淆检测强制审批                         |
| Python `os.remove("/tmp/a")`     | 否\*         | Python 解释器内部 API 无拦截             |
| Node.js `fs.unlink("/tmp/a")`    | 否\*         | 脚本 API 直接执行，无审批                |

> \*注：脚本语言内部的文件删除 API 不会被 exec 审批系统拦截。但如果通过 OpenClaw 内部文件 API（如 `writeFileWithinRoot`）操作，仍受 fs-safe.ts 的边界保护约束。

---

## 十二、安全边界总结

| 防护层           | 机制                      | 拦截 rm 的方式             |
| ---------------- | ------------------------- | -------------------------- |
| Shell 语法分析   | 禁止重定向/命令替换       | 阻断 `rm > /etc/passwd` 等 |
| Safe Bins 白名单 | rm 不在列表               | rm 永远需要审批            |
| Safe Bin Profile | 禁用文件系统 flag         | safe bins 无法读写任意文件 |
| 路径信任验证     | 仅信任 /bin、/usr/bin     | 阻止 /tmp/evil_rm          |
| 包装器穿透       | 递归 4 层解析             | `bash -c "rm"` 仍识别为 rm |
| sudo/doas 阻断   | policyBlocked=true        | 无法通过白名单，需审批     |
| 混淆检测         | Unicode/编码检测          | 阻止混淆形式的 rm          |
| Heredoc 审批     | allowlist 模式强制审批    | 阻止 heredoc 隐藏 rm       |
| 命令链分段       | &&/ll/; 每段独立检查      | 链中 rm 仍需审批           |
| 文件系统边界     | isPathInside + O_NOFOLLOW | 文件 API 限制在 root 内    |
| 硬链接拒绝       | nlink > 1 拒绝            | 防止硬链接攻击             |
| TOCTOU 防护      | dev/ino 身份验证          | 防止时间窗口竞态           |
| 配置文件保护     | 0o600 权限                | 防止白名单被篡改           |

**核心设计原则**：

1. **默认拒绝**：`rm` 默认需要审批，无静默删除
2. **递归检查**：穿透多层 Shell 包装器（最多 4 层），不放过隐藏的 `rm`
3. **分段验证**：命令链每个命令独立检查
4. **路径信任**：仅来自 `/bin`、`/usr/bin` 的可执行文件可被加入安全列表
5. **参数约束**：Safe Bin Profile 禁用所有文件系统相关 flag
6. **混淆检测**：即使白名单满足，混淆命令仍需审批
7. **Windows 更严格**：Windows 平台禁用更多 Shell token
8. **超时保护**：120 秒（exec）/ 30 秒（ACP）无响应自动拒绝
9. **非交互拒绝**：无 TTY 环境自动拒绝（后台服务无法绕过）
10. **纵深防御**：命令审批 + 文件系统边界 + 参数约束，多层独立防护

---

## 十三、关键模块文件索引

### 危险工具与 ACP 审批

| 功能         | 文件路径                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------- |
| 危险工具定义 | [src/security/dangerous-tools.ts](file:///d:/prj/openclaw_analyze/src/security/dangerous-tools.ts) |
| ACP 权限确认 | [src/acp/client.ts](file:///d:/prj/openclaw_analyze/src/acp/client.ts)                             |
| ACP 策略控制 | [src/acp/policy.ts](file:///d:/prj/openclaw_analyze/src/acp/policy.ts)                             |

### 执行审批核心

| 功能             | 文件路径                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 审批核心逻辑     | [src/infra/exec-approvals.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-approvals.ts)                               |
| 命令分析         | [src/infra/exec-approvals-analysis.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-approvals-analysis.ts)             |
| 白名单评估       | [src/infra/exec-approvals-allowlist.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-approvals-allowlist.ts)           |
| 混淆检测         | [src/infra/exec-obfuscation-detect.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-obfuscation-detect.ts)             |
| 包装器解析       | [src/infra/exec-wrapper-resolution.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-wrapper-resolution.ts)             |
| 命令解析         | [src/infra/exec-command-resolution.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-command-resolution.ts)             |
| Safe Bin 策略    | [src/infra/exec-safe-bin-policy.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-safe-bin-policy.ts)                   |
| Safe Bin Profile | [src/infra/exec-safe-bin-policy-profiles.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-safe-bin-policy-profiles.ts) |
| 路径信任验证     | [src/infra/exec-safe-bin-trust.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-safe-bin-trust.ts)                     |
| 审批消息构建     | [src/infra/exec-approval-reply.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-approval-reply.ts)                     |
| 审批转发         | [src/infra/exec-approval-forwarder.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-approval-forwarder.ts)             |
| 主机执行通信     | [src/infra/exec-host.ts](file:///d:/prj/openclaw_analyze/src/infra/exec-host.ts)                                         |

### exec 工具实现

| 功能             | 文件路径                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| exec 工具工厂    | [src/agents/bash-tools.exec.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts)                                   |
| Gateway 主机审批 | [src/agents/bash-tools.exec-host-gateway.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-host-gateway.ts)         |
| Node 主机审批    | [src/agents/bash-tools.exec-host-node.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-host-node.ts)               |
| 审批请求注册     | [src/agents/bash-tools.exec-approval-request.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-approval-request.ts) |
| 运行时参数处理   | [src/agents/bash-tools.exec-runtime.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts)                   |

### 文件系统边界保护

| 功能             | 文件路径                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| 安全文件操作核心 | [src/infra/fs-safe.ts](file:///d:/prj/openclaw_analyze/src/infra/fs-safe.ts)                     |
| 路径边界检查     | [src/infra/path-guards.ts](file:///d:/prj/openclaw_analyze/src/infra/path-guards.ts)             |
| 路径别名逃逸防护 | [src/infra/path-alias-guards.ts](file:///d:/prj/openclaw_analyze/src/infra/path-alias-guards.ts) |
| 文件身份验证     | [src/infra/file-identity.ts](file:///d:/prj/openclaw_analyze/src/infra/file-identity.ts)         |
