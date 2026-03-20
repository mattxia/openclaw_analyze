# OpenClaw 多模型调度机制分析

OpenClaw支持多模型混合调度，通过**模型别名、智能路由、自动降级、负载均衡、多账户轮询**五大核心机制，实现高可用、高性能的模型调用。

---

## 🔍 核心调度机制总览
| 机制 | 核心功能 | 应用场景 |
|------|----------|----------|
| **模型别名系统** | 统一模型引用方式，屏蔽底层实现差异 | 用户配置、Skill定义中使用别名，无需关心具体模型ID |
| **智能路由策略** | 根据任务类型、模型能力、成本自动选择最优模型 | 推理任务、编码任务、工具调用任务自动匹配最合适模型 |
| **自动降级机制** | 主模型调用失败时自动切换到备用模型 | 模型服务不可用、配额耗尽、超时等异常场景 |
| **负载均衡** | 自动分配流量到不同模型/账户，避免限流 | 高并发场景、多账户配置场景 |
| **冷却机制** | 临时故障的模型自动进入冷却期，避免反复调用失败 | 模型临时故障、限流、配额耗尽场景 |

---

## 📋 完整调度流程
### 🎨 多模型调度流程图
```mermaid
flowchart TD
    classDef start fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    classDef decision fill:#fff3e0,stroke:#f57c00,stroke-width:2px
    classDef process fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    classDef end fill:#ffebee,stroke:#c62828,stroke-width:2px

    A(用户请求到达):::start
    B{是否指定模型?}:::decision
    C(解析模型别名):::process
    D(选择主模型):::process
    E(获取模型候选列表):::process
    F(过滤冷却中模型):::process
    G(选择优先级最高的候选):::process
    H(调用模型):::process
    I{调用成功?}:::decision
    J(返回结果):::end
    K(标记模型失败，进入冷却):::process
    L{还有可用候选?}:::decision
    M(返回错误):::end

    A --> B
    B -->|是| C
    B -->|否| D
    C --> E
    D --> E
    E --> F
    F --> G
    G --> H
    H --> I
    I -->|是| J
    I -->|否| K
    K --> L
    L -->|是| F
    L -->|否| M
```

---

## 🔧 核心机制详细分析

### 📍 1. 模型别名系统
**核心定位**：统一模型引用方式，实现配置与具体模型解耦
**实现逻辑**：
- 用户可以在配置中定义模型别名，如`"coding": "anthropic/claude-3-5-sonnet"`
- 系统在运行时自动将别名解析为真实的provider和model ID
- 支持全局别名和Agent级别名，优先级：Agent别名 > 全局别名
**核心代码**：
```typescript
// 来自 src/agents/model-selection.ts
export type ModelAliasIndex = {
  byAlias: Map<string, { alias: string; ref: ModelRef }>;
  byKey: Map<string, string[]>;
};

// 解析模型别名
export function resolveModelRefFromString(
  input: string,
  aliasIndex?: ModelAliasIndex
): ModelRef {
  // 1. 检查是否是别名
  const aliasKey = normalizeAliasKey(input);
  if (aliasIndex?.byAlias.has(aliasKey)) {
    return aliasIndex.byAlias.get(aliasKey)!.ref;
  }
  
  // 2. 解析provider/model格式
  const [provider, ...modelParts] = input.split("/");
  if (modelParts.length > 0) {
    return {
      provider: normalizeProviderId(provider),
      model: modelParts.join("/")
    };
  }
  
  // 3. 默认provider
  return {
    provider: DEFAULT_PROVIDER,
    model: input
  };
}
```
**相关文件**：
- [src/agents/model-selection.ts](file:///d:/prj/openclaw_analyze/src/agents/model-selection.ts) - 模型选择与别名解析

---

### 📍 2. 智能路由策略
**核心定位**：根据任务类型自动选择最优模型
**路由规则**：
1. **任务类型匹配**：
   - 编码任务：优先选择编码能力强的模型（如Claude 3.5 Sonnet、GPT-4o）
   - 推理任务：优先选择推理能力强的模型（如GPT-4o、Claude Opus）
   - 工具调用任务：优先选择工具调用能力好的模型（如GPT-4o Mini、Claude 3.5 Haiku）
   - 嵌入任务：自动选择对应的嵌入模型（如bge-m3、text-embedding-3-small）
2. **成本优先策略**：在能力满足需求的情况下优先选择成本更低的模型
3. **速度优先策略**：需要快速响应的场景优先选择速度更快的小模型
4. **配置指定**：用户明确指定模型时优先使用用户配置

---

### 📍 3. 自动降级（Failover）机制
**核心定位**：主模型调用失败时自动切换到备用模型，保证服务可用性
**降级触发条件**：
- 模型服务不可用（5xx错误）
- 配额耗尽（429错误）
- 调用超时
- 上下文溢出
- 权限错误
**核心实现**：
```typescript
// 来自 src/agents/model-fallback.ts
export async function runWithModelFallback<T>(params: {
  primaryModel: ModelRef;
  fallbacks: ModelRef[];
  run: ModelFallbackRunFn<T>;
  onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>> {
  const attempts: FallbackAttempt[] = [];
  const candidates = [params.primaryModel, ...params.fallbacks];
  
  for (let i = 0; i < candidates.length; i++) {
    const { provider, model } = candidates[i];
    
    // 检查模型是否在冷却期
    if (isProfileInCooldown(provider, model)) {
      attempts.push({
        provider,
        model,
        error: "model in cooldown",
        skipped: true
      });
      continue;
    }
    
    try {
      // 调用模型
      const result = await params.run(provider, model);
      
      // 调用成功
      return buildFallbackSuccess({
        result,
        provider,
        model,
        attempts
      });
    } catch (err) {
      // 处理错误
      const failoverError = coerceToFailoverError(err, { provider, model });
      
      attempts.push({
        provider,
        model,
        error: failoverError,
        skipped: false
      });
      
      // 标记模型进入冷却期
      addToCooldown(provider, model, failoverError.retryAfter);
      
      // 调用错误回调
      if (params.onError) {
        await params.onError({
          provider,
          model,
          error: err,
          attempt: i + 1,
          total: candidates.length
        });
      }
      
      // 用户主动终止，不继续降级
      if (isFallbackAbortError(err)) {
        throw err;
      }
    }
  }
  
  // 所有候选都失败
  throw new Error(`All models failed: ${describeFailoverAttempts(attempts)}`);
}
```
**相关文件**：
- [src/agents/model-fallback.ts](file:///d:/prj/openclaw_analyze/src/agents/model-fallback.ts) - 模型降级核心实现

---

### 📍 4. 负载均衡与冷却机制
**核心定位**：避免单个模型/账户被限流，提升整体吞吐量
**实现逻辑**：
1. **多账户轮询**：同一模型配置了多个API密钥时，自动轮询使用不同账户
2. **冷却机制**：调用失败的模型/账户自动进入冷却期（默认30秒，可根据Retry-After头调整）
3. **配额感知**：自动追踪各模型/账户的配额使用情况，优先使用剩余配额多的账户
**核心代码**：
```typescript
// 来自 src/agents/auth-profiles.ts
function resolveAuthProfileOrder(provider: string, model: string): AuthProfile[] {
  const profiles = getProviderProfiles(provider);
  
  // 过滤掉冷却中的profile
  const availableProfiles = profiles.filter(profile => 
    !isProfileInCooldown(profile.id)
  );
  
  // 按优先级排序：
  // 1. 剩余配额多的优先
  // 2. 最近使用时间早的优先（轮询）
  // 3. 错误率低的优先
  return availableProfiles.sort((a, b) => {
    if (a.remainingQuota !== b.remainingQuota) {
      return b.remainingQuota - a.remainingQuota;
    }
    if (a.lastUsedTime !== b.lastUsedTime) {
      return a.lastUsedTime - b.lastUsedTime;
    }
    return a.errorRate - b.errorRate;
  });
}

// 添加到冷却
function addToCooldown(provider: string, model: string, retryAfter: number = 30_000) {
  const key = `${provider}/${model}`;
  cooldownMap.set(key, Date.now() + retryAfter);
}

// 检查是否在冷却期
function isProfileInCooldown(profileId: string): boolean {
  const expireTime = cooldownMap.get(profileId);
  if (!expireTime) return false;
  if (Date.now() > expireTime) {
    cooldownMap.delete(profileId);
    return false;
  }
  return true;
}
```

---

### 📍 5. 模型配置示例
用户可以通过`openclaw.json`配置多模型和降级策略：
```json5
{
  "agents": {
    "defaults": {
      "model": "anthropic/claude-3-5-sonnet", // 主模型
      "modelFallback": [ // 降级候选列表，按优先级排序
        "openai/gpt-4o",
        "anthropic/claude-3-5-haiku",
        "openai/gpt-4o-mini"
      ],
      "modelAliases": { // 模型别名
        "coding": "anthropic/claude-3-5-sonnet",
        "fast": "openai/gpt-4o-mini",
        "reasoning": "openai/o1-preview"
      },
      "providers": { // 多账户配置
        "anthropic": [
          {"apiKey": "sk-ant-xxx1"},
          {"apiKey": "sk-ant-xxx2"},
          {"apiKey": "sk-ant-xxx3"}
        ],
        "openai": [
          {"apiKey": "sk-xxx1"},
          {"apiKey": "sk-xxx2"}
        ]
      }
    }
  }
}
```

---

## 🔗 核心实现文件汇总
| 文件路径 | 核心功能 |
|----------|----------|
| [src/agents/model-selection.ts](file:///d:/prj/openclaw_analyze/src/agents/model-selection.ts) | 模型选择、别名解析、标准化 |
| [src/agents/model-fallback.ts](file:///d:/prj/openclaw_analyze/src/agents/model-fallback.ts) | 模型自动降级、故障切换 |
| [src/agents/auth-profiles.ts](file:///d:/prj/openclaw_analyze/src/agents/auth-profiles.ts) | 多账户轮询、冷却机制 |
| [src/config/model-input.ts](file:///d:/prj/openclaw_analyze/src/config/model-input.ts) | 模型配置解析 |
| [src/agents/failover-error.ts](file:///d:/prj/openclaw_analyze/src/agents/failover-error.ts) | 故障错误识别与分类 |

这种调度机制既保证了模型调用的高可用性，又能根据场景智能选择最优模型，同时支持水平扩展以应对高并发场景。
