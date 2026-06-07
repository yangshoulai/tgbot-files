import { FormEvent, useEffect, useMemo, useState } from "react";
import { Gauge, Save } from "lucide-react";
import { ApiError, type SessionResponse, updateSettings } from "../../api";
import { useToast } from "../../lib/toast";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Badge } from "../ui/Badge";

interface UploadSettingsPanelProps {
  session: SessionResponse;
  onSessionChange: (session: SessionResponse) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "请求失败";
}

export function UploadSettingsPanel({ session, onSessionChange }: UploadSettingsPanelProps) {
  const toast = useToast();
  const min = session.upload_concurrency_min;
  const max = session.upload_concurrency_max;
  const [draft, setDraft] = useState(String(session.upload_concurrency));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(String(session.upload_concurrency));
  }, [session.upload_concurrency]);

  const parsedDraft = useMemo(() => Number(draft), [draft]);
  const invalid = !Number.isSafeInteger(parsedDraft) || parsedDraft < min || parsedDraft > max;
  const dirty = !invalid && parsedDraft !== session.upload_concurrency;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalid) {
      toast.danger(`并发数量需要在 ${min}-${max} 之间`);
      return;
    }

    setSaving(true);
    try {
      const response = await updateSettings({ upload_concurrency: parsedDraft });
      onSessionChange({
        ...session,
        upload_concurrency: response.settings.upload_concurrency,
        upload_concurrency_min: response.settings.upload_concurrency_min,
        upload_concurrency_max: response.settings.upload_concurrency_max
      });
      setDraft(String(response.settings.upload_concurrency));
      toast.success("上传并发已保存");
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">上传任务</p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">分片并发</h2>
          <p className="mt-0.5 text-xs text-muted">保存后对下一次本地文件、URL 和 HLS 上传生效。</p>
        </div>
        <Badge tone="primary" icon={<Gauge size={12} />}>
          {session.upload_concurrency} 并发
        </Badge>
      </header>

      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="grid gap-3 sm:grid-cols-[1fr_9rem] sm:items-end">
          <label className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted">并发数量</span>
            <input
              type="range"
              min={min}
              max={max}
              step={1}
              value={invalid ? session.upload_concurrency : parsedDraft}
              disabled={saving}
              onChange={(event) => setDraft(event.currentTarget.value)}
              className="h-11 w-full accent-primary"
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted">数值</span>
            <Input
              type="number"
              min={min}
              max={max}
              step={1}
              value={draft}
              disabled={saving}
              invalid={invalid}
              onChange={(event) => setDraft(event.currentTarget.value)}
              trailingNode={<span className="text-xs text-muted">个</span>}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">
            可设置范围 {min}-{max}，当前值 {session.upload_concurrency}。
          </p>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={saving}
            disabled={!dirty || invalid}
            leadingIcon={<Save size={15} />}
          >
            保存设置
          </Button>
        </div>
      </form>
    </section>
  );
}
