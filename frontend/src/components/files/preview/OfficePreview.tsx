import { ExternalLink, FileWarning } from "lucide-react";
import { hasFileLinkAccess } from "../../../lib/file-access";
import { Button } from "../../ui/Button";
import type { PreviewComponentProps } from "./types";
import { PreviewError } from "./PreviewFrame";

export function OfficePreview({ file, fullscreen }: PreviewComponentProps) {
  const linkFile = hasFileLinkAccess(file) ? file : null;

  if (!linkFile) {
    return <PreviewError message="该 Office 文件不提供完整访问链接，无法直接预览" />;
  }

  const absoluteUrl = absoluteFileUrl(file.file_path);
  const canUseOnlineViewer = absoluteUrl && isPublicHttpUrl(absoluteUrl);

  if (!absoluteUrl || !canUseOnlineViewer) {
    return (
      <OfficeUnavailable
        fileName={file.file_name}
        reason={
          absoluteUrl
            ? "Office 在线预览需要公网可访问的 HTTPS/HTTP 签名链接；当前访问地址是本地或内网地址。"
            : "当前浏览器无法生成此文件的绝对访问链接。"
        }
      />
    );
  }

  const viewerUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(absoluteUrl)}`;
  return (
    <div className={fullscreen ? "h-full min-w-0 w-full bg-background" : "h-[min(76dvh,820px)] max-h-[calc(92dvh-12rem)] min-h-96 min-w-0 w-full bg-background"}>
      <iframe
        title={`Office 预览 ${file.file_name}`}
        src={viewerUrl}
        className="h-full w-full border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}

function OfficeUnavailable({ fileName, reason }: { fileName: string; reason: string }) {
  return (
    <div className="grid w-full place-items-center px-6 py-16 text-center">
      <div className="max-w-lg rounded-2xl border border-border bg-background px-6 py-5 shadow-card">
        <span className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-warning-soft text-warning">
          <FileWarning size={20} />
        </span>
        <p className="text-sm font-semibold text-foreground">Office 在线预览暂不可用</p>
        <p className="mt-2 text-xs leading-5 text-muted">
          {fileName} · {reason}
        </p>
        <div className="mt-4 flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<ExternalLink size={14} />}
            onClick={() => window.open("https://www.microsoft.com/zh-cn/microsoft-365/free-office-online-for-the-web", "_blank", "noopener,noreferrer")}
          >
            查看 Office 在线预览说明
          </Button>
        </div>
      </div>
    </div>
  );
}

function absoluteFileUrl(path: string): string | undefined {
  try {
    return new URL(path, window.location.origin).toString();
  } catch {
    return undefined;
  }
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const hostname = url.hostname.toLowerCase();
    return hostname !== "localhost" &&
      hostname !== "127.0.0.1" &&
      hostname !== "0.0.0.0" &&
      hostname !== "::1" &&
      !hostname.endsWith(".local");
  } catch {
    return false;
  }
}
