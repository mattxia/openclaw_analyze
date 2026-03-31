/**
 * proxy-files.ts - 远程浏览器代理文件处理工具
 * 
 * 核心功能：处理远程节点浏览器操作返回的文件，将base64编码的文件内容持久化到本地
 * 并替换结果中的远程路径为本地路径，实现远程文件的本地化透明访问
 * 主要应用场景：远程节点执行截图、下载等操作后，文件需要传回本地使用
 */

// 导入媒体文件存储工具
import { saveMediaBuffer } from "../media/store.js";

/**
 * 浏览器代理返回的文件结构类型
 * 远程节点执行操作后，将文件内容base64编码后返回
 */
export type BrowserProxyFile = {
  path: string;        // 远程节点上的文件路径
  base64: string;      // 文件内容的base64编码
  mimeType?: string;   // 文件MIME类型
};

/**
 * 持久化浏览器代理返回的文件到本地存储
 * 将远程节点返回的base64文件内容保存到本地媒体目录，返回路径映射表
 * 
 * @param files - 远程返回的文件列表
 * @returns 路径映射表：远程路径 -> 本地绝对路径
 */
export async function persistBrowserProxyFiles(files: BrowserProxyFile[] | undefined) {
  // 无文件时返回空映射
  if (!files || files.length === 0) {
    return new Map<string, string>();
  }

  const mapping = new Map<string, string>();
  for (const file of files) {
    // 解码base64内容为Buffer
    const buffer = Buffer.from(file.base64, "base64");
    // 保存到本地媒体存储，自动生成安全的文件名和路径
    const saved = await saveMediaBuffer(buffer, file.mimeType, "browser");
    // 记录远程路径到本地路径的映射
    mapping.set(file.path, saved.path);
  }
  return mapping;
}

/**
 * 将结果对象中的远程文件路径替换为本地路径
 * 遍历结果对象，将已知的文件路径字段（path/imagePath/download.path）替换为本地路径
 * 注意：此方法会修改传入的result对象
 * 
 * @param result - 远程返回的结果对象，可能包含文件路径字段
 * @param mapping - 路径映射表，由persistBrowserProxyFiles生成
 */
export function applyBrowserProxyPaths(result: unknown, mapping: Map<string, string>) {
  // 非对象类型直接返回
  if (!result || typeof result !== "object") {
    return;
  }

  const obj = result as Record<string, unknown>;

  // 替换通用path字段
  if (typeof obj.path === "string" && mapping.has(obj.path)) {
    obj.path = mapping.get(obj.path);
  }

  // 替换截图类的imagePath字段
  if (typeof obj.imagePath === "string" && mapping.has(obj.imagePath)) {
    obj.imagePath = mapping.get(obj.imagePath);
  }

  // 替换下载结果中的path字段
  const download = obj.download;
  if (download && typeof download === "object") {
    const d = download as Record<string, unknown>;
    if (typeof d.path === "string" && mapping.has(d.path)) {
      d.path = mapping.get(d.path);
    }
  }
}
