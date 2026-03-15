# Skill 选择与执行流程分析

## 一、核心原理："提示词引导 + 模型自主决策"模式
OpenClaw的Skill选择不是硬编码的规则匹配，而是**通过系统提示词将Skill信息告知模型，由模型根据用户请求自主判断是否需要使用Skill以及如何使用**。这种设计充分利用了大语言模型的理解能力，具有极高的灵活性。

---

## 二、完整流程详解

### 阶段1：Skill信息注入到系统提示
会话开始时，系统会将所有可用Skill的信息注入到模型的系统提示词中：
```xml
<available_skills>
  <skill>
    <name>weather</name>
    <description>查询全球各地的实时天气、天气预报、空气质量等信息</description>
    <location>/home/user/.openclaw/skills/weather/SKILL.md</location>
  </skill>
  <skill>
    <name>github</name>
    <description>管理GitHub仓库、查询Issue、提交PR、查看通知等操作</description>
    <location>/home/user/workspace/skills/github/SKILL.md</location>
  </skill>
</available_skills>
```

同时系统提示会明确指示模型：
> 当需要使用某项技能时，请先使用`read`工具读取对应`location`路径下的SKILL.md文件，了解详细的使用方法、工具定义和执行步骤。

---

### 阶段2：模型自主决策是否使用Skill
当用户发出请求时，模型会：
1. **理解用户意图**：分析用户请求的内容和目标
2. **匹配Skill描述**：将用户意图与`available_skills`中每个Skill的`description`进行匹配
3. **决策是否使用**：如果某个Skill的功能与用户请求高度相关，模型会决定使用该Skill

#### 示例匹配过程：
> **用户请求**："明天北京天气怎么样？"
> 
> 模型匹配到`weather`技能的描述是"查询天气"，决定使用该Skill。

---

### 阶段3：加载Skill详细说明
模型决定使用某个Skill后，会首先调用`read`工具读取对应Skill的`SKILL.md`文件，获取：
- Skill的详细功能说明
- 触发场景和使用条件
- 需要调用的工具/命令列表
- 具体的执行步骤和参数要求
- 输出格式和错误处理方式

例如读取`weather`的SKILL.md后，模型会知道：
- 需要调用`weather-cli`命令行工具
- 参数格式是`weather-cli <city> [date]`
- 输出为JSON格式，包含温度、湿度、天气状况等字段

---

### 阶段4：执行Skill定义的操作
模型根据SKILL.md中的指示，调用对应的工具/命令执行操作：
1. **工具调用校验**：系统会校验模型调用的工具是否有权限执行
2. **执行端路由**：如果是本地工具直接在Gateway执行，如果是节点工具会路由到对应设备节点执行
3. **结果返回**：工具/命令的执行结果返回给模型

#### 示例执行过程：
模型调用：
```json
{
  "name": "bash",
  "parameters": {
    "command": "weather-cli 北京 2026-03-16"
  }
}
```

执行结果返回：
```json
{
  "temperature": "15°C",
  "weather": "晴",
  "wind": "北风3级",
  "air_quality": "优"
}
```

---

### 阶段5：处理结果生成回复
模型拿到执行结果后，会：
1. 解析执行结果，判断是否成功
2. 如果需要多步操作，继续调用后续工具
3. 最终将结果整理成自然语言回复给用户

#### 示例回复：
> 明天北京的天气是晴，气温15°C，北风3级，空气质量优，适合出行。

---

## 三、特殊调用方式

### 1. 用户主动调用Skill
用户可以通过斜杠命令直接调用Skill，无需模型决策：
```
/skill weather 北京 明天
```
这种情况下：
- 如果Skill声明了`command-dispatch: tool`，会直接执行对应的工具，完全跳过模型决策
- 否则会将命令作为请求发送给模型，由模型按照Skill说明执行

### 2. 自动命令注册
标记为`user-invocable`的Skill会自动注册为斜杠命令：
```
/weather 北京 明天
```
用户可以直接使用`/skillname`的形式调用，更方便。

---

## 四、关键设计特点
1. **零硬编码**：Skill选择完全由模型自主决策，新增Skill不需要修改任何匹配规则
2. **动态适配**：模型会自动学习新Skill的使用方法，不需要重新训练
3. **灵活性高**：支持复杂的多步操作和流程编排，Skill可以定义任意复杂的工作流
4. **可解释性**：模型的决策过程可以通过会话历史追溯，清晰看到为什么选择了某个Skill
5. **安全性**：所有工具调用都会经过系统权限校验，避免模型执行危险操作

---

## 五、相关核心实现
| 模块 | 功能 | 实现文件 |
|------|------|----------|
| `resolveSkillsPromptForRun()` | 构建Skill的XML格式提示词片段 | `src/agents/skills/workspace.ts` |
| 系统提示模板 | 包含Skill使用说明的提示词模板 | 系统提示词定义文件 |
| 工具调用校验器 | 校验模型调用的工具是否有权限执行 | `src/agents/pi-tools.ts` |
| 命令分发器 | 处理`/skill`命令和自动注册的Skill命令 | `src/auto-reply/skill-commands.ts` |

这种设计使得Skill系统具有极强的扩展性，用户只需要编写SKILL.md文件，模型就能自动理解并使用，完全不需要修改系统核心代码。