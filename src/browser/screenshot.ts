/**
 * screenshot.ts - 浏览器截图标准化处理工具
 * 
 * 核心功能：将浏览器原始截图进行智能压缩和尺寸调整，确保输出符合大小限制
 * 主要应用场景：
 * 1. LLM调用截图工具时，确保返回的图片大小适合大模型上下文窗口限制
 * 2. 截图存储和传输时控制带宽和存储成本
 * 3. 统一不同浏览器、不同设备的截图输出格式
 * 
 * 压缩策略：优先保持清晰度，逐步降低尺寸和质量，直到符合大小限制
 */

// 导入图片处理工具函数
import {
  buildImageResizeSideGrid,   // 生成尺寸调整阶梯网格
  getImageMetadata,           // 获取图片元数据（宽高等信息）
  IMAGE_REDUCE_QUALITY_STEPS, // 图片质量调整阶梯（从高到低的质量值数组）
  resizeToJpeg,               // 将图片调整大小并编码为JPEG格式
} from "../media/image-ops.js";

/**
 * 浏览器截图默认最大边长（像素）
 * 超过此尺寸的截图会被等比例缩小，避免过大的图片输入到LLM
 */
export const DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE = 2000;
/**
 * 浏览器截图默认最大文件大小（字节）
 * 默认5MB，符合绝大多数大模型的图片输入大小限制
 */
export const DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 标准化浏览器截图，自动调整尺寸和质量以符合大小限制
 * 处理流程：
 * 1. 先检查原始截图是否已经符合要求，符合则直接返回
 * 2. 生成尺寸调整阶梯（从大到小）
 * 3. 对每个尺寸，按质量从高到低尝试压缩
 * 4. 找到第一个符合大小限制的结果立即返回
 * 5. 所有尝试都失败时，返回最小的结果并抛出错误
 * 
 * @param buffer - 原始截图Buffer（支持PNG/JPEG等常见图片格式）
 * @param opts - 配置选项
 * @param opts.maxSide - 最大边长（像素），默认2000px
 * @param opts.maxBytes - 最大文件大小（字节），默认5MB
 * @returns 标准化后的截图Buffer和内容类型
 * @throws 无法压缩到指定大小限制时抛出错误
 */
export async function normalizeBrowserScreenshot(
  buffer: Buffer,
  opts?: {
    maxSide?: number;
    maxBytes?: number;
  },
): Promise<{ buffer: Buffer; contentType?: "image/jpeg" }> {
  // 处理配置参数，确保有效值
  const maxSide = Math.max(1, Math.round(opts?.maxSide ?? DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE));
  const maxBytes = Math.max(1, Math.round(opts?.maxBytes ?? DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES));

  // 获取图片元数据（宽、高、格式等）
  const meta = await getImageMetadata(buffer);
  const width = Number(meta?.width ?? 0);
  const height = Number(meta?.height ?? 0);
  const maxDim = Math.max(width, height);

  // 快速路径：原始图片已经符合大小和尺寸要求，直接返回
  if (buffer.byteLength <= maxBytes && (maxDim === 0 || (width <= maxSide && height <= maxSide))) {
    return { buffer };
  }

  // 生成尺寸调整阶梯：从原始尺寸开始逐步缩小，直到maxSide
  const sideStart = maxDim > 0 ? Math.min(maxSide, maxDim) : maxSide;
  const sideGrid = buildImageResizeSideGrid(maxSide, sideStart);

  // 记录最小的压缩结果，用于最终失败时返回
  let smallest: { buffer: Buffer; size: number } | null = null;

  // 外层循环：从大到小尝试不同尺寸
  for (const side of sideGrid) {
    // 内层循环：从高到低尝试不同质量
    for (const quality of IMAGE_REDUCE_QUALITY_STEPS) {
      // 调整图片大小并编码为JPEG
      const out = await resizeToJpeg({
        buffer,
        maxSide: side,
        quality,
        withoutEnlargement: true, // 禁止放大图片，保持原始清晰度
      });

      // 更新最小结果记录
      if (!smallest || out.byteLength < smallest.size) {
        smallest = { buffer: out, size: out.byteLength };
      }

      // 找到符合大小限制的结果，立即返回
      if (out.byteLength <= maxBytes) {
        return { buffer: out, contentType: "image/jpeg" };
      }
    }
  }

  // 所有尝试都无法压缩到指定大小，抛出错误并告知实际最小大小
  const best = smallest?.buffer ?? buffer;
  throw new Error(
    `Browser screenshot could not be reduced below ${(maxBytes / (1024 * 1024)).toFixed(0)}MB (got ${(best.byteLength / (1024 * 1024)).toFixed(2)}MB)`,
  );
}
