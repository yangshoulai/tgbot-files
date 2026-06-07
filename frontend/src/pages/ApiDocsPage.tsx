import { useMemo, useState } from "react";
import {
  BookOpenText,
  ChevronRight,
  Download,
  FileDown,
  Globe2,
  KeyRound,
  ShieldCheck
} from "lucide-react";
import type { SessionResponse } from "../api";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Segmented } from "../components/ui/Segmented";
import { cn } from "../lib/cn";
import { formatBytes } from "../utils";

type DocAudience = "api-key" | "admin" | "public";
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type RequiredMark = "是" | "否" | "条件";

interface ApiDocsPageProps {
  session: SessionResponse;
}

interface ParameterDoc {
  name: string;
  location: "Header" | "Cookie" | "Path" | "Query" | "Body" | "FormData" | "Body/FormData" | "Query/Body/FormData" | "Response";
  required: RequiredMark;
  type: string;
  limit: string;
  description: string;
}

interface EndpointDoc {
  id: string;
  method: Method;
  path: string;
  title: string;
  auth: string;
  summary: string;
  functionality: string;
  useCases: string[];
  limits: string[];
  specialHandling: string[];
  requestParams: ParameterDoc[];
  responseParams: ParameterDoc[];
  requestExample: string;
  responseExample: string;
}

interface DocSection {
  id: string;
  title: string;
  description: string;
  endpoints: EndpointDoc[];
}

interface DocGroup {
  title: string;
  description: string;
  sections: DocSection[];
}

export function ApiDocsPage({ session }: ApiDocsPageProps) {
  const [audience, setAudience] = useState<DocAudience>("api-key");
  const docs = useMemo(() => buildDocs(session), [session]);
  const current = docs[audience];

  function exportMarkdown() {
    const markdown = [
      "# TGBot Files API 文档",
      "",
      `服务地址：${session.base_url}`,
      "",
      buildMarkdown(docs["api-key"]),
      buildMarkdown(docs.admin),
      buildMarkdown(docs.public)
    ].join("\n").trim() + "\n";
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tgbot-files-api-docs.md";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="api-docs-page flex flex-col gap-6">
      <section className="overflow-hidden rounded-3xl border border-border bg-surface shadow-card">
        <div className="relative px-5 py-6 sm:px-7 lg:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(16,185,129,0.16),transparent_34%),linear-gradient(135deg,rgba(236,253,245,0.78),transparent_42%)]" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary-soft px-3 py-1 text-xs font-medium text-primary-strong">
                <BookOpenText size={14} />
                分模块接口手册
              </div>
              <h1 className="mt-4 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">API 文档</h1>
              <p className="mt-2 text-sm leading-6 text-muted">
                按访问身份和业务模块组织接口，左侧树形目录可快速定位端点。当前服务地址为{" "}
                <span className="font-mono text-foreground">{session.base_url}</span>。
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Badge tone="primary">单文件上限 {formatBytes(session.max_file_bytes)}</Badge>
                <Badge tone="success">分片上限 {formatBytes(session.max_multipart_file_bytes)}</Badge>
                <Badge tone="info">直链预算 {session.direct_access_max_chunks} 片</Badge>
              </div>
            </div>

            <div className="api-docs-actions flex flex-wrap gap-2">
              <Button variant="secondary" leadingIcon={<FileDown size={15} />} onClick={exportMarkdown}>
                导出 Markdown
              </Button>
              <Button variant="primary" leadingIcon={<Download size={15} />} onClick={() => window.print()}>
                打印 / 保存 PDF
              </Button>
            </div>
          </div>
        </div>
      </section>

      <div className="api-docs-nav flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3 shadow-card sm:flex-row sm:items-center sm:justify-between">
        <Segmented<DocAudience>
          value={audience}
          onChange={setAudience}
          ariaLabel="文档类型"
          options={[
            { value: "api-key", label: "API Key 接口", icon: <KeyRound size={15} /> },
            { value: "admin", label: "管理员接口", icon: <ShieldCheck size={15} /> },
            { value: "public", label: "公开签名访问", icon: <Globe2 size={15} /> }
          ]}
        />
        <p className="text-xs leading-5 text-muted">
          {audience === "api-key"
            ? "外部脚本和自动化客户端使用 Bearer Token。"
            : audience === "admin"
              ? "控制台页面使用 HttpOnly Cookie，fetch 必须带 credentials: include。"
              : "签名链接由文件记录生成，不需要管理员 Cookie 或 API Key。"}
        </p>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start">
        <TreeNav group={current} />

        <article className="api-docs-content grid min-w-0 gap-5">
          <header className="rounded-2xl border border-border bg-surface p-5 shadow-card">
            <h2 className="text-xl font-semibold text-foreground">{current.title}</h2>
            <p className="mt-2 text-sm leading-6 text-muted">{current.description}</p>
          </header>

          {current.sections.map((section) => (
            <section key={section.id} id={section.id} className="min-w-0 scroll-mt-24">
              <div className="mb-3 flex flex-col gap-1">
                <h3 className="text-base font-semibold text-foreground">{section.title}</h3>
                <p className="text-sm leading-6 text-muted">{section.description}</p>
              </div>
              <div className="grid gap-4">
                {section.endpoints.map((endpoint) => (
                  <EndpointCard key={endpoint.id} endpoint={endpoint} />
                ))}
              </div>
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}

function TreeNav({ group }: { group: DocGroup }) {
  return (
    <aside className="api-docs-nav min-w-0 rounded-2xl border border-border bg-surface p-3 shadow-card lg:sticky lg:top-4">
      <p className="px-2 pb-2 text-[11px] font-medium uppercase tracking-wide text-muted">接口目录</p>
      <nav role="tree" aria-label={`${group.title}接口目录`} className="max-h-[70dvh] overflow-auto pr-1 scroll-thin">
        <div className="flex gap-2 overflow-x-auto pb-1 scroll-thin lg:block lg:space-y-3 lg:overflow-visible lg:pb-0">
          {group.sections.map((section) => (
            <div key={section.id} role="group" className="min-w-[16rem] lg:min-w-0">
              <a
                role="treeitem"
                aria-level={1}
                href={`#${section.id}`}
                className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-semibold text-foreground hover:bg-primary-soft hover:text-primary-strong"
              >
                <ChevronRight size={14} />
                {section.title}
              </a>
              <div className="mt-1 space-y-1 border-l border-border pl-3">
                {section.endpoints.map((endpoint) => (
                  <a
                    key={endpoint.id}
                    role="treeitem"
                    aria-level={2}
                    href={`#${endpoint.id}`}
                    className="block rounded-lg px-2 py-1.5 hover:bg-background"
                  >
                    <span className="flex items-center gap-2">
                      <MethodBadge method={endpoint.method} compact />
                      <span className="truncate text-xs font-medium text-foreground">{endpoint.title}</span>
                    </span>
                    <code className="mt-1 block truncate pl-[3.35rem] font-mono text-[11px] text-muted">
                      {endpoint.path}
                    </code>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </aside>
  );
}

function EndpointCard({ endpoint }: { endpoint: EndpointDoc }) {
  return (
    <article id={endpoint.id} className="min-w-0 scroll-mt-24 overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <div className="grid gap-3 border-b border-border bg-background/60 px-4 py-3 lg:grid-cols-[1fr_auto] lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <MethodBadge method={endpoint.method} />
            <code className="overflow-anywhere rounded-lg bg-foreground px-2.5 py-1 font-mono text-xs text-white">
              {endpoint.path}
            </code>
          </div>
          <h4 className="mt-3 text-sm font-semibold text-foreground">{endpoint.title}</h4>
          <p className="mt-1 text-sm leading-6 text-muted">{endpoint.summary}</p>
        </div>
        <Badge tone="neutral" className="justify-self-start lg:justify-self-end">
          {endpoint.auth}
        </Badge>
      </div>

      <div className="grid min-w-0 gap-4 p-4">
        <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <DetailPanel title="接口功能" body={endpoint.functionality} />
          <DetailPanel title="使用场景" body={endpoint.useCases} />
          <DetailPanel title="限制条件" body={endpoint.limits} />
          <DetailPanel title="特殊处理" body={endpoint.specialHandling} />
        </div>

        <FieldTable title="请求参数" fields={endpoint.requestParams} />
        <FieldTable title="响应参数" fields={endpoint.responseParams} />
        <CodePanel title="请求示例" code={endpoint.requestExample} />
        <CodePanel title="响应示例" code={endpoint.responseExample} />
      </div>
    </article>
  );
}

function DetailPanel({ title, body }: { title: string; body: string | string[] }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-background px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{title}</p>
      {Array.isArray(body) ? (
        <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-muted">
          {body.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs leading-5 text-muted">{body}</p>
      )}
    </section>
  );
}

function FieldTable({ title, fields }: { title: string; fields: ParameterDoc[] }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-background">
      <p className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted">{title}</p>
      <div className="overflow-x-auto scroll-thin">
        <table className="min-w-[56rem] w-full text-left text-xs">
          <thead className="bg-surface text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">名称</th>
              <th className="px-3 py-2 font-medium">位置</th>
              <th className="px-3 py-2 font-medium">必填</th>
              <th className="px-3 py-2 font-medium">类型</th>
              <th className="px-3 py-2 font-medium">限制</th>
              <th className="px-3 py-2 font-medium">说明</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {fields.length > 0 ? fields.map((field) => (
              <tr key={`${field.location}:${field.name}`}>
                <td className="px-3 py-2 align-top font-mono text-foreground">{field.name}</td>
                <td className="px-3 py-2 align-top text-muted">{field.location}</td>
                <td className="px-3 py-2 align-top text-muted">{field.required}</td>
                <td className="px-3 py-2 align-top font-mono text-muted">{field.type}</td>
                <td className="px-3 py-2 align-top text-muted">{field.limit}</td>
                <td className="px-3 py-2 align-top text-muted">{field.description}</td>
              </tr>
            )) : (
              <tr>
                <td colSpan={6} className="px-3 py-3 text-center text-muted">
                  无参数。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MethodBadge({ method, compact = false }: { method: Method; compact?: boolean }) {
  const className = {
    GET: "border-success/30 bg-success-soft text-success",
    POST: "border-info/30 bg-info-soft text-info",
    PATCH: "border-warning/40 bg-warning-soft text-warning",
    DELETE: "border-danger/30 bg-danger-soft text-danger"
  }[method];

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-mono font-semibold",
        compact ? "h-5 px-1.5 text-[10px]" : "h-7 px-2.5 text-xs",
        className
      )}
    >
      {method}
    </span>
  );
}

function CodePanel({ title, code }: { title: string; code: string }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-background">
      <p className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted">{title}</p>
      <pre className="max-h-96 overflow-auto p-3 font-mono text-xs leading-6 text-foreground scroll-thin">
        <code>{code.trim()}</code>
      </pre>
    </section>
  );
}

function buildDocs(session: SessionResponse): Record<DocAudience, DocGroup> {
  const baseUrl = session.base_url;
  const maxFile = formatBytes(session.max_file_bytes);
  const maxMultipart = formatBytes(session.max_multipart_file_bytes);
  const chunkSize = formatBytes(session.multipart_chunk_bytes);
  const directMax = formatBytes(session.direct_access_max_bytes);

  const bearer = p("Authorization", "Header", "是", "string", "Bearer <API_KEY>", "外部上传 API Key，禁用或删除后立即不可用。");
  const adminCookie = p("admin_session", "Cookie", "是", "string", "HttpOnly", "管理员登录后由 Worker 设置，成功请求会自动续期。");
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
    p("file.direct_access", "Response", "是", "boolean", "按分片数判断", "是否允许整文件直链读取。"),
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
    p("upload.direct_access", "Response", "是", "boolean", `<=${session.direct_access_max_chunks} 片`, "完成后是否提供整文件直链。"),
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
    p("hls.segments", "Response", "是", "array", "最多 2000 个", "每个 HLS segment 的导入状态和分片情况。")
  ];

  const statusResponseFields = [
    okResponse,
    ...uploadResponseFields.slice(1, 8).map((field) => ({ ...field, name: field.name.replace("upload.", "upload.") })),
    p("uploaded_chunks", "Response", "是", "number[]", "从 0 开始", "已存在的分片序号。"),
    p("missing_chunks", "Response", "是", "number[]", "从 0 开始", "未完成的分片序号。")
  ];

  return {
    "api-key": {
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
              limits: [`文件大小必须小于等于 ${maxFile}。`, "同一目录文件名默认不能重复。", "Content-Type 必须是 multipart/form-data。"],
              specialHandling: ["file_name 会覆盖原始文件名并重新清洗。", "on_conflict=overwrite 时允许覆盖同名索引。", "新客户端建议改用 /api/v1/uploads/*。"],
              requestParams: [
                bearer,
                p("file", "FormData", "是", "File", `<=${maxFile}`, "要上传的文件。"),
                p("file_name", "FormData", "否", "string", "1-180 字符", "覆盖文件名。"),
                p("directory_path", "FormData", "否", "string", "默认 /，最长 512 字符", "目标目录，不存在时自动创建。"),
                p("remark", "FormData", "否", "string", "最多 1000 字符", "文件备注。"),
                p("on_conflict", "FormData", "否", "string", "error / overwrite", "同名文件处理方式，默认 error。")
              ],
              responseParams: [
                okResponse,
                p("id", "Response", "是", "string", "文件 id", "新文件记录 id。"),
                p("url", "Response", "是", "string", "签名 URL", "可直接访问的文件链接。"),
                p("name", "Response", "是", "string", "文件名", "最终文件名。"),
                p("size", "Response", "是", "number", "字节", "文件大小。"),
                p("mime_type", "Response", "是", "string", "MIME", "文件类型。")
              ],
              requestExample: `curl -X POST '${baseUrl}/api/v1/files' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -F 'file=@./hello.txt' \\
  -F 'file_name=hello-copy.txt' \\
  -F 'directory_path=/docs' \\
  -F 'remark=示例文件'`,
              responseExample: `{
  "ok": true,
  "id": "file-id",
  "url": "${baseUrl}/f/<token>/hello-copy.txt",
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
              functionality: "按文件 id 读取 D1 文件索引，并根据存储后端生成公开访问字段。",
              useCases: ["下载前判断 direct_access。", "外部客户端获取 chunk_count 后并发下载。", "同步本地文件清单。"],
              limits: ["fileId 必须指向未删除文件。", "超大分片文件的 url/download_url 可能为 null。"],
              specialHandling: ["HLS 文件会额外返回 hls_download 摘要。", "telegram_channel_id 缺失时序列化为 default。"],
              requestParams: [
                bearer,
                p("fileId", "Path", "是", "string", "文件 id", "文件记录 id。")
              ],
              responseParams: fileResponseFields,
              requestExample: `curl '${baseUrl}/api/v1/files/<FILE_ID>' \\
  -H 'Authorization: Bearer <API_KEY>'`,
              responseExample: `{
  "ok": true,
  "file": {
    "id": "file-id",
    "file_name": "backup.zip",
    "size": 5368709120,
    "storage_backend": "telegram_multipart",
    "chunk_size": ${session.multipart_chunk_bytes},
    "chunk_count": 512,
    "direct_access": false,
    "download_strategy": "accelerated",
    "url": null,
    "download_url": null
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
                bearer,
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
              requestExample: `curl '${baseUrl}/api/v1/files/<FILE_ID>/chunks/0' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -o part-0.bin`,
              responseExample: `HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Length: ${session.multipart_chunk_bytes}
X-Chunk-Index: 0
X-Chunk-Count: 512
X-Chunk-Offset: 0`
            }
          ]
        },
        {
          id: "api-key-multipart",
          title: "统一分片上传",
          description: `本地文件按 ${chunkSize} 分片上传；小文件通常只有 1 片。`,
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
              limits: [`size 必须大于 0 且小于等于 ${maxMultipart}。`, `分片大小固定为 ${chunkSize}。`, "目录路径最长 512 字符。"],
              specialHandling: ["同名冲突返回 409 FileNameConflict，并带 suggested_name。", "未完成会话会被定时清理。"],
              requestParams: [
                bearer,
                p("file_name", "Body", "是", "string", "1-180 字符", "最终文件名。"),
                p("mime_type", "Body", "否", "string", "默认 application/octet-stream", "客户端识别的 MIME。"),
                p("size", "Body", "是", "number", `1-${session.max_multipart_file_bytes}`, "文件总字节数。"),
                p("directory_path", "Body", "否", "string", "默认 /", "目标目录，不存在时自动创建。"),
                p("remark", "Body", "否", "string", "最多 1000 字符", "文件备注。"),
                p("on_conflict", "Body", "否", "string", "error / overwrite", "同名文件处理方式。")
              ],
              responseParams: uploadResponseFields,
              requestExample: `curl -X POST '${baseUrl}/api/v1/uploads/init' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "file_name": "backup.zip",
    "mime_type": "application/zip",
    "size": 5368709120,
    "directory_path": "/backup",
    "remark": "每日备份"
  }'`,
              responseExample: `{
  "ok": true,
  "upload": {
    "id": "upload-id",
    "file_name": "backup.zip",
    "mime_type": "application/zip",
    "size": 5368709120,
    "chunk_size": ${session.multipart_chunk_bytes},
    "chunk_count": 512,
    "direct_access": false,
    "direct_access_max_chunks": ${session.direct_access_max_chunks}
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
                bearer,
                p("uploadId", "Path", "是", "string", "上传会话 id", "初始化接口返回的 upload.id。"),
                p("index", "Path", "是", "number", "0 <= index < chunk_count", "分片序号。"),
                p("chunk", "FormData", "是", "File", "必须等于期望大小", "当前分片 Blob。")
              ],
              responseParams: chunkResponseFields,
              requestExample: `curl -X POST '${baseUrl}/api/v1/uploads/<UPLOAD_ID>/chunks/0' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -F 'chunk=@./backup.zip.part0'`,
              responseExample: `{
  "ok": true,
  "chunk": {
    "chunk_index": 0,
    "size": ${session.multipart_chunk_bytes},
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
                bearer,
                p("uploadId", "Path", "是", "string", "上传会话 id", "初始化接口返回的 upload.id。"),
                p("on_conflict", "Query/Body/FormData", "否", "string", "error / overwrite", "完成阶段同名冲突策略。"),
                p("thumbnail", "FormData", "否", "File", "<=512KB", "可选缩略图。"),
                p("thumbnail_width", "FormData", "否", "number", "1-8192", "缩略图宽度。"),
                p("thumbnail_height", "FormData", "否", "number", "1-8192", "缩略图高度。")
              ],
              responseParams: fileResponseFields,
              requestExample: `curl -X POST '${baseUrl}/api/v1/uploads/<UPLOAD_ID>/complete' \\
  -H 'Authorization: Bearer <API_KEY>'

curl -X POST '${baseUrl}/api/v1/uploads/<UPLOAD_ID>/complete' \\
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
    "chunk_count": 512,
    "direct_access": false,
    "download_strategy": "accelerated",
    "thumbnail_status": "ready",
    "url": null,
    "download_url": null
  }
}`
            }
          ]
        },
        {
          id: "api-key-url",
          title: "URL 分片导入",
          description: "Worker 从远程 URL 按 Range 拉取分片，再转存到 Telegram。",
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
              limits: [`远端大小必须小于等于 ${maxMultipart}。`, "URL 最长 4096 字符。", "远端必须支持 Range 并返回可确认大小。"],
              specialHandling: ["headers 支持对象、数组或 Header-Name: value 文本，最多 32 个，总计 16KB。", "图片小于 100MB 或视频小于分片上限时可能返回 thumbnail_source。"],
              requestParams: [
                bearer,
                p("url", "Body", "是", "string", "http/https，最长 4096", "远程文件 URL。"),
                p("headers", "Body", "否", "object | array | string", "最多 32 个，总计 16KB", "访问远端 URL 时附加的请求头；禁止 Host、Range 等 hop-by-hop 或代理头。"),
                p("file_name", "Body", "否", "string", "1-180 字符", "覆盖从 URL 推断的文件名。"),
                p("directory_path", "Body", "否", "string", "默认 /", "目标目录。"),
                p("remark", "Body", "否", "string", "最多 1000 字符", "文件备注。"),
                p("on_conflict", "Body", "否", "string", "error / overwrite", "同名文件处理方式。")
              ],
              responseParams: [
                okResponse,
                p("mode", "Response", "是", "string", "multipart", "API Key URL 导入固定返回 multipart。"),
                ...uploadResponseFields.slice(1)
              ],
              requestExample: `curl -X POST '${baseUrl}/api/v1/uploads/url/init' \\
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
              summary: "让 Worker 拉取并上传一个远程分片。",
              functionality: "按初始化时保存的 source_url 和 headers 发起 Range 请求，校验大小后上传到 Telegram。",
              useCases: ["服务端代理导入远程大文件。", "客户端只负责调度分片序号。"],
              limits: ["uploadId 必须是 url 上传会话。", "远端响应必须匹配期望 Range 和大小。"],
              specialHandling: ["远端 5xx 会转为 502，远端 4xx 多数转为 400。", "可重复调用同一 index 重试。"],
              requestParams: [
                bearer,
                p("uploadId", "Path", "是", "string", "上传会话 id", "URL 初始化返回的 upload.id。"),
                p("index", "Path", "是", "number", "0 <= index < chunk_count", "分片序号。")
              ],
              responseParams: chunkResponseFields,
              requestExample: `curl -X POST '${baseUrl}/api/v1/uploads/<UPLOAD_ID>/url-chunks/0' \\
  -H 'Authorization: Bearer <API_KEY>'`,
              responseExample: `{
  "ok": true,
  "chunk": {
    "chunk_index": 0,
    "size": ${session.multipart_chunk_bytes},
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
              limits: ["token 默认 10 分钟过期。", "图片源最大 100MB，视频源最大 5GB。"],
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
              requestExample: `curl '${baseUrl}/api/v1/uploads/url-thumbnail-source?token=<TOKEN>' \\
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
    },
    admin: {
      title: "管理员接口",
      description: "面向 React 管理后台。除登录外全部依赖 HttpOnly Cookie；前端 fetch 必须保留 credentials: include。",
      sections: [
        {
          id: "admin-auth",
          title: "认证与会话",
          description: "登录、退出和运行配置读取。",
          endpoints: [
            {
              id: "admin-login",
              method: "POST",
              path: "/api/admin/login",
              title: "管理员登录",
              auth: "无需 Cookie",
              summary: "验证管理员账号密码并设置会话 Cookie。",
              functionality: "支持 JSON、x-www-form-urlencoded 和 multipart/form-data；成功后写入 HttpOnly Cookie。",
              useCases: ["登录页提交账号密码。", "表单模式下支持 303 跳转到 /admin。"],
              limits: ["username/password 必须匹配环境变量配置。", "JSON 请求必须使用 application/json。"],
              specialHandling: ["remember_me=true 时创建持久会话。", "表单登录失败会跳转 /login?error=1，JSON 失败返回 401。"],
              requestParams: [
                p("username", "Body", "是", "string", "环境变量 ADMIN_USERNAME", "管理员用户名。"),
                p("password", "Body", "是", "string", "环境变量 ADMIN_PASSWORD", "管理员密码。"),
                p("remember_me", "Body", "否", "boolean", "默认 false", "是否持久登录。")
              ],
              responseParams: [
                okResponse,
                p("Set-Cookie", "Response", "是", "string", "HttpOnly", "管理员会话 Cookie。")
              ],
              requestExample: `curl -X POST '${baseUrl}/api/admin/login' \\
  -H 'Content-Type: application/json' \\
  -d '{ "username": "admin", "password": "secret", "remember_me": true }'`,
              responseExample: `HTTP/1.1 200 OK
Set-Cookie: admin_session=...; HttpOnly; SameSite=Lax

{ "ok": true }`
            },
            {
              id: "admin-session",
              method: "GET",
              path: "/api/admin/session",
              title: "获取当前会话和运行配置",
              auth: "Admin Cookie",
              summary: "返回登录用户、上传限制、公开服务地址和关键配置状态。",
              functionality: "校验 Cookie 并返回前端初始化所需的运行时配置。",
              useCases: ["App 启动时恢复登录状态。", "设置页展示环境变量配置状态。", "上传前读取大小限制。"],
              limits: ["必须带有效 admin_session。", "成功响应会刷新 Cookie 有效期。"],
              specialHandling: ["config 只返回布尔状态，不泄露密钥。", "config_values 中的敏感值会被 mask。"],
              requestParams: [adminCookie],
              responseParams: [
                okResponse,
                p("username", "Response", "是", "string", "管理员用户名", "当前登录用户。"),
                p("max_file_bytes", "Response", "是", "number", "字节", "单文件直传上限。"),
                p("multipart_chunk_bytes", "Response", "是", "number", "字节", "分片大小。"),
                p("max_multipart_file_bytes", "Response", "是", "number", "字节", "分片文件总上限。"),
                p("direct_access_max_chunks", "Response", "是", "number", "分片数", "允许整文件直链的最大分片数。"),
                p("base_url", "Response", "是", "string", "URL", "公开服务地址。"),
                p("config", "Response", "是", "object", "boolean map", "关键绑定和环境变量是否配置。"),
                p("config_values", "Response", "是", "object", "masked map", "设置页展示用配置摘要。")
              ],
              requestExample: `curl '${baseUrl}/api/admin/session' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "username": "admin",
  "max_file_bytes": ${session.max_file_bytes},
  "multipart_chunk_bytes": ${session.multipart_chunk_bytes},
  "max_multipart_file_bytes": ${session.max_multipart_file_bytes},
  "direct_access_max_chunks": ${session.direct_access_max_chunks},
  "base_url": "${baseUrl}",
  "config": { "files_db": true, "telegram_bot_token": true }
}`
            },
            {
              id: "admin-logout",
              method: "POST",
              path: "/api/admin/logout",
              title: "退出登录",
              auth: "Admin Cookie",
              summary: "清理管理员会话 Cookie。",
              functionality: "校验当前会话后返回过期 Cookie。",
              useCases: ["用户点击退出。", "主动清理浏览器中的管理会话。"],
              limits: ["必须带有效 admin_session。"],
              specialHandling: ["响应会覆盖 Set-Cookie，把会话设置为过期。"],
              requestParams: [adminCookie],
              responseParams: [
                okResponse,
                p("Set-Cookie", "Response", "是", "string", "过期 Cookie", "清理浏览器会话。")
              ],
              requestExample: `curl -X POST '${baseUrl}/api/admin/logout' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `HTTP/1.1 200 OK
Set-Cookie: admin_session=; Max-Age=0

{ "ok": true }`
            }
          ]
        },
        {
          id: "admin-files",
          title: "文件列表与文件管理",
          description: "文件列表、统计、上传、编辑、移动、删除和 HLS 下载计划。",
          endpoints: [
            {
              id: "admin-files-list",
              method: "GET",
              path: "/api/admin/files",
              title: "列出文件、目录和统计",
              auth: "Admin Cookie",
              summary: "管理后台首页的数据源，返回当前目录、子目录、文件分页和全局统计。",
              functionality: "按目录和筛选条件查询 files 表，同时返回直属子目录使用量和全局容量统计。",
              useCases: ["文件管理首页。", "目录切换、搜索、类型筛选、日期筛选。", "顶部指标卡片展示容量。"],
              limits: ["搜索只作用于当前目录，不递归。", "page/limit 必须为正整数；limit=all 或 all=1 返回全部。"],
              specialHandling: ["current_directory 为根目录时 id 为 null。", "global_stats 不受当前目录和筛选条件影响。"],
              requestParams: [
                adminCookie,
                p("dir", "Query", "否", "string", "默认 /", "当前目录路径。"),
                p("q", "Query", "否", "string", "空字符串允许", "文件名或备注搜索词。"),
                p("type", "Query", "否", "string", "image / video / text / pdf / archive / other", "文件类型筛选。"),
                p("created_from", "Query", "否", "string", "ISO 时间", "创建时间起点。"),
                p("created_to", "Query", "否", "string", "ISO 时间", "创建时间终点。"),
                p("page", "Query", "否", "number", ">=1", "页码。"),
                p("limit", "Query", "否", "number | all", ">=1", "每页数量；all 返回全部。"),
                p("all", "Query", "否", "string", "1", "返回全部记录。")
              ],
              responseParams: [
                okResponse,
                p("current_directory", "Response", "是", "object", "目录对象", "当前目录信息。"),
                p("directories", "Response", "是", "array", "直属子目录", "当前目录的子目录列表，包含 file_count 和 total_size。"),
                p("files", "Response", "是", "array<FileItem>", "分页结果", "文件记录列表。"),
                p("pagination", "Response", "是", "object", "page/limit/total/total_pages", "分页信息。"),
                p("global_stats", "Response", "是", "object", "file_count/total_size", "全局文件统计。"),
                p("max_file_bytes", "Response", "是", "number", "字节", "单文件直传上限。"),
                p("multipart_chunk_bytes", "Response", "是", "number", "字节", "分片大小。")
              ],
              requestExample: `curl '${baseUrl}/api/admin/files?dir=/photos&q=trip&type=image&page=1&limit=24' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "current_directory": { "id": null, "path": "/" },
  "directories": [
    { "id": "dir-id", "name": "photos", "path": "/photos", "file_count": 12, "total_size": 1048576 }
  ],
  "files": [
    {
      "id": "file-id",
      "file_name": "trip.jpg",
      "directory_path": "/photos",
      "url": "${baseUrl}/f/<token>/trip.jpg",
      "download_url": "${baseUrl}/f/<token>/trip.jpg?download=1"
    }
  ],
  "pagination": { "page": 1, "limit": 24, "total": 1, "total_pages": 1 },
  "global_stats": { "file_count": 128, "total_size": 987654321 }
}`
            },
            {
              id: "admin-files-create",
              method: "POST",
              path: "/api/admin/files",
              title: "管理员小文件上传或 URL 拉取",
              auth: "Admin Cookie",
              summary: "支持 multipart 文件上传或 JSON URL 拉取，适合小文件。",
              functionality: "读取本地文件或远程 URL，受 MAX_FILE_BYTES 限制，转存到 Telegram 并创建文件索引。",
              useCases: ["控制台上传小文件。", "从 URL 快速导入小文件。"],
              limits: [`文件大小必须小于等于 ${maxFile}。`, "URL 最长 4096 字符。", "Content-Type 必须是 multipart/form-data 或 application/json。"],
              specialHandling: ["远程 URL 可附加 headers/source_headers/request_headers。", "同名冲突默认返回 409，可用 on_conflict=overwrite 覆盖。"],
              requestParams: [
                adminCookie,
                p("file", "FormData", "条件", "File", `<=${maxFile}`, "本地上传文件；与 JSON url 二选一。"),
                p("url", "Body", "条件", "string", "http/https", "远程文件 URL；JSON 模式使用。"),
                p("headers", "Body/FormData", "否", "object | array | string", "最多 32 个，总计 16KB", "拉取远端 URL 时附加请求头。"),
                p("file_name", "Body/FormData", "否", "string", "1-180 字符", "覆盖文件名。"),
                p("directory_path", "Body/FormData", "否", "string", "默认 /", "目标目录。"),
                p("remark", "Body/FormData", "否", "string", "最多 1000 字符", "备注。"),
                p("on_conflict", "Body/FormData", "否", "string", "error / overwrite", "同名处理。")
              ],
              responseParams: fileResponseFields,
              requestExample: `curl -X POST '${baseUrl}/api/admin/files' \\
  -H 'Cookie: admin_session=...' \\
  -F 'file=@./hello.txt' \\
  -F 'directory_path=/docs'

curl -X POST '${baseUrl}/api/admin/files' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "url": "https://example.com/hello.txt", "directory_path": "/docs" }'`,
              responseExample: `{
  "ok": true,
  "file": {
    "id": "file-id",
    "file_name": "hello.txt",
    "storage_backend": "telegram_single",
    "file_path": "/f/<token>/hello.txt",
    "url": "${baseUrl}/f/<token>/hello.txt",
    "download_url": "${baseUrl}/f/<token>/hello.txt?download=1"
  }
}`
            },
            {
              id: "admin-files-update",
              method: "PATCH",
              path: "/api/admin/files/:id",
              title: "修改文件名和备注",
              auth: "Admin Cookie",
              summary: "更新文件展示名和备注。",
              functionality: "读取现有文件记录，校验新文件名并在需要时重新签发 file_path。",
              useCases: ["重命名文件。", "编辑备注。"],
              limits: ["至少提供 file_name 或 remark。", "file_name 必须 1-180 字符且同目录唯一。"],
              specialHandling: ["remark=null 或空字符串会清空备注。", "文件名变更会生成新的签名路径，旧链接不主动失效。"],
              requestParams: [
                adminCookie,
                p("id", "Path", "是", "string", "文件 id", "文件记录 id。"),
                p("file_name", "Body", "否", "string", "1-180 字符", "新的文件名。"),
                p("remark", "Body", "否", "string | null", "最多 1000 字符", "新的备注；null 清空。")
              ],
              responseParams: fileResponseFields,
              requestExample: `curl -X PATCH '${baseUrl}/api/admin/files/<FILE_ID>' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "file_name": "new-name.txt", "remark": "新的备注" }'`,
              responseExample: `{
  "ok": true,
  "file": {
    "id": "file-id",
    "file_name": "new-name.txt",
    "remark": "新的备注",
    "file_path": "/f/<new-token>/new-name.txt"
  }
}`
            },
            {
              id: "admin-files-move",
              method: "PATCH",
              path: "/api/admin/files/move",
              title: "移动文件到目录",
              auth: "Admin Cookie",
              summary: "批量移动文件索引到目标目录。",
              functionality: "解析目标目录，必要时自动创建，然后更新文件记录 directory_path。",
              useCases: ["旧版单类型批量移动。", "只移动文件不移动目录。"],
              limits: ["file_ids 必须非空。", "目标目录内不能出现同名冲突。"],
              specialHandling: ["新前端更推荐使用 /api/admin/entries/move。", "支持通过 new_directory_parent_path + new_directory_name 创建目标目录。"],
              requestParams: [
                adminCookie,
                p("file_ids", "Body", "是", "string[]", "非空", "要移动的文件 id 列表。"),
                p("directory_path", "Body", "条件", "string", "目标目录", "移动到已有或自动创建的目录。"),
                p("new_directory_parent_path", "Body", "条件", "string", "父目录", "创建新目录时的父路径。"),
                p("new_directory_name", "Body", "条件", "string", "1-80 字符", "创建新目录时的名称。")
              ],
              responseParams: [
                okResponse,
                p("moved", "Response", "是", "number", ">=0", "移动成功的文件数。"),
                p("directory_path", "Response", "是", "string", "目标目录", "最终目录路径。")
              ],
              requestExample: `curl -X PATCH '${baseUrl}/api/admin/files/move' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "file_ids": ["file-id-1", "file-id-2"], "directory_path": "/archive" }'`,
              responseExample: `{
  "ok": true,
  "moved": 2,
  "directory_path": "/archive"
}`
            },
            {
              id: "admin-files-delete",
              method: "DELETE",
              path: "/api/admin/files/:id",
              title: "删除单个文件索引",
              auth: "Admin Cookie",
              summary: "软删除一个文件记录。",
              functionality: "把文件记录标记为 deleted，不删除 Telegram 原始消息。",
              useCases: ["从控制台移除单个文件。", "清理索引记录。"],
              limits: ["id 必须指向存在的未删除文件。"],
              specialHandling: ["已分发的签名链接仍可能继续可用。", "不会回收 Telegram 中的消息或文件。"],
              requestParams: [
                adminCookie,
                p("id", "Path", "是", "string", "文件 id", "文件记录 id。")
              ],
              responseParams: [okResponse],
              requestExample: `curl -X DELETE '${baseUrl}/api/admin/files/<FILE_ID>' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{ "ok": true }`
            },
            {
              id: "admin-hls-download-plan",
              method: "GET",
              path: "/api/admin/files/:id/hls-download",
              title: "获取 HLS 加速下载计划",
              auth: "Admin Cookie",
              summary: "为 HLS package 生成可并发下载的 part 列表。",
              functionality: "把 HLS init segment、media segment 和 segment chunk 展开成有序 parts，并生成签名 URL。",
              useCases: ["控制台加速下载 HLS 文件。", "客户端并发下载后按 offset 合并为 TS 或 fMP4 文件。"],
              limits: ["仅支持 storage_backend=hls_package。", "支持 TS HLS 与单 init segment fMP4 HLS 顺序合并。"],
              specialHandling: ["如果 HLS 不可合并会返回 UnsupportedHlsDownload。", "direct_access=false 时仍可使用 parts 加速下载。"],
              requestParams: [
                adminCookie,
                p("id", "Path", "是", "string", "文件 id", "HLS 文件记录 id。")
              ],
              responseParams: [
                okResponse,
                p("hls_download.file_id", "Response", "是", "string", "文件 id", "源文件 id。"),
                p("hls_download.file_name", "Response", "是", "string", "*.ts / *.mp4", "合并下载文件名。"),
                p("hls_download.kind", "Response", "是", "string", "ts / fmp4", "顺序合并的容器类型。"),
                p("hls_download.total_size", "Response", "是", "number", "字节", "所有 part 总大小。"),
                p("hls_download.part_count", "Response", "是", "number", ">=1", "可下载 part 数量。"),
                p("hls_download.parts", "Response", "是", "array", "按 index 排序", "每个 part 的 offset、size、url。")
              ],
              requestExample: `curl '${baseUrl}/api/admin/files/<HLS_FILE_ID>/hls-download' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "hls_download": {
    "file_id": "file-hls",
    "file_name": "movie.ts",
    "total_size": 73400320,
    "part_count": 12,
    "direct_access": false,
    "parts": [
      { "index": 0, "segment_index": 0, "chunk_index": null, "offset": 0, "size": 5242880, "url": "${baseUrl}/api/hls/<token>/segments/0/seg-0.ts" }
    ]
  }
}`
            }
          ]
        },
        {
          id: "admin-directories",
          title: "目录管理",
          description: "虚拟目录的查询、创建、重命名、移动和递归删除。",
          endpoints: [
            {
              id: "admin-directories-list",
              method: "GET",
              path: "/api/admin/directories",
              title: "列出目录",
              auth: "Admin Cookie",
              summary: "返回直属子目录或全部目录。",
              functionality: "flat=1 时读取所有目录；否则按 parent_path 读取子目录。",
              useCases: ["侧边目录树。", "移动弹窗目录选择。"],
              limits: ["parent_path 必须是可读目录。", "目录路径最长 512 字符。"],
              specialHandling: ["flat=true 和 flat=1 等价。", "非 flat 模式会校验父目录存在。"],
              requestParams: [
                adminCookie,
                p("parent_path", "Query", "否", "string", "默认 /", "父目录路径。"),
                p("flat", "Query", "否", "boolean string", "1 / true", "是否返回所有目录。")
              ],
              responseParams: [
                okResponse,
                p("directories", "Response", "是", "array<DirectoryItem>", "目录列表", "目录记录，含 id、parent_id、name、path、file_count、total_size。")
              ],
              requestExample: `curl '${baseUrl}/api/admin/directories?parent_path=/' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "directories": [
    { "id": "dir-id", "parent_id": null, "name": "photos", "path": "/photos", "file_count": 12, "total_size": 1048576 }
  ]
}`
            },
            {
              id: "admin-directories-create",
              method: "POST",
              path: "/api/admin/directories",
              title: "新建目录",
              auth: "Admin Cookie",
              summary: "在指定父目录下创建虚拟目录。",
              functionality: "校验目录名和父路径后写入 directories 记录。",
              useCases: ["用户点击新建文件夹。", "移动文件时自动创建目标目录。"],
              limits: ["name 必须 1-80 字符。", "name 不能包含 /、\\、控制字符、. 或 ..。"],
              specialHandling: ["同级目录重名返回 DirectoryExists。", "根目录 parent_path 使用 /。"],
              requestParams: [
                adminCookie,
                p("name", "Body", "是", "string", "1-80 字符", "目录名称。"),
                p("parent_path", "Body", "否", "string", "默认 /", "父目录路径。")
              ],
              responseParams: [
                okResponse,
                p("directory", "Response", "是", "DirectoryItem", "目录对象", "创建后的目录记录。")
              ],
              requestExample: `curl -X POST '${baseUrl}/api/admin/directories' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "name": "photos", "parent_path": "/" }'`,
              responseExample: `{
  "ok": true,
  "directory": { "id": "dir-id", "name": "photos", "path": "/photos" }
}`
            },
            {
              id: "admin-directories-rename",
              method: "PATCH",
              path: "/api/admin/directories/:id",
              title: "重命名目录",
              auth: "Admin Cookie",
              summary: "重命名目录并递归更新子路径。",
              functionality: "更新目录名称后，同步调整子目录 path 和目录下文件 directory_path。",
              useCases: ["文件夹重命名。"],
              limits: ["不能重命名不存在的目录。", "新名称同样受目录名规则约束。"],
              specialHandling: ["会返回受影响目录数和文件数。", "路径更新是递归操作。"],
              requestParams: [
                adminCookie,
                p("id", "Path", "是", "string", "目录 id", "目录记录 id。"),
                p("name", "Body", "是", "string", "1-80 字符", "新目录名称。")
              ],
              responseParams: [
                okResponse,
                p("directory", "Response", "是", "DirectoryItem", "目录对象", "更新后的目录。"),
                p("renamed_directories", "Response", "是", "number", ">=1", "更新路径的目录数量。"),
                p("updated_files", "Response", "是", "number", ">=0", "更新路径的文件数量。")
              ],
              requestExample: `curl -X PATCH '${baseUrl}/api/admin/directories/<DIR_ID>' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "name": "images" }'`,
              responseExample: `{
  "ok": true,
  "renamed_directories": 2,
  "updated_files": 12,
  "directory": { "id": "dir-id", "path": "/images" }
}`
            },
            {
              id: "admin-directories-move",
              method: "PATCH",
              path: "/api/admin/directories/:id/move",
              title: "移动目录树",
              auth: "Admin Cookie",
              summary: "把目录移动到新的父目录下。",
              functionality: "校验目标父目录后递归更新目录树和文件路径。",
              useCases: ["拖拽移动文件夹。", "整理目录层级。"],
              limits: ["禁止移动到自身或子目录。", "目标父目录必须可写。"],
              specialHandling: ["会返回移动目录数和文件数。", "目录名保持不变。"],
              requestParams: [
                adminCookie,
                p("id", "Path", "是", "string", "目录 id", "要移动的目录。"),
                p("parent_path", "Body", "是", "string", "目标父目录", "新的父目录路径。")
              ],
              responseParams: [
                okResponse,
                p("directory", "Response", "是", "DirectoryItem", "目录对象", "移动后的目录。"),
                p("moved_directories", "Response", "是", "number", ">=1", "移动的目录数量。"),
                p("moved_files", "Response", "是", "number", ">=0", "受影响文件数量。")
              ],
              requestExample: `curl -X PATCH '${baseUrl}/api/admin/directories/<DIR_ID>/move' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "parent_path": "/archive" }'`,
              responseExample: `{
  "ok": true,
  "moved_directories": 2,
  "moved_files": 12,
  "directory": { "id": "dir-id", "path": "/archive/photos" }
}`
            },
            {
              id: "admin-directories-delete",
              method: "DELETE",
              path: "/api/admin/directories/:id",
              title: "递归删除目录树",
              auth: "Admin Cookie",
              summary: "软删除目录、子目录和目录内文件索引。",
              functionality: "递归标记目录树 deleted_at，并软删除目录下文件记录。",
              useCases: ["删除文件夹。", "批量清理目录内容。"],
              limits: ["目录必须存在。"],
              specialHandling: ["不会删除 Telegram 原始消息。", "已分发的签名链接仍可能继续可用。"],
              requestParams: [
                adminCookie,
                p("id", "Path", "是", "string", "目录 id", "要删除的目录。")
              ],
              responseParams: [
                okResponse,
                p("deleted_directories", "Response", "是", "number", ">=1", "软删除目录数量。"),
                p("deleted_files", "Response", "是", "number", ">=0", "软删除文件数量。"),
                p("directory", "Response", "是", "DirectoryItem", "目录对象", "被删除的根目录。")
              ],
              requestExample: `curl -X DELETE '${baseUrl}/api/admin/directories/<DIR_ID>' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "deleted_directories": 2,
  "deleted_files": 12,
  "directory": { "id": "dir-id", "path": "/photos" }
}`
            }
          ]
        },
        {
          id: "admin-entries",
          title: "文件和目录批量操作",
          description: "面向多选 UI 的统一移动和删除接口。",
          endpoints: [
            {
              id: "admin-entries-move",
              method: "PATCH",
              path: "/api/admin/entries/move",
              title: "移动文件和目录",
              auth: "Admin Cookie",
              summary: "支持文件和目录混合移动。",
              functionality: "校验选择项、目标目录、目录树关系和文件名冲突后执行移动。",
              useCases: ["多选移动。", "文件和文件夹一起整理。"],
              limits: ["file_ids 和 directory_ids 至少一个非空。", "目录不能移动到自身或子目录。"],
              specialHandling: ["支持创建新目标目录。", "移动目录时会递归更新子路径。"],
              requestParams: [
                adminCookie,
                p("file_ids", "Body", "否", "string[]", "可空", "要移动的文件 id。"),
                p("directory_ids", "Body", "否", "string[]", "可空", "要移动的目录 id。"),
                p("directory_path", "Body", "条件", "string", "目标目录", "已有或自动创建的目标目录。"),
                p("new_directory_parent_path", "Body", "条件", "string", "父目录", "创建新目录时使用。"),
                p("new_directory_name", "Body", "条件", "string", "1-80 字符", "新目录名称。")
              ],
              responseParams: [
                okResponse,
                p("moved", "Response", "是", "number", ">=0", "移动总数。"),
                p("moved_directories", "Response", "是", "number", ">=0", "移动目录数。"),
                p("moved_files", "Response", "是", "number", ">=0", "移动文件数。"),
                p("directory_path", "Response", "是", "string", "目标目录", "最终目标路径。")
              ],
              requestExample: `curl -X PATCH '${baseUrl}/api/admin/entries/move' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "file_ids": ["file-id"], "directory_ids": ["dir-id"], "directory_path": "/archive" }'`,
              responseExample: `{
  "ok": true,
  "moved": 3,
  "moved_directories": 1,
  "moved_files": 2,
  "directory_path": "/archive"
}`
            },
            {
              id: "admin-entries-delete",
              method: "POST",
              path: "/api/admin/entries/delete",
              title: "批量删除文件和目录",
              auth: "Admin Cookie",
              summary: "支持文件和目录混合软删除。",
              functionality: "软删除选中文件索引，并递归软删除选中目录树。",
              useCases: ["多选删除。", "批量清理文件夹。"],
              limits: ["file_ids 和 directory_ids 至少一个非空。"],
              specialHandling: ["不会删除 Telegram 原始消息。", "目录删除会把目录下文件计入 deleted_files。"],
              requestParams: [
                adminCookie,
                p("file_ids", "Body", "否", "string[]", "可空", "要删除的文件 id。"),
                p("directory_ids", "Body", "否", "string[]", "可空", "要删除的目录 id。")
              ],
              responseParams: [
                okResponse,
                p("deleted_directories", "Response", "是", "number", ">=0", "删除目录数。"),
                p("deleted_files", "Response", "是", "number", ">=0", "删除文件数。")
              ],
              requestExample: `curl -X POST '${baseUrl}/api/admin/entries/delete' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "file_ids": ["file-id"], "directory_ids": ["dir-id"] }'`,
              responseExample: `{
  "ok": true,
  "deleted_directories": 1,
  "deleted_files": 3
}`
            }
          ]
        },
        {
          id: "admin-multipart",
          title: "管理员分片上传",
          description: "控制台本地文件、URL 导入、预检、状态查询和完成提交。",
          endpoints: [
            {
              id: "admin-upload-preflight",
              method: "POST",
              path: "/api/admin/uploads/preflight",
              title: "上传前文件名预检",
              auth: "Admin Cookie",
              summary: "批量检查目标目录下是否存在同名冲突。",
              functionality: "在创建上传会话前检查 files 表和当前批次内的重复文件名。",
              useCases: ["拖拽批量上传前一次性提示冲突。", "为冲突文件生成 suggested_name。"],
              limits: ["entries 必须非空，最多 1000 项。", "file_name 和 directory_path 会按后端规则清洗。"],
              specialHandling: ["source=file 表示数据库已有文件冲突。", "source=batch 表示本次批量内重复。"],
              requestParams: [
                adminCookie,
                p("entries", "Body", "是", "array", "1-1000", "待检查文件列表。"),
                p("entries[].client_id", "Body", "是", "string", "客户端自定义", "用于前端映射结果。"),
                p("entries[].directory_path", "Body", "是", "string", "目录路径", "目标目录。"),
                p("entries[].file_name", "Body", "是", "string", "1-180 字符", "文件名。"),
                p("entries[].relative_path", "Body", "否", "string", "最多 512 字符", "批量目录上传时的相对路径。"),
                p("entries[].size", "Body", "否", "number", ">=0", "文件大小。")
              ],
              responseParams: [
                okResponse,
                p("entries", "Response", "是", "array", "与请求项对应", "每项 status 为 ready 或 conflict。"),
                p("entries[].suggested_name", "Response", "否", "string", "冲突时返回", "建议改名。"),
                p("summary.total", "Response", "是", "number", ">=1", "总项数。"),
                p("summary.ready", "Response", "是", "number", ">=0", "可上传项数。"),
                p("summary.conflicts", "Response", "是", "number", ">=0", "冲突项数。")
              ],
              requestExample: `curl -X POST '${baseUrl}/api/admin/uploads/preflight' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "entries": [{ "client_id": "1", "directory_path": "/docs", "file_name": "readme.txt", "size": 12 }] }'`,
              responseExample: `{
  "ok": true,
  "entries": [
    { "client_id": "1", "directory_path": "/docs", "file_name": "readme.txt", "status": "ready" }
  ],
  "summary": { "total": 1, "ready": 1, "conflicts": 0 }
}`
            },
            {
              id: "admin-uploads-init",
              method: "POST",
              path: "/api/admin/uploads/init",
              title: "初始化本地分片上传",
              auth: "Admin Cookie",
              summary: "创建管理员本地文件分片上传会话。",
              functionality: "与 API Key 分片初始化一致，但会记录 uploaded_by 为当前管理员用户名。",
              useCases: ["控制台上传大文件。", "控制台统一用分片流程上传小文件。"],
              limits: [`size 必须大于 0 且小于等于 ${maxMultipart}。`, `chunk_size 固定为 ${chunkSize}。`],
              specialHandling: ["目标目录不存在时自动创建。", "同名冲突可用 on_conflict=overwrite。"],
              requestParams: [
                adminCookie,
                p("file_name", "Body", "是", "string", "1-180 字符", "最终文件名。"),
                p("mime_type", "Body", "否", "string", "默认 application/octet-stream", "文件类型。"),
                p("size", "Body", "是", "number", `1-${session.max_multipart_file_bytes}`, "文件总大小。"),
                p("directory_path", "Body", "否", "string", "默认 /", "目标目录。"),
                p("remark", "Body", "否", "string", "最多 1000 字符", "备注。"),
                p("on_conflict", "Body", "否", "string", "error / overwrite", "同名处理。")
              ],
              responseParams: uploadResponseFields,
              requestExample: `curl -X POST '${baseUrl}/api/admin/uploads/init' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "file_name": "backup.zip", "mime_type": "application/zip", "size": 5368709120, "directory_path": "/backup" }'`,
              responseExample: `{
  "ok": true,
  "upload": {
    "id": "upload-id",
    "file_name": "backup.zip",
    "chunk_size": ${session.multipart_chunk_bytes},
    "chunk_count": 512,
    "direct_access": false
  }
}`
            },
            {
              id: "admin-url-init",
              method: "POST",
              path: "/api/admin/uploads/url/init",
              title: "初始化 URL 分片导入",
              auth: "Admin Cookie",
              summary: "创建管理员远程 URL 分片导入会话。",
              functionality: "探测远程文件大小和类型，保存 URL、可选请求头和目录信息。",
              useCases: ["控制台从远程 URL 导入大文件。", "视频 URL 导入后生成缩略图源。"],
              limits: [`远端文件小于等于 ${maxMultipart}。`, "URL 最长 4096 字符。", "headers 最多 32 个，总计 16KB。"],
              specialHandling: ["管理员 URL 上传同样固定走 multipart。", "thumbnail_source 只在图片/视频且大小合规时返回。"],
              requestParams: [
                adminCookie,
                p("url", "Body", "是", "string", "http/https", "远程文件 URL。"),
                p("headers", "Body", "否", "object | array | string", "最多 32 个", "远端请求头。"),
                p("file_name", "Body", "否", "string", "1-180 字符", "覆盖文件名。"),
                p("directory_path", "Body", "否", "string", "默认 /", "目标目录。"),
                p("remark", "Body", "否", "string", "最多 1000 字符", "备注。"),
                p("on_conflict", "Body", "否", "string", "error / overwrite", "同名处理。")
              ],
              responseParams: [
                okResponse,
                p("mode", "Response", "是", "string", "multipart", "固定为 multipart。"),
                ...uploadResponseFields.slice(1)
              ],
              requestExample: `curl -X POST '${baseUrl}/api/admin/uploads/url/init' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "url": "https://example.com/video.mp4", "directory_path": "/videos" }'`,
              responseExample: `{
  "ok": true,
  "mode": "multipart",
  "upload": {
    "id": "upload-id",
    "source_kind": "url",
    "file_name": "video.mp4",
    "chunk_count": 42,
    "thumbnail_source": {
      "available": true,
      "kind": "video",
      "url": "/api/admin/uploads/url-thumbnail-source?token=..."
    }
  }
}`
            },
            {
              id: "admin-upload-status",
              method: "GET",
              path: "/api/admin/uploads/:uploadId/status",
              title: "查询分片上传状态",
              auth: "Admin Cookie",
              summary: "返回上传会话和已完成/缺失分片列表。",
              functionality: "读取 multipart_uploads 和 file_chunks，用于恢复未完成上传。",
              useCases: ["上传中断后恢复。", "刷新页面后继续上传。"],
              limits: ["uploadId 必须存在且未被清理。"],
              specialHandling: ["source_kind 区分 local 与 url。", "missing_chunks 可直接作为重试队列。"],
              requestParams: [
                adminCookie,
                p("uploadId", "Path", "是", "string", "上传会话 id", "初始化返回的 upload.id。")
              ],
              responseParams: statusResponseFields,
              requestExample: `curl '${baseUrl}/api/admin/uploads/<UPLOAD_ID>/status' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "upload": { "id": "upload-id", "source_kind": "local", "file_name": "backup.zip", "chunk_count": 512 },
  "uploaded_chunks": [0, 1],
  "missing_chunks": [2, 3, 4]
}`
            },
            {
              id: "admin-upload-chunk",
              method: "POST",
              path: "/api/admin/uploads/:uploadId/chunks/:index",
              title: "上传本地分片",
              auth: "Admin Cookie",
              summary: "上传管理员本地文件的一个分片。",
              functionality: "读取 FormData chunk，校验大小，发送到 Telegram 并保存分片记录。",
              useCases: ["控制台并发上传。", "失败分片重传。"],
              limits: ["uploadId 必须是 local 会话。", "chunk 大小必须匹配 expectedChunkSize。"],
              specialHandling: ["重复 index 会更新分片记录。", "上传通道会在多个 Telegram channel 间调度。"],
              requestParams: [
                adminCookie,
                p("uploadId", "Path", "是", "string", "上传会话 id", "初始化返回 id。"),
                p("index", "Path", "是", "number", "0 <= index < chunk_count", "分片序号。"),
                p("chunk", "FormData", "是", "File", "期望大小", "分片 Blob。")
              ],
              responseParams: chunkResponseFields,
              requestExample: `curl -X POST '${baseUrl}/api/admin/uploads/<UPLOAD_ID>/chunks/0' \\
  -H 'Cookie: admin_session=...' \\
  -F 'chunk=@./backup.zip.part0'`,
              responseExample: `{
  "ok": true,
  "chunk": { "chunk_index": 0, "size": ${session.multipart_chunk_bytes}, "telegram_file_id": "BQACAg..." },
  "uploaded_chunks": 1
}`
            },
            {
              id: "admin-url-chunk",
              method: "POST",
              path: "/api/admin/uploads/:uploadId/url-chunks/:index",
              title: "导入 URL 分片",
              auth: "Admin Cookie",
              summary: "从远端 URL 导入一个指定分片。",
              functionality: "使用 Range 拉取远端分片，校验响应大小后转存到 Telegram。",
              useCases: ["控制台 URL 导入进度调度。", "失败分片重试。"],
              limits: ["uploadId 必须是 url 会话。", "远端必须稳定支持 Range。"],
              specialHandling: ["会复用初始化时保存的 headers。", "远端读取失败会返回 UrlFetchFailed。"],
              requestParams: [
                adminCookie,
                p("uploadId", "Path", "是", "string", "URL 上传会话 id", "url/init 返回 id。"),
                p("index", "Path", "是", "number", "0 <= index < chunk_count", "分片序号。")
              ],
              responseParams: chunkResponseFields,
              requestExample: `curl -X POST '${baseUrl}/api/admin/uploads/<UPLOAD_ID>/url-chunks/0' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "chunk": { "chunk_index": 0, "size": ${session.multipart_chunk_bytes}, "telegram_file_id": "BQACAg..." },
  "uploaded_chunks": 1
}`
            },
            {
              id: "admin-upload-complete",
              method: "POST",
              path: "/api/admin/uploads/:uploadId/complete",
              title: "完成分片上传",
              auth: "Admin Cookie",
              summary: "提交最终文件记录，可选附带缩略图。",
              functionality: "校验所有分片，生成签名 file_path，事务写入 files 并完成上传会话。",
              useCases: ["本地分片上传完成。", "URL 分片导入完成。"],
              limits: ["缺少分片返回 UploadIncomplete。", "缩略图最大 512KB，类型限 JPEG/PNG/WebP。"],
              specialHandling: ["完成阶段仍会检查文件名冲突。", "缩略图失败只影响 thumbnail_status。"],
              requestParams: [
                adminCookie,
                p("uploadId", "Path", "是", "string", "上传会话 id", "初始化返回 id。"),
                p("on_conflict", "Query/Body/FormData", "否", "string", "error / overwrite", "同名处理。"),
                p("thumbnail", "FormData", "否", "File", "<=512KB", "缩略图文件。"),
                p("thumbnail_width", "FormData", "否", "number", "1-8192", "缩略图宽度。"),
                p("thumbnail_height", "FormData", "否", "number", "1-8192", "缩略图高度。")
              ],
              responseParams: fileResponseFields,
              requestExample: `curl -X POST '${baseUrl}/api/admin/uploads/<UPLOAD_ID>/complete' \\
  -H 'Cookie: admin_session=...'

curl -X POST '${baseUrl}/api/admin/uploads/<UPLOAD_ID>/complete' \\
  -H 'Cookie: admin_session=...' \\
  -F 'thumbnail=@./thumbnail.jpg'`,
              responseExample: `{
  "ok": true,
  "file": {
    "id": "upload-id",
    "storage_backend": "telegram_multipart",
    "chunk_count": 512,
    "direct_access": false,
    "download_strategy": "accelerated",
    "thumbnail_status": "ready"
  }
}`
            },
            {
              id: "admin-thumbnail-source",
              method: "GET",
              path: "/api/admin/uploads/url-thumbnail-source?token=...",
              title: "读取管理员 URL 缩略图源",
              auth: "Signed thumbnail token",
              summary: "给控制台缩略图生成流程使用的同源媒体代理。",
              functionality: "与 API Key thumbnail-source 相同，但路径位于管理员命名空间。",
              useCases: ["控制台 URL 视频抽帧。", "控制台 URL 图片生成缩略图。"],
              limits: ["token 默认 10 分钟过期。", "视频默认只代理前 2MB。"],
              specialHandling: ["该接口由签名 token 鉴权，不额外要求 admin Cookie。", "会复用 URL 上传会话中的远端请求头。"],
              requestParams: [
                p("token", "Query", "是", "string", "签名 token", "url/init 返回的 thumbnail_source.url。"),
                p("Range", "Header", "否", "string", "bytes=start-end", "范围读取。")
              ],
              responseParams: [
                p("Content-Type", "Response", "是", "string", "源 MIME", "媒体类型。"),
                p("Content-Length", "Response", "条件", "number", "字节", "响应大小。"),
                p("Content-Range", "Response", "条件", "string", "Range 时返回", "范围信息。"),
                p("Accept-Ranges", "Response", "条件", "string", "bytes", "远端 Range 能力。")
              ],
              requestExample: `curl '${baseUrl}/api/admin/uploads/url-thumbnail-source?token=<TOKEN>' \\
  -H 'Range: bytes=0-2097151' \\
  -o source.part`,
              responseExample: `HTTP/1.1 206 Partial Content
Content-Type: video/mp4
Content-Range: bytes 0-2097151/104857600`
            }
          ]
        },
        {
          id: "admin-hls",
          title: "HLS 导入与预览",
          description: "探测 HLS playlist，导入 segment，生成预览和最终 HLS package 文件。",
          endpoints: [
            {
              id: "admin-hls-probe",
              method: "POST",
              path: "/api/admin/uploads/hls/probe",
              title: "探测 HLS 源",
              auth: "Admin Cookie",
              summary: "读取 HLS playlist，返回 master/media 信息和可选变体。",
              functionality: "拉取 m3u8，解析 master playlist 或 media playlist，估算 segment 信息。",
              useCases: ["用户输入 HLS URL 后预览变体。", "选择分辨率/码率后初始化导入。"],
              limits: ["playlist 最大 2MB。", "variant_id 最长 80 字符。", "仅支持 HTTP/HTTPS 源。"],
              specialHandling: ["master playlist 会返回 variants；media playlist 会返回 media 摘要。", "headers 可用于访问鉴权源。"],
              requestParams: [
                adminCookie,
                p("url", "Body", "是", "string", "m3u8 URL", "HLS playlist 地址。"),
                p("variant_id", "Body", "否", "string", "最多 80 字符", "选择 master playlist 中的变体。"),
                p("headers", "Body", "否", "object | array | string", "最多 32 个", "远端请求头。")
              ],
              responseParams: [
                okResponse,
                p("hls.playlist_url", "Response", "是", "string", "URL", "被探测的 playlist。"),
                p("hls.kind", "Response", "是", "string", "master / media", "playlist 类型。"),
                p("hls.variants", "Response", "是", "array", "master 时可能非空", "可选码率/分辨率列表。"),
                p("hls.media", "Response", "否", "object | null", "media playlist", "目标 media 信息。")
              ],
              requestExample: `curl -X POST '${baseUrl}/api/admin/uploads/hls/probe' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "url": "https://example.com/master.m3u8" }'`,
              responseExample: `{
  "ok": true,
  "hls": {
    "playlist_url": "https://example.com/master.m3u8",
    "kind": "master",
    "selected_variant_id": null,
    "variants": [
      { "id": "v0", "bandwidth": 2500000, "resolution": "1280x720", "codecs": "avc1.64001f" }
    ],
    "media": null
  }
}`
            },
            {
              id: "admin-hls-init",
              method: "POST",
              path: "/api/admin/uploads/hls/init",
              title: "初始化 HLS 导入",
              auth: "Admin Cookie",
              summary: "创建 HLS 导入任务和 segment 记录。",
              functionality: "解析目标 media playlist，写入 hls_assets 和 hls_segments 临时记录。",
              useCases: ["开始导入 HLS 视频。", "保存用户选择的 variant_id、目录和备注。"],
              limits: ["segment 数最多 2000。", "文件名必须 1-180 字符。", "目录路径最长 512 字符。"],
              specialHandling: ["HLS 最终会保存为 storage_backend=hls_package。", "同名冲突在初始化和完成阶段都会校验。"],
              requestParams: [
                adminCookie,
                p("url", "Body", "是", "string", "m3u8 URL", "HLS playlist 地址。"),
                p("variant_id", "Body", "否", "string", "最多 80 字符", "选中的变体。"),
                p("file_name", "Body", "否", "string", "1-180 字符", "最终文件名。"),
                p("directory_path", "Body", "否", "string", "默认 /", "目标目录。"),
                p("remark", "Body", "否", "string", "最多 1000 字符", "备注。"),
                p("headers", "Body", "否", "object | array | string", "最多 32 个", "远端请求头。"),
                p("on_conflict", "Body", "否", "string", "error / overwrite", "同名处理。")
              ],
              responseParams: hlsUploadFields,
              requestExample: `curl -X POST '${baseUrl}/api/admin/uploads/hls/init' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "url": "https://example.com/master.m3u8", "variant_id": "v0", "file_name": "movie.m3u8", "directory_path": "/videos" }'`,
              responseExample: `{
  "ok": true,
  "hls": {
    "asset": {
      "id": "hls-id",
      "file_name": "movie.m3u8",
      "status": "pending",
      "segment_count": 120,
      "preview_playlist_url": "${baseUrl}/api/admin/uploads/hls/hls-id/preview.m3u8"
    },
    "segments": [
      { "segment_index": 0, "status": "pending", "storage_backend": null }
    ]
  }
}`
            },
            {
              id: "admin-hls-status",
              method: "GET",
              path: "/api/admin/uploads/hls/:assetId/status",
              title: "查询 HLS 导入状态",
              auth: "Admin Cookie",
              summary: "返回 HLS asset 和所有 segment 的当前状态。",
              functionality: "读取 HLS 临时记录，用于前端展示导入进度和缺失分片。",
              useCases: ["页面刷新后恢复 HLS 导入。", "轮询导入进度。"],
              limits: ["assetId 必须存在。"],
              specialHandling: ["segment 内可能包含 uploaded_chunks 和 missing_chunks。", "done segment 可用于预览。"],
              requestParams: [
                adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "初始化返回的 asset.id。")
              ],
              responseParams: hlsUploadFields,
              requestExample: `curl '${baseUrl}/api/admin/uploads/hls/<ASSET_ID>/status' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "hls": {
    "asset": { "id": "hls-id", "status": "importing", "segment_count": 120 },
    "segments": [
      { "segment_index": 0, "status": "done", "uploaded_chunks": [], "missing_chunks": [] }
    ]
  }
}`
            },
            {
              id: "admin-hls-preview-playlist",
              method: "GET",
              path: "/api/admin/uploads/hls/:assetId/preview.m3u8",
              title: "读取 HLS 预览 Playlist",
              auth: "Admin Cookie",
              summary: "返回已导入前几个 segment 组成的临时 m3u8。",
              functionality: "选取连续已完成 segment，重写 segment URL 指向管理员预览接口。",
              useCases: ["导入过程中预览视频。", "确认导入源是否可播放。"],
              limits: ["至少完成 1 个 segment。", "最多使用前 4 个已完成 segment。"],
              specialHandling: ["响应 Cache-Control 为 no-store。", "没有可预览 segment 时返回 HlsPreviewNotReady。"],
              requestParams: [
                adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "HLS 导入任务 id。")
              ],
              responseParams: [
                p("Content-Type", "Response", "是", "string", "application/vnd.apple.mpegurl", "HLS playlist。"),
                p("body", "Response", "是", "string", "m3u8 文本", "重写后的 media playlist。")
              ],
              requestExample: `curl '${baseUrl}/api/admin/uploads/hls/<ASSET_ID>/preview.m3u8' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `HTTP/1.1 200 OK
Content-Type: application/vnd.apple.mpegurl; charset=utf-8

#EXTM3U
#EXTINF:6.000,
${baseUrl}/api/admin/uploads/hls/<ASSET_ID>/preview-segments/0`
            },
            {
              id: "admin-hls-preview-segment",
              method: "GET",
              path: "/api/admin/uploads/hls/:assetId/preview-segments/:index",
              title: "读取 HLS 预览 Segment",
              auth: "Admin Cookie",
              summary: "返回已导入的 HLS segment 文件流。",
              functionality: "从 Telegram 读取指定 segment，支持 Range，用于 HLS 播放器预览。",
              useCases: ["video/hls.js 播放预览 playlist。"],
              limits: ["segment 必须已导入完成。", "index 必须在 segment_count 范围内。"],
              specialHandling: ["不强制下载，Content-Disposition 为 inline。", "分片存储的 segment 会继续转到 chunk 读取逻辑。"],
              requestParams: [
                adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "导入任务 id。"),
                p("index", "Path", "是", "number", "0 <= index < segment_count", "segment 序号。"),
                p("Range", "Header", "否", "string", "bytes=start-end", "媒体拖动时使用。")
              ],
              responseParams: [
                p("Content-Type", "Response", "是", "string", "video/mp2t 或源 MIME", "segment 媒体流。"),
                p("Content-Length", "Response", "条件", "number", "字节", "响应大小。"),
                p("Content-Range", "Response", "条件", "string", "Range 时返回", "范围信息。")
              ],
              requestExample: `curl '${baseUrl}/api/admin/uploads/hls/<ASSET_ID>/preview-segments/0' \\
  -H 'Cookie: admin_session=...' \\
  -o seg-0.ts`,
              responseExample: `HTTP/1.1 200 OK
Content-Type: video/mp2t
Content-Length: 5242880`
            },
            {
              id: "admin-hls-segment-import",
              method: "POST",
              path: "/api/admin/uploads/hls/:assetId/segments/:index/import",
              title: "导入 HLS Segment",
              auth: "Admin Cookie",
              summary: "导入一个 HLS segment；小 segment 直接存 Telegram，大 segment 会创建内部分片。",
              functionality: "下载源 segment，必要时解密 AES-128，再上传到 Telegram。",
              useCases: ["按 segment 顺序导入 HLS 视频。", "失败 segment 重试。"],
              limits: ["asset 必须处于可变状态。", "加密 segment 解密后最大支持单分片大小。"],
              specialHandling: ["超过单分片大小的普通 segment 会进入 telegram_multipart。", "返回 missing_chunks 时需继续调用 chunks/import。"],
              requestParams: [
                adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "导入任务 id。"),
                p("index", "Path", "是", "number", "segment 序号", "要导入的 segment。")
              ],
              responseParams: [
                okResponse,
                p("segment", "Response", "是", "HlsSegment", "segment 对象", "最新 segment 状态。"),
                p("uploaded_chunks", "Response", "是", "number[]", "已上传 chunk", "大 segment 的已上传分片。"),
                p("missing_chunks", "Response", "是", "number[]", "缺失 chunk", "大 segment 还需导入的分片。")
              ],
              requestExample: `curl -X POST '${baseUrl}/api/admin/uploads/hls/<ASSET_ID>/segments/0/import' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "segment": { "segment_index": 0, "status": "done", "storage_backend": "telegram_single" },
  "uploaded_chunks": [],
  "missing_chunks": []
}`
            },
            {
              id: "admin-hls-segment-chunk-import",
              method: "POST",
              path: "/api/admin/uploads/hls/:assetId/segments/:index/chunks/:chunkIndex/import",
              title: "导入 HLS Segment 分片",
              auth: "Admin Cookie",
              summary: "导入大 HLS segment 的指定内部 chunk。",
              functionality: "对已经创建 multipart_upload_id 的 segment，按 chunkIndex 拉取源 Range 并上传 Telegram。",
              useCases: ["大 segment 分片导入。", "重试缺失 HLS segment chunk。"],
              limits: ["segment 必须是 multipart 导入状态。", "chunkIndex 必须在 segment.chunk_count 范围内。"],
              specialHandling: ["返回 missing_chunks 为空后再调用 segment complete。"],
              requestParams: [
                adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "导入任务 id。"),
                p("index", "Path", "是", "number", "segment 序号", "segment index。"),
                p("chunkIndex", "Path", "是", "number", "chunk 序号", "segment 内部分片序号。")
              ],
              responseParams: [
                okResponse,
                p("segment", "Response", "是", "HlsSegment", "segment 对象", "最新 segment 状态。"),
                p("uploaded_chunks", "Response", "是", "number[]", "已上传 chunk", "已完成分片。"),
                p("missing_chunks", "Response", "是", "number[]", "缺失 chunk", "未完成分片。")
              ],
              requestExample: `curl -X POST '${baseUrl}/api/admin/uploads/hls/<ASSET_ID>/segments/1/chunks/0/import' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "segment": { "segment_index": 1, "status": "importing", "storage_backend": "telegram_multipart", "chunk_count": 3 },
  "uploaded_chunks": [0],
  "missing_chunks": [1, 2]
}`
            },
            {
              id: "admin-hls-segment-complete",
              method: "POST",
              path: "/api/admin/uploads/hls/:assetId/segments/:index/complete",
              title: "完成 HLS Segment 分片导入",
              auth: "Admin Cookie",
              summary: "把大 segment 的内部 multipart 状态标记为完成。",
              functionality: "校验 segment 的所有内部 chunk 已存在，然后把 segment 状态更新为 done。",
              useCases: ["大 segment 所有 chunks/import 完成后提交。"],
              limits: ["缺少任意内部 chunk 会返回 UploadIncomplete。"],
              specialHandling: ["仅用于大 segment；普通 telegram_single segment 不需要调用。"],
              requestParams: [
                adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "导入任务 id。"),
                p("index", "Path", "是", "number", "segment 序号", "segment index。")
              ],
              responseParams: [
                okResponse,
                p("segment", "Response", "是", "HlsSegment", "segment 对象", "完成后的 segment。"),
                p("uploaded_chunks", "Response", "是", "number[]", "全部 chunk", "已完成分片。"),
                p("missing_chunks", "Response", "是", "number[]", "空数组", "应为空。")
              ],
              requestExample: `curl -X POST '${baseUrl}/api/admin/uploads/hls/<ASSET_ID>/segments/1/complete' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "segment": { "segment_index": 1, "status": "done", "storage_backend": "telegram_multipart", "chunk_count": 3 },
  "uploaded_chunks": [0, 1, 2],
  "missing_chunks": []
}`
            },
            {
              id: "admin-hls-complete",
              method: "POST",
              path: "/api/admin/uploads/hls/:assetId/complete",
              title: "完成 HLS 导入",
              auth: "Admin Cookie",
              summary: "把所有已导入 segment 组装为最终 HLS package 文件记录。",
              functionality: "校验全部 segment 完成，写入 files 表，生成 /api/hls 签名访问路径。",
              useCases: ["HLS 导入全部完成后出现在文件列表。", "可选上传视频封面缩略图。"],
              limits: ["全部 segment 必须 done。", "缩略图最大 512KB，类型限 JPEG/PNG/WebP。"],
              specialHandling: ["最终文件 storage_backend=hls_package。", "整包 download=1 支持 TS 或 fMP4 顺序合并，且 part 数不能超过直链预算。"],
              requestParams: [
                adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "导入任务 id。"),
                p("on_conflict", "Query/Body/FormData", "否", "string", "error / overwrite", "同名处理。"),
                p("thumbnail", "FormData", "否", "File", "<=512KB", "缩略图文件。"),
                p("thumbnail_width", "FormData", "否", "number", "1-8192", "缩略图宽度。"),
                p("thumbnail_height", "FormData", "否", "number", "1-8192", "缩略图高度。")
              ],
              responseParams: fileResponseFields,
              requestExample: `curl -X POST '${baseUrl}/api/admin/uploads/hls/<ASSET_ID>/complete' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "file": {
    "id": "hls-id",
    "file_name": "movie.m3u8",
    "storage_backend": "hls_package",
    "file_path": "/api/hls/<token>/movie.m3u8",
    "download_strategy": "direct_or_accelerated"
  }
}`
            },
            {
              id: "admin-hls-cancel",
              method: "DELETE",
              path: "/api/admin/uploads/hls/:assetId",
              title: "取消并清理 HLS 导入",
              auth: "Admin Cookie",
              summary: "删除 HLS 临时任务数据。",
              functionality: "清理 HLS asset、segment 和相关临时分片记录。",
              useCases: ["用户取消导入。", "清理失败任务。"],
              limits: ["assetId 必须存在或可清理。"],
              specialHandling: ["返回 cleanup 摘要。", "已上传到 Telegram 的原始文件不会被删除。"],
              requestParams: [
                adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "导入任务 id。")
              ],
              responseParams: [
                okResponse,
                p("cleanup", "Response", "是", "object", "清理摘要", "被清理的临时记录数量。")
              ],
              requestExample: `curl -X DELETE '${baseUrl}/api/admin/uploads/hls/<ASSET_ID>' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "cleanup": { "assets": 1, "segments": 120, "chunks": 0 }
}`
            }
          ]
        },
        {
          id: "admin-settings",
          title: "API Key 与 Telegram 通道",
          description: "外部访问密钥和 Telegram 存储通道的管理接口。",
          endpoints: [
            {
              id: "admin-api-keys-list",
              method: "GET",
              path: "/api/admin/api-keys",
              title: "列出 API Keys",
              auth: "Admin Cookie",
              summary: "返回所有未删除 API Key，列表只包含 masked_key。",
              functionality: "读取 api_keys 表并隐藏明文 key。",
              useCases: ["设置页展示外部客户端密钥。"],
              limits: ["只返回未软删除记录。"],
              specialHandling: ["列表永不返回 key 明文。", "需要明文时调用 GET /api/admin/api-keys/:id。"],
              requestParams: [adminCookie],
              responseParams: [
                okResponse,
                p("api_keys", "Response", "是", "array<ApiKeyItem>", "列表", "API Key 列表。"),
                p("api_keys[].masked_key", "Response", "是", "string", "脱敏", "可展示的密钥摘要。"),
                p("api_keys[].status", "Response", "是", "string", "active / disabled", "是否可用于外部接口。")
              ],
              requestExample: `curl '${baseUrl}/api/admin/api-keys' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "api_keys": [
    { "id": "key-id", "name": "backup-client", "masked_key": "tgf_1234••••abcd", "status": "active", "last_used_at": null }
  ]
}`
            },
            {
              id: "admin-api-keys-create",
              method: "POST",
              path: "/api/admin/api-keys",
              title: "创建 API Key",
              auth: "Admin Cookie",
              summary: "创建外部客户端 API Key，并在本次响应返回明文。",
              functionality: "生成 tgf_ 前缀随机密钥，明文存储到 D1。",
              useCases: ["为备份脚本、CLI 或第三方服务创建独立密钥。"],
              limits: ["name 必须 1-80 字符。"],
              specialHandling: ["只有创建响应和显式 reveal 会返回 key 明文。", "数据库泄露时 API Key 会直接暴露，这是当前项目的已知权衡。"],
              requestParams: [
                adminCookie,
                p("name", "Body", "是", "string", "1-80 字符", "密钥名称。")
              ],
              responseParams: [
                okResponse,
                p("api_key", "Response", "是", "ApiKeyItem", "含 key 明文", "创建后的密钥。"),
                p("api_key.key", "Response", "是", "string", "tgf_ 前缀", "明文 API Key，仅此时需要立即复制保存。")
              ],
              requestExample: `curl -X POST '${baseUrl}/api/admin/api-keys' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "name": "backup-client" }'`,
              responseExample: `{
  "ok": true,
  "api_key": {
    "id": "key-id",
    "name": "backup-client",
    "key": "tgf_plaintext_key",
    "masked_key": "tgf_plai••••_key",
    "status": "active"
  }
}`
            },
            {
              id: "admin-api-keys-reveal",
              method: "GET",
              path: "/api/admin/api-keys/:id",
              title: "显式查看明文 API Key",
              auth: "Admin Cookie",
              summary: "返回指定 API Key 的明文。",
              functionality: "按 id 读取未删除密钥，并包含 key 字段。",
              useCases: ["用户重新复制已有密钥。"],
              limits: ["id 必须存在且未删除。"],
              specialHandling: ["前端 reveal 操作应有明确用户动作。", "响应包含敏感明文，不应写入日志。"],
              requestParams: [
                adminCookie,
                p("id", "Path", "是", "string", "API Key id", "密钥记录 id。")
              ],
              responseParams: [
                okResponse,
                p("api_key", "Response", "是", "ApiKeyItem", "含 key 明文", "密钥详情。"),
                p("api_key.key", "Response", "是", "string", "明文", "可用于 Authorization Bearer。")
              ],
              requestExample: `curl '${baseUrl}/api/admin/api-keys/<KEY_ID>' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "api_key": { "id": "key-id", "name": "backup-client", "key": "tgf_plaintext_key", "status": "active" }
}`
            },
            {
              id: "admin-api-keys-update",
              method: "PATCH",
              path: "/api/admin/api-keys/:id",
              title: "重命名或启停 API Key",
              auth: "Admin Cookie",
              summary: "更新 API Key 名称或状态。",
              functionality: "PATCH name/status 字段并更新时间。",
              useCases: ["禁用泄露或停用客户端密钥。", "重命名密钥用途。"],
              limits: ["name 可选但必须 1-80 字符。", "status 只能是 active 或 disabled。"],
              specialHandling: ["禁用后外部接口会返回 Unauthorized。", "响应不包含 key 明文。"],
              requestParams: [
                adminCookie,
                p("id", "Path", "是", "string", "API Key id", "密钥记录 id。"),
                p("name", "Body", "否", "string", "1-80 字符", "新名称。"),
                p("status", "Body", "否", "string", "active / disabled", "新状态。")
              ],
              responseParams: [
                okResponse,
                p("api_key", "Response", "否", "ApiKeyItem", "不含 key", "更新后的密钥。")
              ],
              requestExample: `curl -X PATCH '${baseUrl}/api/admin/api-keys/<KEY_ID>' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "name": "backup-client", "status": "disabled" }'`,
              responseExample: `{
  "ok": true,
  "api_key": { "id": "key-id", "name": "backup-client", "masked_key": "tgf_1234••••abcd", "status": "disabled" }
}`
            },
            {
              id: "admin-api-keys-delete",
              method: "DELETE",
              path: "/api/admin/api-keys/:id",
              title: "删除 API Key",
              auth: "Admin Cookie",
              summary: "软删除外部客户端密钥。",
              functionality: "设置 deleted_at，之后 Bearer 鉴权不会再匹配该 key。",
              useCases: ["撤销不再使用的脚本密钥。"],
              limits: ["id 必须存在且未删除。"],
              specialHandling: ["删除不可恢复。", "不会删除由该 key 已上传的文件。"],
              requestParams: [
                adminCookie,
                p("id", "Path", "是", "string", "API Key id", "密钥记录 id。")
              ],
              responseParams: [okResponse],
              requestExample: `curl -X DELETE '${baseUrl}/api/admin/api-keys/<KEY_ID>' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{ "ok": true }`
            },
            {
              id: "admin-telegram-channels-list",
              method: "GET",
              path: "/api/admin/telegram-channels",
              title: "列出 Telegram 通道",
              auth: "Admin Cookie",
              summary: "返回可用于存储文件的 Telegram 通道配置。",
              functionality: "读取通道记录并返回脱敏 bot token、chat_id、状态和默认通道标记。",
              useCases: ["设置页管理多个 Telegram 存储通道。", "检查默认通道是否配置。"],
              limits: ["只返回配置摘要，不返回 bot token 明文。"],
              specialHandling: ["default 通道可能来自环境变量回退。", "configured=false 表示还不能用于上传。"],
              requestParams: [adminCookie],
              responseParams: [
                okResponse,
                p("channels", "Response", "是", "array<TelegramChannelItem>", "通道列表", "每个通道含 id、name、chat_id、masked_bot_token、status、is_default、configured。")
              ],
              requestExample: `curl '${baseUrl}/api/admin/telegram-channels' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "channels": [
    { "id": "default", "name": "default", "masked_bot_token": "123456:••••test", "chat_id": "-100123", "status": "active", "is_default": true, "configured": true }
  ]
}`
            },
            {
              id: "admin-telegram-channels-create",
              method: "POST",
              path: "/api/admin/telegram-channels",
              title: "创建 Telegram 通道",
              auth: "Admin Cookie",
              summary: "新增一个 Telegram bot token + chat_id 存储通道。",
              functionality: "校验名称、bot token 格式、chat_id 和唯一性，bot token 加密后保存。",
              useCases: ["扩展上传通道以分散 Telegram 限流。"],
              limits: ["name 必须 1-80 字符。", "bot_token 必须匹配 Telegram bot token 格式。", "chat_id 最长 128 字符。"],
              specialHandling: ["名称唯一；bot token + chat_id 组合唯一。", "status 默认为 active。"],
              requestParams: [
                adminCookie,
                p("name", "Body", "是", "string", "1-80 字符", "通道名称。"),
                p("bot_token", "Body", "是", "string", "Telegram bot token", "用于上传文件的 Bot Token。"),
                p("chat_id", "Body", "是", "string", "最长 128 字符", "Telegram 私有频道或群 chat id。"),
                p("status", "Body", "否", "string", "active / disabled", "通道状态。")
              ],
              responseParams: [
                okResponse,
                p("channel", "Response", "是", "TelegramChannelItem | null", "脱敏", "创建后的通道摘要。")
              ],
              requestExample: `curl -X POST '${baseUrl}/api/admin/telegram-channels' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "name": "backup-1", "bot_token": "123456:telegram-token", "chat_id": "-1001234567890", "status": "active" }'`,
              responseExample: `{
  "ok": true,
  "channel": { "id": "channel-id", "name": "backup-1", "masked_bot_token": "123456:••••oken", "chat_id": "-1001234567890", "status": "active", "configured": true }
}`
            },
            {
              id: "admin-telegram-channels-update",
              method: "PATCH",
              path: "/api/admin/telegram-channels/:id",
              title: "更新 Telegram 通道",
              auth: "Admin Cookie",
              summary: "修改通道名称、bot token、chat_id 或状态。",
              functionality: "合并现有配置并重新校验唯一性，必要时重新加密 bot token。",
              useCases: ["替换 Bot Token。", "禁用某个上传通道。", "调整 chat_id。"],
              limits: ["default 通道名称固定为 default。", "status 只能 active 或 disabled。"],
              specialHandling: ["如果通道缺少 bot token，保存前必须补齐。", "响应只返回 masked_bot_token。"],
              requestParams: [
                adminCookie,
                p("id", "Path", "是", "string", "通道 id", "Telegram 通道记录 id。"),
                p("name", "Body", "否", "string", "1-80 字符", "新名称；default 通道忽略。"),
                p("bot_token", "Body", "否", "string", "Telegram bot token", "新 Bot Token。"),
                p("chat_id", "Body", "否", "string", "最长 128 字符", "新 chat id。"),
                p("status", "Body", "否", "string", "active / disabled", "新状态。")
              ],
              responseParams: [
                okResponse,
                p("channel", "Response", "是", "TelegramChannelItem", "脱敏", "更新后的通道。")
              ],
              requestExample: `curl -X PATCH '${baseUrl}/api/admin/telegram-channels/<CHANNEL_ID>' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "status": "disabled" }'`,
              responseExample: `{
  "ok": true,
  "channel": { "id": "channel-id", "name": "backup-1", "status": "disabled", "configured": true }
}`
            },
            {
              id: "admin-telegram-channels-delete",
              method: "DELETE",
              path: "/api/admin/telegram-channels/:id",
              title: "删除 Telegram 通道",
              auth: "Admin Cookie",
              summary: "删除未被引用的非默认 Telegram 通道。",
              functionality: "检查 files/chunks 引用后删除通道配置。",
              useCases: ["移除不再使用的上传通道。"],
              limits: ["default 通道不能删除。", "仍被文件或分片引用的通道不能删除。"],
              specialHandling: ["引用冲突返回 TelegramChannelInUse，并带 files/chunks 计数。"],
              requestParams: [
                adminCookie,
                p("id", "Path", "是", "string", "通道 id", "Telegram 通道记录 id。")
              ],
              responseParams: [okResponse],
              requestExample: `curl -X DELETE '${baseUrl}/api/admin/telegram-channels/<CHANNEL_ID>' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{ "ok": true }`
            }
          ]
        }
      ]
    },
    public: {
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
              limits: [`multipart 文件只有不超过 ${session.direct_access_max_chunks} 片或 ${directMax} 时才提供整文件直链。`, "token 由文件记录生成，不支持客户端自行构造。"],
              specialHandling: ["download=1 或 download=true 会设置 attachment。", "GET 和 HEAD 都会进入该读取路由。", "HLS 文件必须走 /api/hls。"],
              requestParams: [
                signedToken,
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
              requestExample: `curl '${baseUrl}/f/<TOKEN>/hello.txt?download=1' \\
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
                signedToken,
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
              requestExample: `curl '${baseUrl}/f/<TOKEN>/chunks/0' \\
  -o part-0.bin`,
              responseExample: `HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Length: ${session.multipart_chunk_bytes}
X-Chunk-Index: 0
X-Chunk-Count: 512
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
              limits: ["asset 必须 status=done。", "整包下载支持 TS 或 fMP4 顺序合并，且 part 数不超过直链预算。"],
              specialHandling: ["download=1 且 part 太多会返回 DirectAccessDisabled，前端应使用 hls-download plan。", "旧 /hls/:token 路径仍可解析，但响应路径统一推荐 /api/hls。"],
              requestParams: [
                signedToken,
                p("filename", "Path", "否", "string", "展示用", "可选文件名。"),
                p("download", "Query", "否", "string", "1 / true", "强制整包下载。")
              ],
              responseParams: [
                p("Content-Type", "Response", "是", "string", "application/vnd.apple.mpegurl 或 video/mp2t", "playlist 或整包 TS。"),
                p("Content-Disposition", "Response", "是", "string", "inline / attachment", "预览或下载。"),
                p("body", "Response", "条件", "string | stream", "playlist 或文件流", "HLS m3u8 文本或合并后的 TS 流。")
              ],
              requestExample: `curl '${baseUrl}/api/hls/<TOKEN>/movie.m3u8'`,
              responseExample: `HTTP/1.1 200 OK
Content-Type: application/vnd.apple.mpegurl; charset=utf-8

#EXTM3U
#EXTINF:6.000,
${baseUrl}/api/hls/<TOKEN>/segments/0/seg-0.ts`
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
                signedToken,
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
              requestExample: `curl '${baseUrl}/api/hls/<TOKEN>/segments/0/seg-0.ts' \\
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
                signedToken,
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
              requestExample: `curl '${baseUrl}/api/hls/<TOKEN>/segments/1/chunks/0' \\
  -o hls-part-0.bin`,
              responseExample: `HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Length: ${session.multipart_chunk_bytes}
X-Chunk-Index: 0
X-Chunk-Count: 3`
            }
          ]
        }
      ]
    }
  };
}

function p(
  name: string,
  location: ParameterDoc["location"],
  required: RequiredMark,
  type: string,
  limit: string,
  description: string
): ParameterDoc {
  return { name, location, required, type, limit, description };
}

function buildMarkdown(group: DocGroup): string {
  const lines = [`# ${group.title}`, "", group.description, ""];

  for (const section of group.sections) {
    lines.push(`## ${section.title}`, "", section.description, "");
    for (const endpoint of section.endpoints) {
      lines.push(
        `### ${endpoint.method} ${endpoint.path}`,
        "",
        endpoint.summary,
        "",
        `- 鉴权：${endpoint.auth}`,
        `- 接口功能：${endpoint.functionality}`,
        `- 使用场景：${endpoint.useCases.join("；")}`,
        `- 限制条件：${endpoint.limits.join("；")}`,
        `- 特殊处理：${endpoint.specialHandling.join("；")}`,
        "",
        "#### 请求参数",
        "",
        markdownTable(endpoint.requestParams),
        "",
        "#### 响应参数",
        "",
        markdownTable(endpoint.responseParams),
        "",
        "#### 请求示例",
        "",
        "```",
        endpoint.requestExample.trim(),
        "```",
        "",
        "#### 响应示例",
        "",
        "```",
        endpoint.responseExample.trim(),
        "```",
        ""
      );
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

function markdownTable(fields: ParameterDoc[]): string {
  if (fields.length === 0) {
    return "| 名称 | 位置 | 必填 | 类型 | 限制 | 说明 |\n|---|---|---|---|---|---|\n| 无 | - | - | - | - | 无参数 |";
  }

  return [
    "| 名称 | 位置 | 必填 | 类型 | 限制 | 说明 |",
    "|---|---|---|---|---|---|",
    ...fields.map((field) =>
      `| ${escapeTable(field.name)} | ${field.location} | ${field.required} | ${escapeTable(field.type)} | ${escapeTable(field.limit)} | ${escapeTable(field.description)} |`
    )
  ].join("\n");
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
