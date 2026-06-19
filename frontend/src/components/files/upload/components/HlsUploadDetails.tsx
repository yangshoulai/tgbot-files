import { memo, type ReactNode } from "react";
import { cn } from "../../../../lib/cn";
import { formatHlsDuration, hlsVariantLabel } from "../hls-helpers";
import type { HlsUrlState } from "../types";

export function HlsMetaPill({
  children,
  title,
  tone = "neutral"
}: {
  children: ReactNode;
  title?: string;
  tone?: "neutral" | "strong" | "success";
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 max-w-full shrink-0 items-center rounded-full px-1.5 font-medium",
        tone === "neutral" && "bg-background text-muted ring-1 ring-border",
        tone === "strong" && "bg-primary-soft text-primary-strong",
        tone === "success" && "bg-success-soft text-success"
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

export const HlsUploadDetails = memo(function HlsUploadDetails({
  hls,
  disabled,
  onVariantChange
}: {
  hls: HlsUrlState;
  disabled: boolean;
  onVariantChange: (variantId: string) => void;
}) {
  const probe = hls.probe;
  if (!probe) {
    return null;
  }

  const selectedVariant = probe.variants.find((variant) => variant.id === hls.variantId || variant.id === probe.selected_variant_id);
  const media = probe.media;

  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted">
      <HlsMetaPill tone="strong">HLS</HlsMetaPill>
      <HlsMetaPill>{probe.kind === "master" ? "master playlist" : "media playlist"}</HlsMetaPill>
      {media ? (
        <>
          <HlsMetaPill>{media.segment_count} 个片段</HlsMetaPill>
          <HlsMetaPill>{formatHlsDuration(media.duration)}</HlsMetaPill>
          <HlsMetaPill>target {media.target_duration}s</HlsMetaPill>
        </>
      ) : (
        <HlsMetaPill>{probe.variants.length} 个 variant</HlsMetaPill>
      )}
      {hls.previewPlaylistUrl ? (
        <HlsMetaPill tone="success">临时预览已就绪</HlsMetaPill>
      ) : null}
      {selectedVariant ? (
        <HlsMetaPill title={selectedVariant.uri}>{hlsVariantLabel(selectedVariant)}</HlsMetaPill>
      ) : null}
      {probe.kind === "master" ? (
        <select
          value={hls.variantId ?? probe.selected_variant_id ?? ""}
          disabled={disabled}
          className="h-7 max-w-full shrink-0 rounded-md border border-border bg-background px-2 text-[11px] text-foreground outline-none transition-colors focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-ring)] disabled:opacity-60"
          onChange={(event) => onVariantChange(event.target.value)}
        >
          <option value="">选择 variant</option>
          {probe.variants.map((variant) => (
            <option key={variant.id} value={variant.id}>
              {hlsVariantLabel(variant)}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}, hlsUploadDetailsPropsEqual);

function hlsUploadDetailsPropsEqual(
  previous: { hls: HlsUrlState; disabled: boolean },
  next: { hls: HlsUrlState; disabled: boolean }
): boolean {
  return previous.hls === next.hls && previous.disabled === next.disabled;
}
