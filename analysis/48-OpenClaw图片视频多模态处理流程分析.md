# OpenClaw 图片/视频多模态处理流程分析

> 分析目标：用户给 OpenClaw 一个图片或视频地址，且配置的模型支持多模态时，OpenClaw 的完整处理流程。
> 涉及源码版本：本仓库 `d:\prj\openclaw_analyze`（上游 https://github.com/openclaw/openclaw）。

---

## 一、核心结论

OpenClaw 对入站媒体有**两条并行路径**，在 `runCapability` 处分流（`src/media-understanding/runner.ts:707-741`）：

| 媒体     | 主模型支持 vision？            | 处理方式                                                                                              |
| -------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **图片** | 是（`model.input` 含 `image`） | media-understanding 的图片描述被**跳过**，图片经压缩后作为 `ImageContent`（base64）**原生注入主模型** |
| **图片** | 否                             | 用独立"描述模型"（`describeImage`）生成文字描述，注入 prompt                                          |
| **视频** | 无论是否                       | 主模型**永远不直接收视频**；走 `describeVideo` 描述 provider（如 Moonshot/Gemini）转成文本            |
| **音频** | —                              | 走 `transcribeAudio` 转录成文本                                                                       |

---

## 二、全景流程图

```mermaid
flowchart TB
    U[用户发送图片/视频] --> CH[Channel 适配层<br/>Telegram/WhatsApp/Slack/Signal...]
    CH --> D[下载媒体到本地<br/>填充 MediaPaths/MediaTypes]
    D --> F[finalizeInboundContext<br/>规范化 MsgContext]
    F --> AMU[applyMediaUnderstanding]

    AMU --> NORM[normalizeMediaAttachments<br/>提取附件列表 path/url/mime]
    NORM --> CAP[image / audio / video 三能力并发]

    CAP --> IMG{capability=image?}
    IMG -->|是| V{modelSupportsVision<br/>主模型 input 含 image?}
    V -->|是| SKIP[outcome=skipped<br/>转原生注入路径]
    V -->|否| PROV1[describeImage 描述模型]
    IMG -->|否| VIDEO{capability=video?}
    VIDEO -->|是| PROV2[describeVideo 描述模型<br/>base64 超限则 skip]
    VIDEO -->|否| PROV3[transcribeAudio 转录]

    PROV1 --> FMT[formatMediaUnderstandingBody<br/>Image Description 注入 Body]
    PROV2 --> FMT[Video Description 注入 Body]
    PROV3 --> FMT[Transcript 注入 Body]
    SKIP --> NOTE[buildInboundMediaNote<br/>生成 media attached 注记]
    FMT --> NOTE

    NOTE --> AR[agent-runner 启动 Pi Embedded Runner]
    AR --> DET{model.input<br/>含 image?}
    DET -->|是| LOAD[detectAndLoadPromptImages<br/>正则识别路径引用]
    LOAD --> SEC[sandbox/localRoots 安全校验]
    SEC --> LWM[loadWebMedia<br/>本地读取或 SSRF 防护下载<br/>HEIC转JPEG/压缩至6MB内]
    LWM --> B64[转 base64 ImageContent]
    B64 --> PROMPT[session.prompt 带图片]
    DET -->|否/无图片| PROMPT2[session.prompt 纯文本]
    PROMPT --> LLM[多模态主模型推理]
    PROMPT2 --> LLM
    LLM --> REPLY[回复发回渠道]
```

---

## 三、序列图

### 3.1 图片 + vision 主模型（原生注入路径）

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant CH as Channel适配层
    participant GR as getReply
    participant MU as MediaUnderstanding
    participant AR as EmbeddedRunner(attempt)
    participant IL as PromptImageLoader
    participant WM as loadWebMedia
    participant LLM as 主模型

    U->>CH: 发送图片消息
    CH->>CH: 下载媒体到本地临时目录
    CH->>GR: MsgContext{Body, MediaPaths, MediaTypes}
    GR->>GR: finalizeInboundContext(ctx)

    GR->>MU: applyMediaUnderstanding(ctx, activeModel)
    MU->>MU: runCapability(image)
    MU->>MU: 查模型目录 modelSupportsVision=true
    Note over MU: outcome=skipped<br/>主模型原生支持视觉，跳过描述
    MU->>MU: buildInboundMediaNote(ctx)
    Note over MU: Body/Prompt 附加<br/>[media attached: /tmp/x.jpg (image/jpeg)]
    MU-->>GR: 理解结果写回 ctx

    GR->>AR: runReplyAgent(effectivePrompt)
    AR->>IL: detectAndLoadPromptImages(prompt, model)
    IL->>IL: modelSupportsImages(model)=true
    IL->>IL: detectImageReferences(prompt)<br/>匹配 [media attached...]/file:///本地路径
    IL->>IL: loadImageFromRef + sandbox 校验
    IL->>WM: loadWebMedia(path, maxBytes=6MB)
    WM->>WM: 压缩 resizeToJpeg / HEIC转换 / EXIF归一
    WM-->>IL: {buffer, contentType, kind=image}
    IL->>IL: buffer转base64 + sanitizeImageBlocks
    IL-->>AR: ImageContent[{type:image, data, mimeType}]

    AR->>LLM: session.prompt(prompt, {images})
    LLM-->>AR: 文本回复（原生"看懂"图片）
    AR-->>U: 渠道发送回复
```

### 3.2 视频（描述 provider 路径）

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant CH as Channel适配层
    participant GR as getReply
    participant MU as MediaUnderstanding
    participant C as MediaAttachmentCache
    participant P as describeVideo Provider
    participant LLM as 主模型

    U->>CH: 发送视频消息
    CH->>CH: 下载视频到本地
    CH->>GR: MsgContext{MediaPaths, MediaTypes=video/mp4}
    GR->>MU: applyMediaUnderstanding(ctx, activeModel)

    MU->>MU: runCapability(video)
    Note over MU: 不检查主模型vision<br/>视频永远走描述路径
    MU->>MU: resolveModelEntries / resolveAutoEntries<br/>找到已配置API key的video provider
    MU->>C: getBuffer(index, maxBytes)
    C->>C: 本地读取/下载, 校验大小
    C-->>MU: {buffer, fileName, mime}
    MU->>MU: estimateBase64Size > 限制则skip
    MU->>P: describeVideo(buffer, mime, apiKey, prompt)
    P-->>MU: {text: 视频内容描述}
    MU->>MU: formatMediaUnderstandingBody
    Note over MU: ctx.Body = [Video] Description: 描述文本
    GR->>LLM: session.prompt(纯文本含视频描述)
    LLM-->>U: 基于文字描述回答
```

---

## 四、类图

```mermaid
classDiagram
    direction TB

    class MsgContext {
        +Body: string
        +MediaPath: string
        +MediaPaths: StringList
        +MediaTypes: StringList
        +MediaUnderstanding: OutputList
        +MediaUnderstandingDecisions: DecisionList
        +Transcript: string
    }

    class MediaAttachment {
        +path: string
        +url: string
        +mime: string
        +index: number
    }

    class MediaAttachmentCache {
        +getBuffer(params): MediaBufferResult
        +getPath(params): MediaPathResult
    }

    class MediaUnderstandingProvider {
        +id: string
        +transcribeAudio(req): AudioTranscriptionResult
        +describeImage(req): ImageDescriptionResult
        +describeVideo(req): VideoDescriptionResult
    }
    <<interface>> MediaUnderstandingProvider

    class MediaUnderstandingApplier {
        +applyMediaUnderstanding(params): Result
    }

    class CapabilityRunner {
        +runCapability(params): RunCapabilityResult
    }

    class EntryRunner {
        +runProviderEntry(params): MediaUnderstandingOutput
        +runCliEntry(params): MediaUnderstandingOutput
    }

    class MediaNoteBuilder {
        +buildInboundMediaNote(ctx): string
    }

    class PromptImageLoader {
        +detectImageReferences(prompt): DetectedImageRefList
        +loadImageFromRef(ref, workspaceDir, options): ImageContentOrNull
        +modelSupportsImages(model): boolean
        +detectAndLoadPromptImages(params): PromptImageResult
    }

    class WebMediaLoader {
        +loadWebMedia(url, options): WebMediaResult
    }

    class RemoteMediaFetcher {
        +fetchRemoteMedia(options): FetchMediaResult
    }

    class ModelCatalogHelper {
        +modelSupportsVision(entry): boolean
        +findModelInCatalog(catalog, provider, modelId): ModelCatalogEntry
    }

    class EmbeddedRunnerAttempt {
        +detectAndLoadPromptImages调用
        +session.prompt(prompt, options)
    }

    MediaUnderstandingApplier --> CapabilityRunner : image/audio/video并发
    CapabilityRunner --> EntryRunner : 每个附件依次尝试
    CapabilityRunner --> ModelCatalogHelper : vision判定仅image
    EntryRunner --> MediaAttachmentCache : 惰性读buffer/path
    EntryRunner --> MediaUnderstandingProvider : describe/transcribe
    MediaAttachmentCache --> WebMediaLoader : 加载媒体
    WebMediaLoader --> RemoteMediaFetcher : http(s)下载
    MediaUnderstandingApplier --> MediaNoteBuilder : 未理解附件生成注记
    EmbeddedRunnerAttempt --> PromptImageLoader : attempt.ts
    PromptImageLoader --> WebMediaLoader : loadImageFromRef
    MsgContext ..> MediaAttachment : normalizeMediaAttachments
```

---

## 五、关键类与代码对照

### 1. 渠道入站：媒体下载 → MsgContext

| 环节                                                           | 代码                                                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 各渠道下载媒体并填充 `MediaPaths/MediaTypes`                   | `extensions/telegram/src/bot-message-context.body.ts:188`、`extensions/slack/src/monitor/message-handler/prepare.ts:720` 等 |
| 统一 payload 构建器                                            | `buildMediaPayload` — `src/channels/plugins/media-payload.ts:15-33`                                                         |
| MsgContext 规范化（MediaType 兜底 `application/octet-stream`） | `finalizeInboundContext` — `src/auto-reply/reply/inbound-context.ts:37-128`                                                 |

### 2. 理解子系统：`src/media-understanding/`

| 环节                                                     | 代码                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **总入口**（get-reply 中调用）                           | `src/auto-reply/reply/get-reply.ts:129` → `applyMediaUnderstanding` — `src/media-understanding/apply.ts:466-549` |
| 三能力并发执行 + **vision 跳过判定（核心分流点）**       | `runCapability` — `src/media-understanding/runner.ts:659-768`，跳过逻辑在 `runner.ts:707-741`                    |
| provider/CLI 调用、视频 base64 上限校验                  | `runner.entries.ts:539-586`                                                                                      |
| provider 接口定义                                        | `MediaUnderstandingProvider` — `src/media-understanding/types.ts:109-115`                                        |
| 视频描述 provider 示例（Moonshot `video_url` base64）    | `src/media-understanding/providers/moonshot/video.ts`                                                            |
| 描述文本格式化进 Body（`[Video] Description:`）          | `formatMediaUnderstandingBody` — `src/media-understanding/format.ts:32-91`                                       |
| 自动选择有 key 的 provider（`AUTO_VIDEO_KEY_PROVIDERS`） | `resolveKeyEntry` — `src/media-understanding/runner.ts:340-422`                                                  |

### 3. 原生图片注入：`src/agents/pi-embedded-runner/run/`

| 环节                                                                               | 代码                                                                                                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **调用点**：prompt 前检测图片                                                      | `attempt.ts:2914`                                                                                                                            |
| **传给模型**：`session.prompt(prompt, {images})`                                   | `attempt.ts:2988-2994`                                                                                                                       |
| 模型能力检查 `model.input.includes("image")`                                       | `modelSupportsImages` — `src/agents/pi-embedded-runner/run/images.ts:271-273`；`modelSupportsVision` — `src/agents/model-catalog.ts:286-288` |
| 正则识别路径引用（`[media attached:...]`/`file://`/本地路径；**http URL 被忽略**） | `detectImageReferences` — `images.ts:94-184`                                                                                                 |
| 单图加载（sandbox 校验 → loadWebMedia → base64）                                   | `loadImageFromRef` — `images.ts:194-263`                                                                                                     |
| 主流程编排 + 尺寸消毒                                                              | `detectAndLoadPromptImages` — `images.ts:285-360`                                                                                            |

### 4. 媒体加载与安全

| 环节                                                         | 代码                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **统一媒体加载器**（本地读 + URL 下载 + 图片压缩）           | `loadWebMedia` — `extensions/whatsapp/src/media.ts:404-413`，核心 `loadWebMediaInternal:233-402` |
| 远程下载（SSRF 防护 `fetchWithSsrFGuard`、maxBytes、重定向） | `fetchRemoteMedia` — `src/media/fetch.ts:93-251`                                                 |
| 图片压缩网格（2048~800px × 质量 80~40）+ HEIC→JPEG           | `optimizeImageToJpeg` — `extensions/whatsapp/src/media.ts:426-491`                               |
| 本地路径白名单（`localRoots`，防符号链接逃逸）               | `assertLocalMediaAllowed` — `extensions/whatsapp/src/media.ts:81-138`                            |
| sandbox 路径校验                                             | `resolveSandboxedMediaSource` — `src/agents/sandbox-paths.ts:88`                                 |
| **大小上限**：图片 6MB / 音频 16MB / 视频 16MB / 文档 100MB  | `src/media/constants.ts:1-4`                                                                     |

### 5. 注记生成

未理解的附件由 `buildInboundMediaNote`（`src/auto-reply/media-note.ts:49-154`）生成 `[media attached: /tmp/a.png (image/png) | url]` 行注入 prompt——这正是第 3 节正则识别的输入来源，形成闭环：agent 据此可以用 `read` 工具访问文件，或被原生注入为图片。

---

## 六、值得注意的设计细节

1. **决策点在 `runCapability` 而非渠道**：分流逻辑统一收敛在 media-understanding 层，渠道只负责下载和填充 `MediaPaths`，与模型能力解耦。
2. **图片 URL 不走原生注入**：`detectImageReferences`（`images.ts:151`）明确注释 _"Remote HTTP(S) URLs are intentionally ignored. Native image injection is local-only."_——远程图片依赖渠道先下载落地，或由 media-understanding 的 provider 直接下载。
3. **视频只有"描述"一条路**：即使主模型是 Gemini 这类视频多模态模型，主对话通道也不传视频二进制（`ImageContent` 仅支持 image），视频经 `describeVideo` 转成 `[Video] Description:` 文本。
4. **图片只在 prompt 局部生效**（`attempt.ts:2912-2913` 注释 _"Images are prompt-local only (pi-like behavior)"_），历史消息中的已处理图片块会被 `pruneProcessedHistoryImages`（`attempt.ts:2907`）清理以省 token。
5. **幂等降级链**：provider 失败 → 尝试下一个 entry → 全部失败则 attachments 保持原样，由 media-note 注记兜底，agent 仍可通过文件工具访问原始媒体。
6. **安全边界**：本地读取受 `localRoots` 白名单约束；远程下载经过 SSRF 防护（私网地址/非 http 协议拒绝）、重定向次数限制与 maxBytes 硬上限；sandbox 模式下还要过 `resolveSandboxedMediaSource` 校验。
