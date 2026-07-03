# OpenClaw 命令执行默认黑白名单分析

## 概述

OpenClaw 的命令执行审批机制在 `security = "allowlist"` 模式下，通过三层放行通道（允许列表、安全二进制、Skill 自动允许）和多层拒绝规则，实现对主机命令执行的精细管控。本文档从源码层面详细列出所有硬编码的默认白名单和黑名单。

---

## 一、默认白名单（自动放行，无需审批）

### 1.1 默认安全二进制（Safe Bins）

**代码出处**: `src/infra/exec-command-resolution.ts:9`

```typescript
export const DEFAULT_SAFE_BINS = ["jq", "cut", "uniq", "head", "tail", "tr", "wc"];
```

共 **7 个**默认安全二进制，均为**仅限 stdin 操作**的流过滤器：

| 命令 | 用途 | 允许的最大位置参数 | 允许的值标志 | 被拒绝的标志 |
|------|------|-------------------|-------------|-------------|
| `jq` | JSON 流过滤 | 1 | `--arg`, `--argjson`, `--argstr` | `--argfile`, `--rawfile`, `--slurpfile`, `--from-file`, `--library-path`, `-L`, `-f` |
| `cut` | 文本列截取 | 0 | `--bytes`, `--characters`, `--fields`, `--delimiter`, `--output-delimiter`, `-b`, `-c`, `-f`, `-d` | 无 |
| `uniq` | 去重 | 0 | `--skip-fields`, `--skip-chars`, `--check-chars`, `--group`, `-f`, `-s`, `-w` | 无 |
| `head` | 取前 N 行 | 0 | `--lines`, `--bytes`, `-n`, `-c` | 无 |
| `tail` | 取后 N 行 | 0 | `--lines`, `--bytes`, `--sleep-interval`, `--max-unchanged-stats`, `--pid`, `-n`, `-c` | 无 |
| `tr` | 字符替换 | 最少 1，最多 2 | 无 | 无 |
| `wc` | 字数统计 | 0 | 无 | `--files0-from` |

**安全二进制的全局限制**：

- 必须位于受信任目录：默认仅 `/bin`、`/usr/bin`
- 拒绝位置文件参数和类路径 token（仅操作 stdin → stdout 流）
- 强制字面量 token（不做 glob 展开和 `$VARS` 展开）
- Windows 平台上安全二进制机制**完全禁用**
- 长选项采用 fail-closed 策略：未知标志和歧义缩写一律拒绝
- 如果二进制不在受信任目录（如 `/opt/homebrew/bin/jq`），需配置 `tools.exec.safeBinTrustedDirs`

### 1.2 可选添加的安全二进制

需在配置中手动启用 `tools.exec.safeBins`：

| 命令 | 用途 | 允许的最大位置参数 | 被拒绝的标志 |
|------|------|-------------------|-------------|
| `grep` | 文本搜索 | **0**（模式必须用 `-e`/`--regexp` 提供） | `--file`, `--exclude-from`, `--dereference-recursive`, `--directories`, `--recursive`, `-f`, `-d`, `-r`, `-R` |
| `sort` | 排序 | 0 | `--compress-program`, `--files0-from`, `--output`, `--random-source`, `--temporary-directory`, `-T`, `-o` |

**grep 的特殊规则**：
- 模式必须用 `-e`/`--regexp` 提供，位置参数形式被拒绝（防止文件操作数伪装为模式）
- 允许的值标志：`--regexp`, `--max-count`, `--after-context`, `--before-context`, `--context`, `--devices`, `--binary-files`, `--exclude`, `--include`, `--label`, `-e`, `-m`, `-A`, `-B`, `-C`, `-D`

### 1.3 允许列表（Allowlist）模式匹配

这是**用户自定义**的白名单，没有硬编码的默认条目。存储在 `~/.openclaw/exec-approvals.json` 的 `agents.<id>.allowlist` 中。

**模式示例**：

```
~/Projects/**/bin/rg         → 匹配 ~/Projects/ 下任意子目录的 bin/rg
~/.local/bin/*               → 匹配 ~/.local/bin/ 下的所有可执行文件
/opt/homebrew/bin/rg         → 匹配特定路径
/usr/bin/git                 → 匹配特定系统命令
```

**匹配规则**：

- 大小写不敏感的 glob 匹配
- 必须匹配**解析后的完整二进制路径**（纯 basename 如 `rg` 被忽略）
- Shell 链式命令（`&&`、`||`、`;`）的**每个段**都必须满足允许列表
- Dispatch wrapper（`env`、`nice`、`nohup` 等）会自动解包，匹配内部可执行文件
- Shell multiplexer（`busybox`、`toybox`）也会解包

### 1.4 Skill 自动允许

当 `autoAllowSkills = true` 时，已注册 skill 引用的可执行文件自动视为白名单条目。

**限制条件**：

- 只匹配**非路径限定的名称**（如 `mytool`，而非 `/usr/bin/mytool`）
- 可执行文件名和解析路径都必须在 Gateway 的 `skills.bins` 列表中
- 缓存 90 秒刷新一次
- 默认值为 `false`

---

## 二、默认黑名单（始终拒绝）

### 2.1 Shell 语法层面的硬性拒绝

**代码出处**: `src/infra/exec-approvals-analysis.ts:38`

```typescript
const DISALLOWED_PIPELINE_TOKENS = new Set([">", "<", "`", "\n", "\r", "(", ")"]);
```

| 被拒绝的语法 | 示例 | 原因 |
|---|---|---|
| 输出重定向 `>` | `echo hello > file.txt` | 可写入任意文件 |
| 输入重定向 `<` | `command < /etc/passwd` | 可读取任意文件 |
| 命令替换反引号 `` ` `` | `` echo `rm -rf /` `` | 可注入任意命令 |
| 换行符 `\n` `\r` | `cmd1\ncmd2` | 可注入额外命令 |
| 子 shell `(` `)` | `(malicious_command)` | 可执行任意代码 |

**在允许列表解析阶段还有以下硬性拒绝**：

| 被拒绝的形式 | 示例 | 原因 |
|---|---|---|
| `$()` 命令替换 | `echo $(cat /etc/passwd)` | 可注入任意命令（含双引号内） |
| 行续 `\` + `$()` | `echo $\n(id)` | 伪装的命令替换 |
| 未加引号的 heredoc 展开 | `<<EOF\n$VAR\nEOF` | heredoc 中未加引号的变量/命令替换 |
| 纯 basename 的白名单模式 | `pattern: "rg"` | 必须是路径模式如 `/opt/**/rg` |

### 2.2 macOS 审批弹窗的 Shell 控制语法黑名单

在 macOS 伴侣应用审批弹窗中，原始 shell 文本包含以下控制/展开语法时，视为白名单未命中（除非 shell 二进制本身已白名单化）：

| 控制语法 | 说明 |
|----------|------|
| `&&` | 链式与 |
| `\|\|` | 链式或 |
| `;` | 链式分隔 |
| `\|` | 管道 |
| `` ` `` | 反引号命令替换 |
| `$` | 变量展开 |
| `<` `>` | 重定向 |
| `(` `)` | 子 shell |

### 2.3 安全二进制中各命令被拒绝的标志位

**代码出处**: `src/infra/exec-safe-bin-policy-profiles.ts:101-170`

```
jq:   --argfile, --rawfile, --slurpfile, --from-file, --library-path, -L, -f
grep: --file, --exclude-from, --dereference-recursive, --directories, --recursive, -f, -d, -r, -R
sort: --compress-program, --files0-from, --output, --random-source, --temporary-directory, -T, -o
wc:   --files0-from
cut:  (无被拒绝标志)
uniq: (无被拒绝标志)
head: (无被拒绝标志)
tail: (无被拒绝标志)
tr:   (无被拒绝标志)
```

### 2.4 禁止加入 safeBins 的命令

文档明确警告**不要**将以下解释器/运行时二进制加入 safeBins：

```
python3, node, ruby, bash, sh, zsh
```

原因：这些命令可以执行代码、运行子命令或读取文件，不适合作为"仅限 stdin"的安全二进制。如果需要使用，应通过显式的 allowlist 条目配置，并保持审批提示启用。

`openclaw security audit` 会在检测到这些二进制出现在 safeBins 中时发出 `tools.exec.safe_bins_interpreter_unprofiled` 警告。

---

## 三、Shell 包装器特殊处理名单

以下二进制不被直接拒绝，但在 allowlist 模式下会被**特殊处理**（解包内部命令，对每个内部命令分别做白名单检查）。

### 3.1 POSIX Shell 包装器

**代码出处**: `src/infra/exec-wrapper-resolution.ts:11`、`apps/macos/Sources/OpenClaw/ExecShellWrapperParser.swift:27`

```
ash, bash, dash, fish, ksh, sh, zsh
```

**处理逻辑**：

- 检测 `-c`、`-lc`、`--command` 标志
- 提取内联命令文本
- 按 `&&`、`||`、`;` 分割为独立段
- 对每个段解析出实际可执行文件名
- 对每个段分别做白名单/safeBins 检查
- 解析失败时 **fail closed**（视为白名单未命中）

**环境变量缩减**：Shell wrapper 调用时，环境变量覆盖被缩减为仅：

```
TERM, LANG, LC_*, COLORTERM, NO_COLOR, FORCE_COLOR
```

### 3.2 Windows CMD 包装器

```
cmd, cmd.exe
```

**内联命令标志**：`/c`

### 3.3 PowerShell 包装器

```
powershell, powershell.exe, pwsh, pwsh.exe
```

**内联命令标志**：`-c`, `-command`, `--command`

### 3.4 Shell 多路复用器

```
busybox, toybox
```

**处理逻辑**：解包到内部 shell applet（如 `busybox ash ...` → 按 `ash` 处理），如果内部 applet 不是 shell wrapper，则 `kind = "blocked"`，不自动持久化白名单条目。

### 3.5 Dispatch 包装器（透传包装器）

**代码出处**: `src/infra/exec-wrapper-resolution.ts:17-29`

```
chrt, doas, env, ionice, nice, nohup, setsid, stdbuf, sudo, taskset, timeout
```

**处理逻辑**：

- 跳过包装器本身，提取内部实际可执行文件
- 递归解包最多 4 层（`MAX_DISPATCH_WRAPPER_DEPTH = 4`）
- 白名单匹配针对内部可执行文件而非包装器
- `allow-always` 决策时，持久化内部可执行文件路径而非包装器路径

**透明 Dispatch 包装器**（在允许列表持久化时使用内部路径）：

```
nice, nohup, stdbuf, timeout
```

**env 包装器的特殊处理**：

- 支持的环境赋值：`KEY=VALUE` 形式
- 带值的选项：`-u`, `--unset`, `-c`, `--chdir`, `-s`, `--split-string`, `--default-signal`, `--ignore-signal`, `--block-signal`
- 标志选项：`-i`, `--ignore-environment`, `-0`, `--null`

---

## 四、默认策略配置

**代码出处**: `src/infra/exec-approvals.ts`、`apps/macos/Sources/OpenClaw/ExecApprovals.swift:228`

```json
{
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  }
}
```

| 策略维度 | 默认值 | 含义 |
|----------|--------|------|
| `security` | `deny` | 拒绝所有主机执行请求 |
| `ask` | `on-miss` | 白名单未命中时询问用户 |
| `askFallback` | `deny` | 无法交互时拒绝 |
| `autoAllowSkills` | `false` | 不自动允许 Skill CLI |

**受信任的安全二进制目录**：

| 操作系统 | 默认目录 |
|----------|---------|
| macOS/Linux | `/bin`, `/usr/bin` |
| Windows | 安全二进制机制整体禁用 |

**额外需手动配置的常见目录**：

```
/opt/homebrew/bin     (macOS Homebrew)
/usr/local/bin        (Linux 手动安装)
/opt/local/bin        (macOS MacPorts)
/snap/bin             (Linux Snap)
```

---

## 五、完整决策流程图

```
命令执行请求
  │
  ├─ security = "deny" ──────────────→ 直接拒绝
  │
  ├─ security = "full" ──────────────→ 直接放行
  │
  └─ security = "allowlist" ──┐
                              │
                 ┌────────────┴────────────┐
                 │ 1. 解析命令              │
                 │   ├─ 检测 Shell wrapper  │
                 │   ├─ 解包 Dispatch wrapper│
                 │   ├─ 分割链式命令         │
                 │   └─ 解析各段可执行文件   │
                 └────────────┬────────────┘
                              │
                 ┌────────────┴────────────┐
                 │ 2. 解析失败？            │
                 │   ├─ 命令替换 $()        │──→ 拒绝
                 │   ├─ 重定向 > <          │──→ 拒绝
                 │   ├─ 反引号 `            │──→ 拒绝
                 │   ├─ 子 shell ( )        │──→ 拒绝
                 │   └─ 换行符              │──→ 拒绝
                 └────────────┬────────────┘
                              │ 解析成功
                 ┌────────────┴────────────┐
                 │ 3. 逐段检查放行条件       │
                 │   ├─ Allowlist 匹配？    │──→ 段通过
                 │   ├─ Safe Bins 匹配？    │──→ 段通过
                 │   └─ Skill 自动允许？    │──→ 段通过
                 └────────────┬────────────┘
                              │
                 ┌────────────┴────────────┐
                 │ 4. 所有段都通过？         │
                 │   ├─ 是 → allowlistSatisfied = true
                 │   │   ├─ ask = "off"    → 放行
                 │   │   ├─ ask = "on-miss"→ 放行（不弹窗）
                 │   │   └─ ask = "always" → 弹窗审批
                 │   │
                 │   └─ 否 → allowlistSatisfied = false
                 │       ├─ ask = "off"    → 拒绝（无法弹窗）
                 │       ├─ ask = "on-miss"→ 弹窗审批
                 │       └─ ask = "always" → 弹窗审批
                 └────────────┬────────────┘
                              │
                 ┌────────────┴────────────┐
                 │ 5. 弹窗但 UI 不可达？     │
                 │   ├─ askFallback = "deny"     → 拒绝
                 │   ├─ askFallback = "allowlist" → 检查白名单
                 │   └─ askFallback = "full"      → 放行
                 └─────────────────────────┘
```

---

## 六、关键源码文件索引

| 文件 | 语言 | 核心内容 |
|------|------|---------|
| `src/infra/exec-command-resolution.ts` | TypeScript | `DEFAULT_SAFE_BINS` 定义、命令路径解析 |
| `src/infra/exec-safe-bin-policy-profiles.ts` | TypeScript | `SAFE_BIN_PROFILE_FIXTURES` 各安全二进制的参数策略 |
| `src/infra/exec-safe-bin-policy-validator.ts` | TypeScript | 安全二进制 argv 验证逻辑 |
| `src/infra/exec-safe-bin-trust.ts` | TypeScript | 受信任安全二进制目录检查 |
| `src/infra/exec-wrapper-resolution.ts` | TypeScript | Shell/Dispatch 包装器识别与解包 |
| `src/infra/exec-approvals-analysis.ts` | TypeScript | `DISALLOWED_PIPELINE_TOKENS`、Shell 命令解析与分割 |
| `src/infra/exec-approvals-allowlist.ts` | TypeScript | 允许列表评估、`evaluateExecAllowlist()` |
| `src/infra/exec-approvals.ts` | TypeScript | 策略默认值、`requiresExecApproval()` |
| `apps/macos/Sources/OpenClaw/ExecShellWrapperParser.swift` | Swift | macOS 侧 Shell wrapper 检测 |
| `apps/macos/Sources/OpenClaw/ExecSystemRunCommandValidator.swift` | Swift | macOS 侧命令验证、shell wrapper 名称集合 |
