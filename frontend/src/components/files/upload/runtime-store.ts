import { DEFAULT_UPLOAD_CONCURRENCY } from "./constants";
import { uploadRuntimeStateEqual } from "./equality";
import type {
  ChunkProgress,
  QueueItem,
  UploadChunkState,
  UploadRuntimeState,
  UploadRuntimeStore
} from "./types";

export function createUploadRuntimeStore(initialState: UploadRuntimeState = {}): UploadRuntimeStore {
  let state = initialState;
  const listeners = new Set<() => void>();

  const notify = () => {
    listeners.forEach((listener) => listener());
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState: (updater) => {
      const next = updater(state);
      if (uploadRuntimeStateEqual(state, next)) {
        return state;
      }
      state = next;
      notify();
      return state;
    },
    reset: () => {
      if (uploadRuntimeStateEqual(state, {})) {
        return;
      }
      state = {};
      notify();
    }
  };
}

export function seedUploadRuntimeStore(
  store: UploadRuntimeStore,
  progress?: ChunkProgress | null,
  chunks?: UploadChunkState[] | null
): void {
  store.setState((current) => ({
    ...(progress === undefined && current.progress ? { progress: current.progress } : {}),
    ...(progress ? { progress } : {}),
    ...(chunks === undefined && current.chunks ? { chunks: current.chunks } : {}),
    ...(chunks ? { chunks } : {})
  }));
}

export function resetUploadRuntimeStore(store: UploadRuntimeStore | undefined): void {
  store?.reset();
}

export function localRuntimeSnapshot(items: QueueItem[]): Map<string, UploadRuntimeState> {
  return new Map(items.map((item) => [item.id, item.runtimeStore?.getSnapshot() ?? {}]));
}

export function normalizeUploadConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return DEFAULT_UPLOAD_CONCURRENCY;
  }
  return value;
}
