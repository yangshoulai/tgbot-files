import { Archive, File as FileIcon, FileText, Film, Image as ImageIcon, FileCode, Music2 } from "lucide-react";
import { fileKind } from "../../utils";
import { cn } from "../../lib/cn";

type Tone = "image" | "video" | "audio" | "pdf" | "text" | "archive" | "file";
type Size = "sm" | "md" | "lg";

interface FileTypeIconProps {
  mimeType: string;
  fileName: string;
  size?: Size;
  className?: string;
}

const palette: Record<Tone, { bg: string; fg: string; ring: string }> = {
  image: { bg: "bg-success-soft", fg: "text-success", ring: "ring-success/15" },
  video: { bg: "bg-primary-soft", fg: "text-primary-strong", ring: "ring-primary/15" },
  audio: { bg: "bg-info-soft", fg: "text-info", ring: "ring-info/15" },
  pdf: { bg: "bg-danger-soft", fg: "text-danger", ring: "ring-danger/15" },
  text: { bg: "bg-info-soft", fg: "text-info", ring: "ring-info/15" },
  archive: { bg: "bg-warning-soft", fg: "text-warning", ring: "ring-warning/15" },
  file: { bg: "bg-background", fg: "text-muted", ring: "ring-border" }
};

const sizes: Record<Size, { box: string; icon: number }> = {
  sm: { box: "size-9", icon: 16 },
  md: { box: "size-11", icon: 20 },
  lg: { box: "size-16", icon: 28 }
};

export function FileTypeIcon({ mimeType, fileName, size = "md", className }: FileTypeIconProps) {
  const kind = fileKind({ mime_type: mimeType, file_name: fileName });
  const tone: Tone = kind.tone;
  const colors = palette[tone];
  const sizing = sizes[size];

  const Icon =
    tone === "image"
      ? ImageIcon
      : tone === "video"
        ? Film
        : tone === "audio"
          ? Music2
          : tone === "pdf"
            ? FileText
            : tone === "text"
              ? FileCode
              : tone === "archive"
                ? Archive
                : FileIcon;

  return (
    <span
      className={cn(
        "inline-grid place-items-center rounded-xl ring-1",
        colors.bg,
        colors.fg,
        colors.ring,
        sizing.box,
        className
      )}
      aria-label={kind.label}
    >
      <Icon size={sizing.icon} />
    </span>
  );
}
