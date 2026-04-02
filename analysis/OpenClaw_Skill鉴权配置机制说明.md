# OpenClaw Skill鉴权信息存储与获取机制说明

## 一、鉴权信息存储位置
鉴权信息主要存储在 **`~/.openclaw/openclaw.json`** 全局配置文件中，也支持通过系统环境变量直接设置：

```json5
// ~/.openclaw/openclaw.json 配置示例
{
  "skills": {
    "entries": {
      // 为github skill配置鉴权信息
      "github": {
        "enabled": true,
        "env": {
          "GH_TOKEN": "ghp_xxxxxxxxxxxxxxxxxxxx" // 环境变量方式配置
        }
      },
      // 为gemini skill配置鉴权信息
      "nano-banana-pro": {
        "enabled": true,
        "apiKey": "GEMINI_KEY_HERE", // 快捷apiKey字段（适用于声明了primaryEnv的Skill）
        "env": {
          "GEMINI_API_KEY": "GEMINI_KEY_HERE"
        }
      }
    }
  }
}
```

### 两种配置方式：
1. **`env` 字段**：通用配置方式，直接指定环境变量名和对应鉴权值
2. **`apiKey` 快捷字段**：针对声明了 `metadata.openclaw.primaryEnv` 的Skill，可直接用这个字段配置主密钥，系统会自动映射到对应的环境变量

## 二、Skill获取鉴权信息的机制
### 1. Skill首先声明依赖
在Skill的 `SKILL.md` 文件中需要先声明需要的环境变量：
```yaml
---
name: openai-image-gen
description: "DALL-E图片生成"
metadata:
  openclaw:
    requires:
      env: ["OPENAI_API_KEY"] # 声明需要OpenAI API密钥环境变量
---
```

### 2. 系统自动注入
每次智能体运行开始时，OpenClaw会自动执行：
- 读取Skill的元数据配置
- 将 `skills.entries.<skill-name>.env` 和 `apiKey` 中的配置自动注入到 `process.env` 中
- 注入的环境变量**仅在当前智能体运行范围内有效**，运行结束后会自动恢复原始环境，不会污染全局shell环境

### 3. Skill直接读取使用
Skill的代码（无论是声明式命令还是自定义脚本）都可以直接从环境变量中读取鉴权信息：
```python
# Skill脚本中直接读取环境变量
import os
api_key = os.environ["OPENAI_API_KEY"]
```

### 4. 可用性校验
系统加载Skill时会自动检查所需的环境变量是否已配置，未配置的Skill会被标记为不可用，不会被加载到智能体的可用技能列表中。

## 三、优先级规则
环境变量的优先级从高到低：
1. 系统当前已存在的环境变量（优先级最高）
2. `~/.openclaw/openclaw.json` 中配置的 `env` 字段
3. `~/.openclaw/openclaw.json` 中配置的 `apiKey` 字段

如果同一个环境变量在多个位置配置，高优先级的配置会覆盖低优先级的。