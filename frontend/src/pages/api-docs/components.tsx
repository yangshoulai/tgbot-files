import { ChevronRight } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { cn } from "../../lib/cn";
import type { DocGroup, EndpointDoc, Method, ParameterDoc } from "./types";

export function TreeNav({ group }: { group: DocGroup }) {
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

export function EndpointCard({ endpoint }: { endpoint: EndpointDoc }) {
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
