import { useMemo, useState } from "react";
import {
  BookOpenText,
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
import { formatBytes } from "../utils";
import { EndpointCard, TreeNav } from "./api-docs/components";
import { buildDocs } from "./api-docs/docs";
import { buildMarkdown } from "./api-docs/markdown";
import type { DocAudience } from "./api-docs/types";

interface ApiDocsPageProps {
  session: SessionResponse;
}

export function ApiDocsPage({ session }: ApiDocsPageProps) {
  const [audience, setAudience] = useState<DocAudience>("api-key");
  const docs = useMemo(() => buildDocs(session), [session]);
  const current = docs[audience];

  function exportMarkdown() {
    const markdown = [
      "# 飞梭云盘 API 文档",
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
    link.download = "feisuo-cloud-disk-api-docs.md";
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
                <Badge tone="info">整文件直链 {formatBytes(session.direct_access_max_bytes)}</Badge>
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
