import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { SessionResponse } from "../../api";
import { formatBytes } from "../../utils";
import { Badge } from "../ui/Badge";

interface ConfigPanelProps {
  session: SessionResponse;
}

const ITEMS: Array<{ key: keyof SessionResponse["config"]; label: string; hint?: string }> = [
  { key: "database", label: "SQLite 数据库", hint: "存储文件索引与 API keys" },
  { key: "telegram_bot_token", label: "Telegram Bot Token", hint: "调用 Bot API 的鉴权" },
  { key: "telegram_storage_chat_id", label: "Telegram 存储会话", hint: "兼容旧链接的环境变量回退" },
  { key: "telegram_channels", label: "TG 渠道配置", hint: "设置页管理多个 bot-chat 渠道" },
  { key: "tg_channel_secret", label: "TG 渠道加密密钥", hint: "加密存储 Bot Token" },
  { key: "link_signing_secret", label: "签名密钥", hint: "用于生成 /f/:token 的 HMAC" },
  { key: "admin_username", label: "管理员用户名" },
  { key: "admin_password", label: "管理员密码" },
  { key: "admin_session_secret", label: "会话密钥", hint: "签名管理后台 Cookie" }
];

export function ConfigPanel({ session }: ConfigPanelProps) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">运行状态</p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">服务配置</h2>
        </div>
        <Badge tone="success" icon={<CheckCircle2 size={12} />}>
          在线
        </Badge>
      </header>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <RuntimeValue label="BASE_URL" value={session.config_values.public_base_url || session.base_url} />
        <RuntimeValue label="直传上限" value={formatBytes(session.max_file_bytes)} />
        <RuntimeValue label="分片上限" value={formatBytes(session.max_multipart_file_bytes)} />
        <RuntimeValue label="直链上限" value={`${formatBytes(session.direct_access_max_bytes)} · ${session.direct_access_max_chunks} 片`} />
      </div>

      <ul className="flex flex-col gap-2">
        {ITEMS.map((item) => {
          const ok = Boolean(session.config[item.key]);
          const value = session.config_values[item.key] || (ok ? "已配置" : "未配置");
          return (
            <li
              key={item.key}
              className="grid gap-3 rounded-xl border border-border bg-background px-3 py-2.5 sm:grid-cols-[1fr_auto] sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{item.label}</p>
                {item.hint ? <p className="truncate text-xs text-muted">{item.hint}</p> : null}
                <p className="mt-1 truncate font-mono text-xs text-foreground" title={value}>
                  {value}
                </p>
              </div>
              {ok ? (
                <Badge tone="success" size="sm" icon={<CheckCircle2 size={12} />}>
                  已配置
                </Badge>
              ) : (
                <Badge tone="danger" size="sm" icon={<AlertCircle size={12} />}>
                  缺失
                </Badge>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RuntimeValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-background px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 truncate font-mono text-xs text-foreground" title={value}>
        {value}
      </p>
    </div>
  );
}
