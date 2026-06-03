import { useCallback, useEffect, useState } from "react";
import { Bot, CheckCircle2, Edit3, Plus, Power, PowerOff, RefreshCw, SatelliteDish, Trash2 } from "lucide-react";
import {
  ApiError,
  createTelegramChannel,
  deleteTelegramChannel,
  listTelegramChannels,
  TelegramChannelInput,
  TelegramChannelItem,
  updateTelegramChannel
} from "../../api";
import { useConfirm } from "../../lib/confirm";
import { useToast } from "../../lib/toast";
import { formatDateTime } from "../../utils";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Spinner } from "../ui/Spinner";
import { TelegramChannelDialog } from "./TelegramChannelDialog";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "请求失败";
}

export function TelegramChannelsPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const [channels, setChannels] = useState<TelegramChannelItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<TelegramChannelItem | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await listTelegramChannels();
      setChannels(response.channels);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(body: TelegramChannelInput) {
    setSubmitting(true);
    try {
      if (!body.name || !body.bot_token || !body.chat_id) return;
      await createTelegramChannel({ name: body.name, bot_token: body.bot_token, chat_id: body.chat_id, status: body.status });
      toast.success("TG 渠道已新增");
      setCreateOpen(false);
      await load();
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function onUpdate(body: TelegramChannelInput) {
    if (!editing) return;
    setSubmitting(true);
    try {
      await updateTelegramChannel(editing.id, body);
      toast.success("TG 渠道已保存");
      setEditing(null);
      await load();
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function onToggle(channel: TelegramChannelItem) {
    setBusyId(channel.id);
    try {
      const nextStatus = channel.status === "active" ? "disabled" : "active";
      await updateTelegramChannel(channel.id, { status: nextStatus });
      toast.success(nextStatus === "active" ? "TG 渠道已启用" : "TG 渠道已禁用");
      await load();
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(channel: TelegramChannelItem) {
    const ok = await confirm({
      title: "删除该 TG 渠道？",
      description: (
        <>
          渠道 <span className="font-mono text-foreground">{channel.name}</span> 只有在没有任何文件或分片引用时才能删除；default 渠道不能删除。
        </>
      ),
      tone: "danger",
      confirmText: "删除"
    });
    if (!ok) return;

    setBusyId(channel.id);
    try {
      await deleteTelegramChannel(channel.id);
      toast.success("TG 渠道已删除");
      await load();
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  const activeCount = channels.filter((item) => item.status === "active" && item.configured).length;

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5 lg:col-span-2">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Telegram 存储</p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">TG 渠道</h2>
          <p className="mt-0.5 text-xs text-muted">{channels.length} 个渠道 · {activeCount} 个可参与上传调度</p>
        </div>
        <div className="flex items-center gap-2">
          <IconButton variant="default" size="sm" label="刷新 TG 渠道" onClick={() => void load()}>
            {loading ? <Spinner size={14} /> : <RefreshCw size={14} />}
          </IconButton>
          <Button variant="primary" size="sm" leadingIcon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>
            新增渠道
          </Button>
        </div>
      </header>

      {channels.length === 0 ? (
        loading ? (
          <div className="grid place-items-center py-8 text-muted"><Spinner size={20} /></div>
        ) : (
          <EmptyState
            title="还没有 TG 渠道"
            description="先配置 default 渠道，再逐步增加更多 bot-chat 目标来分摊上传限流。"
            icon={<SatelliteDish size={20} />}
            action={<Button size="sm" leadingIcon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>新增渠道</Button>}
          />
        )
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="hidden grid-cols-[1.1fr_1fr_1fr_auto_auto] gap-3 border-b border-border bg-background px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted md:grid">
            <span>渠道</span>
            <span>Bot Token</span>
            <span>Chat ID</span>
            <span>状态</span>
            <span className="text-right">操作</span>
          </div>
          <div className="divide-y divide-border">
            {channels.map((channel) => {
              const active = channel.status === "active";
              return (
                <article key={channel.id} className="grid gap-3 bg-surface px-4 py-3 md:grid-cols-[1.1fr_1fr_1fr_auto_auto] md:items-center">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-strong">
                      <Bot size={16} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-foreground" title={channel.name}>{channel.name}</p>
                        {channel.is_default ? <Badge tone="primary" size="sm">default</Badge> : null}
                        {!channel.configured ? <Badge tone="warning" size="sm">待配置</Badge> : null}
                      </div>
                      <p className="mt-0.5 text-[11px] text-subtle">更新：{formatDateTime(channel.updated_at)}</p>
                    </div>
                  </div>

                  <code className="truncate rounded-lg bg-background px-2 py-1 font-mono text-xs text-muted">{channel.masked_bot_token}</code>
                  <code className="truncate rounded-lg bg-background px-2 py-1 font-mono text-xs text-muted">{channel.chat_id || "未配置"}</code>

                  <Badge tone={active ? "success" : "neutral"} icon={active ? <CheckCircle2 size={12} /> : <PowerOff size={12} />}>
                    {active ? "启用" : "禁用"}
                  </Badge>

                  <div className="flex items-center justify-end gap-1.5">
                    <IconButton variant="ghost" size="sm" label="编辑" onClick={() => setEditing(channel)} disabled={busyId === channel.id}>
                      <Edit3 size={15} />
                    </IconButton>
                    <IconButton variant="ghost" size="sm" label={active ? "禁用" : "启用"} onClick={() => void onToggle(channel)} disabled={busyId === channel.id}>
                      {active ? <PowerOff size={15} /> : <Power size={15} />}
                    </IconButton>
                    <IconButton variant="danger" size="sm" label="删除" onClick={() => void onDelete(channel)} disabled={busyId === channel.id || channel.is_default}>
                      <Trash2 size={15} />
                    </IconButton>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      <TelegramChannelDialog
        open={createOpen}
        submitting={submitting}
        onSubmit={(body) => void onCreate(body)}
        onClose={() => {
          if (!submitting) setCreateOpen(false);
        }}
      />
      <TelegramChannelDialog
        open={editing !== null}
        channel={editing}
        submitting={submitting}
        onSubmit={(body) => void onUpdate(body)}
        onClose={() => {
          if (!submitting) setEditing(null);
        }}
      />
    </section>
  );
}
