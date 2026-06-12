import { FormEvent, useEffect, useMemo, useState, type ReactNode } from "react";
import { FileText, Gauge, HardDrive, Image as ImageIcon, Package, Save, Video } from "lucide-react";
import { ApiError, type SessionResponse, updateSettings } from "../../api";
import { useToast } from "../../lib/toast";
import { formatBytes } from "../../utils";
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

const GIB_BYTES = 1024 * 1024 * 1024;
const MB_BYTES = 1024 * 1024;

export function UploadSettingsPanel({ session, onSessionChange }: UploadSettingsPanelProps) {
  const toast = useToast();
  const min = session.upload_concurrency_min;
  const max = session.upload_concurrency_max;
  const [draft, setDraft] = useState(String(session.upload_concurrency));
  const [cacheDraft, setCacheDraft] = useState(cacheBytesToGiBInput(session.video_preview_cache_bytes));
  const [chunkDraft, setChunkDraft] = useState(bytesToMBInput(session.telegram_chunk_size_bytes));
  const [videoChunkDraft, setVideoChunkDraft] = useState(bytesToMBInput(session.telegram_video_chunk_size_bytes));
  const [textChunkDraft, setTextChunkDraft] = useState(bytesToMBInput(session.telegram_text_chunk_size_bytes));
  const [imageChunkDraft, setImageChunkDraft] = useState(bytesToMBInput(session.telegram_image_chunk_size_bytes));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(String(session.upload_concurrency));
  }, [session.upload_concurrency]);

  useEffect(() => {
    setCacheDraft(cacheBytesToGiBInput(session.video_preview_cache_bytes));
  }, [session.video_preview_cache_bytes]);

  useEffect(() => {
    setChunkDraft(bytesToMBInput(session.telegram_chunk_size_bytes));
  }, [session.telegram_chunk_size_bytes]);

  useEffect(() => {
    setVideoChunkDraft(bytesToMBInput(session.telegram_video_chunk_size_bytes));
  }, [session.telegram_video_chunk_size_bytes]);

  useEffect(() => {
    setTextChunkDraft(bytesToMBInput(session.telegram_text_chunk_size_bytes));
  }, [session.telegram_text_chunk_size_bytes]);

  useEffect(() => {
    setImageChunkDraft(bytesToMBInput(session.telegram_image_chunk_size_bytes));
  }, [session.telegram_image_chunk_size_bytes]);

  const parsedDraft = useMemo(() => Number(draft), [draft]);
  const invalid = !Number.isSafeInteger(parsedDraft) || parsedDraft < min || parsedDraft > max;
  const parsedCacheGiB = useMemo(() => Number(cacheDraft), [cacheDraft]);
  const parsedCacheBytes = useMemo(() => Math.round(parsedCacheGiB * GIB_BYTES), [parsedCacheGiB]);
  const cacheInvalid = !Number.isFinite(parsedCacheGiB) ||
    parsedCacheBytes < session.video_preview_cache_bytes_min ||
    parsedCacheBytes > session.video_preview_cache_bytes_max;
  const parsedChunkMB = useMemo(() => Number(chunkDraft), [chunkDraft]);
  const parsedChunkBytes = useMemo(() => Math.round(parsedChunkMB * MB_BYTES), [parsedChunkMB]);
  const chunkInvalid = isChunkDraftInvalid(parsedChunkMB, parsedChunkBytes, session);
  const parsedVideoChunkMB = useMemo(() => Number(videoChunkDraft), [videoChunkDraft]);
  const parsedVideoChunkBytes = useMemo(() => Math.round(parsedVideoChunkMB * MB_BYTES), [parsedVideoChunkMB]);
  const videoChunkInvalid = isChunkDraftInvalid(parsedVideoChunkMB, parsedVideoChunkBytes, session);
  const parsedTextChunkMB = useMemo(() => Number(textChunkDraft), [textChunkDraft]);
  const parsedTextChunkBytes = useMemo(() => Math.round(parsedTextChunkMB * MB_BYTES), [parsedTextChunkMB]);
  const textChunkInvalid = isChunkDraftInvalid(parsedTextChunkMB, parsedTextChunkBytes, session);
  const parsedImageChunkMB = useMemo(() => Number(imageChunkDraft), [imageChunkDraft]);
  const parsedImageChunkBytes = useMemo(() => Math.round(parsedImageChunkMB * MB_BYTES), [parsedImageChunkMB]);
  const imageChunkInvalid = isChunkDraftInvalid(parsedImageChunkMB, parsedImageChunkBytes, session);
  const anyChunkInvalid = chunkInvalid || videoChunkInvalid || textChunkInvalid || imageChunkInvalid;
  const dirty = (!invalid && parsedDraft !== session.upload_concurrency) ||
    (!cacheInvalid && parsedCacheBytes !== session.video_preview_cache_bytes) ||
    (!chunkInvalid && parsedChunkBytes !== session.telegram_chunk_size_bytes) ||
    (!videoChunkInvalid && parsedVideoChunkBytes !== session.telegram_video_chunk_size_bytes) ||
    (!textChunkInvalid && parsedTextChunkBytes !== session.telegram_text_chunk_size_bytes) ||
    (!imageChunkInvalid && parsedImageChunkBytes !== session.telegram_image_chunk_size_bytes);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalid) {
      toast.danger(`并发数量需要在 ${min}-${max} 之间`);
      return;
    }
    if (cacheInvalid) {
      toast.danger(`视频预览缓存需要在 ${formatBytes(session.video_preview_cache_bytes_min)}-${formatBytes(session.video_preview_cache_bytes_max)} 之间`);
      return;
    }
    if (anyChunkInvalid) {
      toast.danger(`分片大小需要在 ${formatBytes(session.telegram_chunk_size_bytes_min)}-${formatBytes(session.telegram_chunk_size_bytes_max)} 之间`);
      return;
    }

    setSaving(true);
    try {
      const response = await updateSettings({
        upload_concurrency: parsedDraft,
        video_preview_cache_bytes: parsedCacheBytes,
        telegram_chunk_size_bytes: parsedChunkBytes,
        telegram_video_chunk_size_bytes: parsedVideoChunkBytes,
        telegram_text_chunk_size_bytes: parsedTextChunkBytes,
        telegram_image_chunk_size_bytes: parsedImageChunkBytes
      });
      onSessionChange({
        ...session,
        upload_concurrency: response.settings.upload_concurrency,
        upload_concurrency_min: response.settings.upload_concurrency_min,
        upload_concurrency_max: response.settings.upload_concurrency_max,
        video_preview_cache_bytes: response.settings.video_preview_cache_bytes,
        video_preview_cache_bytes_min: response.settings.video_preview_cache_bytes_min,
        video_preview_cache_bytes_max: response.settings.video_preview_cache_bytes_max,
        telegram_chunk_size_bytes: response.settings.telegram_chunk_size_bytes,
        telegram_video_chunk_size_bytes: response.settings.telegram_video_chunk_size_bytes,
        telegram_text_chunk_size_bytes: response.settings.telegram_text_chunk_size_bytes,
        telegram_image_chunk_size_bytes: response.settings.telegram_image_chunk_size_bytes,
        telegram_chunk_size_bytes_min: response.settings.telegram_chunk_size_bytes_min,
        telegram_chunk_size_bytes_max: response.settings.telegram_chunk_size_bytes_max
      });
      setDraft(String(response.settings.upload_concurrency));
      setCacheDraft(cacheBytesToGiBInput(response.settings.video_preview_cache_bytes));
      setChunkDraft(bytesToMBInput(response.settings.telegram_chunk_size_bytes));
      setVideoChunkDraft(bytesToMBInput(response.settings.telegram_video_chunk_size_bytes));
      setTextChunkDraft(bytesToMBInput(response.settings.telegram_text_chunk_size_bytes));
      setImageChunkDraft(bytesToMBInput(response.settings.telegram_image_chunk_size_bytes));
      toast.success("传输与预览设置已保存");
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
          <p className="text-xs font-medium uppercase tracking-wide text-muted">传输任务</p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">并发、分片与预览缓存</h2>
          <p className="mt-0.5 text-xs text-muted">保存后对下一次上传、加速下载和视频预览缓存生效。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone="primary" icon={<Gauge size={12} />}>
            {session.upload_concurrency} 并发
          </Badge>
          <Badge tone="info" icon={<Package size={12} />}>
            默认 {formatBytes(session.telegram_chunk_size_bytes)}
          </Badge>
          <Badge tone="primary" icon={<Video size={12} />}>
            视频 {formatBytes(session.telegram_video_chunk_size_bytes)}
          </Badge>
          <Badge tone="neutral" icon={<HardDrive size={12} />}>
            {formatBytes(session.video_preview_cache_bytes)}
          </Badge>
        </div>
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

        <div className="grid gap-3 sm:grid-cols-2">
          <ChunkSizeField
            label="默认分片"
            description="其他文件类型使用"
            icon={<Package size={14} />}
            value={chunkDraft}
            parsedMB={parsedChunkMB}
            currentBytes={session.telegram_chunk_size_bytes}
            invalid={chunkInvalid}
            saving={saving}
            session={session}
            onChange={setChunkDraft}
          />
          <ChunkSizeField
            label="视频分片"
            description="建议 1-2MB，预览更快"
            icon={<Video size={14} />}
            value={videoChunkDraft}
            parsedMB={parsedVideoChunkMB}
            currentBytes={session.telegram_video_chunk_size_bytes}
            invalid={videoChunkInvalid}
            saving={saving}
            session={session}
            onChange={setVideoChunkDraft}
          />
          <ChunkSizeField
            label="文本分片"
            description="可设大一些，减少切片"
            icon={<FileText size={14} />}
            value={textChunkDraft}
            parsedMB={parsedTextChunkMB}
            currentBytes={session.telegram_text_chunk_size_bytes}
            invalid={textChunkInvalid}
            saving={saving}
            session={session}
            onChange={setTextChunkDraft}
          />
          <ChunkSizeField
            label="图片分片"
            description="图片预览与原图下载"
            icon={<ImageIcon size={14} />}
            value={imageChunkDraft}
            parsedMB={parsedImageChunkMB}
            currentBytes={session.telegram_image_chunk_size_bytes}
            invalid={imageChunkInvalid}
            saving={saving}
            session={session}
            onChange={setImageChunkDraft}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_9rem] sm:items-end">
          <label className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted">视频预览缓存上限</span>
            <input
              type="range"
              min={bytesToGiB(session.video_preview_cache_bytes_min)}
              max={bytesToGiB(session.video_preview_cache_bytes_max)}
              step={0.25}
              value={cacheInvalid ? bytesToGiB(session.video_preview_cache_bytes) : parsedCacheGiB}
              disabled={saving}
              onChange={(event) => setCacheDraft(event.currentTarget.value)}
              className="h-11 w-full accent-primary"
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted">容量</span>
            <Input
              type="number"
              min={bytesToGiB(session.video_preview_cache_bytes_min)}
              max={bytesToGiB(session.video_preview_cache_bytes_max)}
              step={0.25}
              value={cacheDraft}
              disabled={saving}
              invalid={cacheInvalid}
              onChange={(event) => setCacheDraft(event.currentTarget.value)}
              trailingNode={<span className="text-xs text-muted">GiB</span>}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">
            并发 {min}-{max}；四类分片均限制 {formatBytes(session.telegram_chunk_size_bytes_min)}-{formatBytes(session.telegram_chunk_size_bytes_max)}；缓存 {formatBytes(session.video_preview_cache_bytes_min)}-{formatBytes(session.video_preview_cache_bytes_max)}。
          </p>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={saving}
            disabled={!dirty || invalid || cacheInvalid || anyChunkInvalid}
            leadingIcon={<Save size={15} />}
          >
            保存设置
          </Button>
        </div>
      </form>
    </section>
  );
}

function isChunkDraftInvalid(parsedMB: number, parsedBytes: number, session: SessionResponse): boolean {
  return !Number.isFinite(parsedMB) ||
    parsedBytes < session.telegram_chunk_size_bytes_min ||
    parsedBytes > session.telegram_chunk_size_bytes_max;
}

function ChunkSizeField({
  label,
  description,
  icon,
  value,
  parsedMB,
  currentBytes,
  invalid,
  saving,
  session,
  onChange
}: {
  label: string;
  description: string;
  icon: ReactNode;
  value: string;
  parsedMB: number;
  currentBytes: number;
  invalid: boolean;
  saving: boolean;
  session: SessionResponse;
  onChange: (value: string) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-background/60 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <span className="text-primary">{icon}</span>
            <span>{label}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted">{description}</p>
        </div>
        <span className="shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary-strong">
          {formatBytes(currentBytes)}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_5.75rem] sm:items-center">
        <input
          type="range"
          min={bytesToMB(session.telegram_chunk_size_bytes_min)}
          max={bytesToMB(session.telegram_chunk_size_bytes_max)}
          step={1}
          value={invalid ? bytesToMB(currentBytes) : parsedMB}
          disabled={saving}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="h-9 w-full accent-primary"
        />
        <Input
          type="number"
          min={bytesToMB(session.telegram_chunk_size_bytes_min)}
          max={bytesToMB(session.telegram_chunk_size_bytes_max)}
          step={1}
          value={value}
          disabled={saving}
          invalid={invalid}
          onChange={(event) => onChange(event.currentTarget.value)}
          trailingNode={<span className="text-xs text-muted">MB</span>}
        />
      </div>
    </div>
  );
}

function bytesToGiB(value: number): number {
  return value / GIB_BYTES;
}

function bytesToMB(value: number): number {
  return value / MB_BYTES;
}

function cacheBytesToGiBInput(value: number): string {
  return Number(bytesToGiB(value).toFixed(2)).toString();
}

function bytesToMBInput(value: number): string {
  return Math.round(bytesToMB(value)).toString();
}
