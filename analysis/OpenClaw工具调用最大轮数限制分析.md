# OpenClaw 工具调用最大轮数限制分析

## 核心结论

OpenClaw **没有传统的工具调用总轮数硬上限**。工具调用循环由 pi-coding-agent SDK 内部驱动（`while(true)` 式），OpenClaw 通过**循环检测机制** + **运行超时**来约束，而非固定轮数上限。

---

## 一、循环检测机制（最接近"最大轮数"的概念）

### 1.1 核心实现文件

| 文件                                                                                                               | 作用                                      |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| [src/agents/tool-loop-detection.ts](file:///d:/prj/openclaw_analyze/src/agents/tool-loop-detection.ts)             | 循环检测核心逻辑                          |
| [src/agents/pi-tools.before-tool-call.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-tools.before-tool-call.ts) | 工具调用前置 Hook，执行检测并阻止         |
| [src/config/types.tools.ts](file:///d:/prj/openclaw_analyze/src/config/types.tools.ts)                             | `ToolLoopDetectionConfig` 类型定义        |
| [src/agents/pi-tools.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-tools.ts)                                   | 配置解析 `resolveToolLoopDetectionConfig` |

### 1.2 默认常量

核心常量定义在 [tool-loop-detection.ts#L29-L33](file:///d:/prj/openclaw_analyze/src/agents/tool-loop-detection.ts#L29-L33)：

```typescript
export const TOOL_CALL_HISTORY_SIZE = 30;
export const WARNING_THRESHOLD = 10;
export const CRITICAL_THRESHOLD = 20;
export const GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30;
```

### 1.3 三档阈值

**默认关闭**（`enabled: false`），需手动启用。启用后有三档阈值：

| 阈值字段                        | 默认值 | 级别     | 行为                   |
| ------------------------------- | ------ | -------- | ---------------------- |
| `warningThreshold`              | **10** | warning  | 仅警告，不阻止执行     |
| `criticalThreshold`             | **20** | critical | **阻止工具执行**       |
| `globalCircuitBreakerThreshold` | **30** | critical | **全局断路器，硬停止** |

配置类型定义见 [types.tools.ts#L153-L166](file:///d:/prj/openclaw_analyze/src/config/types.tools.ts#L153-L166)：

```typescript
export type ToolLoopDetectionConfig = {
  enabled?: boolean;
  historySize?: number; // default: 30
  warningThreshold?: number; // default: 10
  criticalThreshold?: number; // default: 20
  globalCircuitBreakerThreshold?: number; // default: 30
  detectors?: ToolLoopDetectionDetectorConfig;
};
```

### 1.4 配置示例

```json5
{
  tools: {
    loopDetection: {
      enabled: false, // 默认关闭
      historySize: 30,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

---

## 二、阻止逻辑

### 2.1 前置 Hook 拦截

在 [pi-tools.before-tool-call.ts#L109-L126](file:///d:/prj/openclaw_analyze/src/agents/pi-tools.before-tool-call.ts#L109-L126) 中，`runBeforeToolCallHook` 在每次工具调用前执行检测：

```typescript
const loopResult = detectToolCallLoop(sessionState, toolName, params, args.ctx.loopDetection);

if (loopResult.stuck) {
  if (loopResult.level === "critical") {
    // 直接阻止工具执行
    return { blocked: true, reason: loopResult.message };
  } else {
    // warning 级别：仅记录警告，继续执行
    if (shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
      log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
    }
  }
}
```

### 2.2 工具包装器

在 [pi-tools.before-tool-call.ts#L195-L210](file:///d:/prj/openclaw_analyze/src/agents/pi-tools.before-tool-call.ts#L195-L210) 中，`wrapToolWithBeforeToolCallHook` 包装每个工具的 `execute` 方法：

```typescript
const wrappedTool: AnyAgentTool = {
  ...tool,
  execute: async (toolCallId, params, signal, onUpdate) => {
    const outcome = await runBeforeToolCallHook({ toolName, params, toolCallId, ctx });
    if (outcome.blocked) {
      throw new Error(outcome.reason); // 阻止工具执行
    }
    // ... 正常执行并记录结果
  },
};
```

### 2.3 检测器类型

| 检测器 (`detector`)      | 触发条件                                         | 阻止阈值                       |
| ------------------------ | ------------------------------------------------ | ------------------------------ |
| `global_circuit_breaker` | 任何工具重复无进展                               | **30 次**                      |
| `known_poll_no_progress` | `process poll`/`command_status` 等轮询工具无进展 | **20 次**（critical）          |
| `ping_pong`              | 两个工具交替无进展调用                           | **20 次**（critical）          |
| `generic_repeat`         | 通用重复同工具同参数                             | 仅 **10 次** warning（不阻止） |

### 2.4 检测优先级

检测顺序见 [tool-loop-detection.ts](file:///d:/prj/openclaw_analyze/src/agents/tool-loop-detection.ts) 的 `detectToolCallLoop` 函数：

1. **全局断路器**（最高优先级，30 次）
2. **已知轮询工具无进展 - critical**（20 次）
3. **已知轮询工具无进展 - warning**（10 次）
4. **Ping-Pong 交替 - critical**（20 次）
5. **Ping-Pong 交替 - warning**（10 次）
6. **通用重复 - warning**（10 次，仅警告）

---

## 三、历史记录管理

### 3.1 滑动窗口

循环检测基于滑动窗口历史，见 [tool-loop-detection.ts](file:///d:/prj/openclaw_analyze/src/agents/tool-loop-detection.ts) 的 `recordToolCall` 函数：

```typescript
export function recordToolCall(state, toolName, params, toolCallId, config): void {
  state.toolCallHistory.push({ toolName, argsHash, toolCallId, timestamp: Date.now() });
  if (state.toolCallHistory.length > resolvedConfig.historySize) {
    state.toolCallHistory.shift(); // 保持最多 30 条
  }
}
```

### 3.2 结果指纹

`recordToolCallOutcome` 函数记录工具调用的结果指纹（`resultHash`），用于判断是否"无进展"：

- 错误结果：`error:<hash>`
- 轮询工具：提取 `status`/`exitCode`/`text` 等关键字段哈希
- 普通工具：对 `details` + `text` 哈希

---

## 四、其他相关限制

### 4.1 外层重试循环上限

文件：[src/agents/pi-embedded-runner/run.ts#L144-L154](file:///d:/prj/openclaw_analyze/src/agents/pi-embedded-runner/run.ts#L144-L154)

```typescript
const BASE_RUN_RETRY_ITERATIONS = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MIN_RUN_RETRY_ITERATIONS = 32;
const MAX_RUN_RETRY_ITERATIONS = 160;

function resolveMaxRunRetryIterations(profileCandidateCount: number): number {
  const scaled =
    BASE_RUN_RETRY_ITERATIONS +
    Math.max(1, profileCandidateCount) * RUN_RETRY_ITERATIONS_PER_PROFILE;
  return Math.min(MAX_RUN_RETRY_ITERATIONS, Math.max(MIN_RUN_RETRY_ITERATIONS, scaled));
}
```

| 认证 Profile 数 | 重试上限    |
| --------------- | ----------- |
| 1               | 32          |
| 5               | 64          |
| 10              | 104         |
| 17+             | 160（上限） |

**注意**：这是外层重试循环（认证轮换、模型降级、自动压缩触发的重试），不是单次运行内的工具调用轮数。

### 4.2 运行超时

| 超时项                           | 默认值     | 说明                                                         |
| -------------------------------- | ---------- | ------------------------------------------------------------ |
| `agents.defaults.timeoutSeconds` | **600 秒** | Agent 运行总超时，在 `runEmbeddedPiAgent` 中止计时器强制执行 |
| `agent.wait`                     | **30 秒**  | 仅等待 RPC，不停止 Agent                                     |

### 4.3 Agent 间通信轮数

| 配置项             | 默认值 | 说明                                                   |
| ------------------ | ------ | ------------------------------------------------------ |
| `maxPingPongTurns` | **5**  | Agent 间 A2A 通信的 Ping-Pong 最大轮数（限制范围 0-5） |

定义见 [zod-schema.session.ts#L60](file:///d:/prj/openclaw_analyze/src/config/zod-schema.session.ts#L60)：

```typescript
maxPingPongTurns: z.number().int().min(0).max(5).optional(),
```

---

## 五、总结

### 场景对照表

| 场景                              | 限制类型       | 值         | 是否阻止执行   |
| --------------------------------- | -------------- | ---------- | -------------- |
| 启用循环检测 - 全局断路器         | 重复无进展次数 | **30 次**  | 是（硬停止）   |
| 启用循环检测 - 轮询工具 critical  | 轮询无进展次数 | **20 次**  | 是             |
| 启用循环检测 - Ping-Pong critical | 交替无进展次数 | **20 次**  | 是             |
| 启用循环检测 - 通用重复 warning   | 重复同参数次数 | **10 次**  | 否（仅警告）   |
| 未启用循环检测（默认）            | 无轮数限制     | -          | 否             |
| Agent 运行超时                    | 时间限制       | **600 秒** | 是（中止运行） |
| 外层重试循环                      | 重试次数       | **32-160** | 是（返回错误） |
| A2A 通信                          | Ping-Pong 轮数 | **5**      | 是（停止通信） |

### 关键结论

1. **启用循环检测后**：全局断路器阈值 **30** 是最高的硬停止点（同一工具+参数重复 30 次无进展）
2. **未启用循环检测时（默认）**：工具调用轮数无硬上限，仅受 600 秒超时约束
3. 阻止的是**重复无进展**的调用，不是工具调用的**总轮数**——如果每次调用参数或结果不同，则不会触发循环检测
4. 循环检测默认关闭，需要在配置中显式设置 `tools.loopDetection.enabled: true`
