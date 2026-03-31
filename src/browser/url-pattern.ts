/**
 * url-pattern.ts - URL模式匹配工具
 * 
 * 核心功能：提供灵活的URL匹配能力，支持精确匹配、通配符匹配和包含匹配
 * 主要应用场景：
 * 1. URL白名单/黑名单校验
 * 2. 浏览器等待条件（等待某个URL加载完成）
 * 3. 导航拦截规则配置
 * 
 * 匹配规则优先级：精确匹配 > 通配符匹配 > 包含匹配
 */

/**
 * 匹配URL是否符合指定模式
 * 支持三种匹配模式：
 * 1. 精确匹配：模式与URL完全相等
 * 2. 通配符匹配：模式包含*通配符，*可以匹配任意字符（包含/）
 * 3. 包含匹配：模式不包含通配符时，检查URL是否包含该模式字符串
 * 
 * @param pattern - 匹配模式，支持*通配符
 * @param url - 要匹配的URL
 * @returns 是否匹配成功
 */
export function matchBrowserUrlPattern(pattern: string, url: string): boolean {
  // 清理模式字符串两边的空白字符
  const trimmedPattern = pattern.trim();
  // 空模式不匹配任何URL
  if (!trimmedPattern) {
    return false;
  }

  // 第一优先级：精确匹配，性能最高
  if (trimmedPattern === url) {
    return true;
  }

  // 第二优先级：通配符匹配，模式中包含*时使用正则匹配
  if (trimmedPattern.includes("*")) {
    // 转义正则特殊字符，防止注入，除了*之外的所有正则元字符都转义
    const escaped = trimmedPattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    // 将通配符*替换为正则的.*（匹配任意字符），**和*都统一处理为.*
    const regex = new RegExp(`^${escaped.replace(/\*\*/g, ".*").replace(/\*/g, ".*")}$`);
    return regex.test(url);
  }

  // 第三优先级：包含匹配，模式作为子字符串出现在URL中即匹配
  return url.includes(trimmedPattern);
}
