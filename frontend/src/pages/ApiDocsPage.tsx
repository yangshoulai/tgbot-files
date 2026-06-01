import { useMemo, useState } from "react";
import { BookOpenText, Download, FileDown, KeyRound, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { SessionResponse } from "../api";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Segmented } from "../components/ui/Segmented";
import { formatBytes } from "../utils";
import { cn } from "../lib/cn";

type DocAudience = "api-key" | "admin";
type Method = "GET" | "POST" | "PATCH" | "DELETE";

interface ApiDocsPageProps {
  session: SessionResponse;
}

interface EndpointDoc {
  method: Method;
  path: string;
  title: string;
  description: string;
  auth: string;
  request?: string;
  response?: string;
  notes?: string[];
}

interface DocSection {
  title: string;
  description: string;
  endpoints: EndpointDoc[];
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
      buildMarkdown(docs["api-key"].title, docs["api-key"].description, docs["api-key"].sections),
      buildMarkdown(docs.admin.title, docs.admin.description, docs.admin.sections)
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
                可导出的接口手册
              </div>
              <h1 className="mt-4 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">API 文档</h1>
              <p className="mt-2 text-sm leading-6 text-muted">
                面向脚本、自动化客户端和控制台的接口说明。当前服务地址为{" "}
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
            { value: "admin", label: "管理员接口", icon: <ShieldCheck size={15} /> }
          ]}
        />
        <p className="text-xs leading-5 text-muted">
          {audience === "api-key"
            ? "适合外部脚本和自动化客户端，使用 Bearer Token 鉴权。"
            : "适合控制台页面和受信任浏览器，使用 HttpOnly Cookie 鉴权。"}
        </p>
      </div>

      <article className="api-docs-content grid gap-5">
        <header className="rounded-2xl border border-border bg-surface p-5 shadow-card">
          <h2 className="text-xl font-semibold text-foreground">{current.title}</h2>
          <p className="mt-2 text-sm leading-6 text-muted">{current.description}</p>
        </header>

        {current.sections.map((section) => (
          <section key={section.title} className="grid gap-3">
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-semibold text-foreground">{section.title}</h3>
              <p className="text-sm leading-6 text-muted">{section.description}</p>
            </div>
            <div className="grid gap-3">
              {section.endpoints.map((endpoint) => (
                <EndpointCard key={`${endpoint.method}:${endpoint.path}`} endpoint={endpoint} />
              ))}
            </div>
          </section>
        ))}
      </article>
    </div>
  );
}

function EndpointCard({ endpoint }: { endpoint: EndpointDoc }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <div className="grid gap-3 border-b border-border bg-background/60 px-4 py-3 lg:grid-cols-[1fr_auto] lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <MethodBadge method={endpoint.method} />
            <code className="overflow-anywhere rounded-lg bg-foreground px-2.5 py-1 font-mono text-xs text-white">
              {endpoint.path}
            </code>
          </div>
          <h4 className="mt-3 text-sm font-semibold text-foreground">{endpoint.title}</h4>
          <p className="mt-1 text-sm leading-6 text-muted">{endpoint.description}</p>
        </div>
        <Badge tone="neutral" className="justify-self-start lg:justify-self-end">
          {endpoint.auth}
        </Badge>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-2">
        {endpoint.request ? (
          <CodePanel title="请求示例" code={endpoint.request} />
        ) : (
          <InfoPanel title="请求体" body="无请求体，参数通过路径、查询字符串或 Cookie/Header 传递。" />
        )}
        {endpoint.response ? (
          <CodePanel title="响应示例" code={endpoint.response} />
        ) : (
          <InfoPanel title="响应" body="返回标准 JSON 或文件流，失败时返回 { ok: false, error, message }。" />
        )}
      </div>

      {endpoint.notes?.length ? (
        <div className="border-t border-border bg-primary-soft/30 px-4 py-3">
          <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-muted">
            {endpoint.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function MethodBadge({ method }: { method: Method }) {
  const className = {
    GET: "border-success/30 bg-success-soft text-success",
    POST: "border-info/30 bg-info-soft text-info",
    PATCH: "border-warning/40 bg-warning-soft text-warning",
    DELETE: "border-danger/30 bg-danger-soft text-danger"
  }[method];

  return (
    <span className={cn("inline-flex h-7 items-center rounded-full border px-2.5 font-mono text-xs font-semibold", className)}>
      {method}
    </span>
  );
}

function CodePanel({ title, code }: { title: string; code: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-background">
      <p className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted">{title}</p>
      <pre className="max-h-80 overflow-auto p-3 font-mono text-xs leading-6 text-foreground scroll-thin">
        <code>{code.trim()}</code>
      </pre>
    </div>
  );
}

function InfoPanel({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-background px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{title}</p>
      <p className="mt-2 text-sm leading-6 text-muted">{body}</p>
    </div>
  );
}

function buildDocs(session: SessionResponse): Record<DocAudience, { title: string; description: string; sections: DocSection[] }> {
  const baseUrl = session.base_url;
  const maxFile = formatBytes(session.max_file_bytes);
  const maxMultipart = formatBytes(session.max_multipart_file_bytes);
  const chunkSize = formatBytes(session.multipart_chunk_bytes);

  return {
    "api-key": {
      title: "API Key 接口",
      description: `API Key 接口面向外部脚本和自动化客户端，所有请求都使用 Authorization: Bearer <API_KEY>。普通小文件上传上限为 ${maxFile}，分片上传上限为 ${maxMultipart}。`,
      sections: [
        {
          title: "基础与文件信息",
          description: "用于小文件快速上传、查询文件元数据，并获取分片下载所需的 chunk_size / chunk_count。",
          endpoints: [
            {
              method: "POST",
              path: "/api/v1/files",
              title: "上传小文件",
              description: "旧版兼容接口，只用于普通小文件上传或小文件 URL 拉取。",
              auth: "Bearer API Key",
              request: `curl -X POST '${baseUrl}/api/v1/files' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -F 'file=@./hello.txt' \\
  -F 'directory_path=/' \\
  -F 'remark=示例文件'`,
              response: `{
  "ok": true,
  "id": "file-id",
  "url": "${baseUrl}/f/<token>/hello.txt",
  "name": "hello.txt",
  "size": 12,
  "mime_type": "text/plain"
}`,
              notes: [`文件大小必须小于等于 ${maxFile}；更大的文件请使用分片上传接口。`]
            },
            {
              method: "GET",
              path: "/api/v1/files/:fileId",
              title: "获取文件信息",
              description: "返回文件元数据、访问策略和分片信息。客户端分片下载前应先调用此接口。",
              auth: "Bearer API Key",
              request: `curl '${baseUrl}/api/v1/files/<FILE_ID>' \\
  -H 'Authorization: Bearer <API_KEY>'`,
              response: `{
  "ok": true,
  "file": {
    "id": "file-id",
    "file_name": "backup.zip",
    "size": 5368709120,
    "storage_backend": "telegram_multipart",
    "chunk_size": 18874368,
    "chunk_count": 285,
    "direct_access": false,
    "download_strategy": "accelerated",
    "url": null,
    "download_url": null
  }
}`
            }
          ]
        },
        {
          title: "客户端分片上传",
          description: `本地文件按 ${chunkSize} 分片上传。小于 ${maxFile} 的文件也可以使用该流程，此时通常只有 1 个分片。`,
          endpoints: [
            {
              method: "POST",
              path: "/api/v1/uploads/init",
              title: "初始化分片上传",
              description: "创建上传会话，返回分片大小、分片数量和直链可用性。",
              auth: "Bearer API Key",
              request: `{
  "file_name": "backup.zip",
  "mime_type": "application/zip",
  "size": 5368709120,
  "directory_path": "/backup",
  "remark": "每日备份"
}`,
              response: `{
  "ok": true,
  "upload": {
    "id": "upload-id",
    "file_name": "backup.zip",
    "chunk_size": 18874368,
    "chunk_count": 285,
    "direct_access": false,
    "max_multipart_file_bytes": 5368709120
  }
}`
            },
            {
              method: "POST",
              path: "/api/v1/uploads/:uploadId/chunks/:index",
              title: "上传指定分片",
              description: "每次上传一个分片，index 从 0 开始。",
              auth: "Bearer API Key",
              request: `curl -X POST '${baseUrl}/api/v1/uploads/<UPLOAD_ID>/chunks/0' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -F 'chunk=@./backup.zip.part0'`,
              response: `{
  "ok": true,
  "chunk": {
    "chunk_index": 0,
    "size": 18874368,
    "md5": "tg:<unique-id>",
    "telegram_file_id": "..."
  },
  "uploaded_chunks": 1
}`,
              notes: ["除最后一片外，每片大小必须等于初始化返回的 chunk_size。"]
            },
            {
              method: "POST",
              path: "/api/v1/uploads/:uploadId/complete",
              title: "完成分片上传",
              description: "校验所有分片都已上传后写入文件索引。",
              auth: "Bearer API Key",
              request: `curl -X POST '${baseUrl}/api/v1/uploads/<UPLOAD_ID>/complete' \\
  -H 'Authorization: Bearer <API_KEY>'`,
              response: `{
  "ok": true,
  "file": {
    "id": "upload-id",
    "storage_backend": "telegram_multipart",
    "chunk_count": 285,
    "direct_access": false,
    "url": null,
    "download_url": null
  }
}`
            }
          ]
        },
        {
          title: "URL 分片上传与分片下载",
          description: "让 Worker 从远程 URL 按 Range 拉取分片再转存到 Telegram；下载时按 fileId 和 index 拉取分片。",
          endpoints: [
            {
              method: "POST",
              path: "/api/v1/uploads/url/init",
              title: "初始化 URL 分片上传",
              description: "API Key URL 上传固定走分片流程，包括小文件。",
              auth: "Bearer API Key",
              request: `{
  "url": "https://example.com/video.mp4",
  "directory_path": "/videos",
  "remark": "远程导入"
}`,
              response: `{
  "ok": true,
  "mode": "multipart",
  "upload": {
    "id": "upload-id",
    "file_name": "video.mp4",
    "chunk_count": 42
  }
}`,
              notes: ["远端必须支持 Range 请求，并暴露 Content-Length 或 Content-Range。"]
            },
            {
              method: "POST",
              path: "/api/v1/uploads/:uploadId/url-chunks/:index",
              title: "导入 URL 指定分片",
              description: "Worker 拉取远端指定 Range 并上传到 Telegram。",
              auth: "Bearer API Key",
              response: `{
  "ok": true,
  "uploaded_chunks": 2
}`
            },
            {
              method: "GET",
              path: "/api/v1/files/:fileId/chunks/:index",
              title: "下载指定分片",
              description: "返回原始分片文件流，客户端按 index 合并。",
              auth: "Bearer API Key",
              request: `curl '${baseUrl}/api/v1/files/<FILE_ID>/chunks/0' \\
  -H 'Authorization: Bearer <API_KEY>' \\
  -o part-0.bin`,
              response: `HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Length: 18874368
X-Chunk-Index: 0
X-Chunk-Count: 285
X-Chunk-Offset: 0`,
              notes: ["普通单文件存储不支持该接口，会返回 NotMultipartFile。"]
            }
          ]
        }
      ]
    },
    admin: {
      title: "管理员接口",
      description: "管理员接口由控制台使用，依赖 HttpOnly Cookie 鉴权。前端 fetch 必须带 credentials: include。",
      sections: [
        {
          title: "认证与会话",
          description: "登录后 Worker 会设置管理后台 Cookie，后续 /api/admin/* 请求自动续期。",
          endpoints: [
            {
              method: "POST",
              path: "/api/admin/login",
              title: "管理员登录",
              description: "支持 JSON 或表单提交。",
              auth: "无需 Cookie",
              request: `{
  "username": "admin",
  "password": "secret",
  "remember_me": true
}`,
              response: `{
  "ok": true
}`
            },
            {
              method: "GET",
              path: "/api/admin/session",
              title: "获取当前会话和运行配置",
              description: "返回登录用户、上传上限、分片配置和关键环境变量配置状态。",
              auth: "Admin Cookie",
              response: `{
  "ok": true,
  "username": "admin",
  "max_file_bytes": ${session.max_file_bytes},
  "multipart_chunk_bytes": ${session.multipart_chunk_bytes},
  "max_multipart_file_bytes": ${session.max_multipart_file_bytes}
}`
            },
            {
              method: "POST",
              path: "/api/admin/logout",
              title: "退出登录",
              description: "清理管理后台 Cookie。",
              auth: "Admin Cookie",
              response: `{
  "ok": true
}`
            }
          ]
        },
        {
          title: "文件与目录管理",
          description: "控制台文件列表、目录树、元数据修改、移动与删除。",
          endpoints: [
            {
              method: "GET",
              path: "/api/admin/files?q=&dir=/&page=1&limit=20",
              title: "列出当前目录文件",
              description: "搜索只作用于当前目录，不递归。",
              auth: "Admin Cookie",
              response: `{
  "ok": true,
  "current_directory": { "path": "/" },
  "directories": [],
  "files": [],
  "pagination": { "page": 1, "limit": 20, "total": 0 }
}`
            },
            {
              method: "POST",
              path: "/api/admin/files",
              title: "管理员小文件上传",
              description: "普通上传入口，支持 multipart file 或 JSON URL，受单文件上限约束。",
              auth: "Admin Cookie",
              request: `FormData:
file=@./hello.txt
directory_path=/
remark=可选备注`,
              response: `{
  "ok": true,
  "file": {
    "id": "file-id",
    "url": "${baseUrl}/f/<token>/hello.txt"
  }
}`
            },
            {
              method: "PATCH",
              path: "/api/admin/files/:id",
              title: "修改文件名和备注",
              description: "文件名变更会重签文件链接；备注变更不会影响链接。",
              auth: "Admin Cookie",
              request: `{
  "file_name": "new-name.txt",
  "remark": "新的备注"
}`,
              response: `{
  "ok": true,
  "file": { "file_name": "new-name.txt" }
}`
            },
            {
              method: "POST",
              path: "/api/admin/directories",
              title: "新建目录",
              description: "虚拟目录，不影响 Telegram 原消息。",
              auth: "Admin Cookie",
              request: `{
  "name": "photos",
  "parent_path": "/"
}`
            },
            {
              method: "PATCH",
              path: "/api/admin/entries/move",
              title: "移动文件和目录",
              description: "支持文件与目录混合移动，也支持移动时新建目标目录。",
              auth: "Admin Cookie",
              request: `{
  "file_ids": ["file-id"],
  "directory_ids": ["directory-id"],
  "directory_path": "/archive"
}`
            },
            {
              method: "DELETE",
              path: "/api/admin/entries",
              title: "批量删除文件和目录",
              description: "删除索引和虚拟目录，不删除 Telegram 原始消息。",
              auth: "Admin Cookie",
              request: `{
  "file_ids": ["file-id"],
  "directory_ids": ["directory-id"]
}`
            }
          ]
        },
        {
          title: "管理员分片上传",
          description: "控制台使用的分片上传接口。UI 可选择“小文件也使用分片上传”。URL 分片可通过 force_multipart 强制启用。",
          endpoints: [
            {
              method: "POST",
              path: "/api/admin/uploads/init",
              title: "初始化本地分片上传",
              description: "支持任意大于 0 且不超过分片上限的文件，包括小文件。",
              auth: "Admin Cookie",
              request: `{
  "file_name": "small.txt",
  "mime_type": "text/plain",
  "size": 5,
  "directory_path": "/"
}`
            },
            {
              method: "POST",
              path: "/api/admin/uploads/url/init",
              title: "初始化 URL 分片上传",
              description: "默认小文件返回 single；传 force_multipart: true 时小文件也走分片。",
              auth: "Admin Cookie",
              request: `{
  "url": "https://example.com/small.txt",
  "force_multipart": true,
  "directory_path": "/"
}`
            },
            {
              method: "POST",
              path: "/api/admin/uploads/:uploadId/chunks/:index",
              title: "上传本地分片",
              description: "FormData 字段名为 chunk。",
              auth: "Admin Cookie"
            },
            {
              method: "POST",
              path: "/api/admin/uploads/:uploadId/url-chunks/:index",
              title: "导入 URL 分片",
              description: "按初始化保存的 source_url 拉取 Range。",
              auth: "Admin Cookie"
            },
            {
              method: "POST",
              path: "/api/admin/uploads/:uploadId/complete",
              title: "完成分片上传",
              description: "生成最终文件索引，并按分片数量判断是否返回直链。",
              auth: "Admin Cookie"
            }
          ]
        },
        {
          title: "API Key 管理",
          description: "用于创建、查看、禁用和删除外部客户端访问密钥。",
          endpoints: [
            {
              method: "GET",
              path: "/api/admin/api-keys",
              title: "列出 API Keys",
              description: "列表只返回 masked key。",
              auth: "Admin Cookie"
            },
            {
              method: "POST",
              path: "/api/admin/api-keys",
              title: "创建 API Key",
              description: "仅创建响应会返回明文 key。",
              auth: "Admin Cookie",
              request: `{
  "name": "backup-client"
}`
            },
            {
              method: "GET",
              path: "/api/admin/api-keys/:id",
              title: "显式查看明文 Key",
              description: "用于重新复制已有 API Key。",
              auth: "Admin Cookie"
            },
            {
              method: "PATCH",
              path: "/api/admin/api-keys/:id",
              title: "重命名或禁用 API Key",
              description: "status 可为 active 或 disabled。",
              auth: "Admin Cookie",
              request: `{
  "name": "backup-client",
  "status": "disabled"
}`
            }
          ]
        }
      ]
    }
  };
}

function buildMarkdown(title: string, description: string, sections: DocSection[]): string {
  const lines = [`# ${title}`, "", description, ""];

  for (const section of sections) {
    lines.push(`## ${section.title}`, "", section.description, "");
    for (const endpoint of section.endpoints) {
      lines.push(`### ${endpoint.method} ${endpoint.path}`, "", endpoint.description, "", `- 鉴权：${endpoint.auth}`, "");
      if (endpoint.request) {
        lines.push("#### 请求示例", "", "```", endpoint.request.trim(), "```", "");
      }
      if (endpoint.response) {
        lines.push("#### 响应示例", "", "```", endpoint.response.trim(), "```", "");
      }
      if (endpoint.notes?.length) {
        lines.push("#### 注意事项", "", ...endpoint.notes.map((note) => `- ${note}`), "");
      }
    }
  }

  return `${lines.join("\n").trim()}\n`;
}
