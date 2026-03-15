# OpenClaw Skills 系统技术架构分析

## 一、系统概述
Skills是OpenClaw的动态扩展系统，允许用户通过简单的目录结构和Markdown文件为AI助手添加新功能。Skills采用**声明式定义**，每个Skill是包含`SKILL.md`（带YAML元数据）的目录，系统会自动扫描、解析、校验并加载这些Skills，提供给AI代理使用。

---

## 二、整体分层架构
```
┌─────────────────────────────────────────────────────────────┐
│                     接口层 (Interface Layer)                │
│ CLI命令 · Gateway API · macOS UI · Web控制面板               │
└───────────────────────────────┬─────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────┐
│                     运行时层 (Runtime Layer)                │
│ 会话快照 · 环境变量注入 · 系统提示构建 · 工具调用路由         │
└───────────────────────────────┬─────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────┐
│                     管理层 (Management Layer)               │
│ 状态管理 · 安装器 · 配置覆盖 · 文件监视器 · 资格校验         │
└───────────────────────────────┬─────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────┐
│                     加载层 (Loading Layer)                  │
│ 目录扫描 · SKILL.md解析 · 元数据提取 · 优先级合并            │
└───────────────────────────────┬─────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────┐
│                     存储层 (Storage Layer)                  │
│ 内置Skills · 托管Skills · 工作区Skills · 插件Skills          │
└─────────────────────────────────────────────────────────────┘
```

---

## 三、核心组件职责

### 1. 存储层：Skill的来源与优先级
Skills从以下位置按优先级从高到低加载：

| 来源 | 路径 | 优先级 | 说明 |
|------|------|--------|------|
| 工作区Skills | `<workspace>/skills` | 最高 | 仅对当前工作区的智能体可见 |
| 托管Skills | `~/.openclaw/skills` | 中 | 对所有智能体共享可见 |
| 内置Skills | 随安装包发布 | 最低 | 系统默认提供的基础Skills |
| 插件Skills | 插件目录下的skills文件夹 | 最低 | 随插件启用时加载 |
| 额外目录 | `skills.load.extraDirs`配置 | 最低 | 用户自定义的额外加载目录 |

> 同名Skill会被高优先级的覆盖，无需修改系统文件即可实现自定义扩展。

### 2. 加载层：Skill的加载与解析
| 模块 | 职责 | 核心实现 |
|------|------|----------|
| 目录扫描器 | 遍历所有Skill目录，查找包含`SKILL.md`的文件夹 | `loadWorkspaceSkillEntries()` |
| 解析器 | 解析`SKILL.md`的YAML frontmatter元数据和Markdown内容 | 内置Markdown/YAML解析器 |
| 合并器 | 按优先级合并所有来源的Skills，处理同名覆盖 | `filterWorkspaceSkillEntries()` |
| 元数据处理器 | 提取Skill的依赖要求、安装选项、权限配置等 | `buildWorkspaceSkillSnapshot()` |

### 3. 管理层：Skill的生命周期管理
| 模块 | 职责 | 核心实现 |
|------|------|----------|
| 资格校验器 | 检查Skill是否符合运行条件：<br>• 依赖二进制是否存在<br>• 环境变量是否配置<br>• 配置项是否满足<br>• 是否在白名单内 | `evaluateEntryRequirementsForCurrentPlatform()` |
| 状态管理器 | 维护所有Skill的状态、缺失依赖、安装选项 | `buildSkillStatus()` |
| 安装器 | 自动安装Skill所需的依赖：<br>• brew包<br>• npm/pnpm/yarn/bun包<br>• go模块<br>• uv包<br>• 二进制文件下载 | `skills-install.ts` |
| 配置管理器 | 处理用户对Skill的配置覆盖、启用/禁用、API密钥设置 | `resolveSkillConfig()` |
| 文件监视器 | 监听Skill目录变化，自动热重载Skill | `skills.load.watch`配置项 |

### 4. 运行时层：Skill在会话中的使用
| 模块 | 职责 | 核心实现 |
|------|------|----------|
| 快照管理 | 会话开始时创建Skill快照，同一会话复用 | `buildWorkspaceSkillSnapshot()` |
| 环境变量注入 | 会话运行时临时注入Skill所需的环境变量，运行后恢复 | `applySkillEnvOverrides()` |
| 提示构建 | 将可用Skill的信息注入到AI代理的系统提示中，告知AI可用功能 | `resolveSkillsPromptForRun()` |
| 工具路由 | 处理AI代理调用Skill中定义的工具/命令请求 | `pi-tools.ts` + 节点调度 |

### 5. 接口层：用户交互接口
| 接口 | 功能 | 实现文件 |
|------|------|----------|
| CLI命令 | `openclaw skills`命令：列出、检查、管理Skills | `skills-cli.ts` |
| Gateway API | 提供Skill状态查询、安装、配置更新等接口 | `server-methods/skills.ts` |
| macOS UI | 图形界面管理Skills、安装依赖、配置密钥 | `SkillsSettings.swift` |
| Web控制面板 | 网页端Skill管理界面 | Web端组件 |

---

## 四、核心流程分析

### 1. Skills系统初始化流程
```
Gateway启动
    ↓
加载系统配置，读取Skills相关配置
    ↓
按优先级扫描所有Skill目录（工作区 → 托管 → 内置 → 插件 → 额外目录）
    ↓
解析每个Skill的SKILL.md文件，提取元数据和内容
    ↓
合并同名Skill，高优先级覆盖低优先级
    ↓
资格校验：检查二进制依赖、环境变量、配置项、白名单
    ↓
构建全局Skill状态列表
    ↓
（可选）启动Skill目录监视器，监听文件变化自动热重载
    ↓
初始化完成，对外提供服务
```

### 2. Skill调用流程
```
新会话创建
    ↓
加载当前会话的Skill快照（包含所有符合条件的Skill）
    ↓
用户消息进入
    ↓
注入Skill相关的环境变量到临时运行环境
    ↓
构建系统提示，将可用Skill的描述和使用方法告知AI代理
    ↓
AI代理根据用户请求，决定是否调用相关Skill
    ↓
如果需要调用Skill：
    • 校验工具权限
    • 路由到对应执行端（本地Gateway或远程节点）
    • 执行Skill定义的命令/工具
    • 返回执行结果给AI代理
    ↓
AI代理根据执行结果生成回复
    ↓
会话结束，恢复原始环境变量
```

### 3. Skill安装流程
```
用户发起Skill安装请求（CLI/UI/API）
    ↓
根据Skill元数据中的install配置，选择首选安装方式
    ↓
优先级：brew → uv → npm → go → download
    ↓
执行对应安装操作：
    • brew: 执行brew install
    • node: 执行npm/pnpm/yarn/bun install
    • go: 执行go install
    • download: 下载并解压二进制文件
    ↓
验证安装是否成功（检查二进制是否存在）
    ↓
更新Skill状态为可用
    ↓
通知用户安装结果
```

---

## 五、核心数据结构与接口

### 核心类型定义
| 类型 | 描述 | 核心字段 |
|------|------|----------|
| `SkillEntry` | Skill的内部表示 | `skill`(名称/描述/内容)、`metadata`(元数据)、`filePath`(文件路径) |
| `SkillMetadata` | Skill元数据 | `skillKey`(唯一标识)、`requires`(依赖要求)、`install`(安装选项)、`os`(支持系统)、`primaryEnv`(主环境变量) |
| `SkillStatusEntry` | Skill运行时状态 | `eligible`(是否可用)、`disabled`(是否禁用)、`missing`(缺失依赖)、`install`(可用安装选项) |
| `SkillSnapshot` | 会话Skill快照 | 会话开始时的Skill列表，会话过程中保持不变 |
| `SkillInstallSpec` | 安装配置 | `kind`(安装类型: brew/node/go/download等)、`package/formula/url`(安装源)、`bins`(生成的二进制文件) |

### 核心API方法
| 方法 | 功能 |
|------|------|
| `loadWorkspaceSkillEntries()` | 加载所有Skill条目 |
| `buildWorkspaceSkillSnapshot()` | 构建Skill快照 |
| `resolveSkillsPromptForRun()` | 构建Skill相关的系统提示 |
| `applySkillEnvOverrides()` | 注入Skill环境变量 |
| `buildSkillStatus()` | 构建Skill状态信息 |
| `skills.status` API | 查询所有Skill状态 |
| `skills.install` API | 安装Skill依赖 |
| `skills.update` API | 更新Skill配置 |

---

## 六、技术特点与设计亮点

### 1. 声明式定义
Skill通过简单的`SKILL.md`文件定义，无需编写代码，用户可以快速创建自定义功能。

### 2. 零侵入扩展
新增Skill不需要修改系统核心代码，系统自动扫描加载，完全解耦。

### 3. 多维度权限控制
- 全局白名单控制内置Skill可见性
- 按工作区隔离Skill
- 基于依赖、环境变量、配置的资格校验
- 沙箱运行支持，隔离不可信代码

### 4. 热重载支持
启用文件监视器后，修改Skill文件会自动重新加载，无需重启Gateway。

### 5. 跨平台兼容
自动适配不同操作系统，优先选择适合当前平台的安装方式。

### 6. 安全设计
- 第三方Skill默认视为不可信代码
- 环境变量注入仅在会话运行时有效，不污染全局环境
- 支持沙箱隔离运行高危Skill

---

## 七、核心文件清单

| 文件路径 | 功能描述 |
|----------|----------|
| `src/agents/skills.ts` | Skills系统核心入口，导出所有核心方法和类型 |
| `src/agents/skills-status.ts` | Skill状态管理、资格校验、安装选项生成 |
| `src/agents/skills-install.ts` | Skill安装器实现，支持多种安装方式 |
| `src/agents/skills/workspace.ts` | 工作区Skill加载、快照构建、提示生成 |
| `src/agents/skills/env-overrides.ts` | 环境变量注入与恢复 |
| `src/agents/skills/config.ts` | Skill配置解析与合并 |
| `src/gateway/server-methods/skills.ts` | Gateway Skill API实现 |
| `src/cli/skills-cli.ts` | Skill相关CLI命令实现 |
| `src/auto-reply/skill-commands.ts` | 聊天中Skill相关的命令处理 |
| `src/config/types.skills.ts` | Skill相关配置类型定义 |
