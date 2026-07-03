# OpenClaw Skill 凭证获取序列图

## 概述

本文梳理当用户消息触发一个 agent turn、执行某个 skill 时，OpenClaw **如何把 SecretRef/明文凭证解析出来并注入到 `process.env`**，使得子进程（如 `gh`、`gemini` CLI）能够读取到正确的 `OPENAI_API_KEY` 之类的环境变量。

整个流程分两个**正交但相互衔接**的阶段：

1. **启动阶段（启动时一次性）**：secrets runtime snapshot 把所有 SecretRef 解析为**明文**，克隆到内存快照
2. **运行阶段（每个 agent turn）**：从快照/配置读取 `apiKey`/`env` → 经四道闸门 → 注入 `process.env` → 子进程读取

涉及的源码：

- [src/secrets/runtime.ts](file:///d:/prj/openclaw_analyze/src/secrets/runtime.ts) — 启动时快照
- [src/secrets/resolve.ts](file:///d:/prj/openclaw_analyze/src/secrets/resolve.ts) — 三种 Provider 解析
- [src/secrets/runtime-auth-collectors.ts](file:///d:/prj/openclaw_analyze/src/secrets/runtime-auth-collectors.ts) — auth-profiles 凭证收集
- [src/agents/skills/env-overrides.ts](file:///d:/prj/openclaw_analyze/src/agents/skills/env-overrides.ts) — skill env 注入核心
- [src/agents/skills/workspace.ts](file:///d:/prj/openclaw_analyze/src/agents/skills/workspace.ts) — skill 快照构建
- [src/agents/pi-embedded-runner/run/attempt.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-embedded-runner/run/attempt.ts) — 注入/恢复现场
- [src/acp/client.ts](file:///d:/prj/openclaw_analyze/src/acp/client.ts) — 子进程 spawn 时剥离已注入 key

---

## 一、调用链总览

```
Gateway 启动
  └─ prepareSecretsRuntimeSnapshot
       ├─ collectConfigAssignments  (走 core + channels 收集器)
       │    └─ coerceSecretRef → pushAssignment
       ├─ collectAuthStoreAssignments  (auth-profiles.json)
       │    └─ resolveSecretInputRef → pushAssignment
       └─ resolveSecretRefValues  (批量)
            ├─ env provider   →  process.env
            ├─ file provider  →  assertSecurePath + fs.readFile
            └─ exec provider  →  spawn(command, shell:false)
       → applyResolvedAssignments
       → activateSecretsRuntimeSnapshot (原子 swap)

Agent turn 开始 (pi-embedded-runner/attempt.ts)
  └─ applySkillEnvOverridesFromSnapshot
       └─ 对每个 skill:
            ├─ resolveSkillConfig(skills.entries.<key>)
            ├─ 收集 skillConfig.env
            ├─ 读取 skillConfig.apiKey
            │    ├─ 明文字符串 → 直接用
            │    └─ SecretRef   → 已在启动时解析为明文
            ├─ sanitizeSkillEnvOverrides (4 道闸门)
            └─ acquireActiveSkillEnvKey → process.env[key] = value
  → restoreSkillEnv 在 finally 中恢复

Skill 子进程 spawn
  └─ ACP harness: getActiveSkillEnvKeys() → 剥离
  └─ exec tool: sanitizeHostExecEnv → 净化 env
```

---

## 二、序列图（启动阶段：SecretRef → 内存快照）

```mermaid
sequenceDiagram
    autonumber
    participant GW as Gateway 启动
    participant RT as secrets/runtime.ts
    participant CTX as ResolverContext
    participant CC as runtime-config-collectors
    participant AC as runtime-auth-collectors
    participant RV as secrets/resolve.ts
    participant ENV as EnvProvider
    participant FILE as FileProvider
    participant EXEC as ExecProvider
    participant SNAP as Active Snapshot (内存)

    GW->>RT: prepareSecretsRuntimeSnapshot(config)
    RT->>CTX: createResolverContext(sourceConfig, env)
    RT->>CC: collectConfigAssignments(config, context)
    CC->>CTX: pushAssignment(ref, path, apply)
    Note over CC,CTX: 遍历 models/auth/channels 等<br/>发现 SecretRef 即注册<br/>活动面过滤（SECRETS_REF_IGNORED_INACTIVE_SURFACE）

    RT->>AC: collectAuthStoreAssignments(store, agentDir, context)
    AC->>CTX: pushAssignment(ref, path, apply)<br/>SECRETS_REF_OVERRIDES_PLAINTEXT 警告
    AC->>AC: 若 inline ref 自动迁移到 keyRef 字段

    RT->>RV: resolveSecretRefValues(refs, config, env, cache)

    loop 并行按 provider（maxProviderConcurrency=4）
        alt source = "env"
            RV->>ENV: read process.env[id] (allowlist 过滤)
            ENV-->>RV: 明文
        else source = "file"
            RV->>FILE: assertSecurePath(absolute, trustedDirs, UID/ACL)
            FILE-->>RV: secureFilePath
            RV->>FILE: fs.readFile(timeout, maxBytes)
            FILE-->>RV: JSON / singleValue
        else source = "exec"
            RV->>EXEC: spawn(command, args, shell:false, timeout)
            EXEC->>EXEC: stdin: {protocolVersion, ids}<br/>stdout: {values, errors}
            EXEC-->>RV: values map
        end
    end

    RV-->>RT: resolvedByRefKey Map
    RT->>CTX: applyResolvedAssignments(assignments, resolved)
    CTX->>SNAP: assignment.apply(value) → 写入克隆 config / store
    Note over SNAP: 任何未解析 → 抛错，<br/>last-known-good 保留

    RT-->>GW: PreparedSecretsRuntimeSnapshot
    GW->>RT: activateSecretsRuntimeSnapshot(snapshot)
    RT->>SNAP: 原子替换 activeSnapshot<br/>structuredClone 三份 (config/authStores/webTools)
```

---

## 三、序列图（运行阶段：Skill env 注入到 process.env）

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户消息
    participant RUN as pi-embedded-runner<br/>/run/attempt.ts
    participant SS as SkillSnapshot<br/>(会话开始时构建)
    participant ENV as env-overrides.ts
    participant CFG as skills.entries<br/>(config)
    participant SAPI as sanitize-env-vars
    participant HES as host-env-security
    participant PE as process.env
    participant TRACK as activeSkillEnvEntries
    participant CP as Skill 子进程

    U->>RUN: 触发 agent turn
    RUN->>SS: resolveSkillsPromptForRun(snapshot)
    RUN->>ENV: applySkillEnvOverridesFromSnapshot(snapshot, config)

    loop 对每个 skill in snapshot.skills
        ENV->>CFG: resolveSkillConfig(config, skill.name)
        alt 命中 primaryEnv / requires.env
            ENV->>ENV: 收集 skillConfig.env<br/>排除 hasExternallyManagedValue
            ENV->>CFG: 读 skillConfig.apiKey
            alt 明文字符串
                CFG-->>ENV: 字符串直接用
            else SecretRef
                Note over ENV: 启动时已解析为明文，<br/>此处 assertSecretInputResolved 通过
                CFG-->>ENV: 明文
            end
            ENV->>ENV: canInjectPrimaryEnv?<br/>process.env[primaryEnv] 已被外部设置则跳过
            ENV->>ENV: pendingOverrides 合并
        end

        ENV->>SAPI: sanitizeSkillEnvOverrides(overrides, allowedSensitiveKeys)
        SAPI->>HES: isAlwaysBlockedSkillEnvKey(key)
        Note over HES: 黑名单:<br/>NODE_OPTIONS, LD_*, DYLD_*,<br/>BASH_ENV, IFS, OPENSSL_CONF,<br/>SSH_ASKPASS, EDITOR ...
        HES-->>SAPI: blocked / allowed
        SAPI->>SAPI: validateEnvVarValue(value)
        Note over SAPI: 拒绝 \0 / > 32K / 类 base64 80+
        SAPI-->>ENV: { allowed, blocked, warnings }

        alt blocked 非空
            ENV->>ENV: log.warn("Blocked ...")
        end
        alt warnings 非空
            ENV->>ENV: log.warn("Suspicious ...")
        end

        loop 对每个 allowed (envKey, envValue)
            ENV->>TRACK: acquireActiveSkillEnvKey(envKey, envValue)
            alt 首次注入
                TRACK->>TRACK: activeSkillEnvEntries.set
                TRACK->>PE: process.env[envKey] = value
                ENV->>ENV: updates.push({ key: envKey })
            else 已注入
                TRACK->>TRACK: count += 1
                Note over TRACK: 引用计数防嵌套 turn 互相覆盖
            end
        end
    end

    ENV-->>RUN: restore() 函数

    RUN->>CP: spawn(gh/gemini CLI, env = process.env)
    Note over RUN,CP: 此时子进程继承<br/>已被注入的 key

    RUN->>RUN: finally { restoreSkillEnv() }
    RUN->>TRACK: releaseActiveSkillEnvKey(key)
    alt count > 0
        TRACK->>TRACK: count -= 1
    else count = 0
        TRACK->>PE: 还原 baseline / delete
    end
```

---

## 四、序列图（子进程隔离：ACP harness 剥离注入 key）

```mermaid
sequenceDiagram
    autonumber
    participant TOOL as Tool: spawn ACP server<br/>(如 Codex CLI)
    participant ACP as acp/client.ts
    participant ER as env-overrides.runtime
    participant TRACK as activeSkillEnvEntries
    participant HES as host-env-security
    participant CP as ACP 子进程

    TOOL->>ACP: spawn server
    ACP->>ER: getActiveSkillEnvKeys()
    ER-->>ACP: Set(已注入 key, 如 OPENAI_API_KEY)
    ACP->>ACP: buildAcpClientStripKeys(stripKeys)
    ACP->>HES: sanitizeHostExecEnv({baseEnv, overrides=剥离后})
    Note over HES: 进一步: 净化 DYLD_/LD_/IFS/SSLKEYLOGFILE 等
    HES-->>ACP: cleanEnv
    ACP->>CP: spawn(command, env = cleanEnv)
    Note over CP: 不再继承 host 的 OPENAI_API_KEY
```

---

## 五、关键安全不变量

1. **不在热路径解析** — `secrets.resolve` 只在启动 / `secrets reload` 时调用；agent turn 中 `process.env` 已是明文
2. **类型校验先行** — SecretRef 形态在 [types.secrets.ts](file:///d:/prj/openclaw_analyze/src/config/types.secrets.ts) 入口处严格校验 (provider alias、id 模式、禁 `..`)
3. **活动面过滤** — 关闭的频道/工具即使 ref 解析失败也不阻塞启动
4. **原子快照** — 解析全成功才 swap，失败保留 last-known-good
5. **白名单 only** — skill env 注入必须 `primaryEnv` / `requires.env` 显式声明才允许
6. **黑名单兜底** — `host-env-security-policy.json` + `sanitize-env-vars.ts` 强制阻断危险 key
7. **不覆盖外部值** — `process.env[key]` 已被外部设置时绝不覆盖
8. **引用计数恢复** — 嵌套 turn 不会互相污染，`finally` 中回退到 baseline
9. **子进程剥离** — 派生外部 CLI 前 `getActiveSkillEnvKeys()` 显式移除已注入 key
10. **审计闭环** — `secrets audit` 在静态配置上扫描 plaintext/unresolved/shadowed

---

## 六、典型调用栈（单次 turn 注入 `GEMINI_API_KEY`）

```
attempt.ts:runPiAgent
└─ buildWorkspaceSkillSnapshot                  // 缓存层（可选）
└─ resolveSkillsPromptForRun                    // 构造 LLM 提示中的 skill 列表
└─ applySkillEnvOverridesFromSnapshot
   └─ for skill.name = "gemini"
      ├─ resolveSkillConfig(config, "gemini")
      │    └─ config.skills.entries.gemini
      │         ├─ env.GEMINI_API_KEY: SecretRef{env, default, GEMINI_API_KEY}
      │         └─ apiKey: SecretRef{env, default, GEMINI_API_KEY}
      ├─ pendingOverrides["GEMINI_API_KEY"] = 明文   // 来自启动快照
      ├─ sanitizeSkillEnvOverrides
      │    ├─ isAlwaysBlockedSkillEnvKey → false
      │    ├─ allowedSensitiveKeys 包含 "GEMINI_API_KEY"（来自 requires.env）
      │    └─ validateEnvVarValue → 无警告
      └─ process.env["GEMINI_API_KEY"] = 明文
└─ spawn("gemini", args, env=process.env)
   └─ gemini CLI 直接读 process.env["GEMINI_API_KEY"]
```
