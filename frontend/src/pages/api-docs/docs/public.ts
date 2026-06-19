import { p } from "../doc-field";
import type { DocGroup } from "../types";
import type { DocsContext } from "./context";

export function buildPublicGroup(ctx: DocsContext): DocGroup {
  return {
      title: "公开签名访问",
      description: "文件列表、上传完成和 HLS 完成接口返回的签名路径。调用方不需要 Cookie 或 API Key，但必须持有有效 token。",
      sections: [
        {
          id: "public-files",
          title: "普通文件与分片文件",
          description: "单文件直链、分片文件直链和签名分片下载。",
          endpoints: [
            {
              id: "public-file-access",
              method: "GET",
              path: "/f/:token/:filename?",
              title: "签名链接预览或下载",
              auth: "Signed file token",
              summary: "读取普通单文件或允许直链的分片文件。",
              functionality: "验证签名 token 后，从 Telegram 获取文件或合并可直链的 multipart 文件响应。",
              useCases: ["浏览器预览图片、视频、文本。", "下载 file.url 或 file.download_url。"],
              limits: [`multipart 文件在系统大小上限 ${ctx.directMax} 内提供整文件直链。`, "token 由文件记录生成，不支持客户端自行构造。"],
              specialHandling: ["download=1 或 download=true 会设置 attachment。", "GET 和 HEAD 都会进入该读取路由。", "HLS 文件必须走 /api/hls。"],
              requestParams: [
                ctx.signedToken,
                p("filename", "Path", "否", "string", "展示用", "可选文件名，便于浏览器保存。"),
                p("download", "Query", "否", "string", "1 / true", "强制下载。"),
                p("Range", "Header", "否", "string", "bytes=start-end", "媒体拖动或断点读取。")
              ],
              responseParams: [
                p("Content-Type", "Response", "是", "string", "MIME", "文件类型。"),
                p("Content-Disposition", "Response", "是", "string", "inline / attachment", "预览或下载策略。"),
                p("Content-Length", "Response", "条件", "number", "字节", "响应大小。"),
                p("Content-Range", "Response", "条件", "string", "Range 时返回", "范围响应。"),
                p("Accept-Ranges", "Response", "条件", "string", "bytes", "支持范围读取时返回。")
              ],
              requestExample: `curl '${ctx.baseUrl}/f/<TOKEN>/hello.txt?download=1' \\
  -o hello.txt`,
              responseExample: `HTTP/1.1 200 OK
Content-Type: text/plain
Content-Disposition: attachment; filename="hello.txt"
Accept-Ranges: bytes`
            },
            {
              id: "public-file-chunk-access",
              method: "GET",
              path: "/f/:token/chunks/:index",
              title: "签名分片下载",
              auth: "Signed file token",
              summary: "读取 multipart 文件的单个分片。",
              functionality: "验证 multipart token 后，从 file_chunks 读取指定分片并透传二进制内容。",
              useCases: ["控制台加速下载。", "浏览器并发下载后合并。"],
              limits: ["仅支持 telegram_multipart 文件。", "index 必须是非负整数且在范围内。"],
              specialHandling: ["普通单文件会返回 NotMultipartFile。", "响应头包含分片 index、count 和 offset。"],
              requestParams: [
                ctx.signedToken,
                p("index", "Path", "是", "number", "0 <= index < chunk_count", "分片序号。"),
                p("Range", "Header", "否", "string", "bytes=start-end", "分片内范围读取。")
              ],
              responseParams: [
                p("Content-Type", "Response", "是", "string", "application/octet-stream", "分片文件流。"),
                p("Content-Length", "Response", "条件", "number", "字节", "分片大小。"),
                p("X-Chunk-Index", "Response", "是", "number", "从 0 开始", "当前分片。"),
                p("X-Chunk-Count", "Response", "是", "number", ">=1", "总分片数。"),
                p("X-Chunk-Offset", "Response", "是", "number", "字节", "完整文件偏移。")
              ],
              requestExample: `curl '${ctx.baseUrl}/f/<TOKEN>/chunks/0' \\
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
          id: "public-hls",
          title: "HLS 文件访问",
          description: "HLS package 文件的 playlist、segment 和 segment chunk 访问。",
          endpoints: [
            {
              id: "public-hls-playlist",
              method: "GET",
              path: "/api/hls/:token/:filename?",
              title: "读取 HLS Playlist 或整包下载",
              auth: "Signed HLS token",
              summary: "返回重写后的 HLS media playlist；download=1 时尝试合并下载 TS 或 fMP4。",
              functionality: "验证 v4 HLS token，读取 HLS asset 和 segments，重写 segment URL 为同源 /api/hls 路径。",
              useCases: ["视频在线播放。", "HLS 文件整包下载。"],
              limits: ["asset 必须 status=done。", "整包下载支持 TS 或 fMP4 顺序合并，且总大小不超过系统直链上限。"],
              specialHandling: ["download=1 且文件超过系统直链大小上限时会返回 DirectAccessDisabled，前端可使用 hls-download plan。", "旧 /hls/:token 路径仍可解析，但响应路径统一推荐 /api/hls。"],
              requestParams: [
                ctx.signedToken,
                p("filename", "Path", "否", "string", "展示用", "可选文件名。"),
                p("download", "Query", "否", "string", "1 / true", "强制整包下载。")
              ],
              responseParams: [
                p("Content-Type", "Response", "是", "string", "application/vnd.apple.mpegurl 或 video/mp2t", "playlist 或整包 TS。"),
                p("Content-Disposition", "Response", "是", "string", "inline / attachment", "预览或下载。"),
                p("body", "Response", "条件", "string | stream", "playlist 或文件流", "HLS m3u8 文本或合并后的 TS 流。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/hls/<TOKEN>/movie.m3u8'`,
              responseExample: `HTTP/1.1 200 OK
Content-Type: application/vnd.apple.mpegurl; charset=utf-8

#EXTM3U
#EXTINF:6.000,
${ctx.baseUrl}/api/hls/<TOKEN>/segments/0/seg-0.ts`
            },
            {
              id: "public-hls-segment",
              method: "GET",
              path: "/api/hls/:token/segments/:segmentIndex/:segmentName",
              title: "读取 HLS Segment",
              auth: "Signed HLS token",
              summary: "返回 HLS package 的指定 segment 文件流。",
              functionality: "验证 token 后按 segmentIndex 读取已导入 segment。",
              useCases: ["HLS 播放器读取 playlist 中的 segment URL。", "加速下载计划中的单 segment part。"],
              limits: ["segmentIndex 必须非负且存在。", "segment 必须已导入完成。"],
              specialHandling: ["segmentName 只用于浏览器文件名，不参与定位。", "download=1 会设置 attachment。"],
              requestParams: [
                ctx.signedToken,
                p("segmentIndex", "Path", "是", "number", ">=0", "segment 序号。"),
                p("segmentName", "Path", "否", "string", "展示用", "segment 文件名。"),
                p("download", "Query", "否", "string", "1 / true", "强制下载。"),
                p("Range", "Header", "否", "string", "bytes=start-end", "媒体范围读取。")
              ],
              responseParams: [
                p("Content-Type", "Response", "是", "string", "video/mp2t 或源 MIME", "segment 媒体流。"),
                p("Content-Length", "Response", "条件", "number", "字节", "响应大小。"),
                p("Content-Range", "Response", "条件", "string", "Range 时返回", "范围响应。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/hls/<TOKEN>/segments/0/seg-0.ts' \\
  -o seg-0.ts`,
              responseExample: `HTTP/1.1 200 OK
Content-Type: video/mp2t
Content-Length: 5242880`
            },
            {
              id: "public-hls-segment-chunk",
              method: "GET",
              path: "/api/hls/:token/segments/:segmentIndex/chunks/:chunkIndex",
              title: "读取 HLS Segment 分片",
              auth: "Signed HLS token",
              summary: "读取大 HLS segment 的内部 chunk。",
              functionality: "用于 storage_backend=telegram_multipart 的 HLS segment，按 chunkIndex 返回二进制 part。",
              useCases: ["HLS 加速下载计划中并发下载大 segment 的 part。"],
              limits: ["segment 必须是 multipart 存储。", "chunkIndex 必须在 segment.chunk_count 范围内。"],
              specialHandling: ["响应包含分片偏移信息，客户端按 hls_download.parts 顺序合并。"],
              requestParams: [
                ctx.signedToken,
                p("segmentIndex", "Path", "是", "number", ">=0", "segment 序号。"),
                p("chunkIndex", "Path", "是", "number", ">=0", "segment 内部分片序号。"),
                p("download", "Query", "否", "string", "1 / true", "强制下载。"),
                p("Range", "Header", "否", "string", "bytes=start-end", "chunk 内范围读取。")
              ],
              responseParams: [
                p("Content-Type", "Response", "是", "string", "application/octet-stream", "chunk 文件流。"),
                p("Content-Length", "Response", "条件", "number", "字节", "chunk 大小。"),
                p("X-Chunk-Index", "Response", "是", "number", "从 0 开始", "chunk 序号。"),
                p("X-Chunk-Count", "Response", "是", "number", ">=1", "segment 内 chunk 总数。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/hls/<TOKEN>/segments/1/chunks/0' \\
  -o hls-part-0.bin`,
              responseExample: `HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Length: ${ctx.session.multipart_chunk_bytes}
X-Chunk-Index: 0
X-Chunk-Count: 3`
            }
          ]
        }
      ]
  };
}
