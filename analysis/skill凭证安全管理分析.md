# OpenClaw Skill 凭证安全管理分析

## 概述

OpenClaw 围绕"技能（Skill）→ 凭证（Credential）→ SecretRef 引用（Reference）→ Provider 解析（Resolution）"构建了一套**纵深防御**体系。核心目标是：**永远不要把明文凭证写进配置文件、永远不要让凭证走模型热路径**。

本文基于以下源码与文档分析：

- [src/agents/skills/](file:///d:/prj/openclaw_analyze/src/agents/skills/)（技能加载与 env 注入）
- [src/secrets/](file:///d:/prj/openclaw_analyze/src/secrets/)（SecretRef、Provider、运行时快照、审计、应用）
- [src/config/types.secrets.ts](file:///d:/prj/openclaw_analyze/src/config/types.secrets.ts)（SecretRef 类型契约）
- [src/config/env-vars.ts](file:///d:/prj/openclaw_analyze/src/config/env-vars.ts)（env 收集与净化）
- [src/infra/host-env-security.ts](file:///d:/prj/openclaw_analyze/src/infra/host-env-security.ts)（host env 黑名单策略）
- [src/agents/sandbox/sanitize-env-vars.ts](file:///d:/prj/openclaw_analyze/src/agents/sandbox/sanitize-env-vars.ts)（敏感 env 模式白/黑名单）
- [docs/gateway/secrets.md](file:///d:/prj/openclaw_analyze/docs/gateway/secrets.md)（SecretRef 协议说明）
- [docs/tools/skills.md](file:///d:/prj/openclaw_analyze/docs/tools/skills.md)（技能与 env 注入规范）
- [SECURITY.md](file:///d:/prj/openclaw_analyze/SECURITY.md)（信任模型声明）

---

## 一、技能侧：声明与配置分离

技能通过 `SKILL.md` 的 frontmatter **只声明**自己需要什么凭证（[docs/tools/skills.md](file:///d:/prj/openclaw_analyze/docs/tools/skills.md)）：

```yaml
metadata:
  {
    "openclaw":
      {
        "requires": { "env": ["GEMINI_API_KEY"], "bins": ["gemini"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
```

实际凭证在 `~/.openclaw/openclaw.json` 的 `skills.entries.<key>` 下配置（[docs/tools/skills.md](file:///d:/prj/openclaw_analyze/docs/tools/skills.md#L196-L243)）：

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
        env: { GEMINI_API_KEY: "GEMINI_KEY_HERE" }
      }
    }
  }
}
```

支持两种 `apiKey` 形式：

- **明文字符串**（向后兼容）
- **SecretRef 对象** `{ source, provider, id }`

`env` 注入规则：变量**已存在**则不覆盖，避免破坏用户显式设置（[env-overrides.ts:108-117](file:///d:/prj/openclaw_analyze/src/agents/skills/env-overrides.ts#L108-L117)）。

---

## 二、SecretRef 契约：类型化引用系统

`SecretRef` 是统一引用形态，定义在 [types.secrets.ts:9-13](file:///d:/prj/openclaw_analyze/src/config/types.secrets.ts#L9-L13)：

| 字段 | 来源 | ID 校验 |
|---|---|---|
| `env` | 环境变量 | `^[A-Z][A-Z0-9_]{0,127}$` |
| `file` | 本地文件（绝对路径） | RFC6901 JSON Pointer |
| `exec` | 外部命令（无 shell） | `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$` + 禁 `..` 段 |

provider alias 严格匹配 `^[a-z][a-z0-9_-]{0,63}$`。可同时支持 `coerceSecretRef()`、legacy `{source,id}` 自动补 provider、`${VAR}` 模板字符串三种写法。

---

## 三、Provider 安全模型（核心防线）

### 3.1 Env Provider

[secrets/resolve.ts:251-275](file:///d:/prj/openclaw_analyze/src/secrets/resolve.ts#L251-L275)：

- 可选 `allowlist` 限制可解析的 env 名称
- 缺失/空值立即失败

### 3.2 File Provider

[secrets/resolve.ts:127-243](file:///d:/prj/openclaw_analyze/src/secrets/resolve.ts#L127-L243) 通过 [`assertSecurePath`](file:///d:/prj/openclaw_analyze/src/secrets/resolve.ts#L146-L208) 实施多重检查：

- **绝对路径**强制
- **禁止符号链接**（除非 `allowSymlinkPath`）
- **trustedDirs** 限制（resolveUserPath 归一化后用 `isPathInside` 检查）
- **Unix 权限检查**：禁止 world/group 写；默认禁止 world/group 读
- **UID 归属检查**：非 Windows 下文件 UID 必须等于当前进程 UID
- **Windows ACL 失败关闭**：无法验证时直接拒绝（需显式 `allowInsecurePath: true`）
- 读取有 `timeoutMs`（默认 5s）、`maxBytes`（默认 1MB）限制

### 3.3 Exec Provider

[secrets/resolve.ts](file:///d:/prj/openclaw_analyze/src/secrets/resolve.ts)：

- `spawn` 时显式 `shell: false`（防命令注入）
- `windowsHide: true`
- **trustedDirs** 校验
- **timeoutMs**（默认 5s）+ **noOutputTimeoutMs** 双重超时
- **maxOutputBytes**（默认 1MB）
- `passEnv` 白名单控制传入 env
- `jsonOnly` 强制 JSON 响应
- 显式 `command` 必须为绝对路径，符号链接默认拒绝（`allowSymlinkCommand` 例外）

---

## 四、运行时快照：热路径不解析

四阶段生命周期（[secrets/runtime.ts](file:///d:/prj/openclaw_analyze/src/secrets/runtime.ts)）：

1. `prepareSecretsRuntimeSnapshot` — **启动时**把配置 + auth-profiles + 模型存储中所有 SecretRef 全部解析，填入克隆后的 `resolvedConfig`
2. `activateSecretsRuntimeSnapshot` — **原子**安装：成功全换，失败回退到最后已知良好（last-known-good）状态
3. `getActiveSecretsRuntimeSnapshot()` — 业务代码只读这份内存快照
4. `secrets.reload` — 重新解析，整批原子替换

> **核心安全收益**：模型请求、消息投递、Discord/Telegram 发送等热路径**从不直接调用 provider**。Provider 故障不会造成运行时拒绝服务，且凭证永远不在每次请求时重新接触文件系统或外部进程。

[docs/gateway/secrets.md](file:///d:/prj/openclaw_analyze/docs/gateway/secrets.md) 明确："Resolution is eager during activation, not lazy on request paths."

---

## 五、活动面过滤（Active-Surface Filtering）

不是所有 SecretRef 都会阻塞启动。[docs/gateway/secrets.md](file:///d:/prj/openclaw_analyze/docs/gateway/secrets.md) 列出规则：

- **启用**的频道/账号/工具 → 未解析 ref **阻塞启动**
- **禁用**的频道/账号/工具 → 未解析 ref 产生 `SECRETS_REF_IGNORED_INACTIVE_SURFACE` 诊断，**不阻塞**
- 网关认证面有显式诊断日志（`SECRETS_GATEWAY_AUTH_SURFACE`）说明某 ref 是 `active` 还是 `inactive`

这避免了一个常见痛点："我有一个未配置的可选功能，凭什么不让 gateway 起来？"

---

## 六、审计：发现残留明文

`openclaw secrets audit`（[secrets/audit.ts](file:///d:/prj/openclaw_analyze/src/secrets/audit.ts)）扫描面：

| 扫描目标 | 关注的 finding |
|---|---|
| `openclaw.json` | `PLAINTEXT_FOUND`（任何被识别为敏感字段的明文） |
| `auth-profiles.json` | `api_key` / `token` 明文 |
| `models.json`（生成产物） | provider `apiKey`、敏感 header（启发式：name 含 `token/secret/password/credential/api-key` 等） |
| `~/.openclaw/.env` | `PLAINTEXT_FOUND`（基于 `listKnownSecretEnvVarNames()` 已知清单） |
| legacy `auth.json` | `LEGACY_RESIDUE` |
| SecretRef 解析 | `REF_UNRESOLVED` |
| 优先级漂移 | `REF_SHADOWED`（auth-profiles 凭证盖过 config ref） |

`--check` 模式：CI 闸门，findings 退出码 1，unresolved 退出码 2。

---

## 七、配置-生成-清理单向迁移

`secrets configure`（交互式）→ 预解析 → 写 plan → `secrets apply`（[secrets/apply.ts](file:///d:/prj/openclaw_analyze/src/secrets/apply.ts)）：

- 把明文字段替换为 SecretRef 对象
- 同步清理 `auth-profiles.json`、`legacy auth.json`、`.env` 中已迁移值
- **不写回滚备份**（设计意图：[docs/cli/secrets.md](file:///d:/prj/openclaw_analyze/docs/cli/secrets.md) "Why no rollback backups"）

---

## 八、技能 env 注入：引用计数 + 白名单

`applySkillEnvOverrides`（[env-overrides.ts](file:///d:/prj/openclaw_analyze/src/agents/skills/env-overrides.ts)）有四道闸门：

1. **不覆盖外部值**：`process.env[envKey] !== undefined && !activeSkillEnvEntries.has(envKey)` 时跳过
2. **敏感字段白名单**：仅当 `primaryEnv` 或 `requires.env` 显式声明的 key 才允许携带敏感值
3. **黑名单**：调用 `sanitizeEnvVars`（[sanitize-env-vars.ts](file:///d:/prj/openclaw_analyze/src/agents/sandbox/sanitize-env-vars.ts)）过滤 `ANTHROPIC_API_KEY/OPENAI_API_KEY/_API_KEY|_TOKEN|_PASSWORD|_PRIVATE_KEY|_SECRET$` 等
4. **致命 host env 黑名单**：`isAlwaysBlockedSkillEnvKey` 命中 `host-env-security-policy.json` 中 dangerous key（如 `OPENSSL_CONF`）一律拒绝

**引用计数 + 基线恢复**（[env-overrides.ts:23-79](file:///d:/prj/openclaw_analyze/src/agents/skills/env-overrides.ts#L23-L79)）：多次进入嵌套技能时计数累加，离开时回退到注入前的 baseline，不会污染下一次 agent turn。

**子进程隔离**：[env-overrides.runtime.ts](file:///d:/prj/openclaw_analyze/src/agents/skills/env-overrides.runtime.ts) 暴露 `getActiveSkillEnvKeys()`，ACP harness 派生子进程（如 Codex CLI）前会**剥离**这些 key，防止 `OPENAI_API_KEY` 泄漏到外部 CLI（参见 issue #36280）。

---

## 九、Host env 通用安全策略

[infra/host-env-security.ts](file:///d:/prj/openclaw_analyze/src/infra/host-env-security.ts) 加载外部 JSON 策略 [host-env-security-policy.json](file:///d:/prj/openclaw_analyze/src/infra/host-env-security-policy.json)：

| 类别 | 示例 |
|---|---|
| `blockedKeys` | `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `BASH_ENV`, `IFS`, `SSLKEYLOGFILE`, `BASH_FUNC_*` |
| `blockedOverrideKeys` | `HOME`, `EDITOR`, `OPENSSL_CONF`, `GIT_SSH_COMMAND`, `PAGER` |
| `blockedOverridePrefixes` | `GIT_CONFIG_`, `NPM_CONFIG_` |
| 硬阻断 | `PATH` 任何请求方 override |

`sanitizeHostExecEnv` 在 `bash-tools.exec-runtime.ts`、`node-host/invoke.ts` 等执行点统一调用——**所有 exec 派生都用同一份净化后的 env**。

---

## 十、env 值本身的内容检查

[sanitize-env-vars.ts:36-46](file:///d:/prj/openclaw_analyze/src/agents/sandbox/sanitize-env-vars.ts#L36-L46)：

- 拒绝 `\0`（注入防御）
- 长度上限 32768
- 启发式检测 80+ 字符的 base64 字符串（防止误把二进制密钥当普通变量通过）

---

## 总结：分层安全模型

| 层级 | 机制 | 防什么 |
|---|---|---|
| 1. 声明 | `requires.env` / `primaryEnv` 在 frontmatter | 技能无歧义声明依赖 |
| 2. 配置 | SecretRef 对象，类型 + 模式校验 | 注入非法引用形态 |
| 3. Provider | 路径/UID/ACL/trustedDirs/超时/大小限制 | 任意文件/命令读取、TOCTOU、DoS |
| 4. 启动 | 急切解析、原子快照、last-known-good | 故障放大、Provider 抖动影响热路径 |
| 5. 活动面 | 启用 vs 禁用频道独立判断 | 误报阻塞启动 |
| 6. 注入 | 引用计数 + 基线 + 敏感 key 白名单 | 凭证外泄到非预期 scope |
| 7. 子进程 | `getActiveSkillEnvKeys()` 剥离 | 凭证泄漏到外部 CLI |
| 8. 审计 | plaintext/unresolved/shadowed 多类检测 | 历史残留、配置漂移 |
| 9. 迁移 | configure → apply，单向 scrub | 长期收敛明文 |
| 10. Host env | JSON 策略驱动的统一黑名单 | 库加载劫持、PATH 劫持 |

---

## 信任模型备注

值得注意的"信任模型"声明（[SECURITY.md](file:///d:/prj/openclaw_analyze/SECURITY.md)）：OpenClaw **不是**多租户对抗系统——能修改 `~/.openclaw` 即视为受信操作者。所有上述防御是在该信任边界内对**配置卫生**和**误操作/注入**的纵深加固，而不是对抗已经获得 shell 权限的恶意用户。
