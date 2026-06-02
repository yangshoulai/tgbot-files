import { useEffect, useState } from "react";
import { FileTypeIcon } from "./FileTypeIcon";
import { fileKind } from "../../utils";
import { cn } from "../../lib/cn";

type Size = "sm" | "md" | "lg";

interface FileVisualProps {
  mimeType: string;
  fileName: string;
  url?: string;
  thumbnailUrl?: string | null;
  size?: Size;
  className?: string;
}

const sizes: Record<Size, string> = {
  sm: "size-10",
  md: "size-16",
  lg: "size-24"
};

const iconSizes: Record<Size, "sm" | "md" | "lg"> = {
  sm: "sm",
  md: "md",
  lg: "lg"
};

export function FileVisual({ mimeType, fileName, url, thumbnailUrl, size = "md", className }: FileVisualProps) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [thumbnailUrl, url]);

  const kind = fileKind({ mime_type: mimeType, file_name: fileName });
  const visualUrl = thumbnailUrl || (kind.tone === "image" ? url : undefined);
  const showImage = Boolean(visualUrl) && !imageFailed;

  return (
    <span
      className={cn(
        "relative inline-grid shrink-0 place-items-center overflow-hidden rounded-xl bg-background ring-1 ring-border",
        sizes[size],
        className
      )}
      aria-label={kind.label}
    >
      {showImage ? (
        <img
          src={visualUrl}
          alt={fileName}
          loading="lazy"
          onError={() => setImageFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <FileTypeIcon mimeType={mimeType} fileName={fileName} size={iconSizes[size]} className="rounded-none ring-0" />
      )}
    </span>
  );
}
