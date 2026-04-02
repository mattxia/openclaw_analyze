# OpenClaw共享用户Cookie的Profile配置指南

如果你需要让OpenClaw复用你本地浏览器中已保存的Cookie、登录态、用户配置等信息，可以通过以下三种Profile配置方案实现，根据你的需求选择合适的方式：

---

## 一、三种实现方案对比
| 方案 | 实现方式 | 是否需要插件 | 适用场景 | 特点 |
|------|---------|-------------|---------|------|
| 方案1（推荐） | 内置`user` Profile（Chrome DevTools MCP） | ❌ 不需要 | 需要完全复用整个浏览器的所有登录态和配置 | Chrome 144+原生支持，自动连接到你正在运行的Chrome实例，无需修改启动参数 |
| 方案2 | 扩展中继模式 | ✅ 需要 | 仅需要控制单个特定标签页，复用该标签页的登录态 | 安全性更高，仅控制你手动点击附加的标签页，不会访问其他标签页 |
| 方案3 | 自定义用户数据目录 | ❌ 不需要 | 需要完全复刻你的浏览器配置，在OpenClaw托管浏览器中使用 | 启动独立的浏览器实例，完全使用你指定的用户数据目录 |

---

## 二、方案1：内置`user` Profile（推荐，无需插件）
### 1. 实现原理
基于Chrome官方的DevTools MCP协议，可以直接附加到你正在运行的Chrome实例，完全复用所有已打开的标签页、Cookie、登录态、插件配置等。

### 2. 前置要求
- Chrome版本 ≥ 144
- 开启Chrome远程调试功能

### 3. 配置步骤
1. 在Chrome地址栏打开 `chrome://inspect/#remote-debugging`
2. 勾选"启用远程调试"选项
3. OpenClaw内置了`user` profile，无需额外配置

### 4. 验证连接
```bash
# 查看user profile状态
openclaw browser --browser-profile user status
# 查看当前Chrome中所有打开的标签页（包含你已登录的网站）
openclaw browser --browser-profile user tabs
# 测试页面快照
openclaw browser --browser-profile user snapshot
```

### 5. 智能体调用方式
智能体调用browser工具时指定`profile="user"`即可：
```python
# 示例：操作你已登录的GitHub页面
browser(
    action="navigate",
    url="https://github.com",
    profile="user"
)
```

---

## 三、方案2：扩展中继模式（控制单个标签页）
### 1. 实现原理
通过Chrome扩展将特定标签页的CDP接口暴露给OpenClaw，仅控制你手动附加的标签页，不会影响其他标签页。

### 2. 配置步骤
1. 安装OpenClaw浏览器扩展：
```bash
openclaw browser extension install
# 获取扩展目录路径
openclaw browser extension path
```
2. 打开Chrome扩展管理页面 `chrome://extensions`
3. 开启"开发者模式"，点击"加载已解压的扩展程序"，选择上面输出的目录
4. 固定扩展到工具栏，打开你需要控制的标签页，点击扩展图标（徽章显示ON表示附加成功）

### 3. 配置示例（可选自定义）
默认自带`chrome` profile，也可自定义：
```json5
// ~/.openclaw/openclaw.json
{
  "browser": {
    "profiles": {
      "my-chrome": {
        "name": "my-chrome",
        "driver": "extension",
        "cdpUrl": "http://127.0.0.1:18792",
        "color": "#00AA00"
      }
    }
  }
}
```

### 4. 使用方式
```bash
# 查看已附加的标签页
openclaw browser --browser-profile chrome tabs
# 执行操作
openclaw browser --browser-profile chrome click <ref>
```

---

## 四、方案3：自定义Profile复用用户数据目录
### 1. 实现原理
启动OpenClaw托管的独立浏览器实例时，直接使用你现有的Chrome用户数据目录，完全复刻你的浏览器配置、Cookie、扩展等。

### 2. 配置方式
```json5
// ~/.openclaw/openclaw.json
{
  "browser": {
    "profiles": {
      "my-personal-chrome": {
        "name": "my-personal-chrome",
        "driver": "chrome",
        // 指定你的Chrome用户数据目录路径
        "userDataDir": "C:/Users/你的用户名/AppData/Local/Google/Chrome/User Data", // Windows
        // "userDataDir": "~/Library/Application Support/Google/Chrome", // macOS
        // "userDataDir": "~/.config/google-chrome", // Linux
        "cdpPort": 18802,
        "color": "#00CCFF"
      }
    }
  }
}
```

### 3. 注意事项
- 使用此模式时，需要关闭你正在运行的Chrome实例，否则会出现用户目录锁定冲突
- 如果你需要同时使用个人浏览器和OpenClaw控制，建议使用方案1或方案2

---

## 五、全局默认配置
如果需要默认使用共享用户Cookie的模式，可以设置默认Profile：
```json5
// ~/.openclaw/openclaw.json
{
  "browser": {
    "defaultProfile": "user" // 或 chrome / 自定义profile名称
  }
}
```

---

## 六、安全注意事项
1. **风险提示**：以上模式都会让OpenClaw获得你浏览器的登录态访问权限，相当于可以以你的身份操作所有已登录的网站，请谨慎使用
2. **最小权限原则**：如果只需要操作单个网站，优先使用扩展中继模式，仅附加需要控制的标签页
3. **权限确认**：使用`user` profile时，Chrome会弹出连接确认提示，需要你手动同意后才能连接
4. **隔离建议**：对于不可信的Skill或自动化任务，建议仍然使用默认的隔离`openclaw` profile，避免泄露个人敏感信息
