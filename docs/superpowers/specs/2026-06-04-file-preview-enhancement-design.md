# 文件预览增强设计

日期：2026-06-04
范围：管理后台文件预览弹框与前端预览组件。

## 背景

当前 `PreviewDialog.tsx` 同时承载预览弹框、视频播放器、文本读取、Markdown 渲染和代码高亮逻辑。视频预览已经接入 Plyr 和分片视频 Service Worker，但控件较少、默认控件中文化和样式定制有限；音频在需求中提到，但 `previewKind()` 当前未返回 audio，实际无法进入音频预览。文本预览已有 JSON 格式化和基础高亮，但 XML、YAML 等结构化格式的视觉层次仍可提升。

## 目标

1. 将预览按文件类型组件化，降低 `PreviewDialog` 职责。
2. 接入音频预览，并提供与视频一致的中文控件体验。
3. 美化预览弹框，尤其是音视频区域的布局、加载状态、缩略图和控制条。
4. 视频播放器提供常用中文控件：播放/暂停、停止、快退、快进、倍速、音量、静音、进度和时间显示。
5. 视频加载时优先展示已生成的缩略图 `thumbnail_url`。
6. 文本预览增强 JSON、XML、YAML、TOML、HTML、CSS、JS/TS 等格式的格式化/高亮与行号体验。
7. 尽量不增加新依赖，延续现有 Tailwind v4 token 和 lucide-react 图标体系。

## 非目标

1. 不新增后端转码、音视频转封装或服务端缩略图生成能力。
2. 不实现 Office/PDF 深度预览。
3. 不改变分片文件访问协议和视频 Service Worker 方案。
4. 不引入重量级代码编辑器或语法高亮库。

## 架构设计

新增 `frontend/src/components/files/preview/` 目录，按职责拆分：

- `types.ts`：预览组件共享类型。
- `PreviewShell.tsx`：弹框内统一视觉容器、元信息条和状态布局。
- `MediaPreview.tsx`：音视频共享播放器控制逻辑与中文控件。
- `ImagePreview.tsx`：图片预览。
- `VideoPreview.tsx`：视频预览，保留分片视频 Service Worker 能力。
- `AudioPreview.tsx`：音频预览。
- `TextPreview.tsx`：纯文本/结构化文本预览。
- `MarkdownPreview.tsx`：Markdown 渲染。
- `UnsupportedPreview.tsx`：不支持预览的兜底状态。
- `text-format.tsx`：语言识别、格式化、行号和轻量高亮工具。

`PreviewDialog.tsx` 只保留：

- 根据 `previewKind(file)` 分发组件。
- 处理文本内容读取。
- 管理全屏、复制、下载等弹框级动作。

## 预览类型

`PreviewKind` 增加 `audio`：

- 图片：`image/*`
- 视频：`video/*` 或常见视频扩展名
- 音频：`audio/*` 或 mp3、wav、ogg、m4a、aac、flac 等扩展名
- Markdown：`.md` / `.markdown` / `text/markdown`
- 文本：`text/*`、JSON、XML、YAML、TOML、HTML、CSS、JS/TS 等

## 媒体播放器设计

音频和视频共用自定义控制条：

- 播放/暂停
- 停止：暂停并回到 0 秒
- 快退 10 秒
- 快进 10 秒
- 进度条，可拖动
- 当前时间 / 总时长
- 静音/取消静音
- 音量滑块
- 倍速选择：0.5x、0.75x、1x、1.25x、1.5x、2x

视频补充：

- 使用 `thumbnail_url` 作为 poster。
- 加载/缓冲时显示缩略图上的加载浮层。
- 对可直链视频使用 `file.file_path`；对大分片视频沿用现有 Service Worker 预览 URL。
- `preload="metadata"` 作为默认策略，减少初始压力；播放时浏览器按需加载。

音频补充：

- 使用专用音频卡片布局，展示文件名、大小、MIME、波形感视觉条。
- 不依赖浏览器默认控件，保证中文体验一致。

## 文本预览设计

- JSON：解析成功后 `JSON.stringify(value, null, 2)` 格式化。
- XML/HTML：按标签做轻量换行缩进与高亮。
- YAML/TOML/CSS/JS/TS：保留原文，增强 token 高亮。
- 行号常驻，滚动区域独立。
- 顶部显示语言、行数、是否格式化。
- 空文件显示明确占位。

## 错误与边界

- 直链不可用且又无法使用分片视频预览时，显示明确原因和可操作按钮。
- 文本读取失败显示错误卡片，不影响弹框其他动作。
- 媒体加载失败显示中文错误提示。
- 缩略图加载失败时自动退回深色播放器背景。

## 测试计划

1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm build:frontend`
4. 手动验证：
   - 图片预览
   - 视频预览，含 poster、播放、暂停、停止、快进/快退、倍速、音量
   - 音频预览，含中文控件
   - JSON/XML/YAML/Markdown 预览
   - 大分片视频 Service Worker 预览兜底状态
