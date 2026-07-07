import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import { resolveSandboxPath } from "../sandbox-paths.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { shouldIncludeSkill } from "./config.js";
import { normalizeSkillFilter } from "./filter.js";
import {
  parseFrontmatter,
  resolveOpenClawMetadata,
  resolveSkillInvocationPolicy,
} from "./frontmatter.js";
import { resolvePluginSkillDirs } from "./plugin-skills.js";
import { serializeByKey } from "./serialize.js";
import type {
  ParsedSkillFrontmatter,
  SkillEligibilityContext,
  SkillCommandSpec,
  SkillEntry,
  SkillSnapshot,
} from "./types.js";

const fsp = fs.promises;
// 创建skills子系统的日志记录器，用于输出调试和警告信息
const skillsLogger = createSubsystemLogger("skills");
// 用于存储已打印过的skill命令调试信息，避免重复输出相同日志
const skillCommandDebugOnce = new Set<string>();

/**
 * Replace the user's home directory prefix with `~` in skill file paths
 * to reduce system prompt token usage. Models understand `~` expansion,
 * and the read tool resolves `~` to the home directory.
 *
 * Example: `/Users/alice/.bun/.../skills/github/SKILL.md`
 *       → `~/.bun/.../skills/github/SKILL.md`
 *
 * Saves ~5–6 tokens per skill path × N skills ≈ 400–600 tokens total.
 */
// 将skill文件路径中的用户主目录前缀替换为`~`，减少系统提示词的token使用量
// 模型理解`~`扩展含义，read工具会将`~`解析为实际主目录
// 此优化可节省约5-6 tokens per skill path × N skills ≈ 400-600 tokens total
function compactSkillPaths(skills: Skill[]): Skill[] {
  const home = os.homedir();
  if (!home) return skills;
  // 确保home路径以分隔符结尾，便于统一处理
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return skills.map((s) => ({
    ...s,
    // 如果文件路径以home开头，替换为~开头
    filePath: s.filePath.startsWith(prefix) ? "~/" + s.filePath.slice(prefix.length) : s.filePath,
  }));
}

// 打印skill命令调试信息，每个messageKey只打印一次，避免日志刷屏
function debugSkillCommandOnce(
  messageKey: string,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (skillCommandDebugOnce.has(messageKey)) {
    return;
  }
  skillCommandDebugOnce.add(messageKey);
  skillsLogger.debug(message, meta);
}

// 根据配置和过滤条件过滤skill条目列表
function filterSkillEntries(
  entries: SkillEntry[],
  config?: OpenClawConfig,
  skillFilter?: string[],
  eligibility?: SkillEligibilityContext,
): SkillEntry[] {
  // 首先根据shouldIncludeSkill函数过滤（基于配置和 eligibility）
  let filtered = entries.filter((entry) => shouldIncludeSkill({ entry, config, eligibility }));
  // 如果提供了skillFilter参数，只包含在过滤列表中的skills
  if (skillFilter !== undefined) {
    const normalized = normalizeSkillFilter(skillFilter) ?? [];
    const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
    skillsLogger.debug(`Applying skill filter: ${label}`);
    // normalized为空数组时过滤掉所有skills，否则只保留名称在列表中的skills
    filtered =
      normalized.length > 0
        ? filtered.filter((entry) => normalized.includes(entry.skill.name))
        : [];
    skillsLogger.debug(
      `After skill filter: ${filtered.map((entry) => entry.skill.name).join(", ") || "(none)"}`,
    );
  }
  return filtered;
}

const SKILL_COMMAND_MAX_LENGTH = 32;  // skill命令名称的最大字符长度
const SKILL_COMMAND_FALLBACK = "skill";  // 当sanitize后为空时使用的默认命令名
// Discord命令描述的最大字符长度限制
const SKILL_COMMAND_DESCRIPTION_MAX_LENGTH = 100;

// 默认的技能加载限制参数
const DEFAULT_MAX_CANDIDATES_PER_ROOT = 300;  // 每个skills根目录最多扫描的候选目录数
const DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE = 200;  // 每个来源最多加载的skill数量
const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;  // 提示词中最多包含的skill数量
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 30_000;  // 提示词中skills内容的最大字符数
const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;  // 单个SKILL.md文件的最大字节数

// 清理skill命令名称：转小写，移除非法字符，确保符合命令命名规范
function sanitizeSkillCommandName(raw: string): string {
  const normalized = raw
    .toLowerCase()  // 转换为小写
    .replace(/[^a-z0-9_]+/g, "_")  // 将非法字符替换为下划线
    .replace(/_+/g, "_")  // 合并多个连续下划线
    .replace(/^_+|_+$/g, "");  // 移除首尾的下划线
  const trimmed = normalized.slice(0, SKILL_COMMAND_MAX_LENGTH);  // 截断到最大长度
  return trimmed || SKILL_COMMAND_FALLBACK;  // 如果结果为空，使用默认的fallback
}

// 解决冲突的skill命令名称，确保同一来源中命令名称唯一
function resolveUniqueSkillCommandName(base: string, used: Set<string>): string {
  const normalizedBase = base.toLowerCase();
  if (!used.has(normalizedBase)) {
    return base;
  }
  // 如果名称已使用，尝试添加数字后缀（如 skill_2, skill_3）
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `_${index}`;
    const maxBaseLength = Math.max(1, SKILL_COMMAND_MAX_LENGTH - suffix.length);
    const trimmedBase = base.slice(0, maxBaseLength);
    const candidate = `${trimmedBase}${suffix}`;
    const candidateKey = candidate.toLowerCase();
    if (!used.has(candidateKey)) {
      return candidate;
    }
  }
  // 兜底方案：使用带x后缀的名称
  const fallback = `${base.slice(0, Math.max(1, SKILL_COMMAND_MAX_LENGTH - 2))}_x`;
  return fallback;
}

// 技能加载限制的配置结构
type ResolvedSkillsLimits = {
  maxCandidatesPerRoot: number;  // 每个根目录最大候选数
  maxSkillsLoadedPerSource: number;  // 每个来源最大加载数
  maxSkillsInPrompt: number;  // 提示词中最大技能数
  maxSkillsPromptChars: number;  // 提示词最大字符数
  maxSkillFileBytes: number;  // 单个skill文件最大字节数
};

// 从配置中解析技能加载限制，使用默认值填充未配置的项
function resolveSkillsLimits(config?: OpenClawConfig): ResolvedSkillsLimits {
  const limits = config?.skills?.limits;
  return {
    maxCandidatesPerRoot: limits?.maxCandidatesPerRoot ?? DEFAULT_MAX_CANDIDATES_PER_ROOT,
    maxSkillsLoadedPerSource:
      limits?.maxSkillsLoadedPerSource ?? DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE,
    maxSkillsInPrompt: limits?.maxSkillsInPrompt ?? DEFAULT_MAX_SKILLS_IN_PROMPT,
    maxSkillsPromptChars: limits?.maxSkillsPromptChars ?? DEFAULT_MAX_SKILLS_PROMPT_CHARS,
    maxSkillFileBytes: limits?.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES,
  };
}

// 列出目录下的直接子目录名称（排除隐藏目录和node_modules）
function listChildDirectories(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;  // 跳过隐藏目录
      if (entry.name === "node_modules") continue;  // 跳过node_modules
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(entry.name);
        continue;
      }
      // 处理符号链接：检查链接目标是否为目录
      if (entry.isSymbolicLink()) {
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            dirs.push(entry.name);
          }
        } catch {
          // 忽略损坏的符号链接
        }
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

// 尝试获取文件的真实路径（解析符号链接），失败返回null
function tryRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

// 记录警告：skill路径解析到了配置根目录之外（可能存在路径穿越风险）
function warnEscapedSkillPath(params: {
  source: string;
  rootDir: string;
  candidatePath: string;
  candidateRealPath: string;
}) {
  skillsLogger.warn("Skipping skill path that resolves outside its configured root.", {
    source: params.source,
    rootDir: params.rootDir,
    path: params.candidatePath,
    realPath: params.candidateRealPath,
  });
}

// 检查候选路径是否在根目录内，返回解析后的真实路径或null
function resolveContainedSkillPath(params: {
  source: string;
  rootDir: string;
  rootRealPath: string;
  candidatePath: string;
}): string | null {
  const candidateRealPath = tryRealpath(params.candidatePath);
  if (!candidateRealPath) {
    return null;
  }
  // 使用isPathInside检查候选路径是否在根路径内部
  if (isPathInside(params.rootRealPath, candidateRealPath)) {
    return candidateRealPath;
  }
  // 如果路径逃逸到根目录外，记录警告
  warnEscapedSkillPath({
    source: params.source,
    rootDir: params.rootDir,
    candidatePath: path.resolve(params.candidatePath),
    candidateRealPath,
  });
  return null;
}

// 过滤出所有skill文件都在根目录内的skills（安全性检查）
function filterLoadedSkillsInsideRoot(params: {
  skills: Skill[];
  source: string;
  rootDir: string;
  rootRealPath: string;
}): Skill[] {
  return params.skills.filter((skill) => {
    // 检查baseDir是否在根目录内
    const baseDirRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir: params.rootDir,
      rootRealPath: params.rootRealPath,
      candidatePath: skill.baseDir,
    });
    if (!baseDirRealPath) {
      return false;
    }
    // 检查filePath是否在根目录内
    const skillFileRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir: params.rootDir,
      rootRealPath: params.rootRealPath,
      candidatePath: skill.filePath,
    });
    return Boolean(skillFileRealPath);
  });
}

// 检测嵌套的skills根目录位置
// 启发式逻辑：如果dir/skills/*/SKILL.md存在任意一个，则认为dir/skills是真正的根目录
function resolveNestedSkillsRoot(
  dir: string,
  opts?: {
    maxEntriesToScan?: number;  // 最大扫描条目数限制，避免病态扫描
  },
): { baseDir: string; note?: string } {
  const nested = path.join(dir, "skills");
  try {
    if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) {
      return { baseDir: dir };  // 嵌套skills目录不存在，直接返回原目录
    }
  } catch {
    return { baseDir: dir };
  }

  // 启发式检测：如果dir/skills/*/SKILL.md存在任意一个，使用nested作为根目录
  // 注意：不要在25个就停止，但设置上限避免病态扫描
  const nestedDirs = listChildDirectories(nested);
  const scanLimit = Math.max(0, opts?.maxEntriesToScan ?? 100);
  const toScan = scanLimit === 0 ? [] : nestedDirs.slice(0, Math.min(nestedDirs.length, scanLimit));

  for (const name of toScan) {
    const skillMd = path.join(nested, name, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      return { baseDir: nested, note: `Detected nested skills root at ${nested}` };
    }
  }
  return { baseDir: dir };
}

// 安全地解包加载的skills数据，支持多种格式
function unwrapLoadedSkills(loaded: unknown): Skill[] {
  if (Array.isArray(loaded)) {
    return loaded as Skill[];
  }
  // 支持 { skills: [...] } 格式
  if (loaded && typeof loaded === "object" && "skills" in loaded) {
    const skills = (loaded as { skills?: unknown }).skills;
    if (Array.isArray(skills)) {
      return skills as Skill[];
    }
  }
  return [];
}

// 从指定目录加载skill条目列表
function loadSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;  // 托管skills目录（用户通过openclaw管理的skills）
    bundledSkillsDir?: string;  // 打包skills目录（内置的skills）
  },
): SkillEntry[] {
  const limits = resolveSkillsLimits(opts?.config);

  // 内部函数：从指定目录加载skills
  const loadSkills = (params: { dir: string; source: string }): Skill[] => {
    const rootDir = path.resolve(params.dir);
    const rootRealPath = tryRealpath(rootDir) ?? rootDir;
    const resolved = resolveNestedSkillsRoot(params.dir, {
      maxEntriesToScan: limits.maxCandidatesPerRoot,
    });
    const baseDir = resolved.baseDir;
    const baseDirRealPath = resolveContainedSkillPath({
      source: params.source,
      rootDir,
      rootRealPath,
      candidatePath: baseDir,
    });
    if (!baseDirRealPath) {
      return [];
    }

    // 如果根目录本身就是一个skill目录（存在SKILL.md），直接加载它（但强制限制文件大小）
    const rootSkillMd = path.join(baseDir, "SKILL.md");
    if (fs.existsSync(rootSkillMd)) {
      const rootSkillRealPath = resolveContainedSkillPath({
        source: params.source,
        rootDir,
        rootRealPath: baseDirRealPath,
        candidatePath: rootSkillMd,
      });
      if (!rootSkillRealPath) {
        return [];
      }
      try {
        const size = fs.statSync(rootSkillRealPath).size;
        if (size > limits.maxSkillFileBytes) {
          skillsLogger.warn("Skipping skills root due to oversized SKILL.md.", {
            dir: baseDir,
            filePath: rootSkillMd,
            size,
            maxSkillFileBytes: limits.maxSkillFileBytes,
          });
          return [];
        }
      } catch {
        return [];
      }

      const loaded = loadSkillsFromDir({ dir: baseDir, source: params.source });
      return filterLoadedSkillsInsideRoot({
        skills: unwrapLoadedSkills(loaded),
        source: params.source,
        rootDir,
        rootRealPath: baseDirRealPath,
      });
    }

    // 列出baseDir下的直接子目录
    const childDirs = listChildDirectories(baseDir);
    const suspicious = childDirs.length > limits.maxCandidatesPerRoot;

    // 限制加载的子目录数量
    const maxCandidates = Math.max(0, limits.maxSkillsLoadedPerSource);
    const limitedChildren = childDirs.slice().sort().slice(0, maxCandidates);

    // 如果目录数量异常多，记录警告
    if (suspicious) {
      skillsLogger.warn("Skills root looks suspiciously large, truncating discovery.", {
        dir: params.dir,
        baseDir,
        childDirCount: childDirs.length,
        maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
        maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
      });
    } else if (childDirs.length > maxCandidates) {
      skillsLogger.warn("Skills root has many entries, truncating discovery.", {
        dir: params.dir,
        baseDir,
        childDirCount: childDirs.length,
        maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
      });
    }

    const loadedSkills: Skill[] = [];

    // 只考虑包含SKILL.md且在大小限制内的直接子文件夹
    for (const name of limitedChildren) {
      const skillDir = path.join(baseDir, name);
      const skillDirRealPath = resolveContainedSkillPath({
        source: params.source,
        rootDir,
        rootRealPath: baseDirRealPath,
        candidatePath: skillDir,
      });
      if (!skillDirRealPath) {
        continue;
      }
      const skillMd = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillMd)) {
        continue;
      }
      const skillMdRealPath = resolveContainedSkillPath({
        source: params.source,
        rootDir,
        rootRealPath: baseDirRealPath,
        candidatePath: skillMd,
      });
      if (!skillMdRealPath) {
        continue;
      }
      try {
        const size = fs.statSync(skillMdRealPath).size;
        if (size > limits.maxSkillFileBytes) {
          skillsLogger.warn("Skipping skill due to oversized SKILL.md.", {
            skill: name,
            filePath: skillMd,
            size,
            maxSkillFileBytes: limits.maxSkillFileBytes,
          });
          continue;
        }
      } catch {
        continue;
      }

      // 加载该skill目录下的所有skills文件
      const loaded = loadSkillsFromDir({ dir: skillDir, source: params.source });
      loadedSkills.push(
        ...filterLoadedSkillsInsideRoot({
          skills: unwrapLoadedSkills(loaded),
          source: params.source,
          rootDir,
          rootRealPath: baseDirRealPath,
        }),
      );

      // 如果已加载数量达到上限，停止加载更多
      if (loadedSkills.length >= limits.maxSkillsLoadedPerSource) {
        break;
      }
    }

    // 如果超过限制，按名称排序后截取
    if (loadedSkills.length > limits.maxSkillsLoadedPerSource) {
      return loadedSkills
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, limits.maxSkillsLoadedPerSource);
    }

    return loadedSkills;
  };

  // 解析各个skills目录路径
  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const workspaceSkillsDir = path.resolve(workspaceDir, "skills");
  const bundledSkillsDir = opts?.bundledSkillsDir ?? resolveBundledSkillsDir();
  // 解析额外的skills目录（从配置中读取）
  const extraDirsRaw = opts?.config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => (typeof d === "string" ? d.trim() : ""))
    .filter(Boolean);
  // 解析插件提供的额外skills目录
  const pluginSkillDirs = resolvePluginSkillDirs({
    workspaceDir,
    config: opts?.config,
  });
  // 合并extraDirs和pluginSkillDirs
  const mergedExtraDirs = [...extraDirs, ...pluginSkillDirs];

  // 从各个来源加载skills
  const bundledSkills = bundledSkillsDir
    ? loadSkills({
        dir: bundledSkillsDir,
        source: "openclaw-bundled",
      })
    : [];
  // 从额外配置的目录加载skills
  const extraSkills = mergedExtraDirs.flatMap((dir) => {
    const resolved = resolveUserPath(dir);
    return loadSkills({
      dir: resolved,
      source: "openclaw-extra",
    });
  });
  // 从托管目录加载skills
  const managedSkills = loadSkills({
    dir: managedSkillsDir,
    source: "openclaw-managed",
  });
  // 从用户个人agents目录加载skills
  const personalAgentsSkillsDir = path.resolve(os.homedir(), ".agents", "skills");
  const personalAgentsSkills = loadSkills({
    dir: personalAgentsSkillsDir,
    source: "agents-skills-personal",
  });
  // 从项目agents目录加载skills
  const projectAgentsSkillsDir = path.resolve(workspaceDir, ".agents", "skills");
  const projectAgentsSkills = loadSkills({
    dir: projectAgentsSkillsDir,
    source: "agents-skills-project",
  });
  // 从workspace目录加载skills
  const workspaceSkills = loadSkills({
    dir: workspaceSkillsDir,
    source: "openclaw-workspace",
  });

  // 合并所有来源的skills，按优先级覆盖（后面的优先级更高）
  const merged = new Map<string, Skill>();
  // 优先级顺序：extra < bundled < managed < agents-skills-personal < agents-skills-project < workspace
  for (const skill of extraSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of bundledSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of managedSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of personalAgentsSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of projectAgentsSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of workspaceSkills) {
    merged.set(skill.name, skill);
  }

  // 为每个skill解析frontmatter元数据
  const skillEntries: SkillEntry[] = Array.from(merged.values()).map((skill) => {
    let frontmatter: ParsedSkillFrontmatter = {};
    try {
      const raw = fs.readFileSync(skill.filePath, "utf-8");
      frontmatter = parseFrontmatter(raw);
    } catch {
      // 忽略格式错误的skills
    }
    return {
      skill,
      frontmatter,
      metadata: resolveOpenClawMetadata(frontmatter),
      invocation: resolveSkillInvocationPolicy(frontmatter),
    };
  });
  return skillEntries;
}

// 应用提示词字符数限制，确保skills内容不超过配置的字符上限
function applySkillsPromptLimits(params: { skills: Skill[]; config?: OpenClawConfig }): {
  skillsForPrompt: Skill[];
  truncated: boolean;
  truncatedReason: "count" | "chars" | null;
} {
  const limits = resolveSkillsLimits(params.config);
  const total = params.skills.length;
  // 首先按数量限制截取
  const byCount = params.skills.slice(0, Math.max(0, limits.maxSkillsInPrompt));

  let skillsForPrompt = byCount;
  let truncated = total > byCount.length;
  let truncatedReason: "count" | "chars" | null = truncated ? "count" : null;

  // 检查当前截取结果是否超过字符限制
  const fits = (skills: Skill[]): boolean => {
    const block = formatSkillsForPrompt(skills);
    return block.length <= limits.maxSkillsPromptChars;
  };

  // 如果超过字符限制，使用二分搜索找到满足字符限制的最大前缀
  if (!fits(skillsForPrompt)) {
    let lo = 0;
    let hi = skillsForPrompt.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(skillsForPrompt.slice(0, mid))) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    skillsForPrompt = skillsForPrompt.slice(0, lo);
    truncated = true;
    truncatedReason = "chars";
  }

  return { skillsForPrompt, truncated, truncatedReason };
}

// 构建workspace的skill快照，用于缓存和复用
export function buildWorkspaceSkillSnapshot(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions & { snapshotVersion?: number },
): SkillSnapshot {
  const { eligible, prompt, resolvedSkills } = resolveWorkspaceSkillPromptState(workspaceDir, opts);
  const skillFilter = normalizeSkillFilter(opts?.skillFilter);
  return {
    prompt,
    // 只在prompt中包含skills的名称和env信息（用于验证）
    skills: eligible.map((entry) => ({
      name: entry.skill.name,
      primaryEnv: entry.metadata?.primaryEnv,
      requiredEnv: entry.metadata?.requires?.env?.slice(),
    })),
    // 如果没有skillFilter则不包含该字段
    ...(skillFilter === undefined ? {} : { skillFilter }),
    resolvedSkills,
    version: opts?.snapshotVersion,
  };
}

// 构建workspace的skills提示词内容
export function buildWorkspaceSkillsPrompt(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions,
): string {
  return resolveWorkspaceSkillPromptState(workspaceDir, opts).prompt;
}

// 构建workspace skill选项的类型定义
type WorkspaceSkillBuildOptions = {
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  entries?: SkillEntry[];  // 如果已加载entries，可直接传入避免重复加载
  /** If provided, only include skills with these names */
  skillFilter?: string[];  // 可选：只包含指定名称的skills
  eligibility?: SkillEligibilityContext;  // 可选：eligibility上下文，用于更精细的过滤
};

// 解析workspace skill的提示词状态
function resolveWorkspaceSkillPromptState(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions,
): {
  eligible: SkillEntry[];
  prompt: string;
  resolvedSkills: Skill[];
} {
  // 加载或使用已提供的entries
  const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
  // 过滤得到符合条件的entries
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    opts?.skillFilter,
    opts?.eligibility,
  );
  // 只包含允许模型调用的entries（未标记为disableModelInvocation）
  const promptEntries = eligible.filter(
    (entry) => entry.invocation?.disableModelInvocation !== true,
  );
  const remoteNote = opts?.eligibility?.remote?.note?.trim();
  const resolvedSkills = promptEntries.map((entry) => entry.skill);
  // 应用提示词限制
  const { skillsForPrompt, truncated } = applySkillsPromptLimits({
    skills: resolvedSkills,
    config: opts?.config,
  });
  // 如果有截断，生成截断提示信息
  const truncationNote = truncated
    ? `⚠️ Skills truncated: included ${skillsForPrompt.length} of ${resolvedSkills.length}. Run \`openclaw skills check\` to audit.`
    : "";
  // 组合最终提示词
  const prompt = [
    remoteNote,
    truncationNote,
    formatSkillsForPrompt(compactSkillPaths(skillsForPrompt)),
  ]
    .filter(Boolean)
    .join("\n");
  return { eligible, prompt, resolvedSkills };
}

// 为运行解析skills提示词，支持从快照恢复
export function resolveSkillsPromptForRun(params: {
  skillsSnapshot?: SkillSnapshot;  // 可选：使用已构建的快照
  entries?: SkillEntry[];
  config?: OpenClawConfig;
  workspaceDir: string;
}): string {
  // 如果有快照，直接使用快照中的提示词
  const snapshotPrompt = params.skillsSnapshot?.prompt?.trim();
  if (snapshotPrompt) {
    return snapshotPrompt;
  }
  // 否则根据entries构建新的提示词
  if (params.entries && params.entries.length > 0) {
    const prompt = buildWorkspaceSkillsPrompt(params.workspaceDir, {
      entries: params.entries,
      config: params.config,
    });
    return prompt.trim() ? prompt : "";
  }
  return "";
}

// 加载workspace的skill entries
export function loadWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
  },
): SkillEntry[] {
  return loadSkillEntries(workspaceDir, opts);
}

// 解决唯一的同步skill目录名称，处理名称冲突
function resolveUniqueSyncedSkillDirName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  // 尝试添加数字后缀
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  // 兜底：继续尝试直到找到可用名称
  let fallbackIndex = 10_000;
  let fallback = `${base}-${fallbackIndex}`;
  while (used.has(fallback)) {
    fallbackIndex += 1;
    fallback = `${base}-${fallbackIndex}`;
  }
  used.add(fallback);
  return fallback;
}

// 解析同步skill的目标路径
function resolveSyncedSkillDestinationPath(params: {
  targetSkillsDir: string;
  entry: SkillEntry;
  usedDirNames: Set<string>;
}): string | null {
  // 获取源目录名称
  const sourceDirName = path.basename(params.entry.skill.baseDir).trim();
  // 验证目录名称有效性
  if (!sourceDirName || sourceDirName === "." || sourceDirName === "..") {
    return null;
  }
  // 解决名称冲突，获取唯一目录名
  const uniqueDirName = resolveUniqueSyncedSkillDirName(sourceDirName, params.usedDirNames);
  // 解析完整的目标路径
  return resolveSandboxPath({
    filePath: uniqueDirName,
    cwd: params.targetSkillsDir,
    root: params.targetSkillsDir,
  }).resolved;
}

// 将skills同步到workspace目录（用于沙箱环境）
export async function syncSkillsToWorkspace(params: {
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
}) {
  const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
  const targetDir = resolveUserPath(params.targetWorkspaceDir);
  // 如果源和目标相同，无需同步
  if (sourceDir === targetDir) {
    return;
  }

  // 使用serializeByKey确保同步操作的原子性
  await serializeByKey(`syncSkills:${targetDir}`, async () => {
    const targetSkillsDir = path.join(targetDir, "skills");

    // 加载源workspace的所有skills
    const entries = loadSkillEntries(sourceDir, {
      config: params.config,
      managedSkillsDir: params.managedSkillsDir,
      bundledSkillsDir: params.bundledSkillsDir,
    });

    // 清空并重建目标skills目录
    await fsp.rm(targetSkillsDir, { recursive: true, force: true });
    await fsp.mkdir(targetSkillsDir, { recursive: true });

    const usedDirNames = new Set<string>();
    // 逐个复制skill目录到目标位置
    for (const entry of entries) {
      let dest: string | null = null;
      try {
        dest = resolveSyncedSkillDestinationPath({
          targetSkillsDir,
          entry,
          usedDirNames,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: ${message}`);
        continue;
      }
      if (!dest) {
        skillsLogger.warn(
          `Failed to resolve safe destination for ${entry.skill.name}: invalid source directory name`,
        );
        continue;
      }
      try {
        // 递归复制整个skill目录到目标
        await fsp.cp(entry.skill.baseDir, dest, {
          recursive: true,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
      }
    }
  });
}

// 过滤workspace skill entries（公开函数版本）
export function filterWorkspaceSkillEntries(
  entries: SkillEntry[],
  config?: OpenClawConfig,
): SkillEntry[] {
  return filterSkillEntries(entries, config);
}

// 构建workspace的skill命令规格列表，用于注册CLI命令
export function buildWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
    reservedNames?: Set<string>;  // 保留的命令名称（系统级命令），需要避免冲突
  },
): SkillCommandSpec[] {
  // 加载或使用已提供的entries
  const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
  // 过滤符合条件的entries
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    opts?.skillFilter,
    opts?.eligibility,
  );
  // 只包含允许用户调用的entries（默认允许，除非明确标记为不可用户调用）
  const userInvocable = eligible.filter((entry) => entry.invocation?.userInvocable !== false);
  const used = new Set<string>();
  // 初始化已使用的命令名称集合
  for (const reserved of opts?.reservedNames ?? []) {
    used.add(reserved.toLowerCase());
  }

  const specs: SkillCommandSpec[] = [];
  // 为每个符合条件的skill生成命令规格
  for (const entry of userInvocable) {
    const rawName = entry.skill.name;
    // 清理命令名称
    const base = sanitizeSkillCommandName(rawName);
    if (base !== rawName) {
      debugSkillCommandOnce(
        `sanitize:${rawName}:${base}`,
        `Sanitized skill command name "${rawName}" to "/${base}".`,
        { rawName, sanitized: `/${base}` },
      );
    }
    // 解决命令名称冲突
    const unique = resolveUniqueSkillCommandName(base, used);
    if (unique !== base) {
      debugSkillCommandOnce(
        `dedupe:${rawName}:${unique}`,
        `De-duplicated skill command name for "${rawName}" to "/${unique}".`,
        { rawName, deduped: `/${unique}` },
      );
    }
    used.add(unique.toLowerCase());
    // 处理命令描述
    const rawDescription = entry.skill.description?.trim() || rawName;
    const description =
      rawDescription.length > SKILL_COMMAND_DESCRIPTION_MAX_LENGTH
        ? rawDescription.slice(0, SKILL_COMMAND_DESCRIPTION_MAX_LENGTH - 1) + "…"
        : rawDescription;
    // 解析命令调度配置
    const dispatch = (() => {
      const kindRaw = (
        entry.frontmatter?.["command-dispatch"] ??
        entry.frontmatter?.["command_dispatch"] ??
        ""
      )
        .trim()
        .toLowerCase();
      if (!kindRaw) {
        return undefined;
      }
      // 目前只支持tool类型的调度
      if (kindRaw !== "tool") {
        return undefined;
      }

      // 获取调度的工具名称
      const toolName = (
        entry.frontmatter?.["command-tool"] ??
        entry.frontmatter?.["command_tool"] ??
        ""
      ).trim();
      if (!toolName) {
        debugSkillCommandOnce(
          `dispatch:missingTool:${rawName}`,
          `Skill command "/${unique}" requested tool dispatch but did not provide command-tool. Ignoring dispatch.`,
          { skillName: rawName, command: unique },
        );
        return undefined;
      }

      // 解析命令参数模式
      const argModeRaw = (
        entry.frontmatter?.["command-arg-mode"] ??
        entry.frontmatter?.["command_arg_mode"] ??
        ""
      )
        .trim()
        .toLowerCase();
      const argMode = !argModeRaw || argModeRaw === "raw" ? "raw" : null;
      if (!argMode) {
        debugSkillCommandOnce(
          `dispatch:badArgMode:${rawName}:${argModeRaw}`,
          `Skill command "/${unique}" requested tool dispatch but has unknown command-arg-mode. Falling back to raw.`,
          { skillName: rawName, command: unique, argMode: argModeRaw },
        );
      }

      return { kind: "tool" as const, toolName, argMode: "raw" as const };
    })();

    // 构建命令规格对象
    specs.push({
      name: unique,
      skillName: rawName,
      description,
      ...(dispatch ? { dispatch } : {}),
    });
  }
  return specs;
}