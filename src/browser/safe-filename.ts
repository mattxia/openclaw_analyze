/**
 * safe-filename.ts - 安全文件名清理工具
 * 
 * 核心功能：清理不可信的文件名，防止路径遍历攻击和非法字符导致的文件系统问题
 * 应用场景：处理浏览器下载的文件名、用户上传的文件名等外部输入的文件名
 * 安全特性：
 * 1. 跨平台处理：同时移除Linux和Windows的路径信息
 * 2. 过滤控制字符：移除不可见的控制字符
 * 3. 路径遍历防护：确保只返回文件名，不包含任何路径信息
 * 4. 长度限制：防止文件名过长导致的文件系统问题
 */

import path from "node:path";

/**
 * 清理不可信的文件名，生成安全的文件名
 * 多级安全处理流程：
 * 1. 空值处理：输入为空时返回默认文件名
 * 2. 路径提取：同时提取POSIX和Windows路径中的纯文件名，移除所有路径信息
 * 3. 字符过滤：移除控制字符和不可见字符
 * 4. 特殊值处理：过滤掉.和..等特殊路径
 * 5. 长度限制：截断过长的文件名（最大200字符）
 * 
 * @param fileName - 原始不可信文件名
 * @param fallbackName - 清理失败时使用的默认文件名
 * @returns 安全的文件名，不包含任何路径信息
 */
export function sanitizeUntrustedFileName(fileName: string, fallbackName: string): string {
  // 处理空输入
  const trimmed = String(fileName ?? "").trim();
  if (!trimmed) {
    return fallbackName;
  }

  // 跨平台提取纯文件名：先处理POSIX路径，再处理Windows路径
  // 确保无论输入是哪种系统的路径，都只保留最后一部分文件名
  let base = path.posix.basename(trimmed);
  base = path.win32.basename(base);

  // 过滤控制字符：移除ASCII控制字符（0x00-0x1F）和DEL字符（0x7F）
  let cleaned = "";
  for (let i = 0; i < base.length; i++) {
    const code = base.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    cleaned += base[i];
  }
  base = cleaned.trim();

  // 处理特殊路径值：空、.、..都使用默认文件名，防止路径遍历
  if (!base || base === "." || base === "..") {
    return fallbackName;
  }

  // 文件名长度限制，防止过长文件名导致文件系统错误
  if (base.length > 200) {
    base = base.slice(0, 200);
  }

  return base;
}
