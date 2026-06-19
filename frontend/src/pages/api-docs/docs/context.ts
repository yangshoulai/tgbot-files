import type { SessionResponse } from "../../../api";
import { formatBytes } from "../../../utils";
import { p } from "../doc-field";
import type { ParameterDoc } from "../types";

export interface DocsContext {
  session: SessionResponse;
  baseUrl: string;
  maxFile: string;
  maxMultipart: string;
  chunkSize: string;
  directMax: string;
  exampleMultipartSize: number;
  exampleMultipartChunkCount: number;
  bearer: ParameterDoc;
  adminCookie: ParameterDoc;
  signedToken: ParameterDoc;
  okResponse: ParameterDoc;
  fileResponseFields: ParameterDoc[];
  uploadResponseFields: ParameterDoc[];
  chunkResponseFields: ParameterDoc[];
  hlsUploadFields: ParameterDoc[];
  statusResponseFields: ParameterDoc[];
}

export function createDocsContext(session: SessionResponse): DocsContext {
  const baseUrl = session.base_url;
  const maxFile = formatBytes(session.max_file_bytes);
  const maxMultipart = formatBytes(session.max_multipart_file_bytes);
  const chunkSize = formatBytes(session.multipart_chunk_bytes);
  const directMax = formatBytes(session.direct_access_max_bytes);
  const exampleMultipartSize = session.max_multipart_file_bytes;
  const exampleMultipartChunkCount = Math.ceil(session.max_multipart_file_bytes / session.multipart_chunk_bytes);

  const bearer = p("Authorization", "Header", "是", "string", "Bearer <API_KEY>", "外部上传 API Key，禁用或删除后立即不可用。");
  const adminCookie = p("admin_session", "Cookie", "是", "string", "HttpOnly", "管理员登录后由服务端设置，成功请求会自动续期。");
  const signedToken = p("token", "Path", "是", "string", "签名载荷", "由文件记录生成的签名访问令牌。");
  const okResponse = p("ok", "Response", "是", "boolean", "true", "请求成功标志。");

  const fileResponseFields = [
    okResponse,
    p("file.id", "Response", "是", "string", "UUID 或上传会话 id", "文件索引 id。"),
    p("file.file_name", "Response", "是", "string", "1-180 字符", "展示和下载时使用的文件名。"),
    p("file.mime_type", "Response", "是", "string", "MIME", "存储时识别到的内容类型。"),
    p("file.size", "Response", "是", "number", "字节", "文件总大小。"),
    p("file.storage_backend", "Response", "是", "string", "telegram_single / telegram_multipart / hls_package", "文件在 Telegram 中的存储形态。"),
    p("file.file_path", "Response", "是", "string", "/f 或 /api/hls 路径", "同源签名访问路径。"),
    p("file.url", "Response", "否", "string | null", "direct_access=true 时返回", "可直接预览的完整 URL。"),
    p("file.download_url", "Response", "否", "string | null", "direct_download=true 时返回", "带 download=1 的下载 URL。"),
    p("file.direct_access", "Response", "是", "boolean", "按文件大小判断", "是否允许整文件直链读取；系统大小上限内的分片文件会提供。"),
    p("file.download_strategy", "Response", "是", "string", "direct / direct_or_accelerated / accelerated", "前端选择下载方式的依据。"),
    p("file.thumbnail_url", "Response", "否", "string | null", "缩略图存在时返回", "预览列表可使用的缩略图 URL。")
  ];

  const uploadResponseFields = [
    okResponse,
    p("upload.id", "Response", "是", "string", "UUID", "上传会话 id。"),
    p("upload.file_name", "Response", "是", "string", "1-180 字符", "最终文件名。"),
    p("upload.mime_type", "Response", "是", "string", "MIME", "上传文件类型。"),
    p("upload.size", "Response", "是", "number", `1-${session.max_multipart_file_bytes}`, "文件总大小，单位字节。"),
    p("upload.chunk_size", "Response", "是", "number", `${session.multipart_chunk_bytes}`, `固定分片大小，当前 ${chunkSize}。`),
    p("upload.chunk_count", "Response", "是", "number", ">=1", "需要上传或导入的分片数量。"),
    p("upload.directory_path", "Response", "是", "string", "最长 512 字符", "最终存放目录。"),
    p("upload.direct_access", "Response", "是", "boolean", `<=${directMax}`, "完成后是否提供整文件直链。"),
    p("upload.thumbnail_source", "Response", "否", "object | null", "URL 图片或视频可能返回", "供浏览器生成缩略图的短期同源媒体入口。")
  ];

  const chunkResponseFields = [
    okResponse,
    p("chunk.chunk_index", "Response", "是", "number", "从 0 开始", "已上传分片序号。"),
    p("chunk.size", "Response", "是", "number", "字节", "分片大小。"),
    p("chunk.md5", "Response", "是", "string", "Telegram unique id 派生", "分片校验/去重标识。"),
    p("chunk.telegram_file_id", "Response", "是", "string", "Telegram file_id", "后续下载该分片时使用。"),
    p("chunk.telegram_channel_id", "Response", "是", "string", "default 或通道 id", "实际写入的 Telegram 通道。"),
    p("uploaded_chunks", "Response", "是", "number", ">=1", "当前会话已完成分片数量。")
  ];

  const hlsUploadFields = [
    okResponse,
    p("hls.asset", "Response", "是", "object", "HLS asset", "HLS 导入任务元数据。"),
    p("hls.asset.id", "Response", "是", "string", "UUID", "HLS 导入任务 id。"),
    p("hls.asset.status", "Response", "是", "string", "pending / importing / done / failed / cancelled", "任务状态。"),
    p("hls.asset.preview_playlist_url", "Response", "是", "string", "管理员 Cookie", "已导入片段的预览 playlist 地址。"),
    p("hls.segments", "Response", "是", "array", "按实际 playlist 返回", "每个 HLS segment 的导入状态和分片情况。")
  ];

  const statusResponseFields = [
    okResponse,
    ...uploadResponseFields.slice(1, 8).map((field) => ({ ...field, name: field.name.replace("upload.", "upload.") })),
    p("uploaded_chunks", "Response", "是", "number[]", "从 0 开始", "已存在的分片序号。"),
    p("missing_chunks", "Response", "是", "number[]", "从 0 开始", "未完成的分片序号。")
  ];

  return {
    session,
    baseUrl,
    maxFile,
    maxMultipart,
    chunkSize,
    directMax,
    exampleMultipartSize,
    exampleMultipartChunkCount,
    bearer,
    adminCookie,
    signedToken,
    okResponse,
    fileResponseFields,
    uploadResponseFields,
    chunkResponseFields,
    hlsUploadFields,
    statusResponseFields
  };
}
