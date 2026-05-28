import { CheckCircle2, Eye, KeyRound, Power, PowerOff, Trash2 } from "lucide-react";
import type { ApiKeyItem } from "../../api";
import { formatDateTime } from "../../utils";
import { Badge } from "../ui/Badge";
import { IconButton } from "../ui/IconButton";

interface ApiKeyRowProps {
  apiKey: ApiKeyItem;
  busy?: boolean;
  onReveal: () => void;
  onToggle: () => void;
  onDelete: () => void;
}

export function ApiKeyRow({ apiKey, busy, onReveal, onToggle, onDelete }: ApiKeyRowProps) {
  const active = apiKey.status === "active";

  return (
    <article className="grid gap-3 rounded-xl border border-border bg-surface p-3 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:p-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-strong">
          <KeyRound size={16} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground" title={apiKey.name}>
            {apiKey.name}
          </p>
          <code className="block truncate text-xs text-muted font-mono">{apiKey.masked_key}</code>
          <p className="mt-0.5 text-[11px] text-subtle">
            最近使用：{apiKey.last_used_at ? formatDateTime(apiKey.last_used_at) : "尚未使用"}
          </p>
        </div>
      </div>

      <Badge tone={active ? "success" : "neutral"} icon={active ? <CheckCircle2 size={12} /> : <PowerOff size={12} />}>
        {active ? "启用" : "禁用"}
      </Badge>

      <div className="flex items-center justify-end gap-1.5">
        <IconButton variant="ghost" size="sm" label="查看明文" onClick={onReveal} disabled={busy}>
          <Eye size={15} />
        </IconButton>
        <IconButton
          variant="ghost"
          size="sm"
          label={active ? "禁用" : "启用"}
          onClick={onToggle}
          disabled={busy}
        >
          {active ? <PowerOff size={15} /> : <Power size={15} />}
        </IconButton>
        <IconButton variant="danger" size="sm" label="删除" onClick={onDelete} disabled={busy}>
          <Trash2 size={15} />
        </IconButton>
      </div>
    </article>
  );
}
