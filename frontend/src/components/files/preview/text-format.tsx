import type { ReactNode } from "react";
import type { FileItem } from "../../../api";

export type TextLanguage = "javascript" | "json" | "yaml" | "toml" | "html" | "css" | "xml" | "text";

export interface PreparedTextContent {
  content: string;
  formatted: boolean;
  language: TextLanguage;
}

export function detectTextLanguage(file: Pick<FileItem, "mime_type" | "file_name">): TextLanguage {
  const mime = file.mime_type.toLowerCase();
  const name = file.file_name.toLowerCase();
  const extension = name.split(".").pop() || "";

  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(extension) || mime.includes("javascript") || mime.includes("typescript")) {
    return "javascript";
  }

  if (extension === "json" || mime === "application/json") {
    return "json";
  }

  if (["yaml", "yml"].includes(extension) || mime.includes("yaml")) {
    return "yaml";
  }

  if (extension === "toml" || mime.includes("toml")) {
    return "toml";
  }

  if (["html", "htm"].includes(extension) || mime === "text/html") {
    return "html";
  }

  if (extension === "css" || mime === "text/css") {
    return "css";
  }

  if (extension === "xml" || mime.includes("xml")) {
    return "xml";
  }

  return "text";
}

export function prepareTextContent(content: string, language: TextLanguage): PreparedTextContent {
  if (!content) {
    return { content: "空文本文件", formatted: false, language };
  }

  if (language === "json") {
    try {
      return {
        content: JSON.stringify(JSON.parse(content), null, 2),
        formatted: true,
        language
      };
    } catch {
      return { content, formatted: false, language };
    }
  }

  if (language === "xml" || language === "html") {
    const formatted = formatMarkup(content);
    return { content: formatted, formatted: formatted !== content, language };
  }

  return { content, formatted: false, language };
}

function formatMarkup(value: string): string {
  const compact = value.trim();
  if (!compact) return value;

  try {
    const tokens = compact
      .replace(/>\s+</g, "><")
      .replace(/(>)(<)(\/?)/g, "$1\n$2$3")
      .split("\n")
      .filter(Boolean);
    let indent = 0;

    return tokens.map((token) => {
      const trimmed = token.trim();
      if (/^<\//.test(trimmed)) {
        indent = Math.max(indent - 1, 0);
      }

      const line = `${"  ".repeat(indent)}${trimmed}`;
      if (/^<[^!?/][^>]*[^/]?>$/.test(trimmed) && !/^<[^>]+>.*<\/[^>]+>$/.test(trimmed)) {
        indent += 1;
      }

      return line;
    }).join("\n");
  } catch {
    return value;
  }
}

export function languageLabel(language: TextLanguage): string {
  switch (language) {
    case "javascript":
      return "JavaScript / TypeScript";
    case "json":
      return "JSON";
    case "yaml":
      return "YAML";
    case "toml":
      return "TOML";
    case "html":
      return "HTML";
    case "css":
      return "CSS";
    case "xml":
      return "XML";
    default:
      return "Text";
  }
}

const tokenPattern =
  /(\/\/.*$|#.*$|<!--.*?-->|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|false|finally|for|from|function|if|implements|import|interface|let|new|null|private|protected|public|return|static|switch|this|throw|true|try|type|undefined|var|while|yield)\b|\b\d+(?:\.\d+)?\b|<\/?[A-Za-z][^>]*>|&[A-Za-z0-9#]+;|[{}[\]():,.;=<>+\-*\/])/g;

export function highlightLine(line: string, language: TextLanguage): ReactNode[] {
  if (!line) {
    return [""];
  }

  const keyMatch =
    language === "json" || language === "yaml" || language === "toml"
      ? /^(\s*)("?[\w.-]+"?)(\s*[:=])/.exec(line)
      : null;

  if (keyMatch) {
    const [, indent, key, separator] = keyMatch;
    const consumed = `${indent}${key}${separator}`;
    return [
      indent,
      <span key="key" className="text-[#1d4ed8]">{key}</span>,
      <span key="separator" className="text-[#94a3b8]">{separator}</span>,
      ...highlightTokens(line.slice(consumed.length), language, consumed.length)
    ];
  }

  return highlightTokens(line, language, 0);
}

function highlightTokens(value: string, language: TextLanguage, offset: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of value.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    const token = match[0];

    if (index > lastIndex) {
      nodes.push(value.slice(lastIndex, index));
    }

    nodes.push(
      <span key={`${offset + index}-${token}`} className={tokenClass(token, language)}>
        {token}
      </span>
    );
    lastIndex = index + token.length;
  }

  if (lastIndex < value.length) {
    nodes.push(value.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [value];
}

function tokenClass(token: string, language: TextLanguage): string {
  if (token.startsWith("//") || token.startsWith("#") || token.startsWith("<!--")) {
    return "text-[#64748b]";
  }

  if (
    token.startsWith("\"") ||
    token.startsWith("'") ||
    token.startsWith("`") ||
    (language === "html" && token.startsWith("&"))
  ) {
    return "text-[#047857]";
  }

  if (token.startsWith("<") && token.endsWith(">")) {
    return "text-[#0f766e]";
  }

  if (/^\d/.test(token) || /^(true|false|null|undefined)$/.test(token)) {
    return "text-[#b45309]";
  }

  if (/^[A-Za-z_$][\w$]*$/.test(token)) {
    return "text-[#7c3aed]";
  }

  return "text-[#94a3b8]";
}
