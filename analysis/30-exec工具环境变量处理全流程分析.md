# OpenClaw exec 工具环境变量处理全流程分析

## 概述

本文分析 Agent 执行 Shell 命令时，环境变量从继承、清理、验证、合并到最终传递给子进程的完整生命周期。环境变量处理是 exec 工具安全体系的核心环节，直接影响命令执行的隔离性和安全性。

---

## 一、环境变量处理全景流程图

```
┌─────────────────────────────────────────────────────────────────────┐
│  Agent 调用 exec 工具                                                │
│  params = { command, env?, host?, workdir?, ... }                    │
│  defaults = { host, security, pathPrepend, ... }                     │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ ① 继承宿主环境变量                                                    │
│    coerceEnv(process.env)  →  inheritedBaseEnv                       │
│    [bash-tools.shared.ts:L36-L47]                                    │
│    将 NodeJS.ProcessEnv 中 string 类型的值提取到                      │
│    Record<string, string>，过滤掉 undefined 值                        │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ ② 根据 host 类型选择清理策略                                          │
│    [bash-tools.exec.ts:L505-L506]                                    │
│                                                                      │
│    host=sandbox?                                                     │
│      ├─ YES → baseEnv = inheritedBaseEnv（原始变量，不清理）           │
│      │         沙箱内隔离执行，宿主变量不会造成安全风险                 │
│      └─ NO  → baseEnv = sanitizeHostBaseEnv(inheritedBaseEnv)        │
│                [bash-tools.exec-runtime.ts:L67-L82]                   │
│                遍历所有变量：                                         │
│                · PATH → 保留                                          │
│                · 危险变量 → 跳过（LD_PRELOAD, BASH_ENV 等）          │
│                · 其他 → 保留                                          │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ ③ 验证用户传入的 env 参数（仅 host≠sandbox 时）                      │
│    [bash-tools.exec.ts:L510-L512]                                    │
│                                                                      │
│    if (host !== "sandbox" && params.env):                            │
│      validateHostEnv(params.env)                                     │
│      [bash-tools.exec-runtime.ts:L88-L111]                           │
│                                                                      │
│      遍历 params.env 的每个 key：                                    │
│      · isDangerousHostEnvVarName? → 抛出 Security Violation          │
│      · upperKey === "PATH"?        → 抛出 Security Violation         │
│                                                                      │
│    危险变量黑名单来源：                                               │
│    [host-env-security-policy.json]                                   │
│    blockedKeys:   NODE_OPTIONS, PYTHONPATH, BASH_ENV, LD_*, ...      │
│    blockedPrefixes: DYLD_, LD_, BASH_FUNC_                           │
│    blockedOverrideKeys: HOME, GIT_SSH_COMMAND, OPENSSL_CONF, ...     │
│    blockedOverridePrefixes: GIT_CONFIG_, NPM_CONFIG_                 │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ ④ 合并环境变量                                                      │
│    [bash-tools.exec.ts:L515]                                         │
│                                                                      │
│    host≠sandbox:                                                     │
│      mergedEnv = { ...baseEnv, ...params.env }                       │
│      （用户 env 覆盖基础 env，但 ③ 已验证不含危险变量）              │
│                                                                      │
│    host=sandbox:                                                     │
│      env = buildSandboxEnv({...})                                    │
│      [bash-tools.shared.ts:L17-L34]                                  │
│      构建方式：                                                       │
│        1. 初始化 { PATH: defaultPath, HOME: containerWorkdir }       │
│        2. 合并 sandboxEnv（沙箱配置中的 env）                        │
│        3. 合并 paramsEnv（用户传入的 env）                           │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ ⑤ Shell PATH 增强（仅 gateway + 未指定 PATH 时）                     │
│    [bash-tools.exec.ts:L538-L545]                                    │
│                                                                      │
│    if (!sandbox && host==="gateway" && !params.env?.PATH):           │
│      shellPath = getShellPathFromLoginShell({...})                    │
│      applyShellPath(env, shellPath)                                  │
│      [bash-tools.exec-runtime.ts:L282-L301]                          │
│      将登录 shell 的 PATH 条目前置合并到 env.PATH                     │
│      （确保 gateway 上执行的命令能找到用户安装的工具）                 │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ ⑥ PATH 前置配置（pathPrepend）                                      │
│    [bash-tools.exec.ts:L549-L556]                                    │
│                                                                      │
│    if (host==="node" && pathPrepend.length > 0):                     │
│      → 警告并忽略（node 主机不支持 PATH 覆盖）                       │
│    else:                                                             │
│      applyPathPrepend(env, defaultPathPrepend)                       │
│      [path-prepend.ts:L61-L76]                                       │
│      通过 findPathKey() 兼容 Windows 大小写                          │
│      通过 mergePathPrepend() 去重合并并前置                           │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ ⑦ 传入 runExecProcess 并注入运行时标记                               │
│    [bash-tools.exec-runtime.ts:L455-L458]                            │
│                                                                      │
│    shellRuntimeEnv = { ...opts.env, OPENCLAW_SHELL: "exec" }         │
│    注入 OPENCLAW_SHELL=exec 标记，标识进程来源                       │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ ⑧ 根据 host/sandbox/pty 模式传递环境变量到实际进程                   │
│    [bash-tools.exec-runtime.ts:L553-L598]                            │
│                                                                      │
│    ┌─ sandbox 模式 ──────────────────────────────────────────────┐   │
│    │ buildDockerExecArgs()                                        │   │
│    │ [bash-tools.shared.ts:L49-L104]                              │   │
│    │ · 遍历 shellRuntimeEnv → -e KEY=VALUE                        │   │
│    │ · PATH 跳过（宿主 PATH 会污染容器）                           │   │
│    │ · 改为 -e OPENCLAW_PREPEND_PATH=$PATH                        │   │
│    │ · 最终命令: /bin/sh -lc 'export PATH=...; command'           │   │
│    │   login shell 先 source /etc/profile，再前置自定义 PATH       │   │
│    │ · env 参数使用 process.env（Docker 进程本身的环境）           │   │
│    └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│    ┌─ PTY 模式 ──────────────────────────────────────────────────┐   │
│    │ supervisor.spawn({ mode: "pty", env: shellRuntimeEnv })      │   │
│    │ PTY 模式继承 shellRuntimeEnv 作为子进程环境                   │   │
│    └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│    ┌─ 普通 child 模式 ───────────────────────────────────────────┐   │
│    │ supervisor.spawn({ mode: "child", argv, env: shellRuntimeEnv})│  │
│    │ 子进程继承 shellRuntimeEnv                                    │   │
│    └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│    ┌─ node 模式 ─────────────────────────────────────────────────┐   │
│    │ executeNodeHostCommand({ env, requestedEnv })                 │   │
│    │ env 和 requestedEnv 分别传递给远程节点                         │   │
│    └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、关键实现代码详解

### 1. 环境变量类型转换 — `coerceEnv()`

**文件**: [bash-tools.shared.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.shared.ts) L36-L47

```typescript
export function coerceEnv(env?: NodeJS.ProcessEnv | Record<string, string>) {
  const record: Record<string, string> = {};
  if (!env) { return record; }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      record[key] = value;
    }
  }
  return record;
}
```

Node.js 的 `process.env` 中值可能是 `string | undefined`（Windows 上还有大小写问题），`coerceEnv` 将其标准化为 `Record<string, string>`，过滤掉所有 `undefined` 值。这是整个环境变量处理管线的**第一步**，为后续的清理和验证提供统一的类型基础。

### 2. 危险变量判定 — `isDangerousHostEnvVarName()`

**文件**: [host-env-security.ts](file:///d:/prj/openclaw_analyze/src/infra/host-env-security.ts)

判定逻辑基于外部 JSON 策略文件 [host-env-security-policy.json](file:///d:/prj/openclaw_analyze/src/infra/host-env-security-policy.json)，实现了**数据驱动的安全策略**：

```typescript
export function isDangerousHostEnvVarName(rawKey: string): boolean {
  const key = normalizeEnvVarKey(rawKey);
  if (!key) { return false; }
  const upper = key.toUpperCase();
  if (HOST_DANGEROUS_ENV_KEYS.has(upper)) { return true; }
  return HOST_DANGEROUS_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}
```

**危险变量黑名单分类**：

| 类别 | 示例 | 安全风险 |
|------|------|---------|
| **blockedKeys**（继承时即阻止） | `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `BASH_ENV`, `NODE_OPTIONS`, `PYTHONPATH`, `SHELL`, `SSLKEYLOGFILE` | 动态库劫持、shell 启动文件注入、Node/Python 路径劫持、SSL 密钥泄露 |
| **blockedPrefixes** | `LD_*`, `DYLD_*`, `BASH_FUNC_*` | Unix/macOS 动态链接器注入、bash 函数注入 |
| **blockedOverrideKeys**（用户覆盖时阻止） | `HOME`, `GIT_SSH_COMMAND`, `OPENSSL_CONF`, `EDITOR`, `PROMPT_COMMAND` | 主目录劫持、SSH 命令注入、OpenSSL 配置篡改、命令执行劫持 |
| **blockedOverridePrefixes** | `GIT_CONFIG_*`, `NPM_CONFIG_*` | Git/npm 配置注入 |

### 3. 宿主环境清理 — `sanitizeHostBaseEnv()`

**文件**: [bash-tools.exec-runtime.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts) L67-L82

```typescript
export function sanitizeHostBaseEnv(env: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const upperKey = key.toUpperCase();
    if (upperKey === "PATH") { sanitized[key] = value; continue; }
    if (isDangerousHostEnvVarName(upperKey)) { continue; }
    sanitized[key] = value;
  }
  return sanitized;
}
```

仅对 `host=gateway/node` 执行，从宿主继承的环境中**剔除危险变量但保留 PATH**：
- PATH 特殊保留（由后续步骤单独处理）
- `isDangerousHostEnvVarName` 命中的变量直接跳过
- 这是一个**静默清理**过程，不会抛出异常，仅过滤

### 4. 用户环境验证 — `validateHostEnv()`

**文件**: [bash-tools.exec-runtime.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts) L88-L111

```typescript
export function validateHostEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase();
    if (isDangerousHostEnvVarName(upperKey)) {
      throw new Error(`Security Violation: Environment variable '${key}' is forbidden during host execution.`);
    }
    if (upperKey === "PATH") {
      throw new Error("Security Violation: Custom 'PATH' variable is forbidden during host execution.");
    }
  }
}
```

与 `sanitizeHostBaseEnv` 不同，这是一个**硬性校验**（fail closed），对用户通过 `params.env` 传入的环境变量：
- 危险变量 → 抛出异常，拒绝执行
- **任何形式的 PATH 修改** → 抛出异常（防止二进制劫持）

### 5. 沙箱环境变量构建 — `buildSandboxEnv()`

**文件**: [bash-tools.shared.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.shared.ts) L17-L34

```typescript
export function buildSandboxEnv(params: {
  defaultPath: string;
  paramsEnv?: Record<string, string>;
  sandboxEnv?: Record<string, string>;
  containerWorkdir: string;
}) {
  const env: Record<string, string> = {
    PATH: params.defaultPath,
    HOME: params.containerWorkdir,
  };
  for (const [key, value] of Object.entries(params.sandboxEnv ?? {})) {
    env[key] = value;
  }
  for (const [key, value] of Object.entries(params.paramsEnv ?? {})) {
    env[key] = value;
  }
  return env;
}
```

沙箱模式下环境变量**完全重建**，不继承宿主环境：
- `PATH` = DEFAULT_PATH（Linux 标准路径）
- `HOME` = containerWorkdir（容器内工作目录）
- 合并 `sandboxEnv`（沙箱配置中的 env）
- 合并 `paramsEnv`（用户传入的 env，覆盖前面的同名键）

### 6. Docker exec 的 PATH 特殊处理 — `buildDockerExecArgs()`

**文件**: [bash-tools.shared.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.shared.ts) L49-L104

这是整个流程中最精巧的部分：

```typescript
// 1. 跳过 PATH — 宿主 PATH（如 Windows 路径）会污染容器
for (const [key, value] of Object.entries(params.env)) {
  if (key === "PATH") { continue; }
  args.push("-e", `${key}=${value}`);
}

// 2. 将 PATH 作为 OPENCLAW_PREPEND_PATH 传递
const hasCustomPath = typeof params.env.PATH === "string" && params.env.PATH.length > 0;
if (hasCustomPath) {
  args.push("-e", `OPENCLAW_PREPEND_PATH=${params.env.PATH}`);
}

// 3. 在 login shell 后注入 PATH
const pathExport = hasCustomPath
  ? 'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; '
  : "";
args.push(params.containerName, "/bin/sh", "-lc", `${pathExport}${params.command}`);
```

**为什么不直接 `-e PATH=...`？** 因为 `docker exec` 的 `-e` 会在 login shell (`-l`) 之前设置环境变量，而 login shell 会 source `/etc/profile` **重置 PATH**，覆盖掉 `-e` 传入的值。解决方案是：

1. 先将 PATH 存为 `OPENCLAW_PREPEND_PATH`（通过 `-e` 传入容器环境）
2. 使用 `/bin/sh -lc` 执行命令（login shell 先 source `/etc/profile` 建立标准 PATH）
3. 在命令执行前 `export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"` 将自定义路径前置
4. `unset OPENCLAW_PREPEND_PATH` 清理临时变量

这种方式确保了：
- 容器内的标准系统路径始终可用（由 `/etc/profile` 设置）
- 用户自定义的路径优先级最高（前置到 PATH 头部）
- 不会受到宿主 PATH 的污染（如 Windows 路径）

### 7. PATH 前置合并 — `applyPathPrepend()` / `mergePathPrepend()`

**文件**: [path-prepend.ts](file:///d:/prj/openclaw_analyze/src/infra/path-prepend.ts)

```typescript
export function findPathKey(env: Record<string, string>): string {
  if ("PATH" in env) { return "PATH"; }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") { return key; }
  }
  return "PATH";
}

export function mergePathPrepend(existing: string | undefined, prepend: string[]) {
  if (prepend.length === 0) { return existing; }
  const partsExisting = (existing ?? "")
    .split(path.delimiter).map((part) => part.trim()).filter(Boolean);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const part of [...prepend, ...partsExisting]) {
    if (seen.has(part)) { continue; }
    seen.add(part);
    merged.push(part);
  }
  return merged.join(path.delimiter);
}

export function applyPathPrepend(env: Record<string, string>, prepend: string[] | undefined, options?: { requireExisting?: boolean }) {
  if (!Array.isArray(prepend) || prepend.length === 0) { return; }
  const pathKey = findPathKey(env);
  if (options?.requireExisting && !env[pathKey]) { return; }
  const merged = mergePathPrepend(env[pathKey], prepend);
  if (merged) { env[pathKey] = merged; }
}
```

关键设计：
- `findPathKey()` — 兼容 Windows 的 `Path` vs `PATH` 大小写问题
- `normalizePathPrepend()` — 去重、去空、去首尾空白
- `mergePathPrepend()` — 将 prepend 条目置于现有 PATH 之前，使用 `Set` 去重
- `applyPathPrepend()` — 组合以上操作，直接修改 env 对象

---

## 三、三种 host 模式的环境变量对比

| 特性 | Sandbox (Docker) | Gateway (宿主) | Node (远程) |
|------|-----------------|----------------|-------------|
| 基础环境来源 | 重建（PATH+HOME+sandboxEnv） | `sanitizeHostBaseEnv(process.env)` | 同 Gateway |
| 危险变量清理 | 不需要（容器隔离） | 继承时清理 + 用户 env 验证 | 同 Gateway |
| 用户 env PATH | 允许（容器内安全） | **禁止**（抛出异常） | **禁止** |
| Login shell PATH | 自动（`/bin/sh -lc`） | 通过 `getShellPathFromLoginShell` 获取 | N/A |
| pathPrepend | 支持 | 支持 | **忽略**（发警告） |
| PATH 传递方式 | `OPENCLAW_PREPEND_PATH` 间接传递 | 直接合并到 env.PATH | 由远程节点处理 |
| OPENCLAW_SHELL 标记 | 注入 | 注入 | 注入 |

---

## 四、安全设计分析

### 4.1 防御层次

环境变量安全采用**三层防御**：

1. **第一层：继承清理** (`sanitizeHostBaseEnv`)
   - 作用于：从 `process.env` 继承到非沙箱执行环境
   - 方式：静默过滤危险变量
   - 保留 PATH（由后续层处理）

2. **第二层：用户验证** (`validateHostEnv`)
   - 作用于：用户通过 `params.env` 传入的变量
   - 方式：硬性拒绝，抛出 Security Violation
   - 额外禁止 PATH 修改

3. **第三层：沙箱隔离** (Docker container)
   - 作用于：整个执行环境
   - 方式：完全重建环境变量，不继承宿主
   - PATH 通过 `OPENCLAW_PREPEND_PATH` 间接安全传递

### 4.2 PATH 安全的特殊处理

PATH 在整个系统中享有特殊地位，因为它是**命令解析的核心安全边界**：

- **宿主执行时**：完全禁止用户修改 PATH，防止二进制劫持
- **沙箱执行时**：通过 `OPENCLAW_PREPEND_PATH` 间接传递，避免宿主 PATH 污染容器
- **Windows 兼容**：`findPathKey()` 处理大小写差异
- **去重保护**：`mergePathPrepend()` 使用 `Set` 确保路径不重复

---

## 五、时序总结

环境变量在任务执行中的**设置时机**按顺序为：

1. **进程启动前**（`createExecTool` 工厂函数）— 读取配置中的 `pathPrepend`、`safeBins` 等静态配置
2. **每次 execute 调用时**：
   - ① `coerceEnv(process.env)` — 继承宿主环境
   - ② `sanitizeHostBaseEnv` 或保留原始 — 按 host 类型清理
   - ③ `validateHostEnv(params.env)` — 验证用户传入变量
   - ④ 合并 `baseEnv + params.env` 或 `buildSandboxEnv`
   - ⑤ `applyShellPath` — Gateway 登录 shell PATH
   - ⑥ `applyPathPrepend` — 配置级 PATH 前置
   - ⑦ `shellRuntimeEnv` 注入 `OPENCLAW_SHELL=exec`
   - ⑧ 传入 `supervisor.spawn()` 或 `buildDockerExecArgs()` — 环境变量最终落地到子进程

**存储方式**：环境变量不被持久化存储，而是以 `Record<string, string>` 的形式在内存中逐层传递和变换。最终的 `shellRuntimeEnv` 通过 `supervisor.spawn()` 的 `env` 参数传递给底层子进程，进程退出后即释放。

---

## 六、涉及的关键文件索引

| 文件 | 职责 |
|------|------|
| [bash-tools.exec.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec.ts) | exec 工具入口，协调环境变量处理流程 |
| [bash-tools.exec-runtime.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.exec-runtime.ts) | 安全验证函数、PATH 处理、进程运行时 |
| [bash-tools.shared.ts](file:///d:/prj/openclaw_analyze/src/agents/bash-tools.shared.ts) | `coerceEnv`、`buildSandboxEnv`、`buildDockerExecArgs` |
| [host-env-security.ts](file:///d:/prj/openclaw_analyze/src/infra/host-env-security.ts) | 危险变量判定逻辑 |
| [host-env-security-policy.json](file:///d:/prj/openclaw_analyze/src/infra/host-env-security-policy.json) | 危险变量黑名单策略数据 |
| [path-prepend.ts](file:///d:/prj/openclaw_analyze/src/infra/path-prepend.ts) | PATH 前置合并工具函数 |
| [shell-env.ts](file:///d:/prj/openclaw_analyze/src/infra/shell-env.ts) | 登录 shell PATH 获取 |
