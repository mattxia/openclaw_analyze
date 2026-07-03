/**
 * exec-approvals.ts — 命令执行审批机制的核心模块
 *
 * 本模块实现了 OpenClaw 系统中"命令执行前需用户审批"的完整机制，包括：
 *   1. 审批配置文件的读写与规范化（JSON 格式，持久化到 ~/.openclaw/exec-approvals.json）
 *   2. 安全策略（deny / allowlist / full）与询问策略（off / on-miss / always）的解析
 *   3. 允许列表（allowlist）的增删改查、去重、遗留格式兼容
 *   4. 通过 Unix 域套接字（JSONL 协议）向外部审批网关发送审批请求
 *
 * 整体架构概览：
 *   - 每个智能体（agent）可拥有独立的安全策略与允许列表
 *   - 配置存在全局默认值（defaults），各 agent 可覆盖
 *   - 通配符 agent "*" 的配置作为所有 agent 的兜底
 *   - 审批请求通过 socket 发送给审批网关，网关返回"允许一次/永久允许/拒绝"的决策
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { expandHomePrefix } from "./home-dir.js";
import { requestJsonlSocket } from "./jsonl-socket.js";
export * from "./exec-approvals-analysis.js";
export * from "./exec-approvals-allowlist.js";

// ──────────────────────────────────────────────
// 类型定义区
// ──────────────────────────────────────────────

/** 执行宿主类型：sandbox（沙箱）、gateway（网关）、node（本地节点） */
export type ExecHost = "sandbox" | "gateway" | "node";

/**
 * 安全策略枚举：
 *   - "deny"      → 完全拒绝执行
 *   - "allowlist" → 仅允许匹配允许列表的命令
 *   - "full"      → 完全放行，无需审批
 */
export type ExecSecurity = "deny" | "allowlist" | "full";

/**
 * 询问策略枚举：
 *   - "off"      → 从不弹出审批提示
 *   - "on-miss"  → 允许列表未命中时弹出审批提示
 *   - "always"   → 每次执行都弹出审批提示
 */
export type ExecAsk = "off" | "on-miss" | "always";

/**
 * 将字符串规范化为 ExecHost 类型值
 * @param value - 待规范化的原始字符串（可为 null/undefined）
 * @returns 合法的 ExecHost 值，或 null（如果输入不合法）
 */
export function normalizeExecHost(value?: string | null): ExecHost | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sandbox" || normalized === "gateway" || normalized === "node") {
    return normalized;
  }
  return null;
}

/**
 * 将字符串规范化为 ExecSecurity 类型值
 * @param value - 待规范化的原始字符串
 * @returns 合法的 ExecSecurity 值，或 null
 */
export function normalizeExecSecurity(value?: string | null): ExecSecurity | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return null;
}

/**
 * 将字符串规范化为 ExecAsk 类型值
 * @param value - 待规范化的原始字符串
 * @returns 合法的 ExecAsk 值，或 null
 */
export function normalizeExecAsk(value?: string | null): ExecAsk | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized;
  }
  return null;
}

/**
 * 系统运行审批绑定信息
 * 记录一条命令执行请求与特定 agent 会话的绑定关系
 */
export type SystemRunApprovalBinding = {
  /** 命令参数数组，如 ["git", "commit", "-m", "msg"] */
  argv: string[];
  /** 命令执行的工作目录 */
  cwd: string | null;
  /** 发起执行的智能体 ID */
  agentId: string | null;
  /** 会话密钥，用于标识当前会话 */
  sessionKey: string | null;
  /** 环境变量哈希，用于检测环境是否发生变化 */
  envHash: string | null;
};

/**
 * 系统运行审批的文件操作数
 * 描述命令中可能被修改的文件路径及其校验和
 */
export type SystemRunApprovalFileOperand = {
  /** 该文件路径在 argv 数组中的索引位置 */
  argvIndex: number;
  /** 文件绝对路径 */
  path: string;
  /** 文件内容的 SHA-256 哈希值 */
  sha256: string;
};

/**
 * 系统运行审批计划
 * 在真正执行命令前，先生成执行计划用于审批展示
 */
export type SystemRunApprovalPlan = {
  /** 命令参数数组 */
  argv: string[];
  /** 工作目录 */
  cwd: string | null;
  /** 完整命令文本（拼接后的字符串） */
  commandText: string;
  /** 命令预览文本（用于 UI 展示，可能截断或脱敏） */
  commandPreview?: string | null;
  /** 发起执行的智能体 ID */
  agentId: string | null;
  /** 会话密钥 */
  sessionKey: string | null;
  /** 命令可能修改的文件操作数（如果有的话） */
  mutableFileOperand?: SystemRunApprovalFileOperand | null;
};

/**
 * 执行审批请求的载荷
 * 包含命令详情、安全策略上下文、来源追踪等全部信息
 */
export type ExecApprovalRequestPayload = {
  /** 要执行的命令字符串 */
  command: string;
  /** 命令预览（UI 展示用） */
  commandPreview?: string | null;
  /** 命令参数数组（可选，比 command 更结构化） */
  commandArgv?: string[];
  // Optional UI-safe env key preview for approval prompts.
  /** 环境变量键名列表（仅键名，不含值，用于 UI 安全展示） */
  envKeys?: string[];
  /** 系统运行审批绑定信息 */
  systemRunBinding?: SystemRunApprovalBinding | null;
  /** 系统运行审批计划 */
  systemRunPlan?: SystemRunApprovalPlan | null;
  /** 命令执行的工作目录 */
  cwd?: string | null;
  /** 执行节点 ID */
  nodeId?: string | null;
  /** 执行宿主 */
  host?: string | null;
  /** 安全策略 */
  security?: string | null;
  /** 询问策略 */
  ask?: string | null;
  /** 智能体 ID */
  agentId?: string | null;
  /** 命令的解析路径（如 which 结果） */
  resolvedPath?: string | null;
  /** 会话密钥 */
  sessionKey?: string | null;
  /** 对话来源通道（如 "cli"、"api" 等） */
  turnSourceChannel?: string | null;
  /** 对话目标接收者 */
  turnSourceTo?: string | null;
  /** 对话来源账户 ID */
  turnSourceAccountId?: string | null;
  /** 对话来源线程 ID */
  turnSourceThreadId?: string | number | null;
};

/**
 * 执行审批请求
 * 带有唯一 ID 和过期时间的完整请求对象
 */
export type ExecApprovalRequest = {
  /** 请求唯一标识符（UUID） */
  id: string;
  /** 请求载荷 */
  request: ExecApprovalRequestPayload;
  /** 请求创建时间（毫秒时间戳） */
  createdAtMs: number;
  /** 请求过期时间（毫秒时间戳） */
  expiresAtMs: number;
};

/**
 * 执行审批的已解决结果
 * 表示一个审批请求已被决定（允许或拒绝）
 */
export type ExecApprovalResolved = {
  /** 对应的审批请求 ID */
  id: string;
  /** 审批决策结果 */
  decision: ExecApprovalDecision;
  /** 做出决策的用户/系统标识 */
  resolvedBy?: string | null;
  /** 决策时间（毫秒时间戳） */
  ts: number;
  /** 关联的原始请求载荷（可选） */
  request?: ExecApprovalRequest["request"];
};

/**
 * 审批默认配置
 * 定义全局或 agent 级别的安全策略默认值
 */
export type ExecApprovalsDefaults = {
  /** 安全策略默认值 */
  security?: ExecSecurity;
  /** 询问策略默认值 */
  ask?: ExecAsk;
  /** 询问策略的回退安全策略（当 ask 未能交互时的兜底） */
  askFallback?: ExecSecurity;
  /** 是否自动允许技能（skill）类命令执行 */
  autoAllowSkills?: boolean;
};

/**
 * 允许列表条目
 * 描述一条允许执行的命令模式
 */
export type ExecAllowlistEntry = {
  /** 条目唯一标识符（UUID） */
  id?: string;
  /** 命令匹配模式（如 "git *"、"npm test" 等） */
  pattern: string;
  /** 最后一次使用的时间戳 */
  lastUsedAt?: number;
  /** 最后一次匹配的完整命令 */
  lastUsedCommand?: string;
  /** 最后一次匹配时命令的解析路径 */
  lastResolvedPath?: string;
};

/**
 * 智能体审批配置
 * 继承默认配置，并增加该 agent 的允许列表
 */
export type ExecApprovalsAgent = ExecApprovalsDefaults & {
  /** 该智能体的命令允许列表 */
  allowlist?: ExecAllowlistEntry[];
};

/**
 * 审批配置文件结构
 * 对应 ~/.openclaw/exec-approvals.json 的完整数据结构
 */
export type ExecApprovalsFile = {
  /** 配置文件版本号，当前固定为 1 */
  version: 1;
  /** 套接字连接配置（用于与审批网关通信） */
  socket?: {
    /** Unix 域套接字路径 */
    path?: string;
    /** 套接字认证令牌 */
    token?: string;
  };
  /** 全局默认配置 */
  defaults?: ExecApprovalsDefaults;
  /** 各智能体的配置映射，键为 agent ID，"*" 为通配符 */
  agents?: Record<string, ExecApprovalsAgent>;
};

/**
 * 审批配置快照
 * 包含配置文件路径、原始内容、解析结果及哈希值
 * 用于检测配置文件是否发生变化
 */
export type ExecApprovalsSnapshot = {
  /** 配置文件绝对路径 */
  path: string;
  /** 配置文件是否存在 */
  exists: boolean;
  /** 配置文件原始文本内容 */
  raw: string | null;
  /** 解析并规范化后的配置对象 */
  file: ExecApprovalsFile;
  /** 原始内容的 SHA-256 哈希值，用于变更检测 */
  hash: string;
};

/**
 * 完全解析后的审批配置
 * 所有可选字段都已填充为确定的值，可直接用于业务逻辑判断
 */
export type ExecApprovalsResolved = {
  /** 配置文件路径 */
  path: string;
  /** 套接字路径（已展开 ~ 前缀） */
  socketPath: string;
  /** 套接字认证令牌 */
  token: string;
  /** 解析后的全局默认配置（所有字段必填） */
  defaults: Required<ExecApprovalsDefaults>;
  /** 解析后的当前 agent 配置（所有字段必填） */
  agent: Required<ExecApprovalsDefaults>;
  /** 合并后的允许列表（通配符 agent + 当前 agent） */
  allowlist: ExecAllowlistEntry[];
  /** 原始配置文件对象 */
  file: ExecApprovalsFile;
};

// ──────────────────────────────────────────────
// 常量区
// ──────────────────────────────────────────────

// Keep CLI + gateway defaults in sync.
/** 默认审批请求超时时间：120 秒 */
export const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 120_000;

/** 默认安全策略：拒绝所有执行 */
const DEFAULT_SECURITY: ExecSecurity = "deny";
/** 默认询问策略：允许列表未命中时弹出询问 */
const DEFAULT_ASK: ExecAsk = "on-miss";
/** 默认询问回退安全策略：拒绝 */
const DEFAULT_ASK_FALLBACK: ExecSecurity = "deny";
/** 默认不自动允许技能类命令 */
const DEFAULT_AUTO_ALLOW_SKILLS = false;
/** 默认套接字路径 */
const DEFAULT_SOCKET = "~/.openclaw/exec-approvals.sock";
/** 默认配置文件路径 */
const DEFAULT_FILE = "~/.openclaw/exec-approvals.json";

// ──────────────────────────────────────────────
// 内部工具函数
// ──────────────────────────────────────────────

/**
 * 计算配置文件原始内容的 SHA-256 哈希值
 * @param raw - 配置文件的原始文本，null 视为空串
 * @returns 十六进制格式的哈希摘要
 */
function hashExecApprovalsRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

/**
 * 解析审批配置文件的绝对路径（展开 ~ 前缀为用户主目录）
 * @returns 配置文件的绝对路径
 */
export function resolveExecApprovalsPath(): string {
  return expandHomePrefix(DEFAULT_FILE);
}

/**
 * 解析审批套接字的绝对路径（展开 ~ 前缀为用户主目录）
 * @returns 套接字文件的绝对路径
 */
export function resolveExecApprovalsSocketPath(): string {
  return expandHomePrefix(DEFAULT_SOCKET);
}

/**
 * 规范化允许列表模式字符串
 * 去除首尾空格并转为小写，用于去重比较
 * @param value - 待规范化的模式字符串
 * @returns 规范化后的字符串，空串返回 null
 */
function normalizeAllowlistPattern(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed.toLowerCase() : null;
}

/**
 * 合并遗留的 "default" agent 配置到主 agent 配置中
 *
 * 旧版配置文件使用 "default" 键而非 DEFAULT_AGENT_ID，
 * 此函数将遗留配置合并到标准键下，允许列表做去重合并
 *
 * @param current - 当前主 agent 配置（优先级更高）
 * @param legacy  - 遗留的 "default" agent 配置
 * @returns 合并后的 agent 配置
 */
function mergeLegacyAgent(
  current: ExecApprovalsAgent,
  legacy: ExecApprovalsAgent,
): ExecApprovalsAgent {
  const allowlist: ExecAllowlistEntry[] = [];
  const seen = new Set<string>();
  /** 将条目加入合并后的允许列表，同时按小写模式去重 */
  const pushEntry = (entry: ExecAllowlistEntry) => {
    const key = normalizeAllowlistPattern(entry.pattern);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    allowlist.push(entry);
  };
  // 先推入当前 agent 的条目（优先级更高，先入先保留）
  for (const entry of current.allowlist ?? []) {
    pushEntry(entry);
  }
  // 再推入遗留 agent 的条目
  for (const entry of legacy.allowlist ?? []) {
    pushEntry(entry);
  }

  return {
    security: current.security ?? legacy.security,
    ask: current.ask ?? legacy.ask,
    askFallback: current.askFallback ?? legacy.askFallback,
    autoAllowSkills: current.autoAllowSkills ?? legacy.autoAllowSkills,
    allowlist: allowlist.length > 0 ? allowlist : undefined,
  };
}

/**
 * 确保文件所在目录存在，若不存在则递归创建
 * @param filePath - 文件绝对路径
 */
function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

// Coerce legacy/corrupted allowlists into `ExecAllowlistEntry[]` before we spread
// entries to add ids (spreading strings creates {"0":"l","1":"s",...}).
/**
 * 将遗留或损坏的允许列表强制转换为规范的 ExecAllowlistEntry[] 格式
 *
 * 旧版允许列表可能存储为纯字符串数组（如 ["git", "npm"]），
 * 展开字符串会变成 {"0":"g","1":"i","2":"t"} 的错误结构。
 * 此函数将字符串条目转换为 { pattern: "..." } 对象，并丢弃无效条目。
 *
 * @param allowlist - 未知格式的允许列表数据
 * @returns 规范化后的允许列表，若为空则返回 undefined
 */
function coerceAllowlistEntries(allowlist: unknown): ExecAllowlistEntry[] | undefined {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return Array.isArray(allowlist) ? (allowlist as ExecAllowlistEntry[]) : undefined;
  }
  let changed = false;
  const result: ExecAllowlistEntry[] = [];
  for (const item of allowlist) {
    if (typeof item === "string") {
      // 遗留格式：纯字符串 → 转为对象
      const trimmed = item.trim();
      if (trimmed) {
        result.push({ pattern: trimmed });
        changed = true;
      } else {
        changed = true; // dropped empty string
      }
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      // 标准格式：对象，校验 pattern 字段有效性
      const pattern = (item as { pattern?: unknown }).pattern;
      if (typeof pattern === "string" && pattern.trim().length > 0) {
        result.push(item as ExecAllowlistEntry);
      } else {
        changed = true; // dropped invalid entry
      }
    } else {
      changed = true; // dropped invalid entry
    }
  }
  return changed ? (result.length > 0 ? result : undefined) : (allowlist as ExecAllowlistEntry[]);
}

/**
 * 确保允许列表中每个条目都有唯一 ID
 * 对于缺少 id 的条目，自动生成 UUID
 *
 * @param allowlist - 允许列表
 * @returns 所有条目均含 id 的允许列表
 */
function ensureAllowlistIds(
  allowlist: ExecAllowlistEntry[] | undefined,
): ExecAllowlistEntry[] | undefined {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return allowlist;
  }
  let changed = false;
  const next = allowlist.map((entry) => {
    if (entry.id) {
      return entry;
    }
    changed = true;
    return { ...entry, id: crypto.randomUUID() };
  });
  return changed ? next : allowlist;
}

// ──────────────────────────────────────────────
// 配置文件规范化与读写
// ──────────────────────────────────────────────

/**
 * 规范化审批配置文件
 *
 * 执行以下操作：
 *   1. 清理 socket 路径和 token 的首尾空格
 *   2. 将遗留的 "default" agent 合并到 DEFAULT_AGENT_ID 下
 *   3. 对每个 agent 的允许列表进行强制转换和 ID 补全
 *   4. 构建规范化的配置对象（保留 undefined 表示"未设置"）
 *
 * @param file - 原始配置文件对象
 * @returns 规范化后的配置文件对象
 */
export function normalizeExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  const token = file.socket?.token?.trim();
  const agents = { ...file.agents };
  // 处理遗留的 "default" 键：合并到 DEFAULT_AGENT_ID 下
  const legacyDefault = agents.default;
  if (legacyDefault) {
    const main = agents[DEFAULT_AGENT_ID];
    agents[DEFAULT_AGENT_ID] = main ? mergeLegacyAgent(main, legacyDefault) : legacyDefault;
    delete agents.default;
  }
  // 遍历所有 agent，确保允许列表格式正确且每条有 id
  for (const [key, agent] of Object.entries(agents)) {
    const coerced = coerceAllowlistEntries(agent.allowlist);
    const allowlist = ensureAllowlistIds(coerced);
    if (allowlist !== agent.allowlist) {
      agents[key] = { ...agent, allowlist };
    }
  }
  const normalized: ExecApprovalsFile = {
    version: 1,
    socket: {
      path: socketPath && socketPath.length > 0 ? socketPath : undefined,
      token: token && token.length > 0 ? token : undefined,
    },
    defaults: {
      security: file.defaults?.security,
      ask: file.defaults?.ask,
      askFallback: file.defaults?.askFallback,
      autoAllowSkills: file.defaults?.autoAllowSkills,
    },
    agents,
  };
  return normalized;
}

/**
 * 合并套接字默认配置
 *
 * 优先级：normalized 中的值 > current 中的值 > 系统默认值
 * 用于在配置热更新时保留已有的 socket path 和 token
 *
 * @param params.normalized - 新规范化后的配置
 * @param params.current    - 当前已存在的配置（可选）
 * @returns 合并后的配置文件
 */
export function mergeExecApprovalsSocketDefaults(params: {
  normalized: ExecApprovalsFile;
  current?: ExecApprovalsFile;
}): ExecApprovalsFile {
  const currentSocketPath = params.current?.socket?.path?.trim();
  const currentToken = params.current?.socket?.token?.trim();
  const socketPath =
    params.normalized.socket?.path?.trim() ?? currentSocketPath ?? resolveExecApprovalsSocketPath();
  const token = params.normalized.socket?.token?.trim() ?? currentToken ?? "";
  return {
    ...params.normalized,
    socket: {
      path: socketPath,
      token,
    },
  };
}

/**
 * 生成随机的套接字认证令牌
 * 使用 24 字节随机数编码为 base64url 格式
 * @returns 32 字符的 base64url 令牌字符串
 */
function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * 读取审批配置文件的快照
 *
 * 与 loadExecApprovals 不同，此函数返回快照对象，包含原始文本、哈希值等信息，
 * 适用于需要检测配置变更的场景
 *
 * @returns 配置文件快照，包含路径、是否存在、原始内容、解析结果、哈希值
 */
export function readExecApprovalsSnapshot(): ExecApprovalsSnapshot {
  const filePath = resolveExecApprovalsPath();
  // 文件不存在时返回空快照
  if (!fs.existsSync(filePath)) {
    const file = normalizeExecApprovals({ version: 1, agents: {} });
    return {
      path: filePath,
      exists: false,
      raw: null,
      file,
      hash: hashExecApprovalsRaw(null),
    };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: ExecApprovalsFile | null = null;
  try {
    parsed = JSON.parse(raw) as ExecApprovalsFile;
  } catch {
    parsed = null;
  }
  // 仅接受 version 1 的配置，其他版本回退为空配置
  const file =
    parsed?.version === 1
      ? normalizeExecApprovals(parsed)
      : normalizeExecApprovals({ version: 1, agents: {} });
  return {
    path: filePath,
    exists: true,
    raw,
    file,
    hash: hashExecApprovalsRaw(raw),
  };
}

/**
 * 加载审批配置文件
 *
 * 从磁盘读取 ~/.openclaw/exec-approvals.json 并规范化。
 * 如果文件不存在、JSON 解析失败或版本不匹配，则返回空的默认配置。
 *
 * @returns 规范化后的配置文件对象
 */
export function loadExecApprovals(): ExecApprovalsFile {
  const filePath = resolveExecApprovalsPath();
  try {
    if (!fs.existsSync(filePath)) {
      return normalizeExecApprovals({ version: 1, agents: {} });
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as ExecApprovalsFile;
    if (parsed?.version !== 1) {
      return normalizeExecApprovals({ version: 1, agents: {} });
    }
    return normalizeExecApprovals(parsed);
  } catch {
    return normalizeExecApprovals({ version: 1, agents: {} });
  }
}

/**
 * 将审批配置保存到磁盘
 *
 * 以 0o600 权限（仅所有者可读写）写入配置文件，
 * 确保敏感的 socket token 不会被其他用户读取
 *
 * @param file - 要保存的配置文件对象
 */
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

/**
 * 确保审批配置文件存在并已初始化
 *
 * 加载现有配置 → 规范化 → 确保 socket 路径和 token 存在
 * （若缺失则使用默认值或生成新 token）→ 保存回磁盘
 *
 * @returns 完整初始化后的配置文件对象
 */
export function ensureExecApprovals(): ExecApprovalsFile {
  const loaded = loadExecApprovals();
  const next = normalizeExecApprovals(loaded);
  const socketPath = next.socket?.path?.trim();
  const token = next.socket?.token?.trim();
  const updated: ExecApprovalsFile = {
    ...next,
    socket: {
      path: socketPath && socketPath.length > 0 ? socketPath : resolveExecApprovalsSocketPath(),
      token: token && token.length > 0 ? token : generateToken(),
    },
  };
  saveExecApprovals(updated);
  return updated;
}

// ──────────────────────────────────────────────
// 策略值规范化辅助函数
// ──────────────────────────────────────────────

/**
 * 规范化安全策略值，无效值回退到默认
 * @param value    - 待验证的安全策略值
 * @param fallback - 回退默认值
 * @returns 合法的 ExecSecurity 值
 */
function normalizeSecurity(value: ExecSecurity | undefined, fallback: ExecSecurity): ExecSecurity {
  if (value === "allowlist" || value === "full" || value === "deny") {
    return value;
  }
  return fallback;
}

/**
 * 规范化询问策略值，无效值回退到默认
 * @param value    - 待验证的询问策略值
 * @param fallback - 回退默认值
 * @returns 合法的 ExecAsk 值
 */
function normalizeAsk(value: ExecAsk | undefined, fallback: ExecAsk): ExecAsk {
  if (value === "always" || value === "off" || value === "on-miss") {
    return value;
  }
  return fallback;
}

// ──────────────────────────────────────────────
// 完整配置解析
// ──────────────────────────────────────────────

/**
 * 审批默认配置的覆盖项
 * 用于在运行时覆盖配置文件中的默认值
 */
export type ExecApprovalsDefaultOverrides = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
};

/**
 * 解析指定 agent 的审批配置（便捷入口）
 *
 * 先确保配置文件已初始化，然后委托给 resolveExecApprovalsFromFile 完成解析
 *
 * @param agentId   - 智能体 ID，省略则使用默认 agent
 * @param overrides - 运行时覆盖项，优先级最高
 * @returns 完全解析后的审批配置
 */
export function resolveExecApprovals(
  agentId?: string,
  overrides?: ExecApprovalsDefaultOverrides,
): ExecApprovalsResolved {
  const file = ensureExecApprovals();
  return resolveExecApprovalsFromFile({
    file,
    agentId,
    overrides,
    path: resolveExecApprovalsPath(),
    socketPath: expandHomePrefix(file.socket?.path ?? resolveExecApprovalsSocketPath()),
    token: file.socket?.token ?? "",
  });
}

/**
 * 从给定的配置文件解析指定 agent 的完整审批配置
 *
 * 配置合并优先级（从高到低）：
 *   1. overrides（运行时覆盖）
 *   2. agent 自身配置
 *   3. 通配符 agent ("*") 配置
 *   4. 全局 defaults
 *   5. 代码中的硬编码默认值
 *
 * 允许列表合并规则：通配符 agent 的列表在前，当前 agent 的列表在后
 *
 * @param params.file       - 配置文件对象
 * @param params.agentId    - 智能体 ID
 * @param params.overrides  - 运行时覆盖项
 * @param params.path       - 配置文件路径
 * @param params.socketPath - 套接字路径
 * @param params.token      - 套接字令牌
 * @returns 完全解析后的审批配置
 */
export function resolveExecApprovalsFromFile(params: {
  file: ExecApprovalsFile;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  path?: string;
  socketPath?: string;
  token?: string;
}): ExecApprovalsResolved {
  const file = normalizeExecApprovals(params.file);
  const defaults = file.defaults ?? {};
  const agentKey = params.agentId ?? DEFAULT_AGENT_ID;
  const agent = file.agents?.[agentKey] ?? {};
  const wildcard = file.agents?.["*"] ?? {};
  // 确定各维度的最终回退值（overrides > 硬编码默认值）
  const fallbackSecurity = params.overrides?.security ?? DEFAULT_SECURITY;
  const fallbackAsk = params.overrides?.ask ?? DEFAULT_ASK;
  const fallbackAskFallback = params.overrides?.askFallback ?? DEFAULT_ASK_FALLBACK;
  const fallbackAutoAllowSkills = params.overrides?.autoAllowSkills ?? DEFAULT_AUTO_ALLOW_SKILLS;
  // 解析全局默认配置
  const resolvedDefaults: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(defaults.security, fallbackSecurity),
    ask: normalizeAsk(defaults.ask, fallbackAsk),
    askFallback: normalizeSecurity(
      defaults.askFallback ?? fallbackAskFallback,
      fallbackAskFallback,
    ),
    autoAllowSkills: Boolean(defaults.autoAllowSkills ?? fallbackAutoAllowSkills),
  };
  // 解析当前 agent 配置（agent > 通配符 > 全局默认）
  const resolvedAgent: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(
      agent.security ?? wildcard.security ?? resolvedDefaults.security,
      resolvedDefaults.security,
    ),
    ask: normalizeAsk(agent.ask ?? wildcard.ask ?? resolvedDefaults.ask, resolvedDefaults.ask),
    askFallback: normalizeSecurity(
      agent.askFallback ?? wildcard.askFallback ?? resolvedDefaults.askFallback,
      resolvedDefaults.askFallback,
    ),
    autoAllowSkills: Boolean(
      agent.autoAllowSkills ?? wildcard.autoAllowSkills ?? resolvedDefaults.autoAllowSkills,
    ),
  };
  // 合并允许列表：通配符在前，agent 在后
  const allowlist = [
    ...(Array.isArray(wildcard.allowlist) ? wildcard.allowlist : []),
    ...(Array.isArray(agent.allowlist) ? agent.allowlist : []),
  ];
  return {
    path: params.path ?? resolveExecApprovalsPath(),
    socketPath: expandHomePrefix(
      params.socketPath ?? file.socket?.path ?? resolveExecApprovalsSocketPath(),
    ),
    token: params.token ?? file.socket?.token ?? "",
    defaults: resolvedDefaults,
    agent: resolvedAgent,
    allowlist,
    file,
  };
}

// ──────────────────────────────────────────────
// 审批判定逻辑
// ──────────────────────────────────────────────

/**
 * 判断当前命令是否需要用户审批
 *
 * 判定规则：
 *   - ask === "always" → 始终需要审批
 *   - ask === "on-miss" 且 security === "allowlist" →
 *       当分析未通过（analysisOk=false）或允许列表未命中（allowlistSatisfied=false）时需要审批
 *   - 其他情况 → 不需要审批
 *
 * @param params.ask                - 询问策略
 * @param params.security           - 安全策略
 * @param params.analysisOk         - 命令静态分析是否通过
 * @param params.allowlistSatisfied - 是否匹配了允许列表
 * @returns true 表示需要弹出审批提示
 */
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

// ──────────────────────────────────────────────
// 允许列表操作
// ──────────────────────────────────────────────

/**
 * 记录允许列表条目的使用情况
 *
 * 当某条 allowlist 规则被命令匹配后，更新其 lastUsedAt、lastUsedCommand、
 * lastResolvedPath 字段，并持久化到磁盘
 *
 * @param approvals    - 当前配置文件对象（会被原地修改并保存）
 * @param agentId      - 智能体 ID
 * @param entry        - 被使用的允许列表条目
 * @param command      - 触发匹配的完整命令
 * @param resolvedPath - 命令的解析路径（可选）
 */
export function recordAllowlistUse(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  entry: ExecAllowlistEntry,
  command: string,
  resolvedPath?: string,
) {
  const target = agentId ?? DEFAULT_AGENT_ID;
  const agents = approvals.agents ?? {};
  const existing = agents[target] ?? {};
  const allowlist = Array.isArray(existing.allowlist) ? existing.allowlist : [];
  // 更新匹配条目的使用记录
  const nextAllowlist = allowlist.map((item) =>
    item.pattern === entry.pattern
      ? {
          ...item,
          id: item.id ?? crypto.randomUUID(),
          lastUsedAt: Date.now(),
          lastUsedCommand: command,
          lastResolvedPath: resolvedPath,
        }
      : item,
  );
  agents[target] = { ...existing, allowlist: nextAllowlist };
  approvals.agents = agents;
  saveExecApprovals(approvals);
}

/**
 * 向允许列表添加新条目
 *
 * 如果模式为空或已存在则不操作。新增条目会自动生成 UUID 和 lastUsedAt 时间戳，
 * 并立即持久化到磁盘
 *
 * @param approvals - 当前配置文件对象
 * @param agentId   - 智能体 ID
 * @param pattern   - 要添加的命令匹配模式
 */
export function addAllowlistEntry(
  approvals: ExecApprovalsFile,
  agentId: string | undefined,
  pattern: string,
) {
  const target = agentId ?? DEFAULT_AGENT_ID;
  const agents = approvals.agents ?? {};
  const existing = agents[target] ?? {};
  const allowlist = Array.isArray(existing.allowlist) ? existing.allowlist : [];
  const trimmed = pattern.trim();
  // 空模式或重复模式，不做操作
  if (!trimmed) {
    return;
  }
  if (allowlist.some((entry) => entry.pattern === trimmed)) {
    return;
  }
  allowlist.push({ id: crypto.randomUUID(), pattern: trimmed, lastUsedAt: Date.now() });
  agents[target] = { ...existing, allowlist };
  approvals.agents = agents;
  saveExecApprovals(approvals);
}

// ──────────────────────────────────────────────
// 策略比较工具
// ──────────────────────────────────────────────

/**
 * 取两个安全策略中更严格的一个
 * 严格度排序：deny(0) < allowlist(1) < full(2)
 *
 * @param a - 第一个安全策略
 * @param b - 第二个安全策略
 * @returns 更严格的那个策略
 */
export function minSecurity(a: ExecSecurity, b: ExecSecurity): ExecSecurity {
  const order: Record<ExecSecurity, number> = { deny: 0, allowlist: 1, full: 2 };
  return order[a] <= order[b] ? a : b;
}

/**
 * 取两个询问策略中更严格（即更频繁询问）的一个
 * 严格度排序：off(0) < on-miss(1) < always(2)
 *
 * @param a - 第一个询问策略
 * @param b - 第二个询问策略
 * @returns 更严格的那个询问策略
 */
export function maxAsk(a: ExecAsk, b: ExecAsk): ExecAsk {
  const order: Record<ExecAsk, number> = { off: 0, "on-miss": 1, always: 2 };
  return order[a] >= order[b] ? a : b;
}

// ──────────────────────────────────────────────
// 审批决策与通信
// ──────────────────────────────────────────────

/**
 * 审批决策类型：
 *   - "allow-once"    → 允许本次执行（不添加到允许列表）
 *   - "allow-always"  → 永久允许（添加到允许列表）
 *   - "deny"          → 拒绝执行
 */
export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";

/**
 * 通过 Unix 域套接字发送审批请求并等待决策
 *
 * 使用 JSONL 协议与审批网关通信：
 *   1. 发送 { type: "request", token, id, request } 消息
 *   2. 等待网关返回 { type: "decision", decision } 消息
 *   3. 解析并返回决策结果
 *
 * 如果 socket 路径或 token 为空，直接返回 null（无法通信）
 *
 * @param params.socketPath - Unix 域套接字路径
 * @param params.token      - 认证令牌
 * @param params.request    - 审批请求载荷
 * @param params.timeoutMs  - 超时时间（默认 15 秒）
 * @returns 审批决策，超时或通信失败返回 null
 */
export async function requestExecApprovalViaSocket(params: {
  socketPath: string;
  token: string;
  request: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ExecApprovalDecision | null> {
  const { socketPath, token, request } = params;
  // 缺少必要参数，无法通信
  if (!socketPath || !token) {
    return null;
  }
  const timeoutMs = params.timeoutMs ?? 15_000;
  const payload = JSON.stringify({
    type: "request",
    token,
    id: crypto.randomUUID(),
    request,
  });

  return await requestJsonlSocket({
    socketPath,
    payload,
    timeoutMs,
    accept: (value) => {
      const msg = value as { type?: string; decision?: ExecApprovalDecision };
      if (msg?.type === "decision" && msg.decision) {
        return msg.decision;
      }
      return undefined;
    },
  });
}
