import { type SourceRequestHeaders } from "../../../api";
import { parseCurlCommand } from "../../../lib/curl";
import type { SourceHeaderRow } from "./types";
import { makeSourceHeaderRow } from "./item-factories";

export function sourceHeaderRowsFromCurlHeaders(headers: Record<string, string>): {
  rows: SourceHeaderRow[];
  headerCount: number;
  skippedHeaders: string[];
} {
  const rows: SourceHeaderRow[] = [];
  const skippedHeaders: string[] = [];
  const skipped = new Set<string>();

  const addSkipped = (name: string) => {
    const label = name || "空名称";
    const lowerName = label.toLowerCase();
    if (!skipped.has(lowerName)) {
      skipped.add(lowerName);
      skippedHeaders.push(label);
    }
  };

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = normalizeHeaderKeyInput(rawName);
    const value = rawValue.trim();

    if (!value) {
      continue;
    }

    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[\r\n]/.test(value) || isBlockedSourceHeaderName(name)) {
      addSkipped(rawName.trim());
      continue;
    }

    rows.push(makeSourceHeaderRow(name, value));
  }

  return {
    rows,
    headerCount: rows.length,
    skippedHeaders
  };
}

export function curlImportSummary(headerCount: number, warnings: string[]): string {
  const base = headerCount > 0
    ? `已从 cURL 填入 URL 和 ${headerCount} 个请求头`
    : "已从 cURL 填入 URL";
  const visibleWarnings = warnings.slice(0, 2);
  const warningText = visibleWarnings.length > 0 ? `；${visibleWarnings.join("；")}` : "";
  const overflowText = warnings.length > visibleWarnings.length
    ? `；另有 ${warnings.length - visibleWarnings.length} 条提示`
    : "";

  return `${base}${warningText}${overflowText}`;
}

export function parseRemoteThumbnailInput(input: string): { url: string; headers?: SourceRequestHeaders; summary: string } {
  const text = input.trim();
  if (!text) {
    throw new Error("请输入缩略图 URL 或 cURL 命令");
  }

  if (/^(?:[$>]\s*)?curl(?:\.exe)?\b/i.test(text)) {
    const parsed = parseCurlCommand(text);
    const headerResult = sourceHeaderRowsFromCurlHeaders(parsed.headers);
    const headers = parseSourceHeaderRows(headerResult.rows);
    const warnings = [...parsed.warnings];
    if (headerResult.skippedHeaders.length > 0) {
      warnings.push(`已忽略 ${headerResult.skippedHeaders.length} 个不支持的请求头`);
    }

    return {
      url: parsed.url,
      ...(headers ? { headers } : {}),
      summary: curlImportSummary(headerResult.headerCount, warnings).replace("URL", "缩略图 URL")
    };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("缩略图 URL 必须是完整的 http/https 地址");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("缩略图 URL 必须使用 http 或 https");
  }

  return {
    url: url.toString(),
    summary: "URL 缩略图"
  };
}

export function parseSourceHeaderRows(rows: SourceHeaderRow[]): SourceRequestHeaders | undefined {
  const headers: SourceRequestHeaders = {};
  const seen = new Set<string>();

  for (const [index, row] of rows.entries()) {
    const name = normalizeHeaderKeyInput(row.name);
    const headerValue = row.value.trim();
    const hasName = name.length > 0;
    const hasValue = headerValue.length > 0;

    if (!hasName && !hasValue) {
      continue;
    }

    if (!hasName) {
      throw new Error(`第 ${index + 1} 个请求头缺少 key`);
    }

    if (!hasValue) {
      throw new Error(`请求头 ${name} 缺少 value`);
    }

    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      throw new Error(`请求头 key 无效：${row.name || `第 ${index + 1} 行`}`);
    }

    if (isBlockedSourceHeaderName(name)) {
      throw new Error(`不允许自定义请求头：${name}`);
    }

    if (/[\r\n]/.test(headerValue)) {
      throw new Error(`请求头 ${name} 的 value 不能包含换行`);
    }

    if (seen.has(name)) {
      throw new Error(`请求头 ${name} 重复`);
    }

    seen.add(name);
    headers[name] = headerValue;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function normalizeHeaderKeyInput(value: string): string {
  return value.trim().toLowerCase();
}

export function isBlockedSourceHeaderName(name: string): boolean {
  const lowerName = name.toLowerCase();
  return lowerName === "host" ||
    lowerName === "range" ||
    lowerName === "content-length" ||
    lowerName === "connection" ||
    lowerName === "keep-alive" ||
    lowerName === "proxy-authenticate" ||
    lowerName === "proxy-authorization" ||
    lowerName === "te" ||
    lowerName === "trailer" ||
    lowerName === "transfer-encoding" ||
    lowerName === "upgrade" ||
    lowerName === "accept-encoding" ||
    lowerName === "cf-connecting-ip" ||
    lowerName === "cf-ipcountry" ||
    lowerName === "cf-ray" ||
    lowerName === "cf-visitor" ||
    lowerName === "true-client-ip" ||
    lowerName === "x-forwarded-for" ||
    lowerName === "x-forwarded-host" ||
    lowerName === "x-forwarded-proto" ||
    lowerName === "x-real-ip";
}
