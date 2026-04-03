/**
 * @file fs-bridge.ts
 *
 * @desc 沙箱文件系统桥接层
 *
 * ## 核心功能
 * 1. 提供主机与沙箱容器之间的文件系统操作抽象层
 * 2. 路径安全检查：防止沙箱越权访问主机文件
 * 3. 路径解析：主机路径 ↔ 容器路径双向映射
 * 4. 权限控制：读写权限验证，防止越权操作
 * 5. 封装基础文件操作：read/write/mkdir/remove/rename/stat
 *
 * ## 安全机制
 * - 路径锚定(Pinned Path)：通过文件描述符确保操作目标不被篡改
 * - 挂载点校验：限制操作仅在已挂载的目录内
 * - 权限验证：严格区分读写权限
 * - 沙箱隔离：所有修改仅在容器内生效，不影响主机系统
 *
 * ## 依赖组件
 * - Docker 作为沙箱运行时
 * - fs-bridge-path-safety.ts 路径安全检查
 * - fs-bridge-shell-command-plans.ts 命令计划构建
 * - fs-paths.ts 路径解析
 */

import fs from "node:fs";
import { execDockerRaw, type ExecDockerRawResult } from "./docker.js";
import {
  buildPinnedMkdirpPlan,
  buildPinnedRemovePlan,
  buildPinnedRenamePlan,
  buildPinnedWritePlan,
} from "./fs-bridge-mutation-helper.js";
import { SandboxFsPathGuard } from "./fs-bridge-path-safety.js";
import { buildStatPlan, type SandboxFsCommandPlan } from "./fs-bridge-shell-command-plans.js";
import {
  buildSandboxFsMounts,
  resolveSandboxFsPathWithMounts,
  type SandboxResolvedFsPath,
} from "./fs-paths.js";
import type { SandboxContext, SandboxWorkspaceAccess } from "./types.js";

/**
 * 运行命令选项
 */
type RunCommandOptions = {
  args?: string[];
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
};

/**
 * 沙箱解析后的路径结构
 * 包含主机、相对、容器三种路径表示
 */
export type SandboxResolvedPath = {
  hostPath: string; // 主机上的绝对路径
  relativePath: string; // 相对于工作区的相对路径
  containerPath: string; // 容器内的绝对路径
};

/**
 * 沙箱文件状态信息
 */
export type SandboxFsStat = {
  type: "file" | "directory" | "other"; // 文件类型
  size: number; // 文件大小（字节）
  mtimeMs: number; // 修改时间（毫秒时间戳）
};

/**
 * 沙箱文件系统桥接接口
 * 定义所有支持的文件系统操作
 */
export type SandboxFsBridge = {
  /** 解析路径，返回主机/相对/容器三种路径 */
  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath;

  /** 读取文件内容 */
  readFile(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<Buffer>;

  /** 写入文件内容 */
  writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<void>;

  /** 创建多级目录 */
  mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void>;

  /** 删除文件/目录 */
  remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<void>;

  /** 重命名文件/目录 */
  rename(params: { from: string; to: string; cwd?: string; signal?: AbortSignal }): Promise<void>;

  /** 获取文件状态信息 */
  stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null>;
};

/**
 * 创建沙箱文件系统桥接实例
 * @param params.sandbox 沙箱上下文
 * @returns 沙箱文件系统桥接实例
 */
export function createSandboxFsBridge(params: { sandbox: SandboxContext }): SandboxFsBridge {
  return new SandboxFsBridgeImpl(params.sandbox);
}

/**
 * 沙箱文件系统桥接实现类
 *
 * 核心职责：
 * 1. 路径解析：主机 <-> 容器路径双向映射
 * 2. 安全检查：所有操作前验证路径合法性和权限
 * 3. 操作代理：将文件操作转发到 Docker 容器执行
 * 4. 隔离保障：确保操作不会越权访问主机系统
 */
class SandboxFsBridgeImpl implements SandboxFsBridge {
  private readonly sandbox: SandboxContext; // 沙箱上下文
  private readonly mounts: ReturnType<typeof buildSandboxFsMounts>; // 挂载点配置
  private readonly pathGuard: SandboxFsPathGuard; // 路径安全检查器

  constructor(sandbox: SandboxContext) {
    this.sandbox = sandbox;
    this.mounts = buildSandboxFsMounts(sandbox);
    // 按容器路径长度倒序排序，确保更长路径优先匹配
    const mountsByContainer = [...this.mounts].toSorted(
      (a, b) => b.containerRoot.length - a.containerRoot.length,
    );
    this.pathGuard = new SandboxFsPathGuard({
      mountsByContainer,
      runCommand: (script, options) => this.runCommand(script, options),
    });
  }

  /**
   * 解析路径，返回主机/相对/容器三种路径表示
   * @param params.filePath 要解析的文件路径
   * @param params.cwd 工作目录（可选，默认使用沙箱工作目录）
   * @returns 解析后的路径结构
   */
  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const target = this.resolveResolvedPath(params);
    return {
      hostPath: target.hostPath,
      relativePath: target.relativePath,
      containerPath: target.containerPath,
    };
  }

  /**
   * 读取文件内容
   * @param params.filePath 文件路径
   * @param params.cwd 工作目录
   * @param params.signal 中断信号
   * @returns 文件内容 Buffer
   */
  async readFile(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    const target = this.resolveResolvedPath(params);
    return this.readPinnedFile(target);
  }

  /**
   * 写入文件内容
   * 安全特性：路径锚定 + 权限验证 + 安全检查
   * @param params.filePath 文件路径
   * @param params.cwd 工作目录
   * @param params.data 要写入的数据
   * @param params.encoding 编码格式（默认 utf8）
   * @param params.mkdir 自动创建父目录（默认 true）
   * @param params.signal 中断信号
   */
  async writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveResolvedPath(params);
    this.ensureWriteAccess(target, "write files");
    const writeCheck = {
      target,
      options: { action: "write files", requireWritable: true } as const,
    };
    await this.pathGuard.assertPathSafety(target, writeCheck.options);
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    // 路径锚定：通过文件描述符确保操作目标不被篡改
    const pinnedWriteTarget = await this.pathGuard.resolveAnchoredPinnedEntry(
      target,
      "write files",
    );
    await this.runCheckedCommand({
      ...buildPinnedWritePlan({
        check: writeCheck,
        pinned: pinnedWriteTarget,
        mkdir: params.mkdir !== false,
      }),
      stdin: buffer,
      signal: params.signal,
    });
  }

  /**
   * 创建多级目录
   * @param params.filePath 目录路径
   * @param params.cwd 工作目录
   * @param params.signal 中断信号
   */
  async mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
    const target = this.resolveResolvedPath(params);
    this.ensureWriteAccess(target, "create directories");
    const mkdirCheck = {
      target,
      options: {
        action: "create directories",
        requireWritable: true,
        allowedType: "directory",
      } as const,
    };
    await this.runCheckedCommand({
      ...buildPinnedMkdirpPlan({
        check: mkdirCheck,
        pinned: this.pathGuard.resolvePinnedDirectoryEntry(target, "create directories"),
      }),
      signal: params.signal,
    });
  }

  /**
   * 删除文件或目录
   * @param params.filePath 要删除的路径
   * @param params.cwd 工作目录
   * @param params.recursive 是否递归删除子目录（默认 false）
   * @param params.force 是否强制删除（默认 false）
   * @param params.signal 中断信号
   */
  async remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveResolvedPath(params);
    this.ensureWriteAccess(target, "remove files");
    const removeCheck = {
      target,
      options: {
        action: "remove files",
        requireWritable: true,
      } as const,
    };
    await this.runCheckedCommand({
      ...buildPinnedRemovePlan({
        check: removeCheck,
        pinned: this.pathGuard.resolvePinnedEntry(target, "remove files"),
        recursive: params.recursive,
        force: params.force,
      }),
      signal: params.signal,
    });
  }

  /**
   * 重命名文件或目录
   * @param params.from 源路径
   * @param params.to 目标路径
   * @param params.cwd 工作目录
   * @param params.signal 中断信号
   */
  async rename(params: {
    from: string;
    to: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const from = this.resolveResolvedPath({ filePath: params.from, cwd: params.cwd });
    const to = this.resolveResolvedPath({ filePath: params.to, cwd: params.cwd });
    this.ensureWriteAccess(from, "rename files");
    this.ensureWriteAccess(to, "rename files");
    const fromCheck = {
      target: from,
      options: {
        action: "rename files",
        requireWritable: true,
      } as const,
    };
    const toCheck = {
      target: to,
      options: {
        action: "rename files",
        requireWritable: true,
      } as const,
    };
    await this.runCheckedCommand({
      ...buildPinnedRenamePlan({
        fromCheck,
        toCheck,
        from: this.pathGuard.resolvePinnedEntry(from, "rename files"),
        to: this.pathGuard.resolvePinnedEntry(to, "rename files"),
      }),
      signal: params.signal,
    });
  }

  /**
   * 获取文件状态信息
   * @param params.filePath 文件路径
   * @param params.cwd 工作目录
   * @param params.signal 中断信号
   * @returns 文件状态信息，如果文件不存在返回 null
   */
  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    const target = this.resolveResolvedPath(params);
    const anchoredTarget = await this.pathGuard.resolveAnchoredSandboxEntry(target, "stat files");
    const result = await this.runPlannedCommand(
      buildStatPlan(target, anchoredTarget),
      params.signal,
    );
    if (result.code !== 0) {
      const stderr = result.stderr.toString("utf8");
      if (stderr.includes("No such file or directory")) {
        return null;
      }
      const message = stderr.trim() || `stat failed with code ${result.code}`;
      throw new Error(`stat failed for ${target.containerPath}: ${message}`);
    }
    const text = result.stdout.toString("utf8").trim();
    const [typeRaw, sizeRaw, mtimeRaw] = text.split("|");
    const size = Number.parseInt(sizeRaw ?? "0", 10);
    const mtime = Number.parseInt(mtimeRaw ?? "0", 10) * 1000;
    return {
      type: coerceStatType(typeRaw),
      size: Number.isFinite(size) ? size : 0,
      mtimeMs: Number.isFinite(mtime) ? mtime : 0,
    };
  }

  /**
   * 内部方法：在沙箱容器中运行命令
   * @param script 要执行的 Shell 脚本
   * @param options 运行选项
   * @returns 命令执行结果
   */
  private async runCommand(
    script: string,
    options: RunCommandOptions = {},
  ): Promise<ExecDockerRawResult> {
    const dockerArgs = [
      "exec",
      "-i",
      this.sandbox.containerName,
      "sh",
      "-c",
      script,
      "moltbot-sandbox-fs",
    ];
    if (options.args?.length) {
      dockerArgs.push(...options.args);
    }
    return execDockerRaw(dockerArgs, {
      input: options.stdin,
      allowFailure: options.allowFailure,
      signal: options.signal,
    });
  }

  /**
   * 内部方法：读取锚定文件内容
   * 通过文件描述符读取，确保目标文件不会在读取过程中被篡改
   * @param target 解析后的文件路径
   * @returns 文件内容 Buffer
   */
  private async readPinnedFile(target: SandboxResolvedFsPath): Promise<Buffer> {
    const opened = await this.pathGuard.openReadableFile(target);
    try {
      return fs.readFileSync(opened.fd);
    } finally {
      fs.closeSync(opened.fd);
    }
  }

  /**
   * 内部方法：运行带安全检查的命令
   * 执行命令前后进行路径安全验证
   * @param plan 命令计划
   * @returns 命令执行结果
   */
  private async runCheckedCommand(
    plan: SandboxFsCommandPlan & { stdin?: Buffer | string; signal?: AbortSignal },
  ): Promise<ExecDockerRawResult> {
    await this.pathGuard.assertPathChecks(plan.checks);
    if (plan.recheckBeforeCommand) {
      await this.pathGuard.assertPathChecks(plan.checks);
    }
    return await this.runCommand(plan.script, {
      args: plan.args,
      stdin: plan.stdin,
      allowFailure: plan.allowFailure,
      signal: plan.signal,
    });
  }

  /**
   * 内部方法：运行计划命令
   * 简单包装 runCheckedCommand
   * @param plan 命令计划
   * @param signal 中断信号
   * @returns 命令执行结果
   */
  private async runPlannedCommand(
    plan: SandboxFsCommandPlan,
    signal?: AbortSignal,
  ): Promise<ExecDockerRawResult> {
    return await this.runCheckedCommand({ ...plan, signal });
  }

  /**
   * 内部方法：检查写权限
   * 验证沙箱工作区和目标路径是否可写
   * @param target 目标路径
   * @param action 操作描述（用于错误提示）
   */
  private ensureWriteAccess(target: SandboxResolvedFsPath, action: string) {
    if (!allowsWrites(this.sandbox.workspaceAccess) || !target.writable) {
      throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
    }
  }

  /**
   * 内部方法：解析文件路径
   * 根据挂载点配置将相对路径解析为主机和容器路径
   * @param params.filePath 要解析的路径
   * @param params.cwd 工作目录
   * @returns 解析后的完整路径结构
   */
  private resolveResolvedPath(params: { filePath: string; cwd?: string }): SandboxResolvedFsPath {
    return resolveSandboxFsPathWithMounts({
      filePath: params.filePath,
      cwd: params.cwd ?? this.sandbox.workspaceDir,
      defaultWorkspaceRoot: this.sandbox.workspaceDir,
      defaultContainerRoot: this.sandbox.containerWorkdir,
      mounts: this.mounts,
    });
  }
}

/**
 * 工具函数：检查工作区是否允许写入
 * @param access 工作区访问权限
 * @returns 是否可写
 */
function allowsWrites(access: SandboxWorkspaceAccess): boolean {
  return access === "rw";
}

/**
 * 工具函数：转换 stat 输出的类型字符串
 * @param typeRaw stat 输出的原始类型字符串
 * @returns 标准化的文件类型
 */
function coerceStatType(typeRaw?: string): "file" | "directory" | "other" {
  if (!typeRaw) {
    return "other";
  }
  const normalized = typeRaw.trim().toLowerCase();
  if (normalized.includes("directory")) {
    return "directory";
  }
  if (normalized.includes("file")) {
    return "file";
  }
  return "other";
}
