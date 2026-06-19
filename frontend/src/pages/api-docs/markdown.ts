import type { DocGroup, ParameterDoc } from "./types";

export function buildMarkdown(group: DocGroup): string {
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
