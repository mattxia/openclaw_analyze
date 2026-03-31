/**
 * 浏览器服务上下文模块
 * 提供浏览器操作的上下文封装、多配置文件管理、操作权限隔离等核心功能
 * 是连接HTTP路由层和底层浏览器操作的核心中间层
 */
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { isChromeReachable, resolveOpenClawUserDataDir } from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { resolveProfile } from "./config.js";
import { BrowserProfileNotFoundError, toBrowserErrorResponse } from "./errors.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import {
  refreshResolvedBrowserConfigFromDisk,
  resolveBrowserProfileWithHotReload,
} from "./resolved-config-refresh.js";
import { createProfileAvailability } from "./server-context.availability.js";
import { createProfileResetOps } from "./server-context.reset.js";
import { createProfileSelectionOps } from "./server-context.selection.js";
import { createProfileTabOps } from "./server-context.tab-ops.js";
import type {
  BrowserServerState,
  BrowserRouteContext,
  BrowserTab,
  ContextOptions,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
} from "./server-context.types.js";

// 导出所有上下文相关类型
export type {
  BrowserRouteContext,
  BrowserServerState,
  BrowserTab,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
} from "./server-context.types.js";

/**
 * 获取所有已知的配置文件名称列表
 * 合并配置文件中预定义的和运行时动态创建的配置文件
 * @param state - 浏览器服务全局状态
 * @returns 去重后的配置文件名称数组
 */
export function listKnownProfileNames(state: BrowserServerState): string[] {
  // 从已解析的配置中获取预定义的配置文件
  const names = new Set(Object.keys(state.resolved.profiles));
  // 添加运行时创建的配置文件
  for (const name of state.profiles.keys()) {
    names.add(name);
  }
  return [...names];
}

/**
 * 创建配置文件作用域的操作上下文
 * 封装单个配置文件的所有浏览器操作，实现不同配置文件之间的隔离
 * @param opts - 上下文选项
 * @param profile - 浏览器配置文件
 * @returns 配置文件级别的操作上下文
 */
function createProfileContext(
  opts: ContextOptions,
  profile: ResolvedBrowserProfile,
): ProfileContext {
  /**
   * 获取当前服务全局状态，确保服务已启动
   */
  const state = () => {
    const current = opts.getState();
    if (!current) {
      throw new Error("Browser server not started");
    }
    return current;
  };

  /**
   * 获取配置文件的运行时状态，不存在则自动创建
   */
  const getProfileState = (): ProfileRuntimeState => {
    const current = state();
    let profileState = current.profiles.get(profile.name);
    // 如果不存在运行时状态则初始化一个新的
    if (!profileState) {
      profileState = { profile, running: null, lastTargetId: null, reconcile: null };
      current.profiles.set(profile.name, profileState);
    }
    return profileState;
  };

  /**
   * 更新配置文件的运行状态
   * @param running - 浏览器运行状态实例
   */
  const setProfileRunning = (running: ProfileRuntimeState["running"]) => {
    const profileState = getProfileState();
    profileState.running = running;
  };

  // 创建标签页操作模块：获取标签列表、打开新标签
  const { listTabs, openTab } = createProfileTabOps({
    profile,
    state,
    getProfileState,
  });

  // 创建可用性检查模块：浏览器可用性保证、连通性检查、停止浏览器
  const { ensureBrowserAvailable, isHttpReachable, isReachable, stopRunningBrowser } =
    createProfileAvailability({
      opts,
      profile,
      state,
      getProfileState,
      setProfileRunning,
    });

  // 创建标签选择操作模块：标签可用性保证、聚焦标签、关闭标签
  const { ensureTabAvailable, focusTab, closeTab } = createProfileSelectionOps({
    profile,
    getProfileState,
    ensureBrowserAvailable,
    listTabs,
    openTab,
  });

  // 创建配置文件重置模块：重置配置文件功能
  const { resetProfile } = createProfileResetOps({
    profile,
    getProfileState,
    stopRunningBrowser,
    isHttpReachable,
    resolveOpenClawUserDataDir,
  });

  // 导出配置文件上下文的所有操作接口
  return {
    profile, // 配置文件信息
    ensureBrowserAvailable, // 确保浏览器可用，未启动则自动启动
    ensureTabAvailable, // 确保标签页可用，不存在则自动创建
    isHttpReachable, // 检查HTTP服务是否可达
    isReachable, // 检查浏览器服务是否可达
    listTabs, // 获取标签页列表
    openTab, // 打开新标签页
    focusTab, // 聚焦到指定标签页
    closeTab, // 关闭指定标签页
    stopRunningBrowser, // 停止运行中的浏览器
    resetProfile, // 重置浏览器配置文件
  };
}

/**
 * 创建浏览器路由上下文
 * 提供路由层使用的全局操作接口，处理配置文件路由、配置刷新、错误映射等功能
 * @param opts - 上下文选项
 * @returns 路由级别的操作上下文
 */
export function createBrowserRouteContext(opts: ContextOptions): BrowserRouteContext {
  // 是否启用配置文件热重载（从磁盘刷新配置）
  const refreshConfigFromDisk = opts.refreshConfigFromDisk === true;

  /**
   * 获取当前服务全局状态，确保服务已启动
   */
  const state = () => {
    const current = opts.getState();
    if (!current) {
      throw new Error("Browser server not started");
    }
    return current;
  };

  /**
   * 获取指定配置文件的操作上下文
   * @param profileName - 配置文件名称，不传则使用默认配置
   * @returns 对应配置文件的操作上下文
   */
  const forProfile = (profileName?: string): ProfileContext => {
    const current = state();
    // 未指定配置文件时使用默认配置
    const name = profileName ?? current.resolved.defaultProfile;
    // 解析配置文件，支持热重载
    const profile = resolveBrowserProfileWithHotReload({
      current,
      refreshConfigFromDisk,
      name,
    });

    // 配置文件不存在时抛出明确的错误信息
    if (!profile) {
      const available = Object.keys(current.resolved.profiles).join(", ");
      throw new BrowserProfileNotFoundError(
        `Profile "${name}" not found. Available profiles: ${available || "(none)"}`,
      );
    }
    return createProfileContext(opts, profile);
  };

  /**
   * 获取所有配置文件的状态列表
   * 自动检测每个配置文件的运行状态、标签页数量等信息
   * @returns 配置文件状态数组
   */
  const listProfiles = async (): Promise<ProfileStatus[]> => {
    const current = state();
    // 刷新磁盘上的配置到内存，使用缓存模式提高性能
    refreshResolvedBrowserConfigFromDisk({
      current,
      refreshConfigFromDisk,
      mode: "cached",
    });
    const result: ProfileStatus[] = [];

    // 遍历所有已知的配置文件
    for (const name of listKnownProfileNames(current)) {
      const profileState = current.profiles.get(name);
      // 优先从已解析配置中获取，否则使用运行时配置
      const profile = resolveProfile(current.resolved, name) ?? profileState?.profile;
      if (!profile) {
        continue;
      }
      // 获取配置文件的能力特性
      const capabilities = getBrowserProfileCapabilities(profile);

      let tabCount = 0;
      let running = false;
      // 创建配置文件上下文用于状态检测
      const profileCtx = createProfileContext(opts, profile);

      // Chrome MCP 传输协议的状态检测
      if (capabilities.usesChromeMcp) {
        try {
          running = await profileCtx.isReachable(300);
          if (running) {
            const tabs = await profileCtx.listTabs();
            tabCount = tabs.filter((t) => t.type === "page").length;
          }
        } catch {
          // Chrome MCP 服务不可用，忽略错误
        }
      }
      // 已有运行时状态的 CDP 浏览器检测
      else if (profileState?.running) {
        running = true;
        try {
          const tabs = await profileCtx.listTabs();
          tabCount = tabs.filter((t) => t.type === "page").length;
        } catch {
          // 浏览器可能无响应，忽略错误
        }
      }
      // 未知状态的 CDP 浏览器端口检测
      else {
        try {
          // 检查端口是否有服务监听
          const reachable = await isChromeReachable(profile.cdpUrl, 200);
          if (reachable) {
            running = true;
            const tabs = await profileCtx.listTabs().catch(() => []);
            tabCount = tabs.filter((t) => t.type === "page").length;
          }
        } catch {
          // 端口不可达，忽略错误
        }
      }

      // 组装配置文件状态信息
      result.push({
        name, // 配置文件名称
        transport: capabilities.usesChromeMcp ? "chrome-mcp" : "cdp", // 传输协议
        cdpPort: capabilities.usesChromeMcp ? null : profile.cdpPort, // CDP端口
        cdpUrl: capabilities.usesChromeMcp ? null : profile.cdpUrl, // CDP地址
        color: profile.color, // 标识颜色
        driver: profile.driver, // 驱动类型
        running, // 是否正在运行
        tabCount, // 打开的页面标签数量
        isDefault: name === current.resolved.defaultProfile, // 是否为默认配置
        isRemote: !profile.cdpIsLoopback, // 是否为远程浏览器
        missingFromConfig: !(name in current.resolved.profiles) || undefined, // 是否在配置文件中缺失
        reconcileReason: profileState?.reconcile?.reason ?? null, // 配置同步原因
      });
    }

    return result;
  };

  // 创建默认配置文件上下文，用于向后兼容旧版API
  const getDefaultContext = () => forProfile();

  /**
   * 统一错误映射函数，将内部错误转换为标准HTTP响应格式
   * @param err - 捕获到的错误对象
   * @returns 标准错误响应格式，无法映射则返回null
   */
  const mapTabError = (err: unknown) => {
    // 先尝试浏览器相关错误转换
    const browserMapped = toBrowserErrorResponse(err);
    if (browserMapped) {
      return browserMapped;
    }
    // SSRF防护错误
    if (err instanceof SsrFBlockedError) {
      return { status: 400, message: err.message };
    }
    // 导航URL无效错误
    if (err instanceof InvalidBrowserNavigationUrlError) {
      return { status: 400, message: err.message };
    }
    // 其他错误不处理，由上层统一处理
    return null;
  };

  // 导出路由上下文的所有操作接口
  return {
    state, // 获取全局状态
    forProfile, // 获取指定配置文件的上下文
    listProfiles, // 获取所有配置文件状态列表
    // 兼容旧版API的方法，全部委托到默认配置文件
    ensureBrowserAvailable: () => getDefaultContext().ensureBrowserAvailable(),
    ensureTabAvailable: (targetId) => getDefaultContext().ensureTabAvailable(targetId),
    isHttpReachable: (timeoutMs) => getDefaultContext().isHttpReachable(timeoutMs),
    isReachable: (timeoutMs) => getDefaultContext().isReachable(timeoutMs),
    listTabs: () => getDefaultContext().listTabs(),
    openTab: (url) => getDefaultContext().openTab(url),
    focusTab: (targetId) => getDefaultContext().focusTab(targetId),
    closeTab: (targetId) => getDefaultContext().closeTab(targetId),
    stopRunningBrowser: () => getDefaultContext().stopRunningBrowser(),
    resetProfile: () => getDefaultContext().resetProfile(),
    mapTabError, // 错误映射函数
  };
}
