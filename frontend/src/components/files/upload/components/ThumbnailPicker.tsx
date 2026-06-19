import { type ReactNode } from "react";
import { ImageOff, ImagePlus, Link2 } from "lucide-react";
import { Spinner } from "../../../ui/Spinner";
import { cn } from "../../../../lib/cn";
import type { UploadThumbnailState } from "../types";

export function UploadThumbnailVisual({
  thumbnail,
  fallback
}: {
  thumbnail?: UploadThumbnailState;
  fallback: ReactNode;
}) {
  if (thumbnail?.status === "ready" && thumbnail.generated) {
    return (
      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-background ring-1 ring-border">
        <img
          src={thumbnail.generated.objectUrl}
          alt="缩略图"
          className="h-full w-full object-cover"
        />
      </span>
    );
  }

  if (thumbnail?.status === "ready" && thumbnail.remote) {
    return (
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-strong ring-1 ring-primary/15">
        <Link2 size={16} />
      </span>
    );
  }

  if (thumbnail?.status === "generating") {
    return (
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-strong ring-1 ring-primary/15">
        <Spinner size={16} />
      </span>
    );
  }

  return <>{fallback}</>;
}

export function ThumbnailPicker({
  disabled,
  onChange,
  onUrl,
  onRemove,
  hasThumbnail
}: {
  disabled: boolean;
  onChange: (file: File) => void;
  onUrl: () => void;
  onRemove: () => void;
  hasThumbnail: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <label
        className={cn(
          "grid size-6 cursor-pointer place-items-center rounded-md text-subtle transition-colors hover:bg-primary-soft hover:text-primary-strong",
          disabled && "pointer-events-none opacity-40"
        )}
        title={hasThumbnail ? "更换缩略图" : "选择缩略图"}
      >
        <ImagePlus size={13} />
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onChange(file);
            event.currentTarget.value = "";
          }}
        />
      </label>
      <button
        type="button"
        className="grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-primary-soft hover:text-primary-strong disabled:pointer-events-none disabled:opacity-40"
        disabled={disabled}
        title={hasThumbnail ? "从 URL 更换缩略图" : "从 URL 选择缩略图"}
        onClick={onUrl}
      >
        <Link2 size={13} />
      </button>
      {hasThumbnail ? (
        <button
          type="button"
          className="grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
          disabled={disabled}
          title="移除缩略图"
          onClick={onRemove}
        >
          <ImageOff size={13} />
        </button>
      ) : null}
    </span>
  );
}

export function thumbnailHint(thumbnail: UploadThumbnailState | undefined): string | undefined {
  if (!thumbnail) return undefined;

  switch (thumbnail.status) {
    case "generating":
      return thumbnail.message || "正在生成缩略图";
    case "ready":
      if (thumbnail.remote) return "URL 缩略图";
      return thumbnail.generated?.source === "manual" ? "手动缩略图" : "已生成缩略图";
    case "failed":
      return thumbnail.message || "缩略图失败";
    case "removed":
      return "不使用缩略图";
    default:
      return undefined;
  }
}
