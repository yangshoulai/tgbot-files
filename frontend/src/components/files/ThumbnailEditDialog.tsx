import { ChangeEvent, useEffect, useState } from "react";
import { Check, ImageOff, ImagePlus, Link2 } from "lucide-react";
import {
  ApiError,
  clearFileThumbnail,
  updateFileThumbnail,
  type FileItem,
  type SourceRequestHeaders
} from "../../api";
import { parseCurlCommand } from "../../lib/curl";
import { useToast } from "../../lib/toast";
import {
  generateThumbnailFromFile,
  revokeThumbnail,
  type GeneratedThumbnail
} from "../../lib/thumbnail";
import { formatBytes } from "../../utils";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Textarea } from "../ui/Textarea";
import { Spinner } from "../ui/Spinner";
import { Segmented } from "../ui/Segmented";

type ThumbnailInputMode = "local" | "url";

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
      return;
    }

    setMode("local");
    setUrlText("");
    setMessage(undefined);
    setError(undefined);
    setGenerated((current) => {
      revokeThumbnail(current);
      return undefined;
    });
  }, [file?.id]);

  function updateGenerated(next: GeneratedThumbnail | undefined) {
    setGenerated((current) => {
      revokeThumbnail(current);
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
      updateGenerated(thumbnail);
      setMessage(`已生成 ${thumbnail.width ?? "?"} × ${thumbnail.height ?? "?"} 缩略图，${formatBytes(thumbnail.blob.size)}`);
    } catch (thumbnailError) {
      updateGenerated(undefined);
      setError(errorMessage(thumbnailError));
      setMessage(undefined);
    } finally {
      setGenerating(false);
    }
  }

  async function saveLocalThumbnail() {
    if (!file || !generated) {
      setError("请先选择本地缩略图");
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

  const canSave = mode === "local" ? Boolean(generated) : Boolean(urlText.trim());

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
            onClick={() => void (mode === "local" ? saveLocalThumbnail() : saveUrlThumbnail())}
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
            { value: "local", label: "本地图片", icon: <ImagePlus size={15} /> },
            { value: "url", label: "URL / cURL", icon: <Link2 size={15} /> }
          ]}
        />

        <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <div className="grid aspect-video place-items-center overflow-hidden rounded-xl border border-border bg-background">
            {generated ? (
              <img src={generated.objectUrl} alt="新缩略图预览" className="h-full w-full object-cover" />
            ) : file?.thumbnail_url ? (
              <img src={file.thumbnail_url} alt="当前缩略图" className="h-full w-full object-cover" />
            ) : (
              <span className="flex flex-col items-center gap-1 text-xs text-subtle">
                {generating ? <Spinner size={18} /> : <ImagePlus size={20} />}
                {generating ? "生成中" : "无缩略图"}
              </span>
            )}
          </div>

          {mode === "local" ? (
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
        {error ? (
          <div className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm leading-6 text-danger">
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
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
