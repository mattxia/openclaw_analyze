# OpenClaw LLM未找到适用工具时的处理流程分析

当LLM接收系统注入的工具和Skill列表后，未找到合适的工具/无法完成用户请求时，OpenClaw采用**"有效性校验 → 多轮重试 → 兜底处理"**的三级处理机制，尽可能完成用户请求，避免直接返回失败。

---

## 🔍 完整处理流程总览
```
LLM输出响应 → 系统解析响应
          ↓
┌─────────────────────────────────┐
│ 是否包含工具调用？                │
└───┬─────────────────────────┬───┘
    │ 是                      │ 否
    ▼                         ▼
工具调用有效性校验          判断是否需要工具
    ↓                         ↓
┌─────────────────┐      ┌───────────────────────────┐
│ 调用是否有效？   │      │ 是否需要工具才能完成请求？  │
└───┬─────────┬───┘      └───┬───────────────────┬───┘
    │ 有效     │ 无效          │ 不需要            │ 需要
    ▼         ▼                ▼                   ▼
执行工具    返回错误给LLM重试  直接返回回复给用户  触发兜底机制
    ↓                         
返回结果给LLM继续推理
    ↓
循环直到生成最终回复
```

---

## 📋 分场景详细处理

### 📍 场景1：LLM判断不需要工具（正常流程）
如果LLM分析用户请求不需要任何工具即可回答（比如常识问题、闲聊、不需要外部数据的推理问题），系统会直接将LLM生成的回复返回给用户，结束流程。

**示例**：
> 用户："1+1等于几？"
> LLM直接回答："等于2"
> 系统直接返回给用户，无需工具调用。

---

### 📍 场景2：LLM调用了无效/不存在的工具
系统会先对LLM的工具调用进行有效性校验，如果发现问题，会返回明确的错误信息让LLM修正，最多重试3次：

#### 校验规则：
1. **工具存在性校验**：检查调用的工具是否在可用工具列表中
2. **权限校验**：检查当前会话是否有调用该工具的权限
3. **参数校验**：检查工具参数是否符合Schema定义
4. **安全校验**：检查工具调用是否违反安全策略（如执行危险命令）

#### 重试机制实现：
```typescript
// 来自 src/agents/pi-embedded-runner/run/attempt.ts
const MAX_TOOL_CALL_RETRIES = 3;
let toolCallRetries = 0;

while (toolCallRetries < MAX_TOOL_CALL_RETRIES) {
  const toolCall = parseToolCall(llmOutput);
  
  // 校验工具是否存在
  if (!availableTools.has(toolCall.name)) {
    // 返回错误信息给LLM
    const errorMsg = `工具 "${toolCall.name}" 不存在，可用工具列表：${Array.from(availableTools.keys()).join(", ")}。请选择正确的工具调用，或说明无法完成请求。`;
    
    // 将错误信息加入会话消息，让LLM重试
    session.messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: errorMsg
    });
    
    toolCallRetries++;
    continue;
  }
  
  // 其他校验逻辑（权限、参数、安全）...
  
  // 校验通过，执行工具
  const result = await executeTool(toolCall);
  return result;
}

// 超过重试次数，触发兜底
triggerFallbackMechanism();
```

**给LLM的错误提示示例**：
```
<|ToolCallError|>
错误类型：工具不存在
错误信息：调用的工具 "weather_query" 不在可用工具列表中
可用工具：read, write, exec, web_search, skill_search, memory_search
提示：如果没有合适的工具，可以使用 skill_search 搜索相关Skill，或使用 web_search 获取外部信息
<|ToolCallErrorEnd|>
```

---

### 📍 场景3：LLM无法找到合适工具，主动放弃
当LLM明确判断没有合适的工具可以完成用户请求时，系统会触发兜底处理机制，按以下优先级尝试：

#### 兜底步骤：
1. **自动引导搜索Skill**：系统自动在会话中插入提示，引导LLM使用`skill_search`工具搜索更多相关Skill：
   ```
   系统提示：当前提供的工具中没有能完成该请求的，请先使用 skill_search("<关键词>") 搜索相关Skill，获取更多可用能力。
   ```

2. **建议使用通用工具**：如果搜索Skill也没有结果，系统会提示LLM使用通用工具：
   - 需要实时信息：建议使用`web_search`
   - 需要执行系统操作：建议使用`exec`
   - 需要读取本地文件：建议使用`read`

3. **用户告知机制**：如果以上方式都无法解决问题，系统会引导LLM向用户说明情况，询问是否需要其他帮助，或提供替代方案：
   ```
   抱歉，当前没有找到可以完成该请求的工具或Skill。你可以：
   1. 明确描述你的需求，我会尝试其他方式
   2. 安装相关Skill后重试
   3. 换一种方式实现你的需求
   ```

---

### 📍 场景4：工具执行失败
如果工具调用本身有效，但执行过程中失败（比如网络错误、命令执行失败、API返回错误），系统会将错误详情返回给LLM，由LLM决定是重试、调整参数还是放弃：

**返回给LLM的错误格式**：
```json
{
  "error": "工具执行失败",
  "tool": "web_search",
  "message": "网络连接超时，无法访问搜索引擎",
  "retryable": true,
  "suggestion": "请检查网络连接后重试，或换用其他工具"
}
```

---

## 🚩 最终失败处理
当所有重试和兜底机制都无法完成用户请求时，系统会：
1. 向用户返回明确的失败说明，告知无法完成的原因
2. 提供可行的建议（如需要安装什么Skill、需要什么权限、可以用什么替代方案）
3. 记录失败日志，用于后续优化工具和Skill覆盖度

---

## 🔗 相关核心文件
| 文件路径 | 核心功能 |
|----------|----------|
| [src/agents/pi-embedded-runner/run/attempt.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-embedded-runner/run/attempt.ts) | 工具调用校验与重试逻辑 |
| [src/agents/pi-tools.policy.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-tools.policy.ts) | 工具权限与安全校验 |
| [src/agents/tool-error-handler.ts](file:///d:/prj/openclaw_analyze/src/agents/tool-error-handler.ts) | 工具错误处理与重试提示生成 |

这种处理机制尽可能提高了请求成功率，同时保持了LLM的决策灵活性，避免系统硬编码规则限制LLM的能力。
