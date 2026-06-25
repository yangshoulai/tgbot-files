import { ChangeEvent, useEffect, useState } from "react";
import { Check, ImageOff, ImagePlus, Link2, Sparkles } from "lucide-react";
import {
  ApiError,
  clearFileThumbnail,
  updateFileThumbnail,
  type FileItem,
  type SourceRequestHeaders
} from "../../api";
import { parseCurlCommand } from "../../lib/curl";
import { hasFileLinkAccess } from "../../lib/file-access";
import { useToast } from "../../lib/toast";
import {
  generateThumbnailCandidatesFromHlsPlaylist,
  generateThumbnailCandidatesFromRemoteSource,
  generateThumbnailFromFile,
  revokeThumbnail,
  type GeneratedThumbnail
} from "../../lib/thumbnail";
import { buildVideoPreviewMetadata, buildVideoPreviewUrl } from "../../lib/video-preview";
import { formatBytes } from "../../utils";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Textarea } from "../ui/Textarea";
import { Spinner } from "../ui/Spinner";
import { Segmented } from "../ui/Segmented";

type ThumbnailInputMode = "auto" | "local" | "url";

interface ThumbnailEditDialogProps {
  file: FileItem | null;
  onClose: () => void;
  onSaved: (file: FileItem) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "请求失败";
}

export function ThumbnailEditDialog({ file, onClose, onSaved }: ThumbnailEditDialogProps) {
  const toast = useToast();
  const [mode, setMode] = useState<ThumbnailInputMode>("local");
  const [generated, setGenerated] = useState<GeneratedThumbnail>();
  const [generatedCandidates, setGeneratedCandidates] = useState<GeneratedThumbnail[]>([]);
  const [urlText, setUrlText] = useState("");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!file) {
      setMode("local");
      setUrlText("");
      setMessage(undefined);
      setError(undefined);
      setSaving(false);
      setGenerating(false);
      setGenerated((current) => {
        revokeThumbnail(current);
        return undefined;
      });
      setGeneratedCandidates((current) => {
        for (const candidate of current) {
          revokeThumbnail(candidate);
        }
        return [];
      });
      return;
    }

    setMode(autoThumbnailSupported(file) ? "auto" : "local");
    setUrlText("");
    setMessage(undefined);
    setError(undefined);
    setGenerated((current) => {
      revokeThumbnail(current);
      return undefined;
    });
    setGeneratedCandidates((current) => {
      for (const candidate of current) {
        revokeThumbnail(candidate);
      }
      return [];
    });
  }, [file?.id]);

  function updateGeneratedCandidates(next: GeneratedThumbnail[]) {
    setGenerated((current) => {
      revokeThumbnail(current);
      return undefined;
    });
    setGeneratedCandidates((current) => {
      for (const candidate of current) {
        revokeThumbnail(candidate);
      }
      return next;
    });
  }

  async function handleLocalPick(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    event.currentTarget.value = "";
    if (!picked) return;

    setMode("local");
    setError(undefined);
    setMessage("正在处理本地缩略图");
    setGenerating(true);
    try {
      const thumbnail = await generateThumbnailFromFile(picked, "manual");
      updateGeneratedCandidates([]);
      setGenerated(thumbnail);
      setMessage(`已生成 ${thumbnail.width ?? "?"} × ${thumbnail.height ?? "?"} 缩略图，${formatBytes(thumbnail.blob.size)}`);
    } catch (thumbnailError) {
      updateGeneratedCandidates([]);
      setError(errorMessage(thumbnailError));
      setMessage(undefined);
    } finally {
      setGenerating(false);
    }
  }

  async function generateAutomaticThumbnail() {
    if (!file) return;

    setMode("auto");
    setError(undefined);
    setMessage("正在从当前文件生成缩略图");
    setGenerating(true);
    try {
      const thumbnails = await generateThumbnailCandidatesFromFileItem(file);
      const first = thumbnails[0];
      if (!first) {
        throw new Error("未生成可用缩略图候选");
      }
      updateGeneratedCandidates(thumbnails);
      setGenerated(first);
      setMessage(
        thumbnails.length > 1
          ? `已生成 ${thumbnails.length} 张候选缩略图，请选择一张后保存`
          : `已生成 ${first.width ?? "?"} × ${first.height ?? "?"} 缩略图，${formatBytes(first.blob.size)}`
      );
    } catch (thumbnailError) {
      updateGeneratedCandidates([]);
      setError(errorMessage(thumbnailError));
      setMessage(undefined);
    } finally {
      setGenerating(false);
    }
  }

  async function saveLocalThumbnail() {
    if (!file || !generated) {
      setError(mode === "auto" ? "请先自动生成缩略图" : "请先选择本地缩略图");
      return;
    }

    setSaving(true);
    setError(undefined);
    try {
      const response = await updateFileThumbnail(file.id, {
        blob: generated.blob,
        fileName: generated.fileName,
        ...(generated.width ? { width: generated.width } : {}),
        ...(generated.height ? { height: generated.height } : {})
      });
      toast.success("缩略图已更新");
      onSaved(response.file);
      onClose();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function saveUrlThumbnail() {
    if (!file) return;

    let parsed: { url: string; headers?: SourceRequestHeaders; summary: string };
    try {
      parsed = parseRemoteThumbnailInput(urlText);
    } catch (parseError) {
      setError(errorMessage(parseError));
      return;
    }

    setSaving(true);
    setError(undefined);
    setMessage(parsed.summary);
    try {
      const response = await updateFileThumbnail(file.id, {
        sourceUrl: parsed.url,
        ...(parsed.headers ? { sourceHeaders: parsed.headers } : {})
      });
      toast.success("缩略图已更新");
      onSaved(response.file);
      onClose();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function clearThumbnail() {
    if (!file) return;

    setSaving(true);
    setError(undefined);
    try {
      const response = await clearFileThumbnail(file.id);
      toast.success("缩略图已清除");
      onSaved(response.file);
      onClose();
    } catch (clearError) {
      setError(errorMessage(clearError));
    } finally {
      setSaving(false);
    }
  }

  const supportsAutoThumbnail = Boolean(file && autoThumbnailSupported(file));
  const canSave = mode === "url" ? Boolean(urlText.trim()) : Boolean(generated);

  return (
    <Modal
      open={Boolean(file)}
      onClose={() => {
        if (!saving && !generating) onClose();
      }}
      title="修改缩略图"
      description={file ? `为 ${file.file_name} 设置新的缩略图，或清除当前缩略图。` : undefined}
      size="lg"
      footer={
        <>
          {file?.thumbnail_url ? (
            <Button
              variant="danger-ghost"
              disabled={saving || generating}
              leadingIcon={<ImageOff size={15} />}
              onClick={() => void clearThumbnail()}
            >
              清除缩略图
            </Button>
          ) : null}
          <Button variant="secondary" disabled={saving || generating} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!canSave || generating}
            loading={saving}
            leadingIcon={<Check size={15} />}
            onClick={() => void (mode === "url" ? saveUrlThumbnail() : saveLocalThumbnail())}
          >
            保存缩略图
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented<ThumbnailInputMode>
          value={mode}
          onChange={(nextMode) => {
            setMode(nextMode);
            setError(undefined);
          }}
          ariaLabel="缩略图来源"
          options={[
            { value: "auto", label: "自动生成", icon: <Sparkles size={15} /> },
            { value: "local", label: "本地图片", icon: <ImagePlus size={15} /> },
            { value: "url", label: "URL / cURL", icon: <Link2 size={15} /> }
          ]}
        />

        <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <div className="grid aspect-video place-items-center overflow-hidden rounded-xl border border-border bg-background">
            {generated ? (
              <img src={generated.objectUrl} alt="新缩略图预览" className="max-h-full max-w-full object-contain" />
            ) : file?.thumbnail_url ? (
              <img src={file.thumbnail_url} alt="当前缩略图" className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="flex flex-col items-center gap-1 text-xs text-subtle">
                {generating ? <Spinner size={18} /> : <ImagePlus size={20} />}
                {generating ? "生成中" : "无缩略图"}
              </span>
            )}
          </div>

          {mode === "auto" ? (
            <div className="flex flex-col justify-center gap-2">
              <Button
                variant="secondary"
                leadingIcon={<Sparkles size={16} />}
                loading={generating}
                disabled={saving || !supportsAutoThumbnail}
                onClick={() => void generateAutomaticThumbnail()}
              >
                自动生成缩略图
              </Button>
              <p className="text-xs leading-5 text-muted">
                图片会按原始比例生成；视频会从多个时间点截取候选画面并跳过明显空白帧。HLS 会优先按整段播放时间截取候选，失败时退回首个片段。
              </p>
              {!supportsAutoThumbnail ? (
                <p className="rounded-lg border border-warning/25 bg-warning-soft px-2.5 py-2 text-xs leading-5 text-warning">
                  当前文件类型或访问方式不支持自动生成，请选择本地图片或 URL。
                </p>
              ) : null}
            </div>
          ) : mode === "local" ? (
            <div className="flex flex-col justify-center gap-2">
              <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-foreground shadow-card transition-colors hover:border-border-strong hover:bg-background">
                <ImagePlus size={16} />
                选择本地图片
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/*"
                  className="sr-only"
                  disabled={saving || generating}
                  onChange={handleLocalPick}
                />
              </label>
              <p className="text-xs leading-5 text-muted">
                会在浏览器内压缩为适合存储的缩略图，再上传到 Telegram。
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label htmlFor="edit-thumbnail-url" className="text-xs font-medium text-muted">
                缩略图 URL 或 cURL
              </label>
              <Textarea
                id="edit-thumbnail-url"
                rows={6}
                value={urlText}
                invalid={Boolean(error)}
                disabled={saving}
                className="font-mono !text-[13px] !leading-6 !text-muted"
                placeholder={"https://example.com/cover.jpg\n\n或：\ncurl 'https://example.com/cover.jpg' \\\n  -H 'Referer: https://example.com/' \\\n  -H 'Cookie: session=...'"}
                onChange={(event) => {
                  setUrlText(event.target.value);
                  setError(undefined);
                }}
              />
              <p className="text-xs leading-5 text-muted">
                服务端会拉取并校验图片，仅接受 JPEG、PNG、WebP，大小不超过 512 KB。
              </p>
            </div>
          )}
        </div>

        {message ? (
          <div className="rounded-xl border border-border bg-background px-3 py-2 text-xs leading-5 text-muted">
            {message}
          </div>
        ) : null}
        {mode === "auto" && generatedCandidates.length > 1 ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {generatedCandidates.map((candidate, index) => {
              const selected = generated?.objectUrl === candidate.objectUrl;
              return (
                <button
                  key={candidate.objectUrl}
                  type="button"
                  className={[
                    "group overflow-hidden rounded-xl border bg-surface text-left shadow-card transition",
                    selected ? "border-primary shadow-[0_0_0_4px_var(--color-primary-ring)]" : "border-border hover:border-primary/60"
                  ].join(" ")}
                  disabled={saving || generating}
                  onClick={() => {
                    setGenerated(candidate);
                    setError(undefined);
                  }}
                >
                  <span className="block aspect-video bg-background">
                    <img src={candidate.objectUrl} alt={`候选缩略图 ${index + 1}`} className="h-full w-full object-contain" />
                  </span>
                  <span className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] text-muted">
                    <span>候选 {index + 1}</span>
                    <span>{formatCaptureTime(candidate.captureTimeSeconds)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        {error ? (
          <div className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm leading-6 text-danger">
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function autoThumbnailSupported(file: FileItem): boolean {
  const sourceKind = thumbnailSourceKindForFile(file);
  if (!sourceKind) return false;
  if (sourceKind === "image") return hasFileLinkAccess(file);
  return Boolean(buildVideoPreviewUrl(file, buildVideoPreviewMetadata(file, Number.MAX_SAFE_INTEGER, 1)));
}

async function generateThumbnailFromFileItem(file: FileItem): Promise<GeneratedThumbnail> {
  const candidates = await generateThumbnailCandidatesFromFileItem(file);
  const first = candidates[0];
  if (!first) {
    throw new Error("未生成可用缩略图候选");
  }
  return first;
}

async function generateThumbnailCandidatesFromFileItem(file: FileItem): Promise<GeneratedThumbnail[]> {
  const sourceKind = thumbnailSourceKindForFile(file);
  if (!sourceKind) {
    throw new Error("当前文件类型不支持自动生成缩略图");
  }

  if (file.storage_backend === "hls_package") {
    const metadata = buildVideoPreviewMetadata(file, Number.MAX_SAFE_INTEGER, 1);
    const previewUrl = buildVideoPreviewUrl(file, metadata, { thumbnailCapture: true });
    if (!previewUrl) {
      throw new Error("无法生成 HLS 预览地址");
    }
    return generateThumbnailCandidatesFromHlsPlaylist(previewUrl, file.file_name);
  }

  if (sourceKind === "video") {
    const metadata = buildVideoPreviewMetadata(file, Number.MAX_SAFE_INTEGER, 1);
    const previewUrl = buildVideoPreviewUrl(file, metadata, { thumbnailCapture: true });
    if (!previewUrl) {
      throw new Error("无法生成视频预览地址");
    }
    return generateThumbnailCandidatesFromRemoteSource({
      kind: "video",
      url: previewUrl,
      mime_type: file.mime_type
    }, file.file_name);
  }

  return generateThumbnailCandidatesFromRemoteSource({
    kind: "image",
    url: file.file_path,
    mime_type: file.mime_type
  }, file.file_name);
}

function thumbnailSourceKindForFile(file: FileItem): "image" | "video" | null {
  const mimeType = file.mime_type.toLowerCase();
  const fileName = file.file_name.toLowerCase();

  if (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") {
    return "image";
  }

  if (
    file.storage_backend === "hls_package" ||
    mimeType.startsWith("video/") ||
    /\.(mp4|m4v|mov|webm|ogv|m3u8)$/i.test(fileName)
  ) {
    return "video";
  }

  if (/\.(jpg|jpeg|png|webp|gif|bmp|avif)$/i.test(fileName)) {
    return "image";
  }

  return null;
}

function formatCaptureTime(value: number | null | undefined): string {
  if (value === null) return "当前帧";
  if (!Number.isFinite(value) || value === undefined) return "";
  const totalSeconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function parseRemoteThumbnailInput(input: string): { url: string; headers?: SourceRequestHeaders; summary: string } {
  const text = input.trim();
  if (!text) {
    throw new Error("请输入缩略图 URL 或 cURL 命令");
  }

  if (/^(?:[$>]\s*)?curl(?:\.exe)?\b/i.test(text)) {
    const parsed = parseCurlCommand(text);
    const headers = normalizeCurlHeaders(parsed.headers);
    const headerCount = headers ? Object.keys(headers).length : 0;
    const warningText = parsed.warnings.length > 0 ? `；${parsed.warnings.slice(0, 2).join("；")}` : "";

    return {
      url: parsed.url,
      ...(headers ? { headers } : {}),
      summary: headerCount > 0
        ? `已解析缩略图 URL 和 ${headerCount} 个请求头${warningText}`
        : `已解析缩略图 URL${warningText}`
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

function normalizeCurlHeaders(headers: Record<string, string>): SourceRequestHeaders | undefined {
  const result: SourceRequestHeaders = {};

  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.trim().toLowerCase();
    const normalizedValue = value.trim();
    if (!normalizedName || !normalizedValue || isBlockedHeader(normalizedName)) {
      continue;
    }
    result[normalizedName] = normalizedValue;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function isBlockedHeader(name: string): boolean {
  return [
    "host",
    "range",
    "content-length",
    "connection",
    "accept-encoding",
    "transfer-encoding",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip"
  ].includes(name);
}
