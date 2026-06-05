export interface ParsedCurlCommand {
  url: string;
  headers: Record<string, string>;
  method?: string;
  warnings: string[];
}

const BODY_OPTIONS = new Set([
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-ascii",
  "--data-urlencode",
  "-F",
  "--form",
  "--form-string",
  "--json"
]);

const VALUE_OPTIONS = new Set([
  "-o",
  "--output",
  "-w",
  "--write-out",
  "--connect-timeout",
  "--max-time",
  "--proxy",
  "--proxy-user",
  "--resolve",
  "--cacert",
  "--cert",
  "--key",
  "--limit-rate",
  "--retry",
  "--retry-delay",
  "--retry-max-time",
  "--request-target",
  "--url-query"
]);

export function parseCurlCommand(input: string): ParsedCurlCommand {
  const tokens = tokenizeCurlCommand(input);

  if (tokens.length === 0) {
    throw new Error("请粘贴完整的 cURL 命令");
  }

  let index = 0;
  if (tokens[index] === "$" || tokens[index] === ">") {
    index += 1;
  }

  if (/^(curl|curl\.exe)$/i.test(tokens[index] ?? "")) {
    index += 1;
  }

  let url: string | undefined;
  let method: string | undefined;
  let hasBody = false;
  const headers: Record<string, string> = {};
  const warnings: string[] = [];

  const addWarning = (warning: string) => {
    if (!warnings.includes(warning)) {
      warnings.push(warning);
    }
  };

  const addHeader = (name: string, value: string) => {
    const normalizedName = name.trim();
    const normalizedValue = value.trim();
    if (!normalizedName || !normalizedValue) {
      return;
    }

    const existingName = Object.keys(headers).find(
      (headerName) => headerName.toLowerCase() === normalizedName.toLowerCase()
    );
    if (existingName) {
      delete headers[existingName];
    }
    headers[normalizedName] = normalizedValue;
  };

  const readValue = (option: string, currentIndex: number): { value: string; nextIndex: number } => {
    const next = tokens[currentIndex + 1];
    if (next === undefined) {
      throw new Error(`cURL 参数 ${option} 缺少值`);
    }
    return { value: next, nextIndex: currentIndex + 1 };
  };

  while (index < tokens.length) {
    const token = tokens[index] ?? "";

    if (!token) {
      index += 1;
      continue;
    }

    if (token === "--") {
      index += 1;
      continue;
    }

    const headerValue = optionValue(token, "--header") ?? shortOptionValue(token, "-H");
    if (headerValue !== undefined) {
      parseHeader(headerValue, addHeader, addWarning);
      index += 1;
      continue;
    }

    if (token === "-H" || token === "--header") {
      const parsed = readValue(token, index);
      parseHeader(parsed.value, addHeader, addWarning);
      index = parsed.nextIndex + 1;
      continue;
    }

    const userAgent = optionValue(token, "--user-agent") ?? shortOptionValue(token, "-A");
    if (userAgent !== undefined) {
      addHeader("User-Agent", userAgent);
      index += 1;
      continue;
    }

    if (token === "-A" || token === "--user-agent") {
      const parsed = readValue(token, index);
      addHeader("User-Agent", parsed.value);
      index = parsed.nextIndex + 1;
      continue;
    }

    const referer = optionValue(token, "--referer") ?? shortOptionValue(token, "-e");
    if (referer !== undefined) {
      addHeader("Referer", referer);
      index += 1;
      continue;
    }

    if (token === "-e" || token === "--referer") {
      const parsed = readValue(token, index);
      addHeader("Referer", parsed.value);
      index = parsed.nextIndex + 1;
      continue;
    }

    const cookie = optionValue(token, "--cookie") ?? shortOptionValue(token, "-b");
    if (cookie !== undefined) {
      addHeader("Cookie", cookie);
      index += 1;
      continue;
    }

    if (token === "-b" || token === "--cookie") {
      const parsed = readValue(token, index);
      addHeader("Cookie", parsed.value);
      index = parsed.nextIndex + 1;
      continue;
    }

    const basicUser = optionValue(token, "--user") ?? shortOptionValue(token, "-u");
    if (basicUser !== undefined) {
      addBasicAuthorizationHeader(basicUser, addHeader, addWarning);
      index += 1;
      continue;
    }

    if (token === "-u" || token === "--user") {
      const parsed = readValue(token, index);
      addBasicAuthorizationHeader(parsed.value, addHeader, addWarning);
      index = parsed.nextIndex + 1;
      continue;
    }

    const requestMethod = optionValue(token, "--request") ?? shortOptionValue(token, "-X");
    if (requestMethod !== undefined) {
      method = requestMethod.trim().toUpperCase();
      index += 1;
      continue;
    }

    if (token === "-X" || token === "--request") {
      const parsed = readValue(token, index);
      method = parsed.value.trim().toUpperCase();
      index = parsed.nextIndex + 1;
      continue;
    }

    const explicitUrl = optionValue(token, "--url");
    if (explicitUrl !== undefined) {
      url = explicitUrl;
      index += 1;
      continue;
    }

    if (token === "--url") {
      const parsed = readValue(token, index);
      url = parsed.value;
      index = parsed.nextIndex + 1;
      continue;
    }

    if (BODY_OPTIONS.has(token) || BODY_OPTIONS.has(optionName(token)) || isJoinedShortBodyOption(token)) {
      hasBody = true;
      method = method ?? "POST";
      if (!token.includes("=") && !isJoinedShortBodyOption(token)) {
        const parsed = readValue(token, index);
        index = parsed.nextIndex + 1;
      } else {
        index += 1;
      }
      continue;
    }

    if (VALUE_OPTIONS.has(token) || VALUE_OPTIONS.has(optionName(token))) {
      if (!token.includes("=")) {
        const parsed = readValue(token, index);
        index = parsed.nextIndex + 1;
      } else {
        index += 1;
      }
      continue;
    }

    if (token === "-G" || token === "--get") {
      method = "GET";
      index += 1;
      continue;
    }

    if (!token.startsWith("-") && isHttpUrlLike(token) && !url) {
      url = token;
      index += 1;
      continue;
    }

    index += 1;
  }

  if (!url) {
    throw new Error("未能从 cURL 中解析出 http/https URL");
  }

  const normalizedUrl = normalizeParsedUrl(url);
  if (!normalizedUrl) {
    throw new Error("cURL 中的 URL 必须是完整的 http/https 地址");
  }

  if (method && method !== "GET" && method !== "HEAD") {
    addWarning(`检测到 ${method} 请求，URL 上传仍会使用 GET/HEAD/Range 拉取文件`);
  }

  if (hasBody) {
    addWarning("检测到请求体参数，URL 上传不会转发 body，请确认资源支持直接 GET/Range 访问");
  }

  return {
    url: normalizedUrl,
    headers,
    ...(method ? { method } : {}),
    warnings
  };
}

function tokenizeCurlCommand(input: string): string[] {
  const normalized = input
    .trim()
    .replace(/\\\r?\n\s*/g, " ")
    .replace(/\^\r?\n\s*/g, " ")
    .replace(/`\r?\n\s*/g, " ");
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let started = false;

  const push = () => {
    if (started) {
      tokens.push(current);
      current = "";
      started = false;
    }
  };

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      started = true;
      continue;
    }

    if (quote === "\"") {
      if (char === "\"") {
        quote = null;
      } else if (char === "\\" || char === "`" || char === "^") {
        const next = normalized[index + 1];
        if (next !== undefined) {
          current += next;
          index += 1;
        } else {
          current += char;
        }
      } else {
        current += char;
      }
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      push();
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      started = true;
      continue;
    }

    if (char === "\\" || char === "^" || char === "`") {
      const next = normalized[index + 1];
      if (next !== undefined) {
        current += next;
        index += 1;
      } else {
        current += char;
      }
      started = true;
      continue;
    }

    current += char;
    started = true;
  }

  if (quote) {
    throw new Error("cURL 命令中的引号不完整");
  }

  push();
  return tokens;
}

function parseHeader(
  value: string,
  addHeader: (name: string, value: string) => void,
  addWarning: (warning: string) => void
) {
  const separator = value.indexOf(":");
  if (separator <= 0) {
    addWarning(`已忽略无法识别的请求头：${value}`);
    return;
  }

  addHeader(value.slice(0, separator), value.slice(separator + 1));
}

function addBasicAuthorizationHeader(
  value: string,
  addHeader: (name: string, value: string) => void,
  addWarning: (warning: string) => void
) {
  if (!value.includes(":")) {
    addWarning("已忽略缺少密码部分的 -u/--user 参数");
    return;
  }

  addHeader("Authorization", `Basic ${base64Utf8(value)}`);
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function optionValue(token: string, name: string): string | undefined {
  const prefix = `${name}=`;
  return token.startsWith(prefix) ? token.slice(prefix.length) : undefined;
}

function shortOptionValue(token: string, name: string): string | undefined {
  return token.startsWith(name) && token.length > name.length ? token.slice(name.length) : undefined;
}

function optionName(token: string): string {
  const separator = token.indexOf("=");
  return separator > 0 ? token.slice(0, separator) : token;
}

function isJoinedShortBodyOption(token: string): boolean {
  return (token.startsWith("-d") || token.startsWith("-F")) && token.length > 2;
}

function isHttpUrlLike(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function normalizeParsedUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
