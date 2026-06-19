import type { MagnetUploadEntry } from "../../../lib/upload-tasks";
import type {
  ChunkProgress,
  MagnetUrlState,
  UploadChunkState,
  UploadRuntimeState
} from "./types";
import { magnetImportStructureKey } from "./magnet-helpers";

export function magnetStateEqual(left: MagnetUrlState | undefined, right: MagnetUrlState | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  const leftImportKey = left.import ? magnetImportStructureKey(left.import) : "";
  const rightImportKey = right.import ? magnetImportStructureKey(right.import) : "";
  return leftImportKey === rightImportKey &&
    numberArrayEqual(left.selectedIndexes, right.selectedIndexes) &&
    magnetUploadsEqual(left.uploads, right.uploads) &&
    left.fileDecisions === right.fileDecisions;
}

export function mergeMagnetState(current: MagnetUrlState | undefined, next: MagnetUrlState): MagnetUrlState {
  return magnetStateEqual(current, next) ? current! : next;
}

export function numberArrayEqual(left: number[] | undefined, right: number[] | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

export function magnetUploadsEqual(left: MagnetUploadEntry[] | undefined, right: MagnetUploadEntry[] | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const next = right[index];
    return entry.fileIndex === next.fileIndex &&
      entry.targetDirectoryPath === next.targetDirectoryPath &&
      entry.conflictAction === next.conflictAction &&
      entry.upload.id === next.upload.id &&
      entry.upload.file_name === next.upload.file_name &&
      entry.upload.size === next.upload.size &&
      entry.upload.chunk_size === next.upload.chunk_size &&
      entry.upload.chunk_count === next.upload.chunk_count &&
      entry.upload.direct_access === next.upload.direct_access;
  });
}

export function chunkProgressEqual(left: ChunkProgress | undefined, right: ChunkProgress | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }

  return left.completed === right.completed &&
    left.total === right.total &&
    left.label === right.label &&
    left.failed === right.failed;
}

export function uploadRuntimeStateEqual(left: UploadRuntimeState, right: UploadRuntimeState): boolean {
  return chunkProgressEqual(left.progress, right.progress) &&
    left.chunks === right.chunks;
}

export function uploadChunkStateEqual(left: UploadChunkState, right: UploadChunkState): boolean {
  return left.index === right.index &&
    left.size === right.size &&
    left.status === right.status &&
    left.attempts === right.attempts &&
    left.errorMessage === right.errorMessage;
}
