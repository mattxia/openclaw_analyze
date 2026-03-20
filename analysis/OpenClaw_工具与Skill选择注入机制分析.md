# OpenClaw 工具与Skill选择注入机制分析

当用户输入"请检查下明天的天气怎么样"这类请求时，OpenClaw通过"**系统启动预加载 → 会话运行时过滤 → 系统提示注入 → LLM自主决策**"的四层机制，自动筛选出需要提供给LLM的工具和Skill。

---

## 🔍 整体处理流程总览
```
系统启动 → 加载所有内置工具 → 扫描所有Skill目录 → 门控过滤不可用Skill → 
用户请求到达 → 会话级工具/Skill过滤 → 构建系统提示词 → 注入工具列表和Skill描述 → 
发送给LLM → LLM自主决策调用哪个工具和使用哪个Skill
```

---

## 📋 分阶段详细分析

### 📍 阶段1：系统启动时的全局预加载
**执行时机**：Gateway服务启动时执行一次
**核心逻辑**：
1. **工具预加载**：注册所有系统内置工具（20+个基础工具：read/write/exec/web_search等）
2. **Skill扫描**：按优先级扫描所有Skill目录
   - 工作区Skill：`<workspace>/skills`
   - 托管Skill：`~/.openclaw/skills`
   - 内置Skill：系统随包发布的Skills
   - 插件Skill：插件目录下的skills文件夹
3. **Skill门控过滤**：筛选掉不符合运行条件的Skill
   - 检查二进制依赖是否存在（如weather Skill需要`curl`）
   - 检查环境变量是否配置（如weather Skill需要`WEATHER_API_KEY`）
   - 检查配置项是否启用（如discord Skill需要`discord.enabled = true`）
   - 检查操作系统是否支持（如macOS专属Skill在Windows下会被过滤）

**关键代码片段**（Skill门控逻辑）：
```typescript
// 来自 src/agents/skills/skill-evaluator.ts
function evaluateSkillAvailability(skill: SkillMetadata, config: Config): boolean {
  // 1. 检查二进制依赖
  if (skill.requires?.bins) {
    for (const bin of skill.requires.bins) {
      if (!isInPath(bin)) return false;
    }
  }
  
  // 2. 检查环境变量
  if (skill.requires?.env) {
    for (const env of skill.requires.env) {
      if (!process.env[env] && !config.skills?.entries?.[skill.name]?.env?.[env]) {
        return false;
      }
    }
  }
  
  // 3. 检查配置项
  if (skill.requires?.config) {
    for (const configPath of skill.requires.config) {
      if (!getConfigValue(config, configPath)) return false;
    }
  }
  
  // 4. 检查操作系统
  if (skill.requires?.os && skill.requires.os !== process.platform) {
    return false;
  }
  
  return true;
}
```

**相关文件**：
- [src/agents/skills/skill-loader.ts](file:///d:/prj/openclaw_analyze/src/agents/skills/skill-loader.ts) - Skill加载与扫描
- [src/agents/skills/skill-evaluator.ts](file:///d:/prj/openclaw_analyze/src/agents/skills/skill-evaluator.ts) - 可用性评估

---

### 📍 阶段2：会话创建时的动态过滤
**执行时机**：每个新会话创建时执行
**核心逻辑**：
1. **会话级工具过滤**：根据会话类型和权限，过滤掉不可用工具
   - 普通会话：禁用高权限工具（如`exec`需要elevated权限）
   - 沙箱会话：仅允许安全工具（read/web_search等）
   - 子Agent会话：根据父会话权限继承工具
2. **会话级Skill过滤**：根据当前工作区和会话上下文，进一步过滤Skill
   - 工作区专属Skill仅在对应工作区可见
   - 禁用用户明确关闭的Skill
   - 过滤与当前会话场景无关的Skill（如聊天会话过滤编码Skill）

---

### 📍 阶段3：系统提示词构建时的注入
**执行时机**：每次调用LLM前执行
**核心逻辑**：将筛选后的工具和Skill信息注入到系统提示词中，提供给LLM参考。

#### 3.1 工具列表注入
系统会将所有可用工具的名称、描述、参数格式整理成标准化格式，注入到系统提示词：
```markdown
## Available Tools
你可以使用以下工具来完成任务：

1. `web_search(query: string, num_results?: number)`
   描述：搜索互联网获取实时信息，包括天气、新闻、资料等
   适用场景：需要最新信息、实时数据、未知知识时使用

2. `read(path: string)`
   描述：读取本地文件内容
   适用场景：需要查看本地文件内容时使用

3. `exec(command: string, cwd?: string)`
   描述：执行系统命令
   适用场景：需要运行脚本、编译代码、系统操作时使用

...
```

#### 3.2 Skill信息注入
系统会将所有可用的Skill信息，包含名称、描述、SKILL.md文件路径，注入到系统提示词：
```markdown
## Skills (mandatory)
Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.
- If multiple could apply: choose the most specific one, then read/follow it.
- If none clearly apply: do not read any SKILL.md.

<available_skills>
  <skill>
    <name>weather</name>
    <description>查询全球各地的实时天气、天气预报、空气质量等信息</description>
    <location>~/.openclaw/skills/weather/SKILL.md</location>
  </skill>
  <skill>
    <name>github</name>
    <description>管理GitHub仓库、查询Issue、提交PR、查看通知等操作</description>
    <location>~/.openclaw/skills/github/SKILL.md</location>
  </skill>
</available_skills>
```

**关键代码片段**（Skill注入逻辑）：
```typescript
// 来自 src/agents/system-prompt.ts#L28-L47
function buildSkillsSection(params: { skillsPrompt?: string; readToolName: string }) {
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed) {
    return [];
  }
  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> <description> entries.",
    `- If exactly one skill clearly applies: read its SKILL.md at <location> with \`${params.readToolName}\`, then follow it.`,
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraints: never read more than one skill up front; only read after selecting.",
    "- When a skill drives external API writes, assume rate limits: prefer fewer larger writes, avoid tight one-item loops, serialize bursts when possible, and respect 429/Retry-After.",
    trimmed,
    "",
  ];
}
```

**相关文件**：
- [src/agents/system-prompt.ts](file:///d:/prj/openclaw_analyze/src/agents/system-prompt.ts) - 系统提示词构建核心文件
- [src/agents/pi-embedded-runner/system-prompt.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-embedded-runner/system-prompt.ts) - 嵌入式Agent系统提示构建

---

### 📍 阶段4：LLM自主决策阶段
**执行时机**：LLM接收到系统提示和用户query后
**核心逻辑**：完全由LLM自主决策，没有任何硬编码规则：
1. **意图识别**：分析用户请求"请检查下明天的天气怎么样"，识别出核心需求是"查询天气"
2. **Skill匹配**：在`<available_skills>`中查找最匹配的Skill，发现`weather` Skill描述完全匹配
3. **工具选择**：根据Skill使用说明，需要先使用`read`工具读取`~/.openclaw/skills/weather/SKILL.md`了解使用方法
4. **执行逻辑**：读取Skill文件后，按照说明调用对应的工具（如`web_search`或`exec`调用天气API）
5. **结果生成**：将工具返回的天气信息整理成自然语言回复给用户

**LLM决策过程示例**：
```
<think>
用户需要查询明天的天气，我看到可用Skill中有weather Skill专门处理天气查询。
首先我需要读取weather Skill的使用说明，了解具体调用方式。
</think>

<|FunctionCallBegin|>[{"name":"read","parameters":{"path":"~/.openclaw/skills/weather/SKILL.md"}}]<|FunctionCallEnd|>
```

---

## 🌤️ 天气查询场景的完整执行示例
以用户查询"请检查下明天的天气怎么样"为例，完整流程如下：

| 阶段 | 系统行为 |
|------|----------|
| 1 | 系统启动时已加载weather Skill，检测到`WEATHER_API_KEY`环境变量已配置，标记为可用 |
| 2 | 用户请求到达，创建会话，weather Skill通过会话过滤 |
| 3 | 构建系统提示，将weather Skill注入到`<available_skills>`列表，同时注入`read`、`web_search`等工具 |
| 4 | LLM接收到请求，识别出需要查询天气，匹配到weather Skill |
| 5 | LLM调用`read`工具读取weather Skill的SKILL.md文件 |
| 6 | Skill文件说明：调用`web_search("北京 明天天气")`获取天气信息 |
| 7 | LLM调用`web_search`工具执行查询 |
| 8 | 工具返回天气结果："北京明天晴，气温15-25℃，微风" |
| 9 | LLM整理结果，回复用户："明天北京天气晴朗，气温15到25摄氏度，适合户外活动~" |

---

## 📚 核心设计亮点
1. **无硬编码匹配**：完全由LLM自主决策，无需维护复杂的规则引擎
2. **动态可用性**：通过门控机制自动过滤不可用的工具和Skill
3. **Skill知识可扩展**：新增Skill只需添加SKILL.md文件，无需修改系统代码
4. **渐进式知识加载**：LLM按需读取Skill详细说明，不占用过多上下文窗口

---

## 🔗 相关核心文件
| 文件路径 | 核心功能 |
|----------|----------|
| [src/agents/system-prompt.ts](file:///d:/prj/openclaw_analyze/src/agents/system-prompt.ts) | 系统提示词构建，工具和Skill注入逻辑 |
| [src/agents/skills/skill-loader.ts](file:///d:/prj/openclaw_analyze/src/agents/skills/skill-loader.ts) | Skill目录扫描与加载 |
| [src/agents/skills/skill-evaluator.ts](file:///d:/prj/openclaw_analyze/src/agents/skills/skill-evaluator.ts) | Skill可用性门控检查 |
| [src/agents/pi-embedded.ts](file:///d:/prj/openclaw_analyze/src/agents/pi-embedded.ts) | Agent运行时入口，上下文构建 |
