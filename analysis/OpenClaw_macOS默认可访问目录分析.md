# macOS 上 OpenClaw 执行任务脚本时默认可访问目录分析

## 概述

OpenClaw 在 macOS 上执行任务脚本时，能访问的目录取决于**沙箱模式是否启用**。默认情况下沙箱是**关闭**的（`mode: "off"`），两种场景差异巨大。

---

## 场景一：沙箱关闭（默认）

沙箱默认模式为 `"off"`（见 `src/agents/sandbox/config.ts`）。此时任务脚本**直接在主机进程上下文中执行**，没有 Docker 隔离，能访问的目录由以下因素决定：

### 1. Agent 工作区（默认工作目录）

脚本默认在 Agent 工作区中执行，路径为（见 `src/agents/workspace.ts`）：

```
~/.openclaw/workspace
```

如果设置了 `OPENCLAW_PROFILE` 环境变量且非 `default`，则为：

```
~/.openclaw/workspace-<profile>
```

可通过配置项 `agents.defaults.workspace` 或环境变量覆盖。

### 2. macOS TCC 限制

沙箱关闭时，进程能访问的目录受 macOS TCC 约束：

| 目录                                             | 访问条件                                                     |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `~/.openclaw/` 及子目录                          | **始终可访问**（用户主目录下的应用数据目录，无 TCC 限制）    |
| 用户主目录 `~/`                                  | 可访问                                                       |
| `~/Desktop`、`~/Documents`、`~/Downloads`        | **需 TCC 授权**（终端/后台进程默认被拦截，文件读取可能挂起） |
| 系统目录 `/etc`、`/usr`、`/tmp` 等               | 可读（普通用户权限）                                         |
| 其他用户目录                                     | 受 Unix 权限限制                                             |
| iCloud 同步目录 `~/Library/Mobile Documents/...` | 可访问但不推荐（会导致文件锁竞争）                           |

根据 `docs/platforms/mac/permissions.md`，Desktop/Documents/Downloads 如果没有授权，文件读取会**挂起**。建议将需要的文件移入 `~/.openclaw/workspace`。

### 3. 实际可访问范围

**沙箱关闭时，脚本本质上以当前用户权限运行，可访问用户权限范围内的所有文件系统路径**（受 macOS TCC 对隐私目录的额外限制）。没有应用层的目录白名单约束。

---

## 场景二：沙箱启用（mode 为 `non-main` 或 `all`）

当沙箱启用时，任务脚本在 Docker 容器内执行，可访问目录被严格限制。

### 1. 容器内可访问的目录

根据 `src/agents/sandbox/constants.ts` 和 `src/agents/sandbox/workspace-mounts.ts`，默认挂载的目录：

| 容器路径                   | 主机路径                             | 访问模式                 | 说明                                             |
| -------------------------- | ------------------------------------ | ------------------------ | ------------------------------------------------ |
| `/workspace`               | 沙箱工作区                           | 取决于 `workspaceAccess` | 主工作区，容器内工作目录                         |
| `/agent`                   | Agent 工作区 `~/.openclaw/workspace` | 取决于 `workspaceAccess` | Agent 模板和身份文件（仅当与主工作区不同时挂载） |
| `/tmp`、`/var/tmp`、`/run` | tmpfs（内存）                        | 读写                     | 临时目录，容器停止即消失                         |

### 2. 沙箱工作区的主机路径

沙箱工作区的根目录默认为（`src/agents/sandbox/constants.ts`）：

```
~/.openclaw/sandboxes
```

根据 `scope` 配置，具体工作区路径为（`src/agents/sandbox/shared.ts`）：

| scope            | 工作区路径                             | 说明          |
| ---------------- | -------------------------------------- | ------------- |
| `shared`（共享） | `~/.openclaw/sandboxes`                | 所有会话共享  |
| `agent`（默认）  | `~/.openclaw/sandboxes/<slug>`         | 按 agent 隔离 |
| `session`        | `~/.openclaw/sandboxes/<session-slug>` | 按会话隔离    |

### 3. workspaceAccess 决定读写权限

`src/agents/sandbox/context.ts` 中，实际用作容器工作目录的逻辑：

```typescript
const workspaceDir = cfg.workspaceAccess === "rw" ? agentWorkspaceDir : sandboxWorkspaceDir;
```

| workspaceAccess | 主工作区挂载 | Agent 工作区挂载 | 说明                 |
| --------------- | ------------ | ---------------- | -------------------- |
| `none`（默认）  | **不挂载**   | **不挂载**       | 容器内无主机文件访问 |
| `ro`            | `:ro` 只读   | `:ro` 只读       | 只能读取挂载的工作区 |
| `rw`            | `:rw` 读写   | `:rw` 读写       | 可读写挂载的工作区   |

**注意**：`workspaceAccess` 的默认值是 `"none"`（`src/agents/sandbox/config.ts`），意味着即使启用沙箱，默认情况下**不挂载任何主机目录**，容器内只能访问 `/tmp`、`/var/tmp`、`/run` 这三个 tmpfs 临时目录。

### 4. 容器根文件系统

容器根文件系统默认为**只读**（`readOnlyRoot: true`），只有上述 tmpfs 目录可写。

### 5. 禁止访问的目录

即使通过自定义 bind mount 配置，以下主机路径被硬编码禁止挂载（`src/agents/sandbox/validate-sandbox-security.ts`）：

```
/、/etc、/private/etc、/proc、/sys、/dev、/root、/boot
/run、/var/run、/private/var/run
/var/run/docker.sock、/private/var/run/docker.sock、/run/docker.sock
```

自定义 bind mount 的源路径默认还必须位于 `[workspaceDir, agentWorkspaceDir]` 白名单内。

---

## 总结对比

| 维度           | 沙箱关闭（默认）                   | 沙箱启用 + workspaceAccess=none（默认） | 沙箱启用 + workspaceAccess=rw    |
| -------------- | ---------------------------------- | --------------------------------------- | -------------------------------- |
| 执行环境       | 主机进程                           | Docker 容器                             | Docker 容器                      |
| 默认工作目录   | `~/.openclaw/workspace`            | `/workspace`（空或不挂载）              | `/workspace`（映射到主机工作区） |
| 可访问主机目录 | 用户权限范围内全部                 | **无**（仅 tmpfs）                      | 仅挂载的工作区目录               |
| 读写权限       | 用户权限                           | 仅 `/tmp` 等 tmpfs                      | 工作区可读写                     |
| TCC 限制       | Desktop/Documents/Downloads 需授权 | 不适用（容器内无这些目录）              | 不适用                           |
| 系统目录       | 可读                               | 不可访问                                | 不可访问                         |

**简而言之**：默认配置下（沙箱关闭），脚本以用户权限运行，可访问用户能访问的几乎所有目录，仅受 macOS TCC 对隐私目录的限制；启用沙箱后，默认连工作区都不挂载，脚本只能在容器的 tmpfs 临时目录中操作。

---

## 关键源码索引

| 文件                                              | 作用                                    |
| ------------------------------------------------- | --------------------------------------- |
| `src/agents/sandbox/config.ts`                    | 沙箱配置解析，默认 mode/workspaceAccess |
| `src/agents/sandbox/constants.ts`                 | 默认工作区根、容器工作目录、tmpfs 路径  |
| `src/agents/sandbox/context.ts`                   | 沙箱上下文构建，workspaceDir 选择逻辑   |
| `src/agents/sandbox/workspace-mounts.ts`          | Docker 挂载参数构建                     |
| `src/agents/sandbox/shared.ts`                    | 沙箱工作区路径按 scope 解析             |
| `src/agents/sandbox/validate-sandbox-security.ts` | 禁止挂载路径黑名单                      |
| `src/agents/workspace.ts`                         | 默认 Agent 工作区路径                   |
| `src/config/paths.ts`                             | 状态目录解析（OPENCLAW_STATE_DIR）      |
| `docs/platforms/mac/permissions.md`               | macOS TCC 权限文档                      |
| `docs/platforms/macos.md`                         | macOS 应用整体说明                      |
