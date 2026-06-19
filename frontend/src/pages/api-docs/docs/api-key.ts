import { p } from "../doc-field";
import type { DocGroup } from "../types";
import type { DocsContext } from "./context";

export function buildApiKeyGroup(ctx: DocsContext): DocGroup {
  return {
      title: "API Key 接口",
      description: `面向脚本、CLI、备份任务和第三方自动化客户端。所有业务接口都使用 Authorization: Bearer <API_KEY>；推荐统一使用分片上传，单文件直传仅保留兼容。`,
      sections: [
        {
          id: "api-key-files",
          title: "文件与分片下载",
          description: "小文件兼容上传、文件元数据读取和分片文件下载。",
          endpoints: [
            {
              id: "api-v1-files-create",
              method: "POST",
              path: "/api/v1/files",
              title: "上传小文件（兼容接口）",
              auth: "Bearer API Key",
              summary: "直接把一个小文件转存到 Telegram 并写入文件索引。",
              functionality: "读取 multipart/form-data 中的 file，校验文件名和大小后发送到 Telegram 私有频道，再返回签名访问链接。",
              useCases: ["旧版脚本上传小文件。", "一次性上传不需要断点续传的配置、文本、图片等文件。"],
              limits: [`文件大小必须小于等于 ${ctx.maxFile}。`, "同一目录文件名默认不能重复。", "Content-Type 必须是 multipart/form-data。"],
              specialHandling: ["file_name 会覆盖原始文件名并重新清洗。", "on_conflict=overwrite 时允许覆盖同名索引。", "新客户端建议改用 /api/v1/uploads/*。"],
              requestParams: [
                ctx.bearer,
                p("file", "FormData", "是", "File", `<=${ctx.maxFile}`, "要上传的文件。"),
                p("file_name", "FormData", "否", "string", "1-180 字符", "覆盖文件名。"),
                p("directory_path", "FormData", "否", "string", "默认 /，最长 512 字符", "目标目录，不存在时自动创建。"),
                p("remark", "FormData", "否", "string", "最多 1000 字符", "文件备注。"),
                p("on_conflict", "FormData", "否", "string", "error / overwrite", "同名文件处理方式，默认 error。")
              ],
              responseParams: [
                ctx.okResponse,
                p("id", "Response", "是", "string", "文件 id", "新文件记录 id。"),
                p("url", "Response", "是", "string", "签名 URL", "可直接访问的文件链接。"),
                p("name", "Response", "是", "string", "文件名", "最终文件名。"),
                p("size", "Response", "是", "number", "字节", "文件大小。"),
                p("mime_type", "Response", "是", "string", "MIME", "文件类型。")
              ],
              requestExample: `curl -X POST '${ctx.baseUrl}/api/v1/files' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -F 'file=@./hello.txt' \\
  -F 'file_name=hello-copy.txt' \\
  -F 'directory_path=/docs' \\
  -F 'remark=示例文件'`,
              responseExample: `{
  "ok": true,
  "id": "file-id",
  "url": "${ctx.baseUrl}/f/<token>/hello-copy.txt",
  "name": "hello-copy.txt",
  "size": 12,
  "mime_type": "text/plain"
}`
            },
            {
              id: "api-v1-files-detail",
              method: "GET",
              path: "/api/v1/files/:fileId",
              title: "获取文件信息",
              auth: "Bearer API Key",
              summary: "返回文件元数据、访问链接、下载策略和分片信息。",
              functionality: "按文件 id 读取数据库文件索引，并根据存储后端生成公开访问字段。",
              useCases: ["下载前判断 direct_access。", "外部客户端获取 chunk_count 后并发下载。", "同步本地文件清单。"],
              limits: ["fileId 必须指向未删除文件。", "系统大小上限内的分片文件会返回 url/download_url。"],
              specialHandling: ["HLS 文件会额外返回 hls_download 摘要。", "telegram_channel_id 缺失时序列化为 default。"],
              requestParams: [
                ctx.bearer,
                p("fileId", "Path", "是", "string", "文件 id", "文件记录 id。")
              ],
              responseParams: ctx.fileResponseFields,
              requestExample: `curl '${ctx.baseUrl}/api/v1/files/<FILE_ID>' \\
  -H 'Authorization: Bearer <API_KEY>'`,
              responseExample: `{
  "ok": true,
  "file": {
    "id": "file-id",
    "file_name": "backup.zip",
    "size": ${ctx.exampleMultipartSize},
    "storage_backend": "telegram_multipart",
    "chunk_size": ${ctx.session.multipart_chunk_bytes},
    "chunk_count": ${ctx.exampleMultipartChunkCount},
    "direct_access": true,
    "download_strategy": "direct_or_accelerated",
    "url": "${ctx.baseUrl}/f/<token>/backup.zip",
    "download_url": "${ctx.baseUrl}/f/<token>/backup.zip?download=1"
  }
}`
            },
            {
              id: "api-v1-files-chunk",
              method: "GET",
              path: "/api/v1/files/:fileId/chunks/:index",
              title: "下载指定分片",
              auth: "Bearer API Key",
              summary: "返回分片文件流，客户端按 index 顺序合并。",
              functionality: "校验文件为 telegram_multipart 后，从 Telegram 拉取指定 chunk 并透传二进制响应。",
              useCases: ["超大文件加速下载。", "服务端或 CLI 断点恢复下载。"],
              limits: ["仅支持 storage_backend=telegram_multipart。", "index 必须在 0 到 chunk_count-1 之间。"],
              specialHandling: ["普通单文件会返回 NotMultipartFile。", "支持 Range 透传给 Telegram 文件服务。"],
              requestParams: [
                ctx.bearer,
                p("fileId", "Path", "是", "string", "文件 id", "文件记录 id。"),
                p("index", "Path", "是", "number", "0 <= index < chunk_count", "分片序号。"),
                p("Range", "Header", "否", "string", "bytes=start-end", "读取分片内的字节范围。")
              ],
              responseParams: [
                p("Content-Type", "Response", "是", "string", "application/octet-stream", "二进制文件流。"),
                p("Content-Length", "Response", "条件", "number", "字节", "分片长度。"),
                p("Content-Range", "Response", "条件", "string", "Range 请求时返回", "范围响应信息。"),
                p("X-Chunk-Index", "Response", "是", "number", "从 0 开始", "当前分片序号。"),
                p("X-Chunk-Count", "Response", "是", "number", ">=1", "总分片数。"),
                p("X-Chunk-Offset", "Response", "是", "number", "字节", "当前分片在完整文件中的偏移。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/v1/files/<FILE_ID>/chunks/0' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -o part-0.bin`,
              responseExample: `HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Length: ${ctx.session.multipart_chunk_bytes}
X-Chunk-Index: 0
X-Chunk-Count: ${ctx.exampleMultipartChunkCount}
X-Chunk-Offset: 0`
            }
          ]
        },
        {
          id: "api-key-multipart",
          title: "统一分片上传",
          description: `本地文件按 ${ctx.chunkSize} 分片上传；小文件通常只有 1 片。`,
          endpoints: [
            {
              id: "api-v1-uploads-init",
              method: "POST",
              path: "/api/v1/uploads/init",
              title: "初始化本地分片上传",
              auth: "Bearer API Key",
              summary: "创建本地文件上传会话，返回分片大小和数量。",
              functionality: "校验文件名、目录、大小和同名冲突，写入 multipart_uploads 临时记录。",
              useCases: ["大文件上传。", "需要断点续传或并发上传的客户端。", "统一小文件和大文件上传逻辑。"],
              limits: [`size 必须大于 0 且小于等于 ${ctx.maxMultipart}。`, `分片大小固定为 ${ctx.chunkSize}。`, "目录路径最长 512 字符。"],
              specialHandling: ["同名冲突返回 409 FileNameConflict，并带 suggested_name。", "未完成会话会被定时清理。"],
              requestParams: [
                ctx.bearer,
                p("file_name", "Body", "是", "string", "1-180 字符", "最终文件名。"),
                p("mime_type", "Body", "否", "string", "默认 application/octet-stream", "客户端识别的 MIME。"),
                p("size", "Body", "是", "number", `1-${ctx.session.max_multipart_file_bytes}`, "文件总字节数。"),
                p("directory_path", "Body", "否", "string", "默认 /", "目标目录，不存在时自动创建。"),
                p("remark", "Body", "否", "string", "最多 1000 字符", "文件备注。"),
                p("on_conflict", "Body", "否", "string", "error / overwrite", "同名文件处理方式。")
              ],
              responseParams: ctx.uploadResponseFields,
              requestExample: `curl -X POST '${ctx.baseUrl}/api/v1/uploads/init' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "file_name": "backup.zip",
    "mime_type": "application/zip",
    "size": ${ctx.exampleMultipartSize},
    "directory_path": "/backup",
    "remark": "每日备份"
  }'`,
              responseExample: `{
  "ok": true,
  "upload": {
    "id": "upload-id",
    "file_name": "backup.zip",
    "mime_type": "application/zip",
    "size": ${ctx.exampleMultipartSize},
    "chunk_size": ${ctx.session.multipart_chunk_bytes},
    "chunk_count": ${ctx.exampleMultipartChunkCount},
    "direct_access": true,
    "direct_access_max_chunks": ${ctx.session.direct_access_max_chunks}
  }
}`
            },
            {
              id: "api-v1-uploads-chunk",
              method: "POST",
              path: "/api/v1/uploads/:uploadId/chunks/:index",
              title: "上传本地分片",
              auth: "Bearer API Key",
              summary: "上传一个指定序号的本地文件分片。",
              functionality: "读取 FormData 中的 chunk，校验大小后发送到 Telegram，并 upsert 分片记录。",
              useCases: ["按 index 并发上传。", "失败分片重传。"],
              limits: ["uploadId 必须是 local 上传会话。", "除最后一片外，chunk.size 必须等于初始化返回的 chunk_size。"],
              specialHandling: ["重复上传同一 index 会覆盖对应分片记录。", "Telegram 上传会经过全局限流器。"],
              requestParams: [
                ctx.bearer,
                p("uploadId", "Path", "是", "string", "上传会话 id", "初始化接口返回的 upload.id。"),
                p("index", "Path", "是", "number", "0 <= index < chunk_count", "分片序号。"),
                p("chunk", "FormData", "是", "File", "必须等于期望大小", "当前分片 Blob。")
              ],
              responseParams: ctx.chunkResponseFields,
              requestExample: `curl -X POST '${ctx.baseUrl}/api/v1/uploads/<UPLOAD_ID>/chunks/0' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -F 'chunk=@./backup.zip.part0'`,
              responseExample: `{
  "ok": true,
  "chunk": {
    "chunk_index": 0,
    "size": ${ctx.session.multipart_chunk_bytes},
    "md5": "tg:<unique-id>",
    "telegram_file_id": "BQACAg...",
    "telegram_channel_id": "default"
  },
  "uploaded_chunks": 1
}`
            },
            {
              id: "api-v1-uploads-complete",
              method: "POST",
              path: "/api/v1/uploads/:uploadId/complete",
              title: "完成分片上传",
              auth: "Bearer API Key",
              summary: "校验所有分片后生成最终文件记录。",
              functionality: "检查分片完整性，事务化写入 files 记录并标记上传完成，可选上传缩略图。",
              useCases: ["所有分片上传成功后提交文件。", "为图片或视频补充客户端生成的缩略图。"],
              limits: ["缺少任意分片会返回 409 UploadIncomplete。", "缩略图最大 512 KB，仅支持 JPEG、PNG、WebP。"],
              specialHandling: ["完成阶段再次校验同目录文件名冲突。", "缩略图上传失败不会阻塞主文件完成，会返回 thumbnail_status=failed。"],
              requestParams: [
                ctx.bearer,
                p("uploadId", "Path", "是", "string", "上传会话 id", "初始化接口返回的 upload.id。"),
                p("on_conflict", "Query/Body/FormData", "否", "string", "error / overwrite", "完成阶段同名冲突策略。"),
                p("thumbnail", "FormData", "否", "File", "<=512KB", "可选缩略图。"),
                p("thumbnail_width", "FormData", "否", "number", "1-8192", "缩略图宽度。"),
                p("thumbnail_height", "FormData", "否", "number", "1-8192", "缩略图高度。")
              ],
              responseParams: ctx.fileResponseFields,
              requestExample: `curl -X POST '${ctx.baseUrl}/api/v1/uploads/<UPLOAD_ID>/complete' \\
  -H 'Authorization: Bearer <API_KEY>'

curl -X POST '${ctx.baseUrl}/api/v1/uploads/<UPLOAD_ID>/complete' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -F 'thumbnail=@./thumbnail.webp' \\
  -F 'thumbnail_width=320' \\
  -F 'thumbnail_height=180'`,
              responseExample: `{
  "ok": true,
  "file": {
    "id": "upload-id",
    "file_name": "backup.zip",
    "storage_backend": "telegram_multipart",
    "chunk_count": ${ctx.exampleMultipartChunkCount},
    "direct_access": true,
    "download_strategy": "direct_or_accelerated",
    "thumbnail_status": "ready",
    "url": "${ctx.baseUrl}/f/<token>/backup.zip",
    "download_url": "${ctx.baseUrl}/f/<token>/backup.zip?download=1"
  }
}`
            }
          ]
        },
        {
          id: "api-key-url",
          title: "URL 分片导入",
          description: "服务端从远程 URL 按 Range 拉取分片，再转存到 Telegram。",
          endpoints: [
            {
              id: "api-v1-url-init",
              method: "POST",
              path: "/api/v1/uploads/url/init",
              title: "初始化 URL 分片导入",
              auth: "Bearer API Key",
              summary: "探测远程文件并创建 URL 上传会话。",
              functionality: "读取远端 Content-Length / Content-Range，固定创建 multipart 会话并保存可选请求头。",
              useCases: ["从可访问的 HTTP/HTTPS 地址导入大文件。", "无需客户端先下载再上传。"],
              limits: [`远端大小必须小于等于 ${ctx.maxMultipart}。`, "URL 最长 4096 字符。", "远端必须支持 Range 并返回可确认大小。"],
              specialHandling: ["headers 支持对象、数组或 Header-Name: value 文本，最多 32 个，总计 16KB。", "图片小于 100MB 或视频小于分片上限时可能返回 thumbnail_source。"],
              requestParams: [
                ctx.bearer,
                p("url", "Body", "是", "string", "http/https，最长 4096", "远程文件 URL。"),
                p("headers", "Body", "否", "object | array | string", "最多 32 个，总计 16KB", "访问远端 URL 时附加的请求头；禁止 Host、Range 等 hop-by-hop 或代理头。"),
                p("file_name", "Body", "否", "string", "1-180 字符", "覆盖从 URL 推断的文件名。"),
                p("directory_path", "Body", "否", "string", "默认 /", "目标目录。"),
                p("remark", "Body", "否", "string", "最多 1000 字符", "文件备注。"),
                p("on_conflict", "Body", "否", "string", "error / overwrite", "同名文件处理方式。")
              ],
              responseParams: [
                ctx.okResponse,
                p("mode", "Response", "是", "string", "multipart", "API Key URL 导入固定返回 multipart。"),
                ...ctx.uploadResponseFields.slice(1)
              ],
              requestExample: `curl -X POST '${ctx.baseUrl}/api/v1/uploads/url/init' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "url": "https://example.com/video.mp4",
    "file_name": "video-copy.mp4",
    "directory_path": "/videos",
    "headers": { "Authorization": "Bearer source-token" }
  }'`,
              responseExample: `{
  "ok": true,
  "mode": "multipart",
  "upload": {
    "id": "upload-id",
    "file_name": "video-copy.mp4",
    "chunk_count": 42,
    "thumbnail_source": {
      "available": true,
      "kind": "video",
      "url": "/api/v1/uploads/url-thumbnail-source?token=...",
      "mime_type": "video/mp4",
      "expires_at": "2026-06-07T10:10:00.000Z"
    }
  }
}`
            },
            {
              id: "api-v1-url-chunk",
              method: "POST",
              path: "/api/v1/uploads/:uploadId/url-chunks/:index",
              title: "导入 URL 指定分片",
              auth: "Bearer API Key",
              summary: "让服务端拉取并上传一个远程分片。",
              functionality: "按初始化时保存的 source_url 和 headers 发起 Range 请求，校验大小后上传到 Telegram。",
              useCases: ["服务端代理导入远程大文件。", "客户端只负责调度分片序号。"],
              limits: ["uploadId 必须是 url 上传会话。", "远端响应必须匹配期望 Range 和大小。"],
              specialHandling: ["远端 5xx 会转为 502，远端 4xx 多数转为 400。", "可重复调用同一 index 重试。"],
              requestParams: [
                ctx.bearer,
                p("uploadId", "Path", "是", "string", "上传会话 id", "URL 初始化返回的 upload.id。"),
                p("index", "Path", "是", "number", "0 <= index < chunk_count", "分片序号。")
              ],
              responseParams: ctx.chunkResponseFields,
              requestExample: `curl -X POST '${ctx.baseUrl}/api/v1/uploads/<UPLOAD_ID>/url-chunks/0' \\
  -H 'Authorization: Bearer <API_KEY>'`,
              responseExample: `{
  "ok": true,
  "chunk": {
    "chunk_index": 0,
    "size": ${ctx.session.multipart_chunk_bytes},
    "telegram_file_id": "BQACAg...",
    "telegram_channel_id": "default"
  },
  "uploaded_chunks": 1
}`
            },
            {
              id: "api-v1-thumbnail-source",
              method: "GET",
              path: "/api/v1/uploads/url-thumbnail-source?token=...",
              title: "读取 URL 缩略图源",
              auth: "Signed thumbnail token",
              summary: "为浏览器生成缩略图提供短期同源媒体代理。",
              functionality: "校验 thumbnail_source token 后代理远程图片或视频内容，保留 Content-Length、Content-Range、Accept-Ranges。",
              useCases: ["URL 导入视频时在浏览器用 video + canvas 抽帧。", "URL 导入图片时直接绘制缩略图。"],
              limits: ["token 默认 10 分钟过期。", `图片源最大 100MB，视频源最大 ${ctx.maxMultipart}。`],
              specialHandling: ["视频未带 Range 时默认只代理前 2MB。", "会复用 URL 初始化时保存的远端请求头。"],
              requestParams: [
                p("token", "Query", "是", "string", "签名 token", "url/init 返回的 thumbnail_source.url 查询参数。"),
                p("Range", "Header", "否", "string", "bytes=start-end", "读取视频片段或图片部分内容。")
              ],
              responseParams: [
                p("Content-Type", "Response", "是", "string", "源 MIME", "图片或视频类型。"),
                p("Content-Length", "Response", "条件", "number", "字节", "代理响应大小。"),
                p("Content-Range", "Response", "条件", "string", "Range 响应", "远端范围响应。"),
                p("Accept-Ranges", "Response", "条件", "string", "bytes", "远端支持范围读取时返回。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/v1/uploads/url-thumbnail-source?token=<TOKEN>' \\
  -H 'Range: bytes=0-2097151' \\
  -o source.part`,
              responseExample: `HTTP/1.1 206 Partial Content
Content-Type: video/mp4
Content-Range: bytes 0-2097151/104857600
Accept-Ranges: bytes`
            }
          ]
        }
      ]
  };
}
