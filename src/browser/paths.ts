/**
 * paths.ts - 浏览器模块路径安全校验工具
 *
 * 核心功能：提供路径安全校验能力，防止路径遍历攻击（Path Traversal）
 * 所有浏览器相关的文件操作（上传、下载、快照存储等）都必须通过本模块的路径校验
 * 采用两层防护机制：1. 词法层面校验 2. 真实文件系统校验
 */

import fs from "node:fs/promises";
import path from "node:path";
// 导入安全文件操作工具
import { SafeOpenError, openFileWithinRoot } from "../infra/fs-safe.js";
// 导入路径防护工具函数
import { isNotFoundPathError, isPathInside } from "../infra/path-guards.js";
// 导入OpenClaw临时目录解析函数
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

/**
 * 浏览器默认临时目录，所有浏览器相关的临时文件都存储在此目录下
 * 基于系统临时目录 + openclaw专用路径，确保隔离性
 */
export const DEFAULT_BROWSER_TMP_DIR = resolvePreferredOpenClawTmpDir();
/**
 * 浏览器追踪日志默认存储目录
 */
export const DEFAULT_TRACE_DIR = DEFAULT_BROWSER_TMP_DIR;
/**
 * 浏览器下载文件默认存储目录
 */
export const DEFAULT_DOWNLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "downloads");
/**
 * 浏览器上传文件默认根目录，所有上传文件必须在此目录内
 */
export const DEFAULT_UPLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "uploads");

/**
 * 路径校验失败结果类型
 */
type InvalidPathResult = { ok: false; error: string };

/**
 * 创建路径校验失败的结果对象
 * @param scopeLabel - 路径所在范围的描述（如"uploads directory"）
 * @returns 标准化的错误结果
 */
function invalidPath(scopeLabel: string): InvalidPathResult {
  return {
    ok: false,
    error: `Invalid path: must stay within ${scopeLabel}`,
  };
}

/**
 * 解析路径的真实路径（解析软链），如果路径不存在则返回undefined
 * @param targetPath - 目标路径
 * @returns 真实路径字符串或undefined
 */
async function resolveRealPathIfExists(targetPath: string): Promise<string | undefined> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return undefined;
  }
}

/**
 * 解析可信根目录的真实路径
 * 安全校验：根目录必须是真实存在的目录，且不能是软链
 * @param rootDir - 根目录路径
 * @returns 根目录的真实路径，校验失败返回undefined
 */
async function resolveTrustedRootRealPath(rootDir: string): Promise<string | undefined> {
  try {
    const rootLstat = await fs.lstat(rootDir);
    // 根目录必须是目录且不能是软链，防止软链绕过路径限制
    if (!rootLstat.isDirectory() || rootLstat.isSymbolicLink()) {
      return undefined;
    }
    return await fs.realpath(rootDir);
  } catch {
    return undefined;
  }
}

/**
 * 校验候选路径的规范路径是否在根目录内（真实文件系统层面校验）
 * 安全检查点：
 * 1. 禁止软链，防止软链指向根目录外
 * 2. 文件类型必须符合预期（目录/文件）
 * 3. 禁止硬链接数大于1的文件，防止硬链接绕过路径限制
 * 4. 真实路径必须在根目录范围内
 *
 * @param params - 校验参数
 * @param params.rootRealPath - 根目录的真实路径
 * @param params.candidatePath - 候选路径
 * @param params.expect - 期望的路径类型（directory/file）
 * @returns 校验结果：ok/文件不存在/校验失败
 */
async function validateCanonicalPathWithinRoot(params: {
  rootRealPath: string;
  candidatePath: string;
  expect: "directory" | "file";
}): Promise<"ok" | "not-found" | "invalid"> {
  try {
    const candidateLstat = await fs.lstat(params.candidatePath);
    // 禁止软链
    if (candidateLstat.isSymbolicLink()) {
      return "invalid";
    }
    // 校验路径类型是否符合预期
    if (params.expect === "directory" && !candidateLstat.isDirectory()) {
      return "invalid";
    }
    if (params.expect === "file" && !candidateLstat.isFile()) {
      return "invalid";
    }
    // 禁止多硬链接的文件，防止通过硬链接访问根目录外的文件
    if (params.expect === "file" && candidateLstat.nlink > 1) {
      return "invalid";
    }
    // 解析真实路径并检查是否在根目录内
    const candidateRealPath = await fs.realpath(params.candidatePath);
    return isPathInside(params.rootRealPath, candidateRealPath) ? "ok" : "invalid";
  } catch (err) {
    // 文件不存在返回not-found，其他错误返回invalid
    return isNotFoundPathError(err) ? "not-found" : "invalid";
  }
}

/**
 * 词法层面校验路径是否在根目录内（不访问文件系统，性能高）
 * 第一层防护：快速检查是否存在路径遍历攻击（如../）
 * 注意：此方法只做词法检查，不保证路径真实存在，也不解析软链
 *
 * @param params - 校验参数
 * @param params.rootDir - 根目录路径
 * @param params.requestedPath - 请求的路径
 * @param params.scopeLabel - 路径范围描述，用于错误提示
 * @param params.defaultFileName - 路径为空时使用的默认文件名
 * @returns 校验结果：成功返回解析后的绝对路径，失败返回错误信息
 */
export function resolvePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): { ok: true; path: string } | { ok: false; error: string } {
  const root = path.resolve(params.rootDir);
  const raw = params.requestedPath.trim();

  // 路径为空处理
  if (!raw) {
    if (!params.defaultFileName) {
      return { ok: false, error: "path is required" };
    }
    return { ok: true, path: path.join(root, params.defaultFileName) };
  }

  // 解析为绝对路径
  const resolved = path.resolve(root, raw);
  // 计算相对路径
  const rel = path.relative(root, resolved);

  // 路径遍历检测：相对路径为空 或 以../开头 或 是绝对路径 都属于非法路径
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: `Invalid path: must stay within ${params.scopeLabel}` };
  }

  return { ok: true, path: resolved };
}

/**
 * 校验可写路径是否在根目录内（两层校验：词法 + 文件系统校验）
 * 用于文件写入场景的路径安全校验，比词法校验更严格
 * 安全校验流程：
 * 1. 先做词法校验
 * 2. 校验根目录的合法性
 * 3. 校验父目录的合法性（必须是根目录内的真实目录）
 * 4. 校验目标文件的合法性（如果存在则必须是根目录内的合法文件）
 *
 * @param params - 校验参数
 * @param params.rootDir - 根目录路径
 * @param params.requestedPath - 请求的路径
 * @param params.scopeLabel - 路径范围描述
 * @param params.defaultFileName - 路径为空时使用的默认文件名
 * @returns 校验结果：成功返回解析后的绝对路径，失败返回错误
 */
export async function resolveWritablePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  // 第一层：词法校验
  const lexical = resolvePathWithinRoot(params);
  if (!lexical.ok) {
    return lexical;
  }

  const rootDir = path.resolve(params.rootDir);
  // 校验根目录的合法性
  const rootRealPath = await resolveTrustedRootRealPath(rootDir);
  if (!rootRealPath) {
    return invalidPath(params.scopeLabel);
  }

  const requestedPath = lexical.path;
  const parentDir = path.dirname(requestedPath);
  // 第二层：校验父目录必须是根目录内的真实目录
  const parentStatus = await validateCanonicalPathWithinRoot({
    rootRealPath,
    candidatePath: parentDir,
    expect: "directory",
  });
  if (parentStatus !== "ok") {
    return invalidPath(params.scopeLabel);
  }

  // 第二层：校验目标文件（如果存在则必须是合法文件）
  const targetStatus = await validateCanonicalPathWithinRoot({
    rootRealPath,
    candidatePath: requestedPath,
    expect: "file",
  });
  if (targetStatus === "invalid") {
    return invalidPath(params.scopeLabel);
  }

  return lexical;
}

/**
 * 批量词法校验多个路径是否在根目录内
 * 性能高，不访问文件系统，适合快速校验大量路径
 *
 * @param params - 校验参数
 * @param params.rootDir - 根目录路径
 * @param params.requestedPaths - 请求的路径列表
 * @param params.scopeLabel - 路径范围描述
 * @returns 校验结果：成功返回解析后的绝对路径列表，失败返回错误
 */
export function resolvePathsWithinRoot(params: {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
}): { ok: true; paths: string[] } | { ok: false; error: string } {
  const resolvedPaths: string[] = [];
  for (const raw of params.requestedPaths) {
    const pathResult = resolvePathWithinRoot({
      rootDir: params.rootDir,
      requestedPath: raw,
      scopeLabel: params.scopeLabel,
    });
    if (!pathResult.ok) {
      return { ok: false, error: pathResult.error };
    }
    resolvedPaths.push(pathResult.path);
  }
  return { ok: true, paths: resolvedPaths };
}

/**
 * 批量校验多个已存在的文件路径是否在根目录内（宽松模式）
 * 特性：文件不存在时返回词法解析后的路径（兼容历史行为）
 * 安全级别高，会做最终的文件打开校验
 *
 * @param params - 校验参数
 * @param params.rootDir - 根目录路径
 * @param params.requestedPaths - 请求的路径列表
 * @param params.scopeLabel - 路径范围描述
 * @returns 校验结果：成功返回真实路径列表，失败返回错误
 */
export async function resolveExistingPathsWithinRoot(params: {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
}): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  return await resolveCheckedPathsWithinRoot({
    ...params,
    allowMissingFallback: true, // 允许文件不存在时回退到词法路径
  });
}

/**
 * 批量校验多个已存在的文件路径是否在根目录内（严格模式）
 * 特性：文件不存在时直接返回错误
 * 安全级别最高，适合要求文件必须存在的场景
 *
 * @param params - 校验参数
 * @param params.rootDir - 根目录路径
 * @param params.requestedPaths - 请求的路径列表
 * @param params.scopeLabel - 路径范围描述
 * @returns 校验结果：成功返回真实路径列表，失败返回错误
 */
export async function resolveStrictExistingPathsWithinRoot(params: {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
}): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  return await resolveCheckedPathsWithinRoot({
    ...params,
    allowMissingFallback: false, // 不允许回退，文件不存在直接报错
  });
}

/**
 * 批量校验已存在路径的核心实现（内部函数）
 * 最高安全级别的路径校验：
 * 1. 词法校验
 * 2. 真实路径解析
 * 3. 最终通过openFileWithinRoot做内核级安全校验
 *
 * @param params - 校验参数
 * @param params.rootDir - 根目录路径
 * @param params.requestedPaths - 请求的路径列表
 * @param params.scopeLabel - 路径范围描述
 * @param params.allowMissingFallback - 是否允许文件不存在时回退到词法路径
 * @returns 校验结果：成功返回真实路径列表，失败返回错误
 */
async function resolveCheckedPathsWithinRoot(params: {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
  allowMissingFallback: boolean;
}): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const rootDir = path.resolve(params.rootDir);
  // 根目录不存在时保持历史行为，依赖后续openFileWithinRoot做最终校验
  const rootRealPath = await resolveRealPathIfExists(rootDir);

  /**
   * 检查相对路径是否在根目录内
   * @param relativePath - 相对根目录的路径
   * @returns 是否合法
   */
  const isInRoot = (relativePath: string) =>
    Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);

  /**
   * 解析已存在的相对路径
   * 兼容两种路径格式：相对路径和绝对路径（如果绝对路径在根目录内也允许）
   * @param requestedPath - 请求的路径
   * @returns 解析结果
   */
  const resolveExistingRelativePath = async (
    requestedPath: string,
  ): Promise<
    { ok: true; relativePath: string; fallbackPath: string } | { ok: false; error: string }
  > => {
    const raw = requestedPath.trim();
    // 优先做词法校验
    const lexicalPathResult = resolvePathWithinRoot({
      rootDir,
      requestedPath,
      scopeLabel: params.scopeLabel,
    });
    if (lexicalPathResult.ok) {
      return {
        ok: true,
        relativePath: path.relative(rootDir, lexicalPathResult.path),
        fallbackPath: lexicalPathResult.path,
      };
    }

    // 词法校验失败时，如果是绝对路径且根目录存在，尝试解析真实路径
    if (!rootRealPath || !raw || !path.isAbsolute(raw)) {
      return lexicalPathResult;
    }

    try {
      const resolvedExistingPath = await fs.realpath(raw);
      const relativePath = path.relative(rootRealPath, resolvedExistingPath);
      // 真实路径在根目录内则允许
      if (!isInRoot(relativePath)) {
        return lexicalPathResult;
      }
      return {
        ok: true,
        relativePath,
        fallbackPath: resolvedExistingPath,
      };
    } catch {
      return lexicalPathResult;
    }
  };

  const resolvedPaths: string[] = [];
  for (const raw of params.requestedPaths) {
    const pathResult = await resolveExistingRelativePath(raw);
    if (!pathResult.ok) {
      return { ok: false, error: pathResult.error };
    }

    let opened: Awaited<ReturnType<typeof openFileWithinRoot>> | undefined;
    try {
      // 最终安全校验：通过openFileWithinRoot尝试打开文件，内核级路径安全检查
      opened = await openFileWithinRoot({
        rootDir,
        relativePath: pathResult.relativePath,
      });
      resolvedPaths.push(opened.realPath);
    } catch (err) {
      // 允许回退模式下，文件不存在时使用fallback路径
      if (params.allowMissingFallback && err instanceof SafeOpenError && err.code === "not-found") {
        // 保持历史行为：不存在的文件返回词法解析后的路径
        resolvedPaths.push(pathResult.fallbackPath);
        continue;
      }
      // 文件在根目录外，返回明确错误
      if (err instanceof SafeOpenError && err.code === "outside-workspace") {
        return {
          ok: false,
          error: `File is outside ${params.scopeLabel}`,
        };
      }
      // 其他错误：软链/特殊文件等非法路径
      return {
        ok: false,
        error: `Invalid path: must stay within ${params.scopeLabel} and be a regular non-symlink file`,
      };
    } finally {
      // 关闭文件句柄，避免资源泄漏
      await opened?.handle.close().catch(() => {});
    }
  }
  return { ok: true, paths: resolvedPaths };
}
