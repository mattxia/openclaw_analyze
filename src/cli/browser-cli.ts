/**
 * browser-cli.ts - OpenClaw浏览器CLI命令注册模块
 * 
 * 功能：注册`openclaw browser`系列命令，提供浏览器管理、操作、调试等完整的命令行能力
 * 基于commander.js命令行框架开发，采用模块化设计拆分不同功能的子命令
 */

// 导入commander类型定义，用于命令注册
import type { Command } from "commander";
// 导入终端危险样式标记
import { danger } from "../globals.js";
// 导入运行时实例，用于输出和进程退出
import { defaultRuntime } from "../runtime.js";
// 导入文档链接格式化工具
import { formatDocsLink } from "../terminal/links.js";
// 导入终端主题样式
import { theme } from "../terminal/theme.js";
// 导入输入类动作命令注册器（点击、输入、选择等）
import { registerBrowserActionInputCommands } from "./browser-cli-actions-input.js";
// 导入观察类动作命令注册器（快照、截图、等待等）
import { registerBrowserActionObserveCommands } from "./browser-cli-actions-observe.js";
// 导入调试类命令注册器（日志、请求查看等）
import { registerBrowserDebugCommands } from "./browser-cli-debug.js";
// 导入命令示例配置（核心示例和动作示例）
import { browserActionExamples, browserCoreExamples } from "./browser-cli-examples.js";
// 导入扩展相关命令注册器（扩展安装、路径查看等）
import { registerBrowserExtensionCommands } from "./browser-cli-extension.js";
// 导入检查类命令注册器（元素检查、DOM查看等）
import { registerBrowserInspectCommands } from "./browser-cli-inspect.js";
// 导入管理类命令注册器（启动、停止、profile管理等）
import { registerBrowserManageCommands } from "./browser-cli-manage.js";
// 导入浏览器父命令选项类型定义
import type { BrowserParentOpts } from "./browser-cli-shared.js";
// 导入状态类命令注册器（cookies、storage、设备设置等）
import { registerBrowserStateCommands } from "./browser-cli-state.js";
// 导入CLI命令格式化工具
import { formatCliCommand } from "./command-format.js";
// 导入网关客户端选项添加工具（用于连接远程网关）
import { addGatewayClientOptions } from "./gateway-rpc.js";
// 导入帮助示例格式化工具
import { formatHelpExamples } from "./help-format.js";

/**
 * 注册browser系列CLI命令的入口函数
 * @param program - commander根程序实例
 */
export function registerBrowserCli(program: Command) {
  // 创建browser主命令
  const browser = program
    .command("browser")
    // 命令描述
    .description("Manage OpenClaw's dedicated browser (Chrome/Chromium)")
    // 全局选项：指定浏览器配置文件
    .option("--browser-profile <name>", "Browser profile name (default from config)")
    // 全局选项：是否输出JSON格式结果
    .option("--json", "Output machine-readable JSON", false)
    // 帮助文本后缀：添加示例和文档链接
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples(
          // 合并核心示例和动作示例
          [...browserCoreExamples, ...browserActionExamples].map((cmd) => [cmd, ""]),
          true,
        )}\n\n${theme.muted("Docs:")} ${formatDocsLink(
          "/cli/browser",
          "docs.openclaw.ai/cli/browser",
        )}\n`,
    )
    // 默认动作：不带子命令时显示帮助并提示错误
    .action(() => {
      // 输出帮助信息
      browser.outputHelp();
      // 输出错误提示，建议使用status命令
      defaultRuntime.error(
        danger(`Missing subcommand. Try: "${formatCliCommand("openclaw browser status")}"`),
      );
      // 异常退出
      defaultRuntime.exit(1);
    });

  // 添加网关客户端通用选项（--url, --token等，用于连接远程Gateway）
  addGatewayClientOptions(browser);

  /**
   * 获取父命令选项的工具函数，供子命令继承全局参数
   * @param cmd - 子命令实例
   * @returns 父命令（browser主命令）的选项集合
   */
  const parentOpts = (cmd: Command) => cmd.parent?.opts?.() as BrowserParentOpts;

  // 注册各类子命令，按功能模块划分
  registerBrowserManageCommands(browser, parentOpts);       // 管理类命令：start/stop/profiles等
  registerBrowserExtensionCommands(browser, parentOpts);    // 扩展类命令：extension install/path等
  registerBrowserInspectCommands(browser, parentOpts);      // 检查类命令：snapshot/screenshot等
  registerBrowserActionInputCommands(browser, parentOpts);  // 输入类动作命令：click/type/navigate等
  registerBrowserActionObserveCommands(browser, parentOpts);// 观察类动作命令：wait/find等
  registerBrowserDebugCommands(browser, parentOpts);        // 调试类命令：logs/requests等
  registerBrowserStateCommands(browser, parentOpts);        // 状态类命令：cookies/storage/set等
}
