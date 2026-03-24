// Vitest 测试框架导入
import { describe, expect, it, vi } from "vitest";
// 导入 OpenClaw 配置类型
import type { OpenClawConfig } from "../../../config/config.js";
// 导入 Ollama 基础 URL 解析函数
import { resolveOllamaBaseUrlForRun } from "../../ollama-stream.js";
// 导入 attempt.ts 中待测试的函数
import {
  buildAfterTurnRuntimeContext, // 构建 afterTurn 运行时上下文
  composeSystemPromptWithHookContext, // 组合带 Hook 上下文的系统提示
  isOllamaCompatProvider, // 判断是否为 Ollama 兼容提供者
  prependSystemPromptAddition, // 在系统提示前添加内容
  resolveAttemptFsWorkspaceOnly, // 解析尝试的文件系统工作区限制
  resolveOllamaCompatNumCtxEnabled, // 解析 Ollama 兼容 num_ctx 是否启用
  resolvePromptBuildHookResult, // 解析 prompt 构建 Hook 结果
  resolvePromptModeForSession, // 解析会话的 prompt 模式
  shouldInjectOllamaCompatNumCtx, // 判断是否应该注入 Ollama 兼容 num_ctx
  decodeHtmlEntitiesInObject, // 解码对象中的 HTML 实体
  wrapOllamaCompatNumCtx, // 包装 Ollama 兼容 num_ctx 流函数
  wrapStreamFnRepairMalformedToolCallArguments, // 包装修复格式错误工具调用参数的流函数
  wrapStreamFnTrimToolCallNames, // 包装修剪工具调用名称的流函数
} from "./attempt.js";

/**
 * 创建 Ollama 提供者配置
 * @param injectNumCtxForOpenAICompat 是否注入 num_ctx 参数
 * @returns OpenClaw 配置对象
 */
function createOllamaProviderConfig(injectNumCtxForOpenAICompat: boolean): OpenClawConfig {
  return {
    models: {
      providers: {
        ollama: {
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          injectNumCtxForOpenAICompat,
          models: [],
        },
      },
    },
  };
}

// ============================================================================
// resolvePromptBuildHookResult 测试
// 测试 prompt 构建 Hook 结果的解析逻辑
// ============================================================================
describe("resolvePromptBuildHookResult", () => {
  /**
   * 创建仅支持旧版 Hook 的 Hook 运行器
   * 模拟只支持 before_agent_start Hook 的情况
   */
  function createLegacyOnlyHookRunner() {
    return {
      hasHooks: vi.fn(
        (hookName: "before_prompt_build" | "before_agent_start") =>
          hookName === "before_agent_start",
      ),
      runBeforePromptBuild: vi.fn(async () => undefined),
      runBeforeAgentStart: vi.fn(async () => ({ prependContext: "from-hook" })),
    };
  }

  /**
   * 测试：当存在预计算的 legacy before_agent_start 结果时，不再次调用 Hook
   * 验证缓存机制正常工作，避免重复执行 Hook
   */
  it("reuses precomputed legacy before_agent_start result without invoking hook again", async () => {
    const hookRunner = createLegacyOnlyHookRunner();
    const result = await resolvePromptBuildHookResult({
      prompt: "hello",
      messages: [],
      hookCtx: {},
      hookRunner,
      legacyBeforeAgentStartResult: { prependContext: "from-cache", systemPrompt: "legacy-system" },
    });

    // 验证没有再次调用 Hook
    expect(hookRunner.runBeforeAgentStart).not.toHaveBeenCalled();
    // 验证返回结果正确使用了缓存值
    expect(result).toEqual({
      prependContext: "from-cache",
      systemPrompt: "legacy-system",
      prependSystemContext: undefined,
      appendSystemContext: undefined,
    });
  });

  /**
   * 测试：当没有预计算结果时，调用 legacy Hook
   * 验证 Hook 在没有缓存时正常执行
   */
  it("calls legacy hook when precomputed result is absent", async () => {
    const hookRunner = createLegacyOnlyHookRunner();
    const messages = [{ role: "user", content: "ctx" }];
    const result = await resolvePromptBuildHookResult({
      prompt: "hello",
      messages,
      hookCtx: {},
      hookRunner,
    });

    // 验证 Hook 被调用了一次
    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledTimes(1);
    // 验证调用参数正确
    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledWith({ prompt: "hello", messages }, {});
    // 验证返回结果包含 Hook 注入的上下文
    expect(result.prependContext).toBe("from-hook");
  });

  /**
   * 测试：以确定性顺序合并 prompt-build 和 legacy 上下文字段
   * 验证当两种 Hook 都存在时，结果按正确顺序合并
   */
  it("merges prompt-build and legacy context fields in deterministic order", async () => {
    const hookRunner = {
      hasHooks: vi.fn(() => true),
      runBeforePromptBuild: vi.fn(async () => ({
        prependContext: "prompt context",
        prependSystemContext: "prompt prepend",
        appendSystemContext: "prompt append",
      })),
      runBeforeAgentStart: vi.fn(async () => ({
        prependContext: "legacy context",
        prependSystemContext: "legacy prepend",
        appendSystemContext: "legacy append",
      })),
    };

    const result = await resolvePromptBuildHookResult({
      prompt: "hello",
      messages: [],
      hookCtx: {},
      hookRunner,
    });

    // 验证上下文按 prompt 优先、legacy 在后的顺序合并
    expect(result.prependContext).toBe("prompt context\n\nlegacy context");
    expect(result.prependSystemContext).toBe("prompt prepend\n\nlegacy prepend");
    expect(result.appendSystemContext).toBe("prompt append\n\nlegacy append");
  });
});

// ============================================================================
// composeSystemPromptWithHookContext 测试
// 测试系统提示与 Hook 上下文的组合逻辑
// ============================================================================
describe("composeSystemPromptWithHookContext", () => {
  /**
   * 测试：当没有 Hook 系统上下文时返回 undefined
   */
  it("returns undefined when no hook system context is provided", () => {
    expect(composeSystemPromptWithHookContext({ baseSystemPrompt: "base" })).toBeUndefined();
  });

  /**
   * 测试：构建 prepend/base/append 系统提示顺序
   * 验证三段式系统提示的正确拼接
   */
  it("builds prepend/base/append system prompt order", () => {
    expect(
      composeSystemPromptWithHookContext({
        baseSystemPrompt: "  base system  ",
        prependSystemContext: "  prepend  ",
        appendSystemContext: "  append  ",
      }),
    ).toBe("prepend\n\nbase system\n\nappend");
  });

  /**
   * 测试：当基础系统提示为空时避免空白分隔符
   * 验证空基础提示时的正确处理
   */
  it("avoids blank separators when base system prompt is empty", () => {
    expect(
      composeSystemPromptWithHookContext({
        baseSystemPrompt: "   ",
        appendSystemContext: "  append only  ",
      }),
    ).toBe("append only");
  });
});

// ============================================================================
// resolvePromptModeForSession 测试
// 测试会话 prompt 模式的解析逻辑
// ============================================================================
describe("resolvePromptModeForSession", () => {
  /**
   * 测试：子代理会话使用 minimal 模式
   * 验证子代理会话的提示模式正确
   */
  it("uses minimal mode for subagent sessions", () => {
    expect(resolvePromptModeForSession("agent:main:subagent:child")).toBe("minimal");
  });

  /**
   * 测试：定时任务会话使用 minimal 模式
   * 验证 cron 会话的提示模式正确
   */
  it("uses minimal mode for cron sessions", () => {
    expect(resolvePromptModeForSession("agent:main:cron:job-1")).toBe("minimal");
    expect(resolvePromptModeForSession("agent:main:cron:job-1:run:run-abc")).toBe("minimal");
  });

  /**
   * 测试：常规和未定义会话使用 full 模式
   * 验证普通会话使用完整提示模式
   */
  it("uses full mode for regular and undefined sessions", () => {
    expect(resolvePromptModeForSession(undefined)).toBe("full");
    expect(resolvePromptModeForSession("agent:main")).toBe("full");
    expect(resolvePromptModeForSession("agent:main:thread:abc")).toBe("full");
  });
});

// ============================================================================
// resolveAttemptFsWorkspaceOnly 测试
// 测试文件系统工作区限制的解析逻辑
// ============================================================================
describe("resolveAttemptFsWorkspaceOnly", () => {
  /**
   * 测试：当 agent 没有覆盖时使用全局 tools.fs.workspaceOnly 配置
   * 验证全局配置的 fallback 行为
   */
  it("uses global tools.fs.workspaceOnly when agent has no override", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: { workspaceOnly: true },
      },
    };

    expect(
      resolveAttemptFsWorkspaceOnly({
        config: cfg,
        sessionAgentId: "main",
      }),
    ).toBe(true);
  });

  /**
   * 测试：优先使用 agent 特定的 tools.fs.workspaceOnly 覆盖
   * 验证 agent 级别配置的优先级
   */
  it("prefers agent-specific tools.fs.workspaceOnly override", () => {
    const cfg: OpenClawConfig = {
      tools: {
        fs: { workspaceOnly: true },
      },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: false },
            },
          },
        ],
      },
    };

    expect(
      resolveAttemptFsWorkspaceOnly({
        config: cfg,
        sessionAgentId: "main",
      }),
    ).toBe(false);
  });
});

// ============================================================================
// wrapStreamFnTrimToolCallNames 测试
// 测试工具调用名称修剪流函数包装器
// ============================================================================
describe("wrapStreamFnTrimToolCallNames", () => {
  /**
   * 创建假流用于测试
   * @param params 流参数（事件列表和结果消息）
   * @returns 模拟的流对象
   */
  function createFakeStream(params: { events: unknown[]; resultMessage: unknown }): {
    result: () => Promise<unknown>;
    [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
  } {
    return {
      async result() {
        return params.resultMessage;
      },
      [Symbol.asyncIterator]() {
        return (async function* () {
          for (const event of params.events) {
            yield event;
          }
        })();
      },
    };
  }

  /**
   * 调用包装后的流函数
   * @param baseFn 基础流函数
   * @param allowedToolNames 允许的工具名称集合
   * @returns 包装后的流
   */
  async function invokeWrappedStream(
    baseFn: (...args: never[]) => unknown,
    allowedToolNames?: Set<string>,
  ) {
    const wrappedFn = wrapStreamFnTrimToolCallNames(baseFn as never, allowedToolNames);
    return await wrappedFn({} as never, {} as never, {} as never);
  }

  /**
   * 创建事件流用于测试
   * @param params 事件参数
   * @returns 基础函数和最终消息
   */
  function createEventStream(params: {
    event: unknown;
    finalToolCall: { type: string; name: string };
  }) {
    const finalMessage = { role: "assistant", content: [params.finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({ events: [params.event], resultMessage: finalMessage }),
    );
    return { baseFn, finalMessage };
  }

  /**
   * 测试：修剪实时流式工具调用名称和最终结果消息中的空白
   * 验证流式传输过程中工具名称的空白修剪
   */
  it("trims whitespace from live streamed tool call names and final result message", async () => {
    const partialToolCall = { type: "toolCall", name: " read " };
    const messageToolCall = { type: "toolCall", name: " exec " };
    const finalToolCall = { type: "toolCall", name: " write " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
      message: { role: "assistant", content: [messageToolCall] },
    };
    const { baseFn, finalMessage } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn);

    const seenEvents: unknown[] = [];
    for await (const item of stream) {
      seenEvents.push(item);
    }
    const result = await stream.result();

    // 验证看到了 1 个事件
    expect(seenEvents).toHaveLength(1);
    // 验证工具名称的空白被修剪
    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("exec");
    expect(finalToolCall.name).toBe("write");
    expect(result).toBe(finalMessage);
    expect(baseFn).toHaveBeenCalledTimes(1);
  });

  /**
   * 测试：支持返回 Promise 的异步流函数
   * 验证包装器正确处理异步流
   */
  it("supports async stream functions that return a promise", async () => {
    const finalToolCall = { type: "toolCall", name: " browser " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(async () =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    const result = await stream.result();

    expect(finalToolCall.name).toBe("browser");
    expect(result).toBe(finalMessage);
    expect(baseFn).toHaveBeenCalledTimes(1);
  });

  /**
   * 测试：当允许规范名称时规范化常见工具别名
   * 验证工具别名到规范名称的映射
   */
  it("normalizes common tool aliases when the canonical name is allowed", async () => {
    const finalToolCall = { type: "toolCall", name: " BASH " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec"]));
    const result = await stream.result();

    // 验证 BASH 被映射到 exec
    expect(finalToolCall.name).toBe("exec");
    expect(result).toBe(finalMessage);
  });

  /**
   * 测试：将提供者前缀的工具名称映射到允许的规范工具
   * 验证 functions.read 等前缀格式的规范化
   */
  it("maps provider-prefixed tool names to allowed canonical tools", async () => {
    const partialToolCall = { type: "toolCall", name: " functions.read " };
    const messageToolCall = { type: "toolCall", name: " functions.write " };
    const finalToolCall = { type: "toolCall", name: " tools/exec " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
      message: { role: "assistant", content: [messageToolCall] },
    };
    const { baseFn } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));

    for await (const _item of stream) {
      // drain
    }
    await stream.result();

    // 验证所有前缀格式都被正确规范化
    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("write");
    expect(finalToolCall.name).toBe("exec");
  });

  /**
   * 测试：在分发前规范化 toolUse 和 functionCall 名称
   * 验证不同工具调用类型的名称规范化
   */
  it("normalizes toolUse and functionCall names before dispatch", async () => {
    const partialToolCall = { type: "toolUse", name: " functions.read " };
    const messageToolCall = { type: "functionCall", name: " functions.exec " };
    const finalToolCall = { type: "toolUse", name: " tools/write " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
      message: { role: "assistant", content: [messageToolCall] },
    };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));

    for await (const _item of stream) {
      // drain
    }
    const result = await stream.result();

    // 验证不同类型的工具调用都被规范化
    expect(partialToolCall.name).toBe("read");
    expect(messageToolCall.name).toBe("exec");
    expect(finalToolCall.name).toBe("write");
    expect(result).toBe(finalMessage);
  });

  /**
   * 测试：删除提供者前缀时保留多段工具后缀
   * 验证 graph.search 等多段名称的正确处理
   */
  it("preserves multi-segment tool suffixes when dropping provider prefixes", async () => {
    const finalToolCall = { type: "toolCall", name: " functions.graph.search " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["graph.search", "search"]));
    const result = await stream.result();

    // 验证保留了完整的后缀 graph.search
    expect(finalToolCall.name).toBe("graph.search");
    expect(result).toBe(finalMessage);
  });

  /**
   * 测试：当允许列表存在时从格式错误的 toolCallId 变体推断工具名称
   * 验证从 functions.read:0 等格式 ID 推断工具名
   */
  it("infers tool names from malformed toolCallId variants when allowlist is present", async () => {
    const partialToolCall = { type: "toolCall", id: "functions.read:0", name: "" };
    const finalToolCallA = { type: "toolCall", id: "functionsread3", name: "" };
    const finalToolCallB: { type: string; id: string; name?: string } = {
      type: "toolCall",
      id: "functionswrite4",
    };
    const finalToolCallC = { type: "functionCall", id: "functions.exec2", name: "" };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const finalMessage = {
      role: "assistant",
      content: [finalToolCallA, finalToolCallB, finalToolCallC],
    };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write", "exec"]));
    for await (const _item of stream) {
      // drain
    }
    const result = await stream.result();

    // 验证从各种格式的 ID 正确推断工具名
    expect(partialToolCall.name).toBe("read");
    expect(finalToolCallA.name).toBe("read");
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallC.name).toBe("exec");
    expect(result).toBe(finalMessage);
  });

  /**
   * 测试：当允许列表不存在时不从格式错误的 toolCallId 推断名称
   * 验证没有允许列表时不进行推断
   */
  it("does not infer names from malformed toolCallId when allowlist is absent", async () => {
    const finalToolCall: { type: string; id: string; name?: string } = {
      type: "toolCall",
      id: "functionsread3",
    };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    // 验证没有设置名称
    expect(finalToolCall.name).toBeUndefined();
  });

  /**
   * 测试：在分发前推断格式错误的非空工具名称
   * 验证从格式错误的名称推断正确工具名
   */
  it("infers malformed non-blank tool names before dispatch", async () => {
    const partialToolCall = { type: "toolCall", id: "functions.read:0", name: "functionsread3" };
    const finalToolCall = { type: "toolCall", id: "functions.read:0", name: "functionsread3" };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    for await (const _item of stream) {
      // drain
    }
    await stream.result();

    // 验证格式错误的名称被正确推断
    expect(partialToolCall.name).toBe("read");
    expect(finalToolCall.name).toBe("read");
  });

  /**
   * 测试：当 ID 缺失时恢复格式错误的非空名称
   * 验证只有名称时的推断逻辑
   */
  it("recovers malformed non-blank names when id is missing", async () => {
    const finalToolCall = { type: "toolCall", name: "functionsread3" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  /**
   * 测试：当名称为空时从规范 ID 恢复规范工具名称
   * 验证从 ID 到名称的反向推断
   */
  it("recovers canonical tool names from canonical ids when name is empty", async () => {
    const finalToolCall = { type: "toolCall", id: "read", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  /**
   * 测试：当名称仅为空白时从 ID 恢复工具名称
   * 验证空白名称的处理
   */
  it("recovers tool names from ids when name is whitespace-only", async () => {
    const finalToolCall = { type: "toolCall", id: "functionswrite4", name: "   " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("write");
  });

  /**
   * 测试：当名称和 ID 都为空时保持空白并分配回退 ID
   * 验证完全空值的处理
   */
  it("keeps blank names blank and assigns fallback ids when both name and id are blank", async () => {
    const finalToolCall = { type: "toolCall", id: "", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("");
    expect(finalToolCall.id).toBe("call_auto_1");
  });

  /**
   * 测试：当名称和 ID 都缺失时分配回退 ID
   * 验证 undefined 值的处理
   */
  it("assigns fallback ids when both name and id are missing", async () => {
    const finalToolCall: { type: string; name?: string; id?: string } = { type: "toolCall" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBeUndefined();
    expect(finalToolCall.id).toBe("call_auto_1");
  });

  /**
   * 测试：优先使用显式规范名称而非冲突的规范 ID
   * 验证名称优先级高于 ID
   */
  it("prefers explicit canonical names over conflicting canonical ids", async () => {
    const finalToolCall = { type: "toolCall", id: "write", name: "read" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    // 验证名称优先于 ID
    expect(finalToolCall.name).toBe("read");
    expect(finalToolCall.id).toBe("write");
  });

  /**
   * 测试：优先使用显式修剪的规范名称而非冲突的格式错误 ID
   * 验证显式名称的优先级
   */
  it("prefers explicit trimmed canonical names over conflicting malformed ids", async () => {
    const finalToolCall = { type: "toolCall", id: "functionswrite4", name: " read " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  /**
   * 测试：不重写提及多个工具的复合名称
   * 验证复合工具名称不被错误修改
   */
  it("does not rewrite composite names that mention multiple tools", async () => {
    const finalToolCall = { type: "toolCall", id: "functionsread3", name: "read write" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    // 验证复合名称保持不变
    expect(finalToolCall.name).toBe("read write");
  });

  /**
   * 测试：对于模棱两可的格式错误非空名称失败关闭
   * 验证歧义情况下的保守处理
   */
  it("fails closed for malformed non-blank names that are ambiguous", async () => {
    const finalToolCall = { type: "toolCall", id: "functions.exec2", name: "functions.exec2" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec", "exec2"]));
    await stream.result();

    // 验证歧义时保持原样（失败关闭）
    expect(finalToolCall.name).toBe("functions.exec2");
  });

  /**
   * 测试：跨常见分隔符大小写不敏感匹配格式错误的 ID
   * 验证大小写和分隔符的容错处理
   */
  it("matches malformed ids case-insensitively across common separators", async () => {
    const finalToolCall = { type: "toolCall", id: "Functions.Read_7", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    expect(finalToolCall.name).toBe("read");
  });

  /**
   * 测试：不用推断的 ID 覆盖显式非空工具名称
   * 验证显式名称的保护机制
   */
  it("does not override explicit non-blank tool names with inferred ids", async () => {
    const finalToolCall = { type: "toolCall", id: "functionswrite4", name: "someOtherTool" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["read", "write"]));
    await stream.result();

    // 验证显式名称不被覆盖
    expect(finalToolCall.name).toBe("someOtherTool");
  });

  /**
   * 测试：当格式错误的 ID 可能映射到多个允许的工具时失败关闭
   * 验证多匹配时的保守处理
   */
  it("fails closed when malformed ids could map to multiple allowlisted tools", async () => {
    const finalToolCall = { type: "toolCall", id: "functions.exec2", name: "" };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn, new Set(["exec", "exec2"]));
    await stream.result();

    // 验证多匹配时保持空字符串（失败关闭）
    expect(finalToolCall.name).toBe("");
  });

  /**
   * 测试：不将仅空白的工具名称折叠为空字符串
   * 验证空白名称的保留
   */
  it("does not collapse whitespace-only tool names to empty strings", async () => {
    const partialToolCall = { type: "toolCall", name: "   " };
    const finalToolCall = { type: "toolCall", name: "\t  " };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const { baseFn } = createEventStream({ event, finalToolCall });

    const stream = await invokeWrappedStream(baseFn);

    for await (const _item of stream) {
      // drain
    }
    await stream.result();

    // 验证空白名称保持不变
    expect(partialToolCall.name).toBe("   ");
    expect(finalToolCall.name).toBe("\t  ");
    expect(baseFn).toHaveBeenCalledTimes(1);
  });

  /**
   * 测试：为流式和最终消息中缺失/空白的工具调用 ID 分配回退 ID
   * 验证 ID 缺失时的自动分配
   */
  it("assigns fallback ids to missing/blank tool call ids in streamed and final messages", async () => {
    const partialToolCall = { type: "toolCall", name: " read ", id: "   " };
    const finalToolCallA = { type: "toolCall", name: " exec ", id: "" };
    const finalToolCallB: { type: string; name: string; id?: string } = {
      type: "toolCall",
      name: " write ",
    };
    const event = {
      type: "toolcall_delta",
      partial: { role: "assistant", content: [partialToolCall] },
    };
    const finalMessage = { role: "assistant", content: [finalToolCallA, finalToolCallB] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [event],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }
    const result = await stream.result();

    // 验证名称修剪和 ID 分配
    expect(partialToolCall.name).toBe("read");
    expect(partialToolCall.id).toBe("call_auto_1");
    expect(finalToolCallA.name).toBe("exec");
    expect(finalToolCallA.id).toBe("call_auto_1");
    expect(finalToolCallB.name).toBe("write");
    expect(finalToolCallB.id).toBe("call_auto_2");
    expect(result).toBe(finalMessage);
  });

  /**
   * 测试：修剪工具调用 ID 周围的前后空白
   * 验证 ID 的空白修剪
   */
  it("trims surrounding whitespace on tool call ids", async () => {
    const finalToolCall = { type: "toolCall", name: " read ", id: "  call_42  " };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCall.name).toBe("read");
    expect(finalToolCall.id).toBe("call_42");
  });

  /**
   * 测试：将消息内重复的工具调用 ID 重新分配为唯一的回退值
   * 验证 ID 重复时的去重处理
   */
  it("reassigns duplicate tool call ids within a message to unique fallbacks", async () => {
    const finalToolCallA = { type: "toolCall", name: " read ", id: "  edit:22  " };
    const finalToolCallB = { type: "toolCall", name: " write ", id: "edit:22" };
    const finalMessage = { role: "assistant", content: [finalToolCallA, finalToolCallB] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    await stream.result();

    expect(finalToolCallA.name).toBe("read");
    expect(finalToolCallB.name).toBe("write");
    // 验证第一个保留原 ID，第二个获得回退 ID
    expect(finalToolCallA.id).toBe("edit:22");
    expect(finalToolCallB.id).toBe("call_auto_1");
  });
});

// ============================================================================
// wrapStreamFnRepairMalformedToolCallArguments 测试
// 测试格式错误工具调用参数修复流函数包装器
// ============================================================================
describe("wrapStreamFnRepairMalformedToolCallArguments", () => {
  /**
   * 创建假流用于测试
   * @param params 流参数（事件列表和结果消息）
   * @returns 模拟的流对象
   */
  function createFakeStream(params: { events: unknown[]; resultMessage: unknown }): {
    result: () => Promise<unknown>;
    [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
  } {
    return {
      async result() {
        return params.resultMessage;
      },
      [Symbol.asyncIterator]() {
        return (async function* () {
          for (const event of params.events) {
            yield event;
          }
        })();
      },
    };
  }

  /**
   * 调用包装后的流函数
   * @param baseFn 基础流函数
   * @returns 包装后的流
   */
  async function invokeWrappedStream(baseFn: (...args: never[]) => unknown) {
    const wrappedFn = wrapStreamFnRepairMalformedToolCallArguments(baseFn as never);
    return await wrappedFn({} as never, {} as never, {} as never);
  }

  /**
   * 测试：当有效 JSON 后跟随尾部垃圾时修复 anthropic 兼容的工具参数
   * 验证 Kimi 等模型返回的带尾部垃圾的 JSON 修复
   */
  it("repairs anthropic-compatible tool arguments when trailing junk follows valid JSON", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const endMessageToolCall = { type: "toolCall", name: "read", arguments: {} };
    const finalToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const endMessage = { role: "assistant", content: [endMessageToolCall] };
    const finalMessage = { role: "assistant", content: [finalToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}',
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "xx",
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
            message: endMessage,
          },
        ],
        resultMessage: finalMessage,
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }
    const result = await stream.result();

    // 验证所有阶段的参数都被正确修复
    expect(partialToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(streamedToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(endMessageToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(finalToolCall.arguments).toEqual({ path: "/tmp/report.txt" });
    expect(result).toBe(finalMessage);
  });

  /**
   * 测试：保持不完整的部分 JSON 不变直到存在完整对象
   * 验证不完整 JSON 不被错误修复
   */
  it("keeps incomplete partial JSON unchanged until a complete object exists", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp',
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }

    // 验证不完整的 JSON 保持为空
    expect(partialToolCall.arguments).toEqual({});
  });

  /**
   * 测试：当尾部垃圾超过 Kimi 特定允许范围时不修复工具参数
   * 验证超出允许范围的尾部垃圾不被修复
   */
  it("does not repair tool arguments when trailing junk exceeds the Kimi-specific allowance", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}oops',
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }

    // 验证超出允许的尾部垃圾不被修复
    expect(partialToolCall.arguments).toEqual({});
    expect(streamedToolCall.arguments).toEqual({});
  });

  /**
   * 测试：当后续增量使尾部后缀无效时清除缓存的修复
   * 验证修复状态的动态更新
   */
  it("clears a cached repair when later deltas make the trailing suffix invalid", async () => {
    const partialToolCall = { type: "toolCall", name: "read", arguments: {} };
    const streamedToolCall = { type: "toolCall", name: "read", arguments: {} };
    const partialMessage = { role: "assistant", content: [partialToolCall] };
    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/tmp/report.txt"}',
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "x",
            partial: partialMessage,
          },
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: "yzq",
            partial: partialMessage,
          },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: streamedToolCall,
            partial: partialMessage,
          },
        ],
        resultMessage: { role: "assistant", content: [partialToolCall] },
      }),
    );

    const stream = await invokeWrappedStream(baseFn);
    for await (const _item of stream) {
      // drain
    }

    // 验证尾部垃圾累积超限后修复被清除
    expect(partialToolCall.arguments).toEqual({});
    expect(streamedToolCall.arguments).toEqual({});
  });
});

// ============================================================================
// isOllamaCompatProvider 测试
// 测试 Ollama 兼容提供者检测逻辑
// ============================================================================
describe("isOllamaCompatProvider", () => {
  /**
   * 测试：检测原生 ollama 提供者 ID
   */
  it("detects native ollama provider id", () => {
    expect(
      isOllamaCompatProvider({
        provider: "ollama",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
      }),
    ).toBe(true);
  });

  /**
   * 测试：检测本地主机 Ollama OpenAI 兼容端点
   * 验证 localhost:11434 的自动识别
   */
  it("detects localhost Ollama OpenAI-compatible endpoint", () => {
    expect(
      isOllamaCompatProvider({
        provider: "custom",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).toBe(true);
  });

  /**
   * 测试：不误分类非本地 OpenAI 兼容提供者
   * 验证远程服务的正确排除
   */
  it("does not misclassify non-local OpenAI-compatible providers", () => {
    expect(
      isOllamaCompatProvider({
        provider: "custom",
        api: "openai-completions",
        baseUrl: "https://api.openrouter.ai/v1",
      }),
    ).toBe(false);
  });

  /**
   * 测试：当提供者 ID 提示 ollama 时检测远程 Ollama 兼容端点
   * 验证 provider 名称提示的远程服务识别
   */
  it("detects remote Ollama-compatible endpoint when provider id hints ollama", () => {
    expect(
      isOllamaCompatProvider({
        provider: "my-ollama",
        api: "openai-completions",
        baseUrl: "http://ollama-host:11434/v1",
      }),
    ).toBe(true);
  });

  /**
   * 测试：检测 IPv6 环回 Ollama OpenAI 兼容端点
   * 验证 IPv6 地址的正确处理
   */
  it("detects IPv6 loopback Ollama OpenAI-compatible endpoint", () => {
    expect(
      isOllamaCompatProvider({
        provider: "custom",
        api: "openai-completions",
        baseUrl: "http://[::1]:11434/v1",
      }),
    ).toBe(true);
  });

  /**
   * 测试：没有 ollama 提供者提示时不分类 11434 端口上的任意远程主机
   * 验证无提示时的保守处理
   */
  it("does not classify arbitrary remote hosts on 11434 without ollama provider hint", () => {
    expect(
      isOllamaCompatProvider({
        provider: "custom",
        api: "openai-completions",
        baseUrl: "http://example.com:11434/v1",
      }),
    ).toBe(false);
  });
});

// ============================================================================
// resolveOllamaBaseUrlForRun 测试
// 测试 Ollama 基础 URL 解析逻辑
// ============================================================================
describe("resolveOllamaBaseUrlForRun", () => {
  /**
   * 测试：优先使用提供者 baseUrl 而非模型 baseUrl
   */
  it("prefers provider baseUrl over model baseUrl", () => {
    expect(
      resolveOllamaBaseUrlForRun({
        modelBaseUrl: "http://model-host:11434",
        providerBaseUrl: "http://provider-host:11434",
      }),
    ).toBe("http://provider-host:11434");
  });

  /**
   * 测试：当提供者 baseUrl 缺失时回退到模型 baseUrl
   */
  it("falls back to model baseUrl when provider baseUrl is missing", () => {
    expect(
      resolveOllamaBaseUrlForRun({
        modelBaseUrl: "http://model-host:11434",
      }),
    ).toBe("http://model-host:11434");
  });

  /**
   * 测试：当两者都未配置时回退到原生默认值
   */
  it("falls back to native default when neither baseUrl is configured", () => {
    expect(resolveOllamaBaseUrlForRun({})).toBe("http://127.0.0.1:11434");
  });
});

// ============================================================================
// wrapOllamaCompatNumCtx 测试
// 测试 Ollama 兼容 num_ctx 包装器
// ============================================================================
describe("wrapOllamaCompatNumCtx", () => {
  /**
   * 测试：注入 num_ctx 并保留下游 onPayload Hook
   * 验证 num_ctx 注入和 Hook 链的完整性
   */
  it("injects num_ctx and preserves downstream onPayload hooks", () => {
    let payloadSeen: Record<string, unknown> | undefined;
    const baseFn = vi.fn((_model, _context, options) => {
      const payload: Record<string, unknown> = { options: { temperature: 0.1 } };
      options?.onPayload?.(payload, _model);
      payloadSeen = payload;
      return {} as never;
    });
    const downstream = vi.fn();

    const wrapped = wrapOllamaCompatNumCtx(baseFn as never, 202752);
    void wrapped({} as never, {} as never, { onPayload: downstream } as never);

    expect(baseFn).toHaveBeenCalledTimes(1);
    // 验证 num_ctx 被正确注入
    expect((payloadSeen?.options as Record<string, unknown> | undefined)?.num_ctx).toBe(202752);
    // 验证下游 Hook 被调用
    expect(downstream).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// resolveOllamaCompatNumCtxEnabled 测试
// 测试 Ollama 兼容 num_ctx 启用状态解析
// ============================================================================
describe("resolveOllamaCompatNumCtxEnabled", () => {
  /**
   * 测试：配置缺失时默认为 true
   */
  it("defaults to true when config is missing", () => {
    expect(resolveOllamaCompatNumCtxEnabled({ providerId: "ollama" })).toBe(true);
  });

  /**
   * 测试：提供者配置缺失时默认为 true
   */
  it("defaults to true when provider config is missing", () => {
    expect(
      resolveOllamaCompatNumCtxEnabled({
        config: { models: { providers: {} } },
        providerId: "ollama",
      }),
    ).toBe(true);
  });

  /**
   * 测试：当提供者标志显式禁用时返回 false
   */
  it("returns false when provider flag is explicitly disabled", () => {
    expect(
      resolveOllamaCompatNumCtxEnabled({
        config: createOllamaProviderConfig(false),
        providerId: "ollama",
      }),
    ).toBe(false);
  });
});

// ============================================================================
// shouldInjectOllamaCompatNumCtx 测试
// 测试 Ollama 兼容 num_ctx 注入判断逻辑
// ============================================================================
describe("shouldInjectOllamaCompatNumCtx", () => {
  /**
   * 测试：需要 openai-completions 适配器
   * 验证非 openai-completions API 不注入
   */
  it("requires openai-completions adapter", () => {
    expect(
      shouldInjectOllamaCompatNumCtx({
        model: {
          provider: "ollama",
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      }),
    ).toBe(false);
  });

  /**
   * 测试：尊重提供者标志禁用
   * 验证配置禁用时不注入
   */
  it("respects provider flag disablement", () => {
    expect(
      shouldInjectOllamaCompatNumCtx({
        model: {
          provider: "ollama",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
        config: createOllamaProviderConfig(false),
        providerId: "ollama",
      }),
    ).toBe(false);
  });
});

// ============================================================================
// decodeHtmlEntitiesInObject 测试
// 测试对象中 HTML 实体解码逻辑
// ============================================================================
describe("decodeHtmlEntitiesInObject", () => {
  /**
   * 测试：解码字符串值中的 HTML 实体
   * 验证常见 HTML 实体的解码
   */
  it("decodes HTML entities in string values", () => {
    const result = decodeHtmlEntitiesInObject(
      "source .env &amp;&amp; psql &quot;$DB&quot; -c &lt;query&gt;",
    );
    expect(result).toBe('source .env && psql "$DB" -c <query>');
  });

  /**
   * 测试：递归解码嵌套对象
   * 验证深层嵌套结构的解码
   */
  it("recursively decodes nested objects", () => {
    const input = {
      command: "cd ~/dev &amp;&amp; npm run build",
      args: ["--flag=&quot;value&quot;", "&lt;input&gt;"],
      nested: { deep: "a &amp; b" },
    };
    const result = decodeHtmlEntitiesInObject(input) as Record<string, unknown>;
    expect(result.command).toBe("cd ~/dev && npm run build");
    expect((result.args as string[])[0]).toBe('--flag="value"');
    expect((result.args as string[])[1]).toBe("<input>");
    expect((result.nested as Record<string, string>).deep).toBe("a & b");
  });

  /**
   * 测试：非字符串原样返回
   * 验证数字、null、boolean、undefined 不被修改
   */
  it("passes through non-string primitives unchanged", () => {
    expect(decodeHtmlEntitiesInObject(42)).toBe(42);
    expect(decodeHtmlEntitiesInObject(null)).toBe(null);
    expect(decodeHtmlEntitiesInObject(true)).toBe(true);
    expect(decodeHtmlEntitiesInObject(undefined)).toBe(undefined);
  });

  /**
   * 测试：没有实体的字符串保持不变
   */
  it("returns strings without entities unchanged", () => {
    const input = "plain string with no entities";
    expect(decodeHtmlEntitiesInObject(input)).toBe(input);
  });

  /**
   * 测试：解码数字字符引用
   * 验证十进制和十六进制字符引用的解码
   */
  it("decodes numeric character references", () => {
    expect(decodeHtmlEntitiesInObject("&#39;hello&#39;")).toBe("'hello'");
    expect(decodeHtmlEntitiesInObject("&#x27;world&#x27;")).toBe("'world'");
  });
});

// ============================================================================
// prependSystemPromptAddition 测试
// 测试系统提示添加逻辑
// ============================================================================
describe("prependSystemPromptAddition", () => {
  /**
   * 测试：将上下文引擎添加内容前置到系统提示
   * 验证 prepend 格式正确
   */
  it("prepends context-engine addition to the system prompt", () => {
    const result = prependSystemPromptAddition({
      systemPrompt: "base system",
      systemPromptAddition: "extra behavior",
    });

    expect(result).toBe("extra behavior\n\nbase system");
  });

  /**
   * 测试：当没有提供添加内容时返回原始系统提示
   */
  it("returns the original system prompt when no addition is provided", () => {
    const result = prependSystemPromptAddition({
      systemPrompt: "base system",
    });

    expect(result).toBe("base system");
  });
});

// ============================================================================
// buildAfterTurnRuntimeContext 测试
// 测试 afterTurn 运行时上下文构建逻辑
// ============================================================================
describe("buildAfterTurnRuntimeContext", () => {
  /**
   * 测试：当 compaction.model 未设置时使用主模型
   * 验证默认模型选择逻辑
   */
  it("uses primary model when compaction.model is not set", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: {} as OpenClawConfig,
        skillsSnapshot: undefined,
        senderIsOwner: true,
        provider: "openai-codex",
        modelId: "gpt-5.3-codex",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });

    expect(legacy).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.3-codex",
    });
  });

  /**
   * 测试：即使设置了 compaction.model 也传递主模型（覆盖在 compactDirect 中解析）
   * 验证模型覆盖的集中解析逻辑
   */
  it("passes primary model through even when compaction.model is set (override resolved in compactDirect)", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: {
          agents: {
            defaults: {
              compaction: {
                model: "openrouter/anthropic/claude-sonnet-4-5",
              },
            },
          },
        } as OpenClawConfig,
        skillsSnapshot: undefined,
        senderIsOwner: true,
        provider: "openai-codex",
        modelId: "gpt-5.3-codex",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });

    // buildAfterTurnLegacyCompactionParams 不再解析覆盖；
    // compactEmbeddedPiSessionDirect 为自动和手动路径集中处理
    expect(legacy).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.3-codex",
    });
  });

  /**
   * 测试：包含用于上下文引擎 afterTurn 压缩的已解析 auth profile 字段
   * 验证 auth profile 字段的正确传递
   */
  it("includes resolved auth profile fields for context-engine afterTurn compaction", () => {
    const legacy = buildAfterTurnRuntimeContext({
      attempt: {
        sessionKey: "agent:main:session:abc",
        messageChannel: "slack",
        messageProvider: "slack",
        agentAccountId: "acct-1",
        authProfileId: "openai:p1",
        config: { plugins: { slots: { contextEngine: "lossless-claw" } } } as OpenClawConfig,
        skillsSnapshot: undefined,
        senderIsOwner: true,
        provider: "openai-codex",
        modelId: "gpt-5.3-codex",
        thinkLevel: "off",
        reasoningLevel: "on",
        extraSystemPrompt: "extra",
        ownerNumbers: ["+15555550123"],
      },
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });

    expect(legacy).toMatchObject({
      authProfileId: "openai:p1",
      provider: "openai-codex",
      model: "gpt-5.3-codex",
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
    });
  });
});
