import {
  type MagnetFileUploadOption,
  type MagnetImport,
  type MagnetImportFile
} from "../../../api";
import { formatBytes } from "../../../utils";
import type { MagnetFileDecision } from "./types";
import { normalizedFileNameOverride } from "./filename-conflict";
import { joinDirectoryPath } from "./dropped-files";

export function effectiveMagnetFileName(file: MagnetImportFile, decision: MagnetFileDecision | undefined): string {
  return normalizedFileNameOverride(decision?.fileNameOverride) ?? file.file_name;
}

export function magnetTargetDirectoryPath(baseDirectoryPath: string, file: MagnetImportFile): string {
  return joinDirectoryPath(baseDirectoryPath, file.relative_directory_path ?? undefined);
}

export function magnetFileNameOverrideValue(file: MagnetImportFile, value: string): string | undefined {
  if (value.trim().length === 0) {
    return value;
  }

  return value.trim() === file.file_name ? undefined : value;
}

export function resetMagnetDecisionsForDirectoryChange(
  decisions: Record<number, MagnetFileDecision> | undefined
): Record<number, MagnetFileDecision> | undefined {
  if (!decisions) {
    return undefined;
  }

  const next: Record<number, MagnetFileDecision> = {};
  for (const [key, decision] of Object.entries(decisions)) {
    const { conflict: _conflict, conflictAction: _conflictAction, editingFileName: _editingFileName, ...rest } = decision;
    if (Object.keys(rest).length > 0) {
      next[Number(key)] = rest;
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function magnetFileUploadOptions(
  magnet: MagnetImport,
  selectedIndexes: number[],
  decisions: Record<number, MagnetFileDecision>
): MagnetFileUploadOption[] {
  const selected = new Set(selectedIndexes);
  return magnet.files
    .filter((file) => selected.has(file.file_index))
    .map((file) => {
      const decision = decisions[file.file_index];
      const fileName = effectiveMagnetFileName(file, decision);
      return {
        file_index: file.file_index,
        ...(fileName !== file.file_name ? { file_name: fileName } : {}),
        ...(decision?.conflictAction === "overwrite" ? { on_conflict: "overwrite" as const } : {})
      };
    });
}

export function isLikelyMagnetUrl(value: string): boolean {
  return value.trim().toLowerCase().startsWith("magnet:?");
}

export function defaultMagnetSelectedIndexes(files: MagnetImportFile[], maxMultipartBytes: number): number[] {
  return files
    .filter((file) => file.size > 0 && file.size <= maxMultipartBytes)
    .map((file) => file.file_index)
    .sort((left, right) => left - right);
}

export function selectedMagnetIndexesForResume(magnet: MagnetImport, maxMultipartBytes: number): number[] {
  const selected = magnet.files
    .filter((file) => file.selected && file.size > 0 && file.size <= maxMultipartBytes)
    .map((file) => file.file_index)
    .sort((left, right) => left - right);

  return selected.length > 0 ? selected : defaultMagnetSelectedIndexes(magnet.files, maxMultipartBytes);
}

export function magnetStatusLabel(status: MagnetImport["status"]): string {
  switch (status) {
    case "probing":
      return "解析中";
    case "ready":
      return "已解析";
    case "downloading":
      return "下载中";
    case "downloaded":
      return "已下载";
    case "importing":
      return "导入中";
    case "done":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

export function magnetStatusProgressLabel(label: string, magnet: MagnetImport, selectedCount?: number): string {
  const status = magnetStatusLabel(magnet.status);
  const fileCount = selectedCount ?? (magnet.file_count || magnet.files.length);
  const size = selectedCount === undefined && magnet.total_size ? ` · ${formatBytes(magnet.total_size)}` : "";
  const download = magnetDownloadProgressLabel(magnet);
  return `${label} · ${status}${download ? ` · ${download}` : ""}${fileCount > 0 ? ` · ${fileCount} 个文件${size}` : ""}`;
}

export function magnetDownloadProgressLabel(magnet: MagnetImport): string | null {
  const total = magnet.download_total_bytes;
  const completed = magnet.download_completed_bytes;
  if (
    typeof total !== "number" ||
    typeof completed !== "number" ||
    !Number.isFinite(total) ||
    !Number.isFinite(completed) ||
    total <= 0
  ) {
    return null;
  }

  const progress = typeof magnet.download_progress === "number"
    ? Math.min(100, Math.max(0, magnet.download_progress * 100))
    : Math.min(100, Math.max(0, (completed / total) * 100));
  const speed = magnet.download_speed_bytes_per_second && magnet.download_speed_bytes_per_second > 0
    ? ` · ${formatBytes(magnet.download_speed_bytes_per_second)}/s`
    : "";

  return `${formatBytes(completed)}/${formatBytes(total)} · ${progress >= 10 ? progress.toFixed(0) : progress.toFixed(1)}%${speed}`;
}

export function magnetImportStructureKey(magnet: MagnetImport): string {
  return JSON.stringify({
    status: magnet.status,
    error: magnet.error_message ?? "",
    aria2Status: magnet.aria2_status ?? "",
    totalBytes: magnet.download_total_bytes ?? 0,
    metadataCompletedAt: magnet.metadata_completed_at ?? "",
    downloadStartedAt: magnet.download_started_at ?? "",
    downloadCompletedAt: magnet.download_completed_at ?? "",
    completedAt: magnet.completed_at ?? "",
    fileCount: magnet.file_count,
    totalSize: magnet.total_size ?? 0,
    files: magnet.files.map((file) => [
      file.file_index,
      file.path,
      file.file_name,
      file.relative_directory_path ?? "",
      file.size,
      file.mime_type,
      file.chunk_size,
      file.chunk_count,
      file.selected,
      file.status,
      file.upload_id ?? "",
      file.error_message ?? ""
    ])
  });
}

export function magnetImportStableUiKey(magnet: MagnetImport): string {
  return JSON.stringify({
    status: magnet.status,
    error: magnet.error_message ?? "",
    metadataCompletedAt: magnet.metadata_completed_at ?? "",
    downloadStartedAt: magnet.download_started_at ?? "",
    downloadCompletedAt: magnet.download_completed_at ?? "",
    completedAt: magnet.completed_at ?? "",
    fileCount: magnet.file_count,
    totalSize: magnet.total_size ?? 0,
    files: magnet.files.map((file) => [
      file.file_index,
      file.path,
      file.file_name,
      file.relative_directory_path ?? "",
      file.size,
      file.mime_type,
      file.chunk_size,
      file.chunk_count,
      file.selected,
      file.status,
      file.upload_id ?? "",
      file.error_message ?? ""
    ])
  });
}
