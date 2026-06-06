# OpenClaw Agent 与 Node 能力路由分析

## 场景描述

```
设备A                                    设备B                                    设备C
┌─────────────────────────────────┐    ┌─────────────────────────────────┐    ┌─────────────────────────────────┐
│ OpenClaw AgentA                  │    │ OpenClaw AgentB                  │    │ OpenClaw Node (设备C)            │
│ - 通用AI处理能力                  │    │ - 任务编排Agent                   │    │ - 设备能力 (摄像头、屏幕等)        │
│ - 代码执行工具                    │    │ - 调用其他Agent/Node              │    │ - 设备控制命令                    │
│ - 文件处理工具                    │    │ - 能力路由决策                     │    │ - camera.snap, screen.record等   │
│ Session: agent:agentA:main        │    │ Session: agent:agentB:main        │    │ NodeId: node-device-C            │
└─────────────────────────────────┘    └─────────────────────────────────┘    └─────────────────────────────────┘
                                          │                                        │
                                          │                                        │
                                          └──────────────┬─────────────────────────┘
                                                         │
                                                    ┌────┴────┐
                                                    │ Gateway  │
                                                    │ (中央协调) │
                                                    └──────────┘
```

## 一、核心概念区分

### 1.1 Node vs Agent 能力模型

```mermaid
classDiagram
    direction LR
    
    class Agent {
        <<实体>>
        +sessionKey: string
        +tools: AgentTool[]
        +capabilities: AI能力
    }
    
    class Node {
        <<设备>>
        +nodeId: string
        +platform: ios/android
        +caps: DeviceCapability[]
        +commands: DeviceCommand[]
    }
    
    class AgentTool {
        +name: string
        +description: string
        +execute() ToolResult
    }
    
    class DeviceCommand {
        +command: string
        +description: string
        +execute() DeviceResult
    }
    
    Agent "1" --> "*" AgentTool : 拥有
    Node "1" --> "*" DeviceCommand : 提供
    
    note for Agent "执行AI任务<br/>如: 写代码、分析、推理"
    note for Node "控制设备硬件<br/>如: 拍照、录音、屏幕录制"
```

### 1.2 能力类型对比

| 维度 | Agent (AgentA) | Node (设备C) |
|------|----------------|--------------|
| **本质** | AI 处理能力 | 设备硬件能力 |
| **执行位置** | Gateway/沙箱 | 设备本地 |
| **工具** | LLM + Tools | 设备命令 |
| **示例** | 写代码、分析数据 | 拍照、录屏 |
| **发现方式** | sessions_list | nodes.list |
| **调用方式** | sessions_send | node.invoke |
| **会话模型** | Session Key | Node ID |

---

## 二、AgentB 如何发现能力

### 2.1 能力发现流程图

```mermaid
sequenceDiagram
    participant AgentB
    participant Gateway as Gateway
    participant ToolCatalog as Tool Catalog
    participant AgentA
    participant NodeC as Node (设备C)
    
    Note over AgentB: AgentB 启动，需要了解可用能力
    
    rect rgb(200, 220, 240)
        Note over AgentB,ToolCatalog: 1. 发现内置工具
        AgentB->>ToolCatalog: 获取工具列表
        ToolCatalog-->>AgentB: exec, read, write, search...
    end
    
    rect rgb(220, 240, 200)
        Note over AgentB,Gateway: 2. 发现其他Agent会话
        AgentB->>Gateway: sessions.list
        Gateway-->>AgentB: 活跃会话列表
        Note over AgentB: agent:agentA:main (AI处理)<br/>agent:agentA:coding (代码专用)
    end
    
    rect rgb(240, 220, 200)
        Note over AgentB,Gateway: 3. 发现Node设备
        AgentB->>Gateway: node.list
        Gateway-->>AgentB: 已连接设备列表
        Note over AgentB: node-device-C (iPhone)<br/>caps: camera, screen, location...
    end
    
    rect rgb(200, 240, 220)
        Note over AgentB: 4. LLM 理解能力上下文
        AgentB->>AgentB: 理解各能力用途<br/>决定何时调用Agent<br/>决定何时调用Node
    end
```

### 2.2 能力描述对比

**AgentA 的能力描述**（通过工具元数据）:
```json
{
  "name": "sessions_send",
  "description": "Send a message into another session. Use sessionKey or label to identify the target.",
  "parameters": {
    "sessionKey": "Target agent session",
    "message": "Task description"
  }
}
```

**设备C 的能力描述**（通过 node.describe）:
```json
{
  "nodeId": "node-device-C",
  "displayName": "iPhone 15 Pro",
  "platform": "ios",
  "caps": ["camera", "screen", "location", "photos"],
  "commands": [
    "camera.snap",
    "screen.record",
    "location.get",
    "system.run"
  ]
}
```

---

## 三、能力路由决策机制

### 3.1 决策流程图

```mermaid
flowchart TD
    A["AgentB 收到任务"] --> B{"任务类型判断"}
    
    B -->|"拍照/录屏"| C["调用 nodes 工具"]
    B -->|"AI分析/代码"| D["调用 sessions_send"]
    B -->|"文件操作"| E{"位置判断"}
    
    C --> C1["nodes.invoke<br/>command: camera.snap"]
    C --> C2["nodes.invoke<br/>command: screen.record"]
    
    D --> D1["sessions_send<br/>sessionKey: agent:agentA:main"]
    D --> D2["sessions_send<br/>sessionKey: agent:agentA:coding"]
    
    E -->|"本地文件"| E1["exec / read 工具"]
    E -->|"远程处理"| E2["sessions_send"]
    
    style C fill:#87CEEB
    style D fill:#90EE90
    style E fill:#FFD700
```

### 3.2 LLM 决策逻辑

AgentB 的 LLM 基于以下信号做出路由决策：

```mermaid
sequenceDiagram
    participant LLM as AgentB 的 LLM
    participant Context as 能力上下文
    
    Note over LLM: 任务: "帮我拍一张照片并分析其中的内容"
    
    LLM->>Context: 解析任务需求
    Context-->>LLM: 需要: 1)拍照 2)图像分析
    
    LLM->>Context: 查询拍照能力
    Context-->>LLM: Node设备C有 camera.snap<br/>AgentA 有图像分析能力
    
    rect rgb(200, 220, 240)
        Note over LLM: 决策点 1: 拍照
        LLM->>LLM: 拍照需要设备硬件
        LLM->>LLM: 应该调用 nodes.invoke(camera.snap)
    end
    
    rect rgb(220, 240, 200)
        Note over LLM: 决策点 2: 图像分析
        LLM->>LLM: 分析是AI处理任务
        LLM->>LLM: 应该调用 sessions_send(agentA)
    end
    
    LLM->>Context: 执行拍照
    Context-->>LLM: 照片数据
    LLM->>Context: 发送照片给AgentA分析
    Context-->>LLM: 分析结果
```

---

## 四、典型场景实现

### 场景：拍照 + AI 分析

**目标**：AgentB 让设备C拍照，然后由 AgentA 分析照片内容

#### 4.1 实现流程图

```mermaid
sequenceDiagram
    participant User
    participant AgentB
    participant Gateway as Gateway
    participant NodeC as Node (设备C)
    participant AgentA as AgentA
    
    User->>AgentB: 帮我拍一张照片并分析内容
    
    rect rgb(200, 220, 240)
        Note over AgentB,NodeC: 步骤1: 拍照
        AgentB->>Gateway: nodes.invoke
        Note over Gateway: nodeId: node-device-C
        Note over Gateway: command: camera.snap
        Gateway->>NodeC: camera.snap 命令
        NodeC-->>Gateway: 照片数据 (base64)
        Gateway-->>AgentB: { payload: photoData }
    end
    
    rect rgb(220, 240, 200)
        Note over AgentB,AgentA: 步骤2: AI分析
        AgentB->>Gateway: sessions.send
        Note over Gateway: sessionKey: agent:agentA:main
        Note over Gateway: message: 分析这张照片
        Note over Gateway: attachments: photoData
        Gateway->>AgentA: 触发AgentA执行
        AgentA-->>Gateway: 分析结果
        Gateway-->>AgentB: 分析结果
    end
    
    AgentB-->>User: 照片分析结果
```

#### 4.2 核心代码实现

**AgentB 的任务编排逻辑**:

```typescript
// AgentB 收到任务: "拍照并分析"
async function handleTask(task: string) {
  // 1. 发现可用能力
  const nodes = await gateway.call("node.list");
  const sessions = await gateway.call("sessions.list");
  
  // 2. 决策: 拍照 -> Node, 分析 -> AgentA
  const deviceC = nodes.find(n => n.caps.includes("camera"));
  
  // 3. 调用 Node 拍照
  const photoResult = await gateway.call("node.invoke", {
    nodeId: deviceC.nodeId,
    command: "camera.snap",
    params: { facing: "back" }
  });
  
  // 4. 将照片发送给 AgentA 分析
  const analysisResult = await gateway.call("sessions.send", {
    sessionKey: "agent:agentA:main",
    message: "请分析这张照片的内容",
    attachments: [{ type: "image", data: photoResult.payload }]
  });
  
  return analysisResult;
}
```

**nodes.invoke 调用**:

```typescript
// 文件: nodes-tool.ts
async function invokeNodeCommandPayload(params: {
  node: string;
  command: string;
  commandParams?: Record<string, unknown>;
}) {
  // 解析目标 Node
  const nodeId = await resolveNodeId(gatewayOpts, params.node);
  
  // 调用 Gateway 的 node.invoke 方法
  const raw = await callGatewayTool("node.invoke", gatewayOpts, {
    nodeId,
    command: params.command,
    params: params.commandParams ?? {},
    idempotencyKey: crypto.randomUUID(),
  });
  
  return raw?.payload ?? {};
}

// 使用示例
const photo = await invokeNodeCommandPayload({
  node: "node-device-C",  // 指定设备
  command: "camera.snap",
  commandParams: { facing: "back", maxWidth: 1920 }
});
```

**sessions.send 调用**:

```typescript
// 文件: sessions-send-tool.ts
async function sendToAgent(params: {
  targetSessionKey: string;
  message: string;
  attachments?: Attachment[];
}) {
  // 解析目标会话
  const resolved = await gateway.call("sessions.resolve", {
    label: params.targetSessionKey
  });
  
  // 调用 agent.send
  const response = await gateway.call("agent", {
    sessionKey: resolved.key,
    message: params.message,
    attachments: params.attachments,
    lane: "nested",
    extraSystemPrompt: buildAgentContext()
  });
  
  return response;
}

// 使用示例
const analysis = await sendToAgent({
  targetSessionKey: "agent:agentA:main",
  message: "请分析这张照片的内容",
  attachments: [{ type: "image", data: photo }]
});
```

---

## 五、能力选择策略

### 5.1 能力匹配矩阵

| 任务需求 | Node (设备C) | AgentA | 优先级说明 |
|---------|-------------|--------|-----------|
| 拍照 | ✅ camera.snap | ❌ | 硬件操作，Node专有 |
| 录屏 | ✅ screen.record | ❌ | 硬件操作，Node专有 |
| 获取位置 | ✅ location.get | ❌ | 硬件操作，Node专有 |
| AI代码生成 | ❌ | ✅ LLM | AI处理，Agent专有 |
| 文件分析 | ❌ | ✅ LLM + Tools | AI处理，Agent专有 |
| 发送通知 | ✅ system.notify | ❌ | 硬件操作，Node专有 |
| 复杂推理 | ❌ | ✅ LLM | AI处理，Agent专有 |

### 5.2 决策规则

```mermaid
flowchart TD
    A["任务解析"] --> B{"涉及硬件?"}
    
    B -->|"是<br/>拍照/录音/定位等"| D["使用 nodes 工具"]
    B -->|"否"| C{"需要AI处理?"}
    
    C -->|"是<br/>分析/推理/生成"| E["使用 sessions_send"]
    C -->|"否"| F["使用内置工具<br/>exec/read/write"]
    
    D --> G["选择目标Node"]
    G --> G1{"多个Node?"}
    G1 -->|"是"| G2["基于能力匹配<br/>基于负载<br/>基于位置"]
    G1 -->|"否"| G3["使用唯一Node"]
    
    E --> H["选择目标Agent"]
    H --> H1{"多个Agent?"}
    H1 -->|"是"| H2["基于专长匹配<br/>agent:agentA:coding"]
    H1 -->|"否"| H3["使用默认Agent"]
```

### 5.3 多 Node/Agent 选择策略

当存在多个 Node 或 Agent 提供相似能力时：

```typescript
// 多 Node 选择策略
async function selectNode(task: Task): Promise<Node> {
  const nodes = await gateway.call("node.list");
  const capable = nodes.filter(n => 
    task.requiredCaps.every(cap => n.caps.includes(cap))
  );
  
  if (capable.length === 1) return capable[0];
  
  // 多于一个时，考虑:
  // 1. 设备类型匹配 (手机 vs 平板)
  // 2. 设备状态 (电量、在线状态)
  // 3. 位置邻近度 (如果任务有位置要求)
  return capable[0];
}

// 多 Agent 选择策略
async function selectAgent(task: Task): Promise<string> {
  const sessions = await gateway.call("sessions.list");
  const agentSessions = sessions.filter(s => 
    s.key.startsWith("agent:")
  );
  
  // 基于会话标签/名称匹配
  const label = resolveLabelFromTask(task);
  if (label) {
    const resolved = await gateway.call("sessions.resolve", { label });
    return resolved.key;
  }
  
  // 默认使用 main
  return "agent:main:main";
}
```

---

## 六、完整协作序列图

```mermaid
sequenceDiagram
    participant User
    participant AgentB
    participant Gateway
    participant NodeC
    participant AgentA
    
    Note over User,AgentA: 完整协作流程: 拍照 + 分析
    
    rect rgb(180, 180, 180)
        Note over User,Gateway: 初始化阶段
        NodeC->>Gateway: WebSocket 连接
        Note over NodeC: caps: camera, screen
        Gateway->>Gateway: NodeRegistry.register
        Note over Gateway: node-device-C
    end
    
    rect rgb(200, 200, 220)
        Note over User,AgentB: 任务发起
        User->>AgentB: 帮我拍照并分析内容
    end
    
    rect rgb(220, 200, 220)
        Note over AgentB,Gateway: 能力发现
        AgentB->>Gateway: node.list
        Gateway-->>AgentB: 设备列表
        Note over AgentB: node-device-C
        Note over AgentB: caps: camera, screen
        AgentB->>Gateway: sessions.list
        Gateway-->>AgentB: 会话列表
        Note over AgentB: agentA:main, agentA:coding
    end
    
    rect rgb(200, 220, 240)
        Note over AgentB,NodeC: 阶段1: 拍照
        AgentB->>Gateway: node.invoke
        Note over Gateway: nodeId: node-device-C
        Note over Gateway: command: camera.snap
        Note over Gateway: params: facing=back
        Gateway->>NodeC: camera.snap
        NodeC-->>Gateway: photoData
        Gateway-->>AgentB: payload: photoData
    end
    
    rect rgb(220, 240, 200)
        Note over AgentB,AgentA: 阶段2: 图像分析
        AgentB->>Gateway: sessions.send
        Note over Gateway: sessionKey: agent:agentA:main
        Note over Gateway: message: 分析照片
        Note over Gateway: attachments: photoData
        Gateway->>AgentA: 触发执行
        AgentA->>AgentA: 图像识别
        AgentA-->>Gateway: 分析结果
        Gateway-->>AgentB: text: 照片显示
    end
    
    rect rgb(200, 240, 220)
        Note over User,AgentB: 结果返回
        AgentB-->>User: 照片分析结果
    end
```

---

## 七、配置与策略

### 7.1 Node 连接配置

**设备C (Node)** 的配置：

```json5
{
  // 手机 App 配置
  caps: ["camera", "screen", "location", "photos"],
  commands: [
    "camera.snap",
    "screen.record",
    "location.get",
    "system.run"
  ],
  permissions: {
    "camera": true,
    "location": true
  }
}
```

### 7.2 Agent A2A 配置

**AgentB** 的 A2A 配置：

```json5
{
  tools: {
    // Agent 间通信策略
    agentToAgent: {
      enabled: true,
      allow: ["agentA", "agentB"]
    },
    // Node 访问策略
    nodes: {
      enabled: true,
      allow: ["*"]  // 允许访问所有配对设备
    }
  }
}
```

### 7.3 工具可见性配置

```json5
{
  tools: {
    sessions: {
      // Agent 会话可见性
      visibility: "all"  // 可看到所有 Agent 会话
    }
  }
}
```

---

## 八、总结

### 8.1 能力区分原则

| 原则 | Node (设备C) | AgentA |
|------|-------------|--------|
| **硬件控制** | ✅ | ❌ |
| **AI处理** | ❌ | ✅ |
| **实时感知** | ✅ (摄像头、麦克风) | ❌ |
| **复杂推理** | ❌ | ✅ |
| **数据处理** | ❌ | ✅ |

### 8.2 LLM 路由决策

AgentB 的 LLM 基于以下信息做出路由决策：

1. **任务语义分析** - 理解用户需要什么
2. **能力上下文** - 了解 nodes.list 和 sessions.list 的结果
3. **工具描述** - 基于工具的 description 和 parameters
4. **执行结果** - 根据前一步的结果决定后续步骤

### 8.3 关键代码位置

| 组件 | 文件路径 |
|------|---------|
| Node 注册 | [node-registry.ts](file:///d:/prj/openclaw_analyze/src/gateway/node-registry.ts) |
| Node 调用 | [nodes-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/nodes-tool.ts) |
| Session 发送 | [sessions-send-tool.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/sessions-send-tool.ts) |
| A2A 策略 | [sessions-access.ts](file:///d:/prj/openclaw_analyze/src/agents/tools/sessions-access.ts) |
| 工具目录 | [tool-catalog.ts](file:///d:/prj/openclaw_analyze/src/agents/tool-catalog.ts) |

---

## 九、扩展场景

### 9.1 多个 Node 提供相似能力

```
设备C: camera.snap, screen.record
设备D: camera.snap, camera.clip, screen.record
```

**选择策略**：
- 优先选择支持更多能力的设备
- 考虑设备当前状态（电量、是否空闲）
- 考虑位置因素（如果任务有位置依赖）

### 9.2 多个 Agent 提供相似能力

```
AgentA:main - 通用AI
AgentA:coding - 专门代码处理
AgentA:design - 专门设计
```

**选择策略**：
- 基于会话标签/名称匹配
- 基于历史交互记录
- 基于任务类型（编码 -> coding 会话）

### 9.3 能力组合

```
任务: "拍照 -> 分析 -> 生成代码 -> 在设备上运行"
       ↓        ↓         ↓         ↓
     NodeC   AgentA    AgentA    NodeC
   camera   分析结果   生成代码   system.run
```

AgentB 需要编排多个步骤，每个步骤可能调用不同的目标。
