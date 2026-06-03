import { FormEvent, useEffect, useMemo, useState } from "react";
import { Bot, Hash, Plus, Save } from "lucide-react";
import type { TelegramChannelInput, TelegramChannelItem } from "../../api";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";

interface TelegramChannelDialogProps {
  open: boolean;
  channel?: TelegramChannelItem | null;
  submitting: boolean;
  onSubmit: (body: TelegramChannelInput & { name?: string }) => void;
  onClose: () => void;
}

export function TelegramChannelDialog({ open, channel, submitting, onSubmit, onClose }: TelegramChannelDialogProps) {
  const editing = Boolean(channel);
  const [name, setName] = useState("");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [status, setStatus] = useState<"active" | "disabled">("active");

  useEffect(() => {
    if (!open) return;
    setName(channel?.name ?? "");
    setBotToken("");
    setChatId(channel?.chat_id ?? "");
    setStatus(channel?.status ?? "active");
  }, [channel, open]);

  const tokenRequired = useMemo(() => !editing || channel?.configured === false, [channel?.configured, editing]);
  const canSubmit = (channel?.is_default || name.trim()) && chatId.trim() && (!tokenRequired || botToken.trim());

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || submitting) return;

    onSubmit({
      ...(channel?.is_default ? {} : { name: name.trim() }),
      ...(botToken.trim() ? { bot_token: botToken.trim() } : {}),
      chat_id: chatId.trim(),
      status
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `编辑 TG 渠道：${channel?.name}` : "新增 TG 渠道"}
      description="每个渠道对应一个 Telegram Bot Token 和一个目标 chat_id，上传调度器会在启用渠道之间选择可用目标。"
      size="md"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      footer={
        <>
          <Button variant="secondary" disabled={submitting} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            form="telegram-channel-form"
            variant="primary"
            loading={submitting}
            leadingIcon={editing ? <Save size={16} /> : <Plus size={16} />}
            disabled={!canSubmit}
          >
            {editing ? "保存渠道" : "新增渠道"}
          </Button>
        </>
      }
    >
      <form id="telegram-channel-form" onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="tg-channel-name" className="text-xs font-medium text-muted">
            渠道名称
          </label>
          <Input
            id="tg-channel-name"
            value={channel?.is_default ? "default" : name}
            disabled={channel?.is_default || submitting}
            placeholder="如 tg-02、archive-bot"
            maxLength={64}
            leadingIcon={<Hash size={15} />}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="tg-bot-token" className="text-xs font-medium text-muted">
            Bot Token {tokenRequired ? <span className="text-danger">*</span> : <span className="text-subtle">（留空保持不变）</span>}
          </label>
          <Input
            id="tg-bot-token"
            value={botToken}
            type="password"
            autoComplete="off"
            placeholder={tokenRequired ? "123456:ABC..." : channel?.masked_bot_token ?? "留空保持不变"}
            leadingIcon={<Bot size={15} />}
            onChange={(event) => setBotToken(event.target.value)}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="tg-chat-id" className="text-xs font-medium text-muted">
              Chat ID <span className="text-danger">*</span>
            </label>
            <Input
              id="tg-chat-id"
              value={chatId}
              placeholder="-1001234567890"
              inputClassName="font-mono"
              onChange={(event) => setChatId(event.target.value)}
            />
          </div>
          <label className="flex h-11 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm text-foreground shadow-card">
            <input
              type="checkbox"
              className="size-4 rounded border-border text-primary focus:ring-primary"
              checked={status === "active"}
              onChange={(event) => setStatus(event.target.checked ? "active" : "disabled")}
            />
            启用新上传
          </label>
        </div>

        <p className="text-xs leading-5 text-muted">
          已禁用渠道不会参与新的上传调度，但历史文件仍会按记录的渠道下载。default 渠道用于兼容旧链接，不能删除。
        </p>
      </form>
    </Modal>
  );
}
