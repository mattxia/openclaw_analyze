# Project Rules

## Mermaid 类图语法规范

编写 Mermaid classDiagram 时必须遵循以下规则：

### 1. 字符转义规则

**禁止使用 HTML 实体**，必须使用原始 ASCII 字符：
- 箭头用 `-->`，不用 `--&gt;`
- 依赖用 `..>`，不用 `..&gt;`
- 实现/继承用 `<|..` 或 `<|--`，不用 `&lt;|..`
- stereotype 用 `<<interface>>`，不要写成 `&lt;&lt;interface&gt;&gt;`

### 2. Stereotype 写法

Stereotype（如 `<<interface>>`）必须放在**类定义体外部、类名之后的一行**：

```mermaid
class AgentTool {
    +name: string
    +execute(): result
}
<<interface>> AgentTool
```

不要写在类体内部！不要写成：
```
class AgentTool {
    <<interface>>
    +name: string
}
```

### 3. 成员/方法简化

方法签名中避免以下会导致解析失败的内容：
- **禁止泛型语法** `Promise~ManagedRun~` → 改为 `ManagedRun`
- **禁止花括号** `{shell, args}` → 改为 `ShellConfig`
- **禁止管道符** `"on"|"off"` → 改为 `string`
- 保持简洁：`+methodName(param): ReturnType`

### 4. 集合和映射类型的简化命名

Mermaid 类图不支持 TypeScript/Java 的泛型语法（如 `Record<string, T>`、`Set<T>`），必须使用简化的命名：

| 原始类型 | 简化表示 | 说明 |
|---------|---------|------|
| `Record<string, T>` | `Map` 或 `Dict` | 键值对映射 |
| `Record<string, string>` | `EnvMap` | 环境变量映射 |
| `Record<string, SafeBinProfile>` | `ProfileMap` | 配置文件映射 |
| `Set<string>` | `SetString` 或 `StringSet` | 字符串集合 |
| `Map<string, T>` | `KeyMap` 或 `StringKeyMap` | 键映射 |
| `T[]` 或 `Array<T>` | `TList` 或 `TArray` | 列表/数组 |
| `Partial<T>` | `PartialT` | 部分类型 |
| `Readonly<T>` | `ReadonlyT` | 只读类型 |

### 5. 内联对象的简化

内联对象（如 `{min, max}`）会导致解析失败，改为简单类型名：

| 原始表示 | 简化表示 |
|---------|---------|
| `{min, max}` | `MinMax` |
| `{width, height}` | `Dimensions` |
| `{x, y}` | `Point` 或 `Coords` |
| `{key, value}` | `KeyValue` |

### 6. 联合类型和可选类型的简化

Mermaid 不支持 `|` 分隔的联合类型和 `?` 可选标记：

| 原始表示 | 简化表示 |
|---------|---------|
| `"on" \| "off" \| "auto"` | `String` 或 `OnOffMode` |
| `T \| null \| undefined` | `TOrNull` 或 `OptionalT` |
| `flag?: boolean` | `flag?: boolean` (保留原样) |

### 7. 关系标签

关系标签中避免使用特殊字符：
- 空格可用下划线替换：`host_gateway` 而不是 `host gateway`
- 避免 `=` 等符号在标签中出现

### 8. 文件编码

- 对含有 Mermaid 图表的 Markdown 文件，使用 `Write` 工具重写整个文件，不要使用 PowerShell 的 `Get-Content | Set-Content` 管道操作（会破坏 UTF-8 编码）
- 同样避免用 `SearchReplace` 工具批量替换 `--&gt;` → `-->` 这类 HTML 实体（工具会自动转义）

### 正确示例

```mermaid
classDiagram
    direction TB

    class AgentTool {
        +name: string
        +execute(toolCallId, args, signal): AgentToolResult
    }
    <<interface>> AgentTool

    class ExecToolFactory {
        +createExecTool(defaults): AgentTool
    }

    AgentTool <|.. ExecToolFactory : implements
    ExecToolFactory --> ProcessSupervisor : calls
    ExecToolFactory ..> ManagedRun : returns
```
