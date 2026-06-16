import type { FileItem } from "../../../api";

export interface PreviewComponentProps {
  file: FileItem;
  fullscreen: boolean;
  previewUrl?: string;
}

export interface TextPreviewState {
  status: "idle" | "loading" | "ready" | "error";
  content: string;
  message?: string;
}
