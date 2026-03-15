# Pi-Agent 集成单元测试分析

## 🔍 项目中的 Pi-Agent 相关测试文件
| 测试文件 | 测试内容 | 类型 |
|---------|---------|------|
| **`src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.e2e.test.ts`** | **核心集成测试**，测试 Pi-Agent 运行的上层控制逻辑，包括认证轮换、故障转移、错误处理 | E2E 集成测试 |
| `src/agents/pi-embedded-runner.resolvesessionagentids.test.ts` | 测试会话代理ID解析逻辑 | 单元测试 |
| `src/agents/pi-tools-agent-config.test.ts` | 测试 Pi-Agent 工具集与代理配置的集成 | 单元测试 |

---

## 🎯 核心集成测试设计分析（重点）
`pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.e2e.test.ts` 是专门测试 Pi-Agent 集成逻辑的完整测试套件，设计非常精妙：

### 1. 测试思路
采用 **分层Mock** 设计，只测试上层控制逻辑，不需要调用真实AI模型：
```typescript
// 把底层的单次执行逻辑完全 Mock 掉，只测试上层 runEmbeddedPiAgent 的故障转移、重试、认证轮换逻辑
vi.mock("./pi-embedded-runner/run/attempt.js", () => ({
  runEmbeddedAttempt: (params: unknown) => runEmbeddedAttemptMock(params),
}));
```
✅ **优势**：测试运行速度极快，不依赖网络和AI服务，完全可控，覆盖各种异常场景

### 2. 主要测试场景
| 测试用例 | 测试目标 |
|---------|---------|
| 🔑 Copilot token 自动刷新 | 认证错误时自动刷新 Copilot token 并重试 |
| 🔄 API 密钥轮换 | 当一个 API 密钥限流/过期/报错时，自动切换到下一个备用密钥 |
| 🚦 冷却策略 | 失败的密钥会进入冷却期，避免短时间内重复尝试 |
| 🚨 错误分类处理 | 不同错误类型（限流、认证错误、账单不足）采用不同的重试策略 |
| 📊 使用统计 | 正确记录每个密钥的使用情况和失败统计 |
| 🔌 模型故障转移 | 主模型失败时自动切换到配置的 fallback 模型 |

### 3. 测试覆盖的核心集成逻辑
这个测试完整覆盖了 `run.ts` 中的核心故障转移逻辑：
- 多认证 profile 轮询机制
- 错误分类和重试策略
- 上下文溢出自动压缩重试
- 超时和取消逻辑
- 会话和沙箱隔离

---

## ✅ 测试运行方法
运行所有 Pi-Agent 相关测试：
```bash
pnpm test pi-embedded-runner
```
运行单个测试文件：
```bash
pnpm test src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.e2e.test.ts
```

---

## 📝 测试设计亮点
1. **高内聚低耦合**：通过 Mock 底层依赖，只测试集成逻辑，不依赖真实AI服务
2. **异常场景优先**：大部分测试用例都是异常场景，保证系统鲁棒性
3. **真实环境模拟**：模拟真实的配置文件、认证存储、错误返回，和生产行为一致
4. **无副作用**：所有测试都在临时目录运行，测试完成自动清理，不会污染本地环境

这种测试设计非常值得学习，既保证了集成逻辑的正确性，又避免了集成测试通常会有的速度慢、不稳定、依赖外部服务等问题。
