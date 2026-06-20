const CACHE_NAME = "tgbot-files-video-preview-v1";
const DB_NAME = "tgbot-files-video-preview-cache";
const STORE_NAME = "chunks";
const DB_VERSION = 2;
const FILE_RECORD_CACHE_KEY_PREFIX = `${self.location.origin}/__preview-cache/file-records/`;
const DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const RESPONSE_WINDOW_BYTES = 2 * 1024 * 1024;
const DEFAULT_PREVIEW_PREFETCH_CONCURRENCY = 5;
const MAX_PREVIEW_PREFETCH_CONCURRENCY = 32;
const MAX_MANUAL_FILE_CACHE_SESSIONS = 5;
const MAX_MANUAL_FILE_CACHE_WORKERS = 5;
const CHUNK_FETCH_MAX_ATTEMPTS = 3;
const CHUNK_FETCH_RETRY_BASE_DELAY_MS = 800;
const CHUNK_FETCH_RETRY_MAX_DELAY_MS = 8_000;
const CACHE_STORAGE_METADATA_SNAPSHOT_TTL_MS = 5_000;
const CONTINUOUS_PREFETCH_SESSION_TTL_MS = 12_000;
const CONTINUOUS_PREFETCH_RETRY_DELAY_MS = 3_000;
const HOT_CHUNK_CACHE_MAX_BYTES = 160 * 1024 * 1024;
const fullChunkLoads = new Map();
const hlsPartLoads = new Map();
const continuousPrefetchSessions = new Map();
const hotChunkCache = new Map();
const hlsPreviewSources = new Map();
const hlsPreviewCacheSessions = new Map();
const fileCacheSessions = new Map();
const previewFileCacheSessions = new Map();
let cacheStorageMetadataSnapshot = null;
let cacheStorageMetadataSnapshotAt = 0;
let cacheStorageMetadataSnapshotPromise = null;
let cacheStorageMetadataRebuildPromise = null;
let hotChunkCacheBytes = 0;
let manualFileCacheRehydration = null;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    void cleanupPreviewCache().catch((error) => {
      warnPreviewCacheError("cleanup on activate", error);
    });
    void ensureManualFileCacheRehydrated();
    scheduleCacheStorageMetadataRebuild();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (event.data?.type === "CLAIM_CLIENTS") {
    // 页面已注册但没有被接管（首次安装 / 硬刷新）时，由页面请求立即接管。
    event.waitUntil(self.clients.claim());
    return;
  }

  if (event.data?.type === "VIDEO_PREVIEW_CACHE_START") {
    const metadata = normalizePreviewMetadata(event.data.metadata);
    const sessionId = normalizeSessionId(event.data.sessionId);
    if (metadata && sessionId) {
      event.waitUntil(
        metadata.kind === "hls"
          ? startHlsPreviewCacheSession(sessionId, metadata)
          : startContinuousPreviewCache(sessionId, metadata)
      );
    }
    return;
  }

  if (event.data?.type === "VIDEO_PREVIEW_CACHE_STOP") {
    const sessionId = normalizeSessionId(event.data.sessionId);
    if (sessionId) {
      stopContinuousPreviewCache(sessionId);
      stopHlsPreviewCacheSession(sessionId);
    }
    return;
  }

  if (event.data?.type === "VIDEO_PREVIEW_PLAYBACK_PROGRESS") {
    const metadata = normalizePreviewMetadata(event.data.metadata);
    const sessionId = normalizeSessionId(event.data.sessionId);
    const progress = normalizePlaybackProgress(event.data.progress);
    if (metadata && sessionId && progress) {
      event.waitUntil(updatePreviewCachePlaybackPriority(sessionId, metadata, progress));
    }
    return;
  }

  if (event.data?.type === "VIDEO_PREVIEW_CACHE_STATE_REQUEST") {
    const metadata = normalizePreviewMetadata(event.data.metadata);
    const requestId = normalizeRequestId(event.data.requestId);
    if (metadata && requestId) {
      event.waitUntil(replyPreviewCacheState(event, requestId, metadata));
    }
    return;
  }

  if (typeof event.data?.type === "string" && event.data.type.startsWith("FILE_CACHE_")) {
    const requestId = normalizeRequestId(event.data.requestId);
    if (requestId) {
      event.waitUntil(handleFileCacheMessage(event, requestId));
    }
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith("/__video-preview/hls-part/")) {
    event.respondWith(handleHlsPartRequest(event.request, event));
    return;
  }

  if (url.pathname.startsWith("/__file-cache/")) {
    event.respondWith(handleFileCacheRequest(event.request, event));
    return;
  }

  if (!url.pathname.startsWith("/__video-preview/")) {
    return;
  }

  event.respondWith(handleVideoPreviewRequest(event.request, event));
});

async function handleVideoPreviewRequest(request, event) {
  const metadata = parsePreviewMetadata(new URL(request.url));
  if (!metadata) {
    return new Response("Invalid video preview metadata", { status: 400 });
  }

  if (metadata.kind === "hls") {
    return handleHlsPlaylistRequest(metadata, event);
  }

  const range = parseRange(request.headers.get("Range"), metadata.size, metadata.chunkSize);
  if (!range) {
    return rangeNotSatisfiable(metadata.size);
  }

  try {
    const body = await createRangeStream(metadata, range);
    const firstChunk = Math.floor(range.start / metadata.chunkSize);
    const endChunk = Math.floor(range.end / metadata.chunkSize);
    event.waitUntil(prioritizeContinuousPreviewCache(metadata, firstChunk));
    event.waitUntil(prefetchChunks(metadata, endChunk + 1, metadata.prefetchConcurrency));

    return new Response(body, {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Type": metadata.mimeType || "application/octet-stream",
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${metadata.size}`,
        "X-Preview-Cache": "chunked"
      }
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Video preview failed", {
      status: 502,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }
}

async function handleHlsPlaylistRequest(metadata, event) {
  // 优先用已缓存的 m3u8：已缓存的 HLS 无需联网拉取播放列表即可立即起播，
  // 避免源站（Telegram 签名链接）慢/抖动时卡在"视频加载中"。
  const cachedText = await readCachedHlsPlaylistText(metadata.fileId);
  if (cachedText) {
    const rewritten = rewriteHlsPlaylist(cachedText, metadata);
    hlsPreviewSources.set(metadata.fileId, rewritten.sources);
    event.waitUntil(prioritizeHlsPreviewCache(metadata.fileId, 0, metadata.cacheMaxBytes, metadata.prefetchConcurrency));
    return new Response(rewritten.text, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        "X-Preview-Cache": "hls-playlist-cache"
      }
    });
  }

  const response = await fetch(metadata.sourceUrl, { credentials: "omit" });
  if (!response.ok) {
    return new Response(`HLS playlist load failed (${response.status})`, { status: 502 });
  }

  const playlistText = await response.text();
  // 若该文件已被手动缓存（分片在册但 m3u8 还没持久化，例如旧版本缓存的），
  // 顺带把 m3u8 存下来，让历史手动缓存下次也能秒开；清理同样走 deleteFileCache。
  const existingEntry = await readFileCacheEntry(metadata.fileId).catch(() => null);
  if (existingEntry?.cacheSource === "manual") {
    event.waitUntil(writeCachedHlsPlaylistText(metadata.fileId, playlistText));
  }
  const rewritten = rewriteHlsPlaylist(playlistText, metadata);
  hlsPreviewSources.set(metadata.fileId, rewritten.sources);
  event.waitUntil(prioritizeHlsPreviewCache(metadata.fileId, 0, metadata.cacheMaxBytes, metadata.prefetchConcurrency));

  return new Response(rewritten.text, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
      "X-Preview-Cache": "hls-playlist"
    }
  });
}

async function handleHlsPartRequest(request, event) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const fileId = parts[2];
  const partKind = parts[3] === "init" ? "init" : "segment";
  const partIndex = Number(parts[4] || "0");
  const sourceUrl = normalizeSameOriginSourceUrl(url.searchParams.get("source"));
  const fullSourceUrl = normalizeSameOriginSourceUrl(url.searchParams.get("full_source"));
  const cacheMaxBytes = normalizeCacheMaxBytes(url.searchParams.get("cache_max"));
  const prefetchConcurrency = normalizePreviewPrefetchConcurrency(url.searchParams.get("prefetch_concurrency"));
  const metadata = normalizeFileCacheMetadata({
    kind: "hls",
    fileId,
    fileName: url.searchParams.get("file_name") || fileId,
    directoryPath: normalizeDirectoryPath(url.searchParams.get("directory_path")),
    mimeType: url.searchParams.get("mime") || "application/vnd.apple.mpegurl",
    sourceUrl,
    size: Number(url.searchParams.get("size")),
    chunkSize: Number(url.searchParams.get("chunk_size")),
    chunkCount: Number(url.searchParams.get("chunk_count")),
    cacheMaxBytes,
    cacheSource: normalizeCacheSource(url.searchParams.get("cache_source"))
  });

  if (!fileId || !Number.isSafeInteger(partIndex) || partIndex < 0 || !sourceUrl) {
    return new Response("Invalid HLS preview part", { status: 400 });
  }

  try {
    const range = parseRange(request.headers.get("Range"), Number(url.searchParams.get("full_size")) || Number(url.searchParams.get("chunk_size")) || 1, Number(url.searchParams.get("full_size")) || Number(url.searchParams.get("chunk_size")) || 1);
    if (partKind === "segment" && range && fullSourceUrl) {
      const cachedFullPart = await (await caches.open(CACHE_NAME)).match(hlsPartCacheKey(fileId, partKind, partIndex));
      if (cachedFullPart) {
        const bytes = await cachedFullPart.arrayBuffer();
        const slice = bytes.slice(range.start, range.end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
            "Content-Type": cachedFullPart.headers.get("Content-Type") || "application/octet-stream",
            "Content-Length": String(slice.byteLength),
            "Content-Range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
            "X-Preview-Cache": "hls-segment-range"
          }
        });
      }

      const fallback = await fetch(sourceUrl, { credentials: "omit" });
      if (!fallback.ok) {
        throw new Error(`HLS ${partKind} ${partIndex} preview load failed (HTTP ${fallback.status})`);
      }
      return new Response(fallback.body || await fallback.arrayBuffer(), {
        status: fallback.status,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": fallback.headers.get("Content-Type") || "application/octet-stream",
          "Content-Length": fallback.headers.get("Content-Length") || String(Number(url.searchParams.get("chunk_size")) || 0),
          "X-Preview-Cache": "hls-segment-range-miss"
        }
      });
    }

    const response = await fetchAndCacheHlsPart({ fileId, partKind, partIndex, sourceUrl, cacheMaxBytes, metadata });
    if (partKind === "segment") {
      event.waitUntil(prioritizeHlsPreviewCache(fileId, partIndex, cacheMaxBytes, prefetchConcurrency));
      event.waitUntil(prefetchHlsSegments(fileId, partIndex + 1, prefetchConcurrency, cacheMaxBytes));
    }
    return response;
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "HLS preview segment failed", {
      status: 502,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }
}

async function handleFileCacheRequest(request, event) {
  const metadata = parseFileCacheMetadata(new URL(request.url));
  if (!metadata) {
    return new Response("Invalid file cache metadata", { status: 400 });
  }

  const rangeHeader = request.headers.get("Range");
  const range = rangeHeader ? parseRange(rangeHeader, metadata.size, metadata.chunkSize) : null;
  const responseRange = range || {
    start: 0,
    end: metadata.size - 1
  };

  try {
    event.waitUntil(putFileRecordMetadata(metadata, { keepFileRecord: true }));
    const body = await createRangeStream(metadata, responseRange);
    const firstChunk = Math.floor(responseRange.start / metadata.chunkSize);
    const endChunk = Math.floor(responseRange.end / metadata.chunkSize);
    event.waitUntil(prefetchChunks(metadata, endChunk + 1, Math.min(metadata.prefetchConcurrency || 1, 3)));

    const headers = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Type": metadata.mimeType || "application/octet-stream",
      "Content-Length": String(responseRange.end - responseRange.start + 1),
      "X-File-Cache": "chunked"
    };

    if (range) {
      headers["Content-Range"] = `bytes ${responseRange.start}-${responseRange.end}/${metadata.size}`;
    }

    event.waitUntil(updateFileCacheAccess(metadata, firstChunk));

    return new Response(body, {
      status: range ? 206 : 200,
      headers
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "File cache proxy failed", {
      status: 502,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }
}

async function handleFileCacheMessage(event, requestId) {
  try {
    // SW 冷启动（被浏览器终止后被消息唤醒）不会触发 activate，
    // 在这里兜底恢复进行中的手动缓存任务。
    await ensureManualFileCacheRehydrated();
    let result = null;

    if (event.data.type === "FILE_CACHE_CACHE_FILE") {
      const metadata = normalizeFileCacheMetadata(event.data.metadata);
      if (!metadata) throw new Error("文件缓存参数无效");
      result = await cacheWholeFile(metadata);
    } else if (event.data.type === "FILE_CACHE_START_PREVIEW") {
      const metadata = normalizeFileCacheMetadata(event.data.metadata);
      const sessionId = normalizeSessionId(event.data.sessionId);
      if (!metadata || !sessionId) throw new Error("文件预览缓存参数无效");
      await startPreviewFileCacheSession(sessionId, metadata);
      result = await readFileCacheSummary();
    } else if (event.data.type === "FILE_CACHE_STOP_PREVIEW") {
      const sessionId = normalizeSessionId(event.data.sessionId);
      if (!sessionId) throw new Error("文件预览缓存会话无效");
      await stopPreviewFileCacheSession(sessionId);
      result = await readFileCacheSummary();
    } else if (event.data.type === "FILE_CACHE_PAUSE_FILE") {
      await pauseFileCacheSession(normalizeFileId(event.data.fileId));
      result = await readFileCacheSummary();
    } else if (event.data.type === "FILE_CACHE_RESUME_FILE") {
      await resumeFileCacheSession(normalizeFileId(event.data.fileId), normalizeFileCacheMetadata(event.data.metadata));
      result = await readFileCacheSummary();
    } else if (event.data.type === "FILE_CACHE_TERMINATE_FILE") {
      await terminateFileCacheSession(normalizeFileId(event.data.fileId));
      result = await readFileCacheSummary();
    } else if (event.data.type === "FILE_CACHE_STATE_REQUEST") {
      const metadata = normalizeFileCacheMetadata(event.data.metadata);
      if (!metadata) throw new Error("文件缓存参数无效");
      result = await readFileCacheEntry(metadata.fileId);
    } else if (event.data.type === "FILE_CACHE_LIST_REQUEST") {
      result = await readFileCacheSummary();
    } else if (event.data.type === "FILE_CACHE_CLEAR_FILE") {
      await terminateFileCacheSession(normalizeFileId(event.data.fileId));
      result = await readFileCacheSummary();
    } else if (event.data.type === "FILE_CACHE_CLEAR_FILES") {
      const fileIds = Array.isArray(event.data.fileIds) ? event.data.fileIds.map(normalizeFileId).filter(Boolean) : [];
      for (const fileId of fileIds) {
        await terminateFileCacheSession(fileId);
      }
      result = await readFileCacheSummary();
    } else if (event.data.type === "FILE_CACHE_CLEAR_AUTO") {
      await clearAutomaticCacheEntries();
      result = await readFileCacheSummary();
    } else {
      throw new Error("未知文件缓存请求");
    }

    postFileCacheResponse(event, { type: "FILE_CACHE_RESPONSE", requestId, result });
  } catch (error) {
    postFileCacheResponse(event, {
      type: "FILE_CACHE_RESPONSE",
      requestId,
      error: error instanceof Error ? error.message : "文件缓存请求失败"
    });
  }
}

function postFileCacheResponse(event, response) {
  const port = event.ports?.[0];
  if (port) {
    port.postMessage(response);
    return;
  }

  event.source?.postMessage(response);
}

async function cacheWholeFile(metadata) {
  const manualMetadata = {
    ...metadata,
    cacheSource: "manual",
    cacheMaxBytes: Number.MAX_SAFE_INTEGER
  };

  const existing = fileCacheSessions.get(manualMetadata.fileId);
  if (existing?.status === "caching") {
    return readFileCacheSummary();
  }
  if (existing?.status === "paused" || existing?.status === "waiting") {
    await resumeFileCacheSession(manualMetadata.fileId, manualMetadata);
    return readFileCacheSummary();
  }

  const manualStartedAt = Date.now();
  const session = createManualFileCacheSession(manualMetadata, "waiting", manualStartedAt);
  fileCacheSessions.set(manualMetadata.fileId, session);
  await putFileRecordMetadata(session.metadata, { manualStartedAt, manualCacheStatus: "waiting" });
  await pumpManualFileCacheQueue();
  return readFileCacheSummary();
}

function createManualFileCacheSession(metadata, status, manualStartedAt) {
  const normalizedManualStartedAt = safeTime(manualStartedAt) || Date.now();
  const session = {
    fileId: metadata.fileId,
    metadata: {
      ...metadata,
      manualStartedAt: normalizedManualStartedAt,
      ...(status === "waiting" || status === "paused" ? { manualCacheStatus: status } : {})
    },
    status,
    manualStartedAt: normalizedManualStartedAt,
    controller: null,
    promise: null
  };
  return session;
}

async function startPreviewFileCacheSession(sessionId, metadata) {
  const existing = previewFileCacheSessions.get(sessionId);
  const normalizedMetadata = {
    ...metadata,
    cacheSource: "auto",
    cacheMaxBytes: metadata.cacheMaxBytes || DEFAULT_MAX_CACHE_BYTES
  };
  const metadataKey = fileCacheMetadataKey(normalizedMetadata);

  if (existing && existing.metadataKey === metadataKey) {
    existing.lastHeartbeat = Date.now();
    if (existing.status === "caching") {
      return;
    }
  } else if (existing) {
    await stopPreviewFileCacheSession(sessionId);
  }

  const manualSession = fileCacheSessions.get(normalizedMetadata.fileId);
  if (manualSession && (manualSession.status === "caching" || manualSession.status === "waiting")) {
    await putFileRecordMetadata({ ...normalizedMetadata, cacheSource: "manual" }, {
      manualStartedAt: manualSession.manualStartedAt,
      manualCacheStatus: manualSession.status
    });
    return;
  }

  const existingEntry = await readFileCacheEntry(normalizedMetadata.fileId);
  if (existingEntry?.cacheSource === "manual") {
    return;
  }

  const session = {
    sessionId,
    metadata: normalizedMetadata,
    metadataKey,
    status: "caching",
    controller: new AbortController(),
    promise: null,
    lastHeartbeat: Date.now()
  };
  previewFileCacheSessions.set(sessionId, session);
  await putFileRecordMetadata(normalizedMetadata, { keepFileRecord: true });
  session.promise = runPreviewFileCacheSession(session)
    .catch((error) => {
      if (session.status !== "stopped") {
        warnPreviewCacheError(`preview cache ${session.metadata.fileId}`, error);
      }
    })
    .finally(() => {
      if (previewFileCacheSessions.get(sessionId) === session) {
        previewFileCacheSessions.delete(sessionId);
      }
      session.promise = null;
      session.controller = null;
    });
}

async function stopPreviewFileCacheSession(sessionId) {
  const session = previewFileCacheSessions.get(sessionId);
  if (!session) {
    return;
  }
  session.status = "stopped";
  session.controller?.abort();
  previewFileCacheSessions.delete(sessionId);
  await putFileRecordMetadata(session.metadata, { keepFileRecord: true });
}

async function runPreviewFileCacheSession(session) {
  const { metadata } = session;
  if (metadata.kind === "hls") {
    await cacheWholeHlsFile(metadata, session);
    return;
  }

  const queue = createPriorityChunkQueue(metadata.chunkCount, 0);
  await runConcurrentManualCacheWorkers(session, queue, async (chunkIndex) => {
    throwIfPreviewFileCacheStopped(session);
    if (await getCachedChunkResponse(metadata, chunkIndex)) {
      return;
    }
    await getChunkBytes(metadata, chunkIndex, session.controller.signal);
  });
}

function throwIfPreviewFileCacheStopped(session) {
  if (session.status !== "caching" || session.controller.signal.aborted) {
    throw new DOMException("文件预览缓存已停止", "AbortError");
  }
}

function fileCacheMetadataKey(metadata) {
  return [
    metadata.kind,
    metadata.fileId,
    metadata.size,
    metadata.chunkSize,
    metadata.chunkCount,
    metadata.sourceUrl || "",
    metadata.token || ""
  ].join(":");
}

async function runManualFileCacheSession(session) {
  const { metadata } = session;
  await putFileRecordMetadata(metadata, { manualStartedAt: session.manualStartedAt, manualCacheStatus: "caching" });
  if (metadata.kind === "hls") {
    await cacheWholeHlsFile(metadata, session);
    return;
  }

  const queue = createPriorityChunkQueue(metadata.chunkCount, 0);
  await runConcurrentManualCacheWorkers(session, queue, async (chunkIndex) => {
    throwIfFileCacheStopped(session);
    if (await getCachedChunkResponse(metadata, chunkIndex)) {
      await markChunkMetadataForManualCache(metadata, chunkIndex, expectedChunkSize(metadata, chunkIndex));
      return;
    }
    const bytes = await getChunkBytes(metadata, chunkIndex, session.controller.signal);
    await markChunkMetadataForManualCache(metadata, chunkIndex, bytes.byteLength || expectedChunkSize(metadata, chunkIndex));
  });
}

async function runConcurrentManualCacheWorkers(session, queue, loadNext) {
  const workerCount = Math.min(MAX_MANUAL_FILE_CACHE_WORKERS, Math.max(1, queue.length));

  async function runWorker() {
    while (queue.length > 0) {
      throwIfFileCacheStopped(session);
      const item = queue.shift();
      if (item === undefined) {
        continue;
      }
      try {
        await loadNext(item);
      } catch (error) {
        if (session.status === "caching") {
          session.controller?.abort();
        }
        throw error;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

// 每个 SW 实例只恢复一次进行中的手动缓存任务。SW 被浏览器终止后再被
// 事件唤醒（冷启动）时不会触发 activate，所以恢复必须能在任意入口惰性触发。
function ensureManualFileCacheRehydrated() {
  if (!manualFileCacheRehydration) {
    manualFileCacheRehydration = rehydrateManualFileCacheSessions().catch((error) => {
      // 恢复失败时清空 guard，下次事件可重试。
      manualFileCacheRehydration = null;
      warnPreviewCacheError("rehydrate manual cache sessions", error);
    });
  }
  return manualFileCacheRehydration;
}

async function rehydrateManualFileCacheSessions() {
  const summary = await readFileCacheSummary();
  // "waiting" = 排队中；"caching" = 上次被中断的进行中任务。两者都应继续，
  // 只有用户主动暂停的 "paused" 才保持停止。
  const resumableEntries = summary.entries
    .filter((entry) => (entry.manualCacheStatus === "waiting" || entry.manualCacheStatus === "caching") && !entry.complete)
    .sort((left, right) => safeTime(left.manualStartedAt) - safeTime(right.manualStartedAt));

  for (const entry of resumableEntries) {
    if (fileCacheSessions.has(entry.fileId)) {
      continue;
    }

    const metadata = normalizeFileCacheMetadata({
      kind: entry.kind,
      fileId: entry.fileId,
      fileName: entry.fileName,
      directoryPath: entry.directoryPath,
      mimeType: entry.mimeType,
      size: entry.size,
      chunkSize: entry.chunkSize,
      chunkCount: entry.chunkCount,
      sourceUrl: entry.sourceUrl,
      token: entry.token,
      cacheMaxBytes: Number.MAX_SAFE_INTEGER,
      cacheSource: "manual"
    });

    if (!metadata) {
      continue;
    }

    fileCacheSessions.set(entry.fileId, createManualFileCacheSession({
      ...metadata,
      manualCacheStatus: "waiting"
    }, "waiting", safeTime(entry.manualStartedAt) || Date.now()));
  }

  await pumpManualFileCacheQueue();
}

async function pumpManualFileCacheQueue() {
  const activeSessions = () => Array.from(fileCacheSessions.values())
    .filter((session) => session.status === "caching");

  while (activeSessions().length < MAX_MANUAL_FILE_CACHE_SESSIONS) {
    const nextSession = Array.from(fileCacheSessions.values())
      .filter((session) => session.status === "waiting")
      .sort((left, right) => safeTime(left.manualStartedAt) - safeTime(right.manualStartedAt))[0];

    if (!nextSession) {
      break;
    }

    await startManualFileCacheSession(nextSession);
  }
}

async function startManualFileCacheSession(session) {
  if (session.status !== "waiting" && session.status !== "paused") {
    return;
  }

  if (Array.from(fileCacheSessions.values()).filter((item) => item.status === "caching").length >= MAX_MANUAL_FILE_CACHE_SESSIONS) {
    return;
  }

  session.status = "caching";
  session.controller = new AbortController();
  session.metadata = {
    ...session.metadata,
    manualStartedAt: session.manualStartedAt,
    cacheSource: "manual",
    cacheMaxBytes: Number.MAX_SAFE_INTEGER,
    manualCacheStatus: "caching"
  };
  await putFileRecordMetadata(session.metadata, { manualStartedAt: session.manualStartedAt, manualCacheStatus: "caching" });
  session.promise = runManualFileCacheSession(session)
    .catch(async (error) => {
      if (session.status !== "paused") {
        warnPreviewCacheError(`manual cache ${session.fileId}`, error);
        if (fileCacheSessions.get(session.fileId) === session && session.status === "caching") {
          session.status = "paused";
          session.metadata = {
            ...session.metadata,
            manualCacheStatus: "paused"
          };
          await putFileRecordMetadata(session.metadata, { manualStartedAt: session.manualStartedAt, manualCacheStatus: "paused" });
        }
      }
    })
    .finally(() => {
      if (fileCacheSessions.get(session.fileId) === session && session.status === "caching") {
        fileCacheSessions.delete(session.fileId);
        void deleteChunkMetadata(fileRecordCacheKey(session.fileId)).catch((error) => {
          warnPreviewCacheError(`delete manual cache record ${session.fileId}`, error);
        });
      }
      session.promise = null;
      session.controller = null;
      void pumpManualFileCacheQueue();
    });
}

async function pauseFileCacheSession(fileId) {
  const session = fileCacheSessions.get(fileId);
  if (!session || (session.status !== "caching" && session.status !== "waiting")) {
    return;
  }
  const wasCaching = session.status === "caching";
  session.status = "paused";
  session.metadata = {
    ...session.metadata,
    manualCacheStatus: "paused"
  };
  await putFileRecordMetadata(session.metadata, { manualStartedAt: session.manualStartedAt, manualCacheStatus: "paused" });
  if (wasCaching) {
    session.controller?.abort();
  } else {
    await pumpManualFileCacheQueue();
  }
}

async function resumeFileCacheSession(fileId, fallbackMetadata = null) {
  const session = fileCacheSessions.get(fileId);
  if (session) {
    if (session.status === "caching") {
      return;
    }

    const nextMetadata = fallbackMetadata?.fileId === fileId ? fallbackMetadata : session.metadata;
    const wasPaused = session.status === "paused";
    session.status = "waiting";
    session.manualStartedAt = wasPaused ? Date.now() : session.manualStartedAt || Date.now();
    session.metadata = {
      ...session.metadata,
      ...nextMetadata,
      manualStartedAt: session.manualStartedAt,
      cacheSource: "manual",
      cacheMaxBytes: Number.MAX_SAFE_INTEGER,
      manualCacheStatus: "waiting"
    };
    await putFileRecordMetadata(session.metadata, { manualStartedAt: session.manualStartedAt, manualCacheStatus: "waiting" });
    await pumpManualFileCacheQueue();
    return;
  }

  const entry = await readFileCacheEntry(fileId);
  if (entry?.complete) {
    return;
  }

  const metadata = fallbackMetadata?.fileId === fileId ? normalizeFileCacheMetadata({
    ...fallbackMetadata,
    cacheMaxBytes: Number.MAX_SAFE_INTEGER,
    cacheSource: "manual"
  }) : entry ? normalizeFileCacheMetadata({
    kind: entry.kind,
    fileId: entry.fileId,
    fileName: entry.fileName,
    directoryPath: entry.directoryPath,
    mimeType: entry.mimeType,
    size: entry.size,
    chunkSize: entry.chunkSize,
    chunkCount: entry.chunkCount,
    sourceUrl: entry.sourceUrl,
    token: entry.token,
    cacheMaxBytes: Number.MAX_SAFE_INTEGER,
    cacheSource: "manual"
  }) : null;
  if (metadata) {
    const sessionToQueue = createManualFileCacheSession({
      ...metadata,
      manualCacheStatus: "waiting"
    }, "waiting", Date.now());
    fileCacheSessions.set(fileId, sessionToQueue);
    await putFileRecordMetadata(sessionToQueue.metadata, { manualStartedAt: sessionToQueue.manualStartedAt, manualCacheStatus: "waiting" });
    await pumpManualFileCacheQueue();
  }
}

async function terminateFileCacheSession(fileId) {
  const session = fileCacheSessions.get(fileId);
  if (session) {
    session.status = "terminated";
    session.controller?.abort();
    fileCacheSessions.delete(fileId);
  }
  await deleteFileCache(fileId);
  await pumpManualFileCacheQueue();
}

function throwIfFileCacheStopped(session) {
  if (session.status !== "caching" || session.controller.signal.aborted) {
    throw new DOMException("文件缓存已停止", "AbortError");
  }
}

async function cacheWholeHlsFile(metadata, session) {
  const response = await fetch(metadata.sourceUrl, { credentials: "omit", signal: session.controller.signal });
  if (!response.ok) {
    throw new Error(`HLS 播放列表加载失败（HTTP ${response.status}）`);
  }

  const playlistText = await response.text();
  // 手动缓存时一并持久化 m3u8，后续预览可离线秒开（清理在 deleteFileCache 中处理）。
  await writeCachedHlsPlaylistText(metadata.fileId, playlistText);
  const rewritten = rewriteHlsPlaylist(playlistText, metadata);
  hlsPreviewSources.set(metadata.fileId, rewritten.sources);
  const queue = createHlsPriorityQueue(rewritten.sources, 0);
  await runConcurrentManualCacheWorkers(session, queue, async (part) => {
    if (!part?.sourceUrl) {
      return;
    }

    const partMetadata = part.partKind === "segment"
      ? {
          ...metadata,
          chunkCount: rewritten.sources.segments.length
        }
      : metadata;
    const response = await fetchAndCacheHlsPart({
      fileId: metadata.fileId,
      partKind: part.partKind,
      partIndex: part.partIndex,
      sourceUrl: part.sourceUrl,
      cacheMaxBytes: Number.MAX_SAFE_INTEGER,
      cacheSource: "manual",
      metadata: partMetadata,
      signal: session.controller.signal
    });
    await markHlsPartMetadataForManualCache(partMetadata, part.partKind, part.partIndex, response);
  });
}

async function updateFileCacheAccess(metadata, chunkIndex) {
  const entry = await readFileCacheEntry(metadata.fileId);
  if (!entry) {
    await putFileRecordMetadata(metadata);
    return;
  }

  await putFileRecordMetadata({
    ...metadata,
    cacheSource: entry.cacheSource === "manual" ? "manual" : metadata.cacheSource
  });

  if (Number.isSafeInteger(chunkIndex)) {
    const cacheKey = chunkCacheKey(metadata.fileId, chunkIndex);
    const chunk = await getChunkMetadata(cacheKey).catch(() => null);
    if (chunk) {
      await putChunkMetadata({
        ...chunk,
        fileName: metadata.fileName,
        mimeType: metadata.mimeType,
        totalSize: metadata.size,
        chunkSize: metadata.chunkSize,
        chunkCount: metadata.chunkCount,
        cacheSource: entry.cacheSource === "manual" ? "manual" : metadata.cacheSource,
        lastAccessed: Date.now()
      }, true);
    }
  }
}

function rewriteHlsPlaylist(playlistText, metadata) {
  const lines = playlistText.split(/\r?\n/);
  const segments = [];
  const durations = [];
  let initSource = null;
  let pendingDuration = null;

  const rewrittenLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return line;
    }

    if (trimmed.startsWith("#EXT-X-MAP:")) {
      const match = /URI="([^"]+)"/.exec(line);
      if (!match?.[1]) {
        return line;
      }
      initSource = normalizeHlsSource(match[1], metadata.sourceUrl);
      if (!initSource) {
        return line;
      }
      return line.replace(match[0], `URI="${hlsPartPreviewUrl(metadata, "init", 0, initSource)}"`);
    }

    if (trimmed.startsWith("#EXTINF:")) {
      pendingDuration = parseHlsExtinfDuration(trimmed);
      return line;
    }

    if (trimmed.startsWith("#")) {
      return line;
    }

    const source = normalizeHlsSource(trimmed, metadata.sourceUrl);
    if (!source) {
      return line;
    }
    const index = segments.length;
    segments.push(source);
    durations.push(pendingDuration);
    pendingDuration = null;
    return hlsPartPreviewUrl(metadata, "segment", index, source);
  });

  return {
    text: rewrittenLines.join("\n"),
    sources: {
      init: initSource,
      segments,
      durations
    }
  };
}

function parseHlsExtinfDuration(value) {
  const match = /^#EXTINF:([0-9]+(?:\.[0-9]+)?)/i.exec(value);
  if (!match?.[1]) {
    return null;
  }

  const duration = Number(match[1]);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function normalizeHlsSource(value, playlistSourceUrl) {
  try {
    const baseUrl = new URL(playlistSourceUrl, self.location.origin);
    const sourceUrl = new URL(value, baseUrl);
    return sourceUrl.origin === self.location.origin ? `${sourceUrl.pathname}${sourceUrl.search}` : null;
  } catch {
    return null;
  }
}

function hlsPartPreviewUrl(metadata, partKind, index, sourceUrl) {
  const params = new URLSearchParams({
    source: sourceUrl,
    cache_max: String(metadata.cacheMaxBytes),
    prefetch_concurrency: String(metadata.prefetchConcurrency),
    file_name: metadata.fileName || metadata.fileId,
    directory_path: metadata.directoryPath || "/",
    mime: metadata.mimeType || "application/vnd.apple.mpegurl",
    size: String(metadata.size || 0),
    chunk_size: String(metadata.chunkSize || 1),
    chunk_count: String(metadata.chunkCount || 1),
    cache_source: metadata.cacheSource || "auto"
  });
  return `/__video-preview/hls-part/${encodeURIComponent(metadata.fileId)}/${partKind}/${index}?${params.toString()}`;
}

async function fetchAndCacheHlsPart({ fileId, partKind, partIndex, sourceUrl, cacheMaxBytes, cacheSource = "auto", metadata = null, signal = null }) {
  const cacheKey = hlsPartCacheKey(fileId, partKind, partIndex);
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (cached) {
    touchPreviewCacheMetadata(metadata || fileId, hlsChunkIndex(partKind, partIndex), safeSize(Number(cached.headers.get("Content-Length"))), cacheKey);
    return cached;
  }

  const loadKey = `${fileId}:${partKind}:${partIndex}:${sourceUrl}`;
  let load = hlsPartLoads.get(loadKey);
  if (!load) {
    load = fetchAndCacheHlsPartBytes({
      fileId,
      partKind,
      partIndex,
      sourceUrl,
      cacheMaxBytes,
      cacheKey,
      cacheSource,
      metadata,
      signal
    }).finally(() => {
      hlsPartLoads.delete(loadKey);
    });
    hlsPartLoads.set(loadKey, load);
  }

  const result = await load;
  return createHlsPartResponse(result.bytes, result.contentType);
}

async function fetchHlsPartBytesWithRetry({ partKind, partIndex, sourceUrl, signal }) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    if (signal?.aborted) {
      throw new DOMException("文件缓存已停止", "AbortError");
    }

    try {
      const response = await fetch(sourceUrl, { credentials: "omit", signal: signal || undefined });
      if (!response.ok) {
        if (shouldRetryChunkStatus(response.status) && attempt < CHUNK_FETCH_MAX_ATTEMPTS) {
          await delayBeforeChunkRetry(attempt, signal);
          continue;
        }
        throw permanentCacheError(`HLS ${partKind} ${partIndex} preview load failed (HTTP ${response.status})`);
      }

      const bytes = await response.arrayBuffer();
      const contentType = response.headers.get("Content-Type") || "application/octet-stream";
      return { bytes, contentType };
    } catch (error) {
      if (isAbortError(error) || error?.permanent || attempt >= CHUNK_FETCH_MAX_ATTEMPTS) {
        throw error;
      }
      await delayBeforeChunkRetry(attempt, signal);
    }
  }
}

async function fetchAndCacheHlsPartBytes({ fileId, partKind, partIndex, sourceUrl, cacheMaxBytes, cacheKey, cacheSource = "auto", metadata = null, signal = null }) {
  const { bytes, contentType } = await fetchHlsPartBytesWithRetry({ partKind, partIndex, sourceUrl, signal });
  const now = Date.now();

  if (cacheSource !== "manual") {
    await cleanupPreviewCache(bytes.byteLength, cacheMaxBytes);
  }
  const cache = await caches.open(CACHE_NAME);
  await cache.put(cacheKey, new Response(bytes.slice(0), {
    headers: cacheStorageResponseHeaders({
      fileId,
      metadata,
      kind: "hls",
      partKind,
      partIndex,
      chunkIndex: hlsChunkIndex(partKind, partIndex),
      sourceUrl: metadata?.sourceUrl || sourceUrl,
      cacheSource,
      contentType,
      size: bytes.byteLength,
      now
    })
  }));
  invalidateCacheStorageMetadataSnapshot();
  await putChunkMetadata({
    cacheKey,
    fileId,
    chunkIndex: hlsChunkIndex(partKind, partIndex),
    fileName: metadata?.fileName || fileId,
    directoryPath: metadata?.directoryPath || "/",
    kind: "hls",
    mimeType: metadata?.mimeType || contentType,
    totalSize: metadata?.size || bytes.byteLength,
    chunkSize: metadata?.chunkSize || bytes.byteLength,
    chunkCount: metadata?.chunkCount || 1,
    sourceUrl: metadata?.sourceUrl || "",
    token: metadata?.token || "",
    cacheSource,
    size: bytes.byteLength,
    manualStartedAt: metadata?.manualStartedAt,
    createdAt: now,
    lastAccessed: now
  }, true);
  if (cacheSource !== "manual") {
    await cleanupPreviewCache(0, cacheMaxBytes);
  }

  return { bytes, contentType };
}

function createHlsPartResponse(bytes, contentType) {
  return new Response(bytes, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Preview-Cache": "hls-segment"
    }
  });
}

function cacheStorageResponseHeaders({
  fileId,
  metadata = null,
  kind,
  partKind = "chunk",
  partIndex,
  chunkIndex,
  sourceUrl,
  cacheSource,
  contentType,
  size,
  now
}) {
  const headers = new Headers({
    "Content-Type": contentType || metadata?.mimeType || "application/octet-stream",
    "Content-Length": String(safeSize(size)),
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Preview-Cache-File-Id": fileId || metadata?.fileId || "",
    "X-Preview-Cache-File-Name": encodeMetadataHeader(metadata?.fileName || fileId || ""),
    "X-Preview-Cache-Directory-Path": encodeMetadataHeader(metadata?.directoryPath || "/"),
    "X-Preview-Cache-Kind": kind || metadata?.kind || "single",
    "X-Preview-Cache-Mime": metadata?.mimeType || contentType || "application/octet-stream",
    "X-Preview-Cache-Total-Size": String(safeSize(metadata?.size) || safeSize(size)),
    "X-Preview-Cache-Chunk-Size": String(safeSize(metadata?.chunkSize) || safeSize(size)),
    "X-Preview-Cache-Chunk-Index": String(Number.isSafeInteger(chunkIndex) ? chunkIndex : 0),
    "X-Preview-Cache-Part-Kind": partKind || "chunk",
    "X-Preview-Cache-Source": normalizeCacheSource(cacheSource || metadata?.cacheSource),
    "X-Preview-Cache-Created-At": String(safeTime(now) || Date.now()),
    "X-Preview-Cache-Last-Accessed": String(safeTime(now) || Date.now())
  });

  if (Number.isSafeInteger(metadata?.chunkCount) && metadata.chunkCount > 0) {
    headers.set("X-Preview-Cache-Chunk-Count", String(metadata.chunkCount));
  }

  const normalizedSourceUrl = sourceUrl || metadata?.sourceUrl || "";
  if (normalizedSourceUrl) {
    headers.set("X-Preview-Cache-Source-Url", encodeMetadataHeader(normalizedSourceUrl));
  }
  if (metadata?.token) {
    headers.set("X-Preview-Cache-Token", encodeMetadataHeader(metadata.token));
  }
  if (metadata?.manualStartedAt) {
    headers.set("X-Preview-Cache-Manual-Started-At", String(safeTime(metadata.manualStartedAt)));
  }
  const manualStatus = normalizeManualCacheStatus(metadata?.manualCacheStatus);
  if (manualStatus) {
    headers.set("X-Preview-Cache-Manual-Status", manualStatus);
  }
  if (Number.isSafeInteger(partIndex)) {
    headers.set("X-Preview-Cache-Part-Index", String(partIndex));
  }

  return headers;
}

function encodeMetadataHeader(value) {
  return encodeURIComponent(String(value || ""));
}

async function prefetchHlsSegments(fileId, startIndex, count, cacheMaxBytes) {
  const sources = hlsPreviewSources.get(fileId);
  if (!sources?.segments) {
    return;
  }

  const tasks = [];
  for (let index = startIndex; index < Math.min(sources.segments.length, startIndex + count); index += 1) {
    tasks.push((async () => {
      try {
        await fetchAndCacheHlsPart({
          fileId,
          partKind: "segment",
          partIndex: index,
          sourceUrl: sources.segments[index],
          cacheMaxBytes
        });
      } catch {
        // Best-effort lookahead; playback requests will retry on demand.
      }
    })());
  }

  await Promise.allSettled(tasks);
}

async function runConcurrentPrefetchWorkers(session, generation, sessions, loadNext) {
  const concurrency = normalizePreviewPrefetchConcurrency(session.metadata?.prefetchConcurrency);
  const workerCount = Math.min(concurrency, Math.max(1, session.queue.length));
  const failedItems = [];

  async function runWorker() {
    while (
      isContinuousPrefetchSessionActive(session, sessions) &&
      generation === session.generation &&
      session.queue.length > 0
    ) {
      const item = session.queue.shift();
      if (item === undefined) {
        continue;
      }

      try {
        await loadNext(item);
      } catch {
        failedItems.push(item);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  if (
    failedItems.length > 0 &&
    isContinuousPrefetchSessionActive(session, sessions) &&
    generation === session.generation
  ) {
    session.queue.push(...failedItems);
  }
}

function hlsChunkIndex(partKind, partIndex) {
  return partKind === "init" ? -1 : partIndex;
}

function hlsPartCacheKey(fileId, partKind, partIndex) {
  return `${self.location.origin}/__preview-cache/hls/${encodeURIComponent(fileId)}/${partKind}/${partIndex}`;
}

// HLS 播放列表（.m3u8）按 fileId 单独缓存，使"已缓存"的 HLS 无需再次联网拉取 m3u8 即可秒开。
// 注意该 key 不会被 parseCacheStorageCacheKey 识别，因此不会计入用量统计，
// 也不会被 cleanupPreviewCache 回收；其清理在 deleteFileCache 中显式处理。
function hlsPlaylistCacheKey(fileId) {
  return `${self.location.origin}/__preview-cache/hls-playlist/${encodeURIComponent(fileId)}`;
}

async function readCachedHlsPlaylistText(fileId) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(hlsPlaylistCacheKey(fileId));
    return cached ? await cached.text() : null;
  } catch (error) {
    warnPreviewCacheError(`read hls playlist ${fileId}`, error);
    return null;
  }
}

async function writeCachedHlsPlaylistText(fileId, playlistText) {
  if (typeof playlistText !== "string" || !playlistText.trim()) {
    return;
  }
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(hlsPlaylistCacheKey(fileId), new Response(playlistText, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }));
  } catch (error) {
    warnPreviewCacheError(`write hls playlist ${fileId}`, error);
  }
}

async function deleteCachedHlsPlaylist(fileId) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(hlsPlaylistCacheKey(fileId));
  } catch (error) {
    warnPreviewCacheError(`delete hls playlist ${fileId}`, error);
  }
}

function markHlsPartMetadataForManualCache(metadata, partKind, partIndex, response) {
  const size = safeSize(Number(response.headers.get("Content-Length")));
  if (size <= 0) {
    return Promise.resolve();
  }

  return markChunkMetadataForManualCache(
    metadata,
    hlsChunkIndex(partKind, partIndex),
    size,
    hlsPartCacheKey(metadata.fileId, partKind, partIndex)
  );
}

function startHlsPreviewCacheSession(sessionId, metadata) {
  const metadataKey = previewMetadataKey(metadata);
  const existing = hlsPreviewCacheSessions.get(sessionId);

  if (existing && existing.metadataKey === metadataKey) {
    existing.lastHeartbeat = Date.now();
    existing.active = true;
    if (existing.completed) {
      scheduleContinuousPrefetchExpiry(existing, hlsPreviewCacheSessions);
      return Promise.resolve();
    }
    return scheduleHlsPreviewCacheSession(existing);
  }

  if (existing) {
    existing.active = false;
  }

  const session = {
    sessionId,
    metadata,
    metadataKey,
    active: true,
    completed: false,
    lastHeartbeat: Date.now(),
    priorityStart: 0,
    queue: [],
    generation: 0,
    task: null,
    retryTimer: null
  };
  hlsPreviewCacheSessions.set(sessionId, session);

  return scheduleHlsPreviewCacheSession(session);
}

function stopHlsPreviewCacheSession(sessionId) {
  const session = hlsPreviewCacheSessions.get(sessionId);
  if (!session) {
    return;
  }

  session.active = false;
  clearContinuousPrefetchRetry(session);
  hlsPreviewCacheSessions.delete(sessionId);
}

function prioritizeHlsPreviewCache(fileId, startIndex, cacheMaxBytes, prefetchConcurrency) {
  const tasks = [];

  for (const session of hlsPreviewCacheSessions.values()) {
    if (session.metadata.fileId !== fileId) {
      continue;
    }

    if (Number.isSafeInteger(cacheMaxBytes) && cacheMaxBytes > 0) {
      session.metadata = {
        ...session.metadata,
        cacheMaxBytes
      };
    }

    session.metadata = {
      ...session.metadata,
      prefetchConcurrency: normalizePreviewPrefetchConcurrency(prefetchConcurrency ?? session.metadata.prefetchConcurrency)
    };

    tasks.push(setHlsPreviewCachePriority(session, startIndex));
  }

  return Promise.allSettled(tasks).then(() => undefined);
}

function setHlsPreviewCachePriority(session, startIndex) {
  const sources = hlsPreviewSources.get(session.metadata.fileId);
  if (!sources?.segments) {
    return Promise.resolve();
  }

  const priorityStart = normalizeChunkIndex(startIndex, sources.segments.length);
  if (session.priorityStart !== priorityStart || session.completed) {
    session.priorityStart = priorityStart;
    session.queue = createHlsPriorityQueue(sources, priorityStart);
    session.completed = false;
    session.generation += 1;
    clearContinuousPrefetchRetry(session);
  } else if (session.queue.length === 0 && !session.task) {
    session.queue = createHlsPriorityQueue(sources, priorityStart);
  }

  return scheduleHlsPreviewCacheSession(session);
}

function scheduleHlsPreviewCacheSession(session) {
  const sources = hlsPreviewSources.get(session.metadata.fileId);
  if (!sources?.segments) {
    return Promise.resolve();
  }

  if (session.completed) {
    return Promise.resolve();
  }

  if (session.queue.length === 0 && !session.task) {
    session.queue = createHlsPriorityQueue(sources, session.priorityStart);
  }

  if (session.task) {
    return session.task;
  }

  const generation = session.generation;
  const task = runHlsPreviewCacheQueue(session, generation)
    .then(() => {
      if (hlsPreviewCacheSessions.get(session.sessionId) !== session) {
        return;
      }

      if (session.task === task) {
        session.task = null;
      }

      if (generation !== session.generation) {
        if (session.active) {
          return scheduleHlsPreviewCacheSession(session);
        }
        hlsPreviewCacheSessions.delete(session.sessionId);
        return;
      }

      const completed = session.queue.length === 0;

      if (session.active && completed) {
        session.completed = true;
        scheduleContinuousPrefetchExpiry(session, hlsPreviewCacheSessions);
      } else if (session.active && !completed) {
        scheduleContinuousPrefetchRetry(session, hlsPreviewCacheSessions, scheduleHlsPreviewCacheSession);
      } else if (!session.active) {
        hlsPreviewCacheSessions.delete(session.sessionId);
      }
    });

  session.task = task;
  return session.task;
}

async function runHlsPreviewCacheQueue(session, generation) {
  await runConcurrentPrefetchWorkers(session, generation, hlsPreviewCacheSessions, async (part) => {
    if (!part?.sourceUrl) {
      return;
    }

    try {
      await fetchAndCacheHlsPart({
        fileId: session.metadata.fileId,
        partKind: part.partKind,
        partIndex: part.partIndex,
        sourceUrl: part.sourceUrl,
        cacheMaxBytes: session.metadata.cacheMaxBytes
      });
    } catch (error) {
      warnPreviewCacheError(`continuous prefetch HLS ${part.partKind} ${part.partIndex}`, error);
      throw error;
    }
  });
}

function createHlsPriorityQueue(sources, startIndex) {
  const queue = [];

  if (sources.init) {
    queue.push({
      partKind: "init",
      partIndex: 0,
      sourceUrl: sources.init
    });
  }

  for (const index of createPriorityChunkQueue(sources.segments.length, startIndex)) {
    queue.push({
      partKind: "segment",
      partIndex: index,
      sourceUrl: sources.segments[index]
    });
  }

  return queue;
}

function parsePreviewMetadata(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const pathKind = parts[1];
  const fileId = parts[2] || parts[1];
  const kind = normalizePreviewKind(url.searchParams.get("kind") || pathKind);
  const token = url.searchParams.get("token");
  const sourceUrl = normalizeSameOriginSourceUrl(url.searchParams.get("source"));
  const size = Number(url.searchParams.get("size"));
  const chunkSize = Number(url.searchParams.get("chunk_size"));
  const chunkCount = Number(url.searchParams.get("chunk_count"));
  const mimeType = url.searchParams.get("mime") || "application/octet-stream";
  const cacheMaxBytes = normalizeCacheMaxBytes(url.searchParams.get("cache_max"));
  const prefetchConcurrency = normalizePreviewPrefetchConcurrency(url.searchParams.get("prefetch_concurrency"));

  if (!fileId || !kind) {
    return null;
  }

  if (kind === "hls") {
    if (!sourceUrl) {
      return null;
    }
    return {
      kind,
      fileId,
      fileName: decodeURIComponent(parts[3] || fileId),
      sourceUrl,
      chunkCount: Number.isSafeInteger(chunkCount) && chunkCount > 0 ? chunkCount : undefined,
      mimeType,
      cacheMaxBytes,
      cacheSource: "auto",
      prefetchConcurrency
    };
  }

  if (!Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || !Number.isSafeInteger(chunkCount) || chunkCount <= 0) {
    return null;
  }

  if (kind === "multipart" && !token) {
    return null;
  }

  if (kind === "single" && !sourceUrl) {
    return null;
  }

  if (kind === "hls" && !sourceUrl) {
    return null;
  }

  return {
    kind,
    fileId,
    fileName: decodeURIComponent(parts[3] || fileId),
    token,
    sourceUrl,
    size,
    chunkSize,
    chunkCount,
    mimeType,
    cacheMaxBytes,
    cacheSource: "auto",
    prefetchConcurrency
  };
}

function normalizePreviewMetadata(value) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const fileId = typeof value.fileId === "string" ? value.fileId : "";
  const fileName = typeof value.fileName === "string" && value.fileName ? value.fileName : fileId;
  const kind = normalizePreviewKind(value.kind);
  const token = typeof value.token === "string" ? value.token : "";
  const sourceUrl = normalizeSameOriginSourceUrl(value.sourceUrl);
  const size = Number(value.size);
  const chunkSize = Number(value.chunkSize);
  const chunkCount = Number(value.chunkCount);
  const mimeType = typeof value.mimeType === "string" && value.mimeType ? value.mimeType : "application/octet-stream";
  const cacheMaxBytes = normalizeCacheMaxBytes(value.cacheMaxBytes);
  const prefetchConcurrency = normalizePreviewPrefetchConcurrency(value.prefetchConcurrency);

  if (!fileId || !kind) {
    return null;
  }

  if (kind === "hls") {
    if (!sourceUrl) {
      return null;
    }
    return {
      kind,
      fileId,
      fileName,
      sourceUrl,
      mimeType,
      cacheMaxBytes,
      cacheSource: "auto",
      prefetchConcurrency
    };
  }

  if (!Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || !Number.isSafeInteger(chunkCount) || chunkCount <= 0) {
    return null;
  }

  if (kind === "multipart" && !token) {
    return null;
  }

  if (kind === "single" && !sourceUrl) {
    return null;
  }

  if (kind === "hls" && !sourceUrl) {
    return null;
  }

  return {
    kind,
    fileId,
    fileName,
    token,
    sourceUrl,
    size,
    chunkSize,
    chunkCount,
    mimeType,
    cacheMaxBytes,
    cacheSource: "auto",
    prefetchConcurrency
  };
}

function normalizePreviewKind(value) {
  return value === "single" || value === "multipart" || value === "hls" ? value : null;
}

function parseFileCacheMetadata(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const kind = normalizeFileCacheKind(url.searchParams.get("kind") || parts[1]);
  const fileId = parts[2] || "";
  const fileName = url.searchParams.get("file_name") || decodeURIComponent(parts[3] || fileId);
  const directoryPath = normalizeDirectoryPath(url.searchParams.get("directory_path"));
  const token = url.searchParams.get("token");
  const sourceUrl = normalizeSameOriginSourceUrl(url.searchParams.get("source"));
  const size = Number(url.searchParams.get("size"));
  const chunkSize = Number(url.searchParams.get("chunk_size"));
  const chunkCount = Number(url.searchParams.get("chunk_count"));
  const mimeType = url.searchParams.get("mime") || "application/octet-stream";
  const cacheMaxBytes = normalizeCacheMaxBytes(url.searchParams.get("cache_max"));
  const cacheSource = normalizeCacheSource(url.searchParams.get("cache_source"));

  return normalizeFileCacheMetadata({
    kind,
    fileId,
    fileName,
    directoryPath,
    token,
    sourceUrl,
    size,
    chunkSize,
    chunkCount,
    mimeType,
    cacheMaxBytes,
    cacheSource
  });
}

function normalizeFileCacheMetadata(value) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const kind = normalizeFileCacheKind(value.kind);
  const fileId = typeof value.fileId === "string" ? value.fileId : "";
  const fileName = typeof value.fileName === "string" && value.fileName ? value.fileName : fileId;
  const directoryPath = normalizeDirectoryPath(value.directoryPath);
  const token = typeof value.token === "string" ? value.token : "";
  const sourceUrl = normalizeSameOriginSourceUrl(value.sourceUrl);
  const size = Number(value.size);
  const chunkSize = Number(value.chunkSize);
  const chunkCount = Number(value.chunkCount);
  const mimeType = typeof value.mimeType === "string" && value.mimeType ? value.mimeType : "application/octet-stream";
  const cacheMaxBytes = normalizeCacheMaxBytes(value.cacheMaxBytes);
  const cacheSource = normalizeCacheSource(value.cacheSource);

  if (!kind || !fileId || !Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || !Number.isSafeInteger(chunkCount) || chunkCount <= 0) {
    return null;
  }

  if (kind === "multipart" && !token) {
    return null;
  }

  if (kind === "single" && !sourceUrl) {
    return null;
  }

  return {
    kind,
    fileId,
    fileName,
    directoryPath,
    token,
    sourceUrl,
    size,
    chunkSize,
    chunkCount,
    mimeType,
    cacheMaxBytes,
    cacheSource,
    prefetchConcurrency: DEFAULT_PREVIEW_PREFETCH_CONCURRENCY
  };
}

function normalizeFileCacheKind(value) {
  return value === "single" || value === "multipart" || value === "hls" ? value : null;
}

function normalizeCacheSource(value) {
  return value === "manual" ? "manual" : "auto";
}

function normalizeManualCacheStatus(value) {
  return value === "caching" || value === "paused" || value === "waiting" ? value : undefined;
}

function normalizeDirectoryPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "/";
  }
  const normalized = value.trim();
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function normalizeCacheMaxBytes(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CACHE_BYTES;
}

function normalizePreviewPrefetchConcurrency(value) {
  const parsed = Math.floor(Number(value));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_PREVIEW_PREFETCH_CONCURRENCY;
  }
  return Math.min(MAX_PREVIEW_PREFETCH_CONCURRENCY, parsed);
}

function normalizeSameOriginSourceUrl(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }

  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

function normalizeSessionId(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeRequestId(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

async function replyPreviewCacheState(event, requestId, metadata) {
  try {
    postPreviewCacheStateResponse(event, {
      type: "VIDEO_PREVIEW_CACHE_STATE_RESPONSE",
      requestId,
      state: await readPreviewCacheState(metadata)
    });
  } catch (error) {
    postPreviewCacheStateResponse(event, {
      type: "VIDEO_PREVIEW_CACHE_STATE_RESPONSE",
      requestId,
      state: null,
      error: error instanceof Error ? error.message : "Failed to read preview cache state"
    });
  }
}

function postPreviewCacheStateResponse(event, response) {
  const port = event.ports?.[0];
  if (port) {
    port.postMessage(response);
    return;
  }

  event.source?.postMessage(response);
}

async function readPreviewCacheState(metadata) {
  const chunkCount = previewCacheStateChunkCount(metadata);
  const cachedChunks = [];

  if (chunkCount > 0) {
    const entries = await getAllChunkMetadata();
    const seen = new Set();

    for (const entry of entries) {
      if (entry?.fileId !== metadata.fileId) {
        continue;
      }

      const chunkIndex = Math.floor(Number(entry.chunkIndex));
      if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount || seen.has(chunkIndex)) {
        continue;
      }

      seen.add(chunkIndex);
      cachedChunks.push(chunkIndex);
    }

    if (cachedChunks.length < chunkCount) {
      const fallbackCachedChunks = await readCachedChunkIndexesForMetadata(metadata, chunkCount, seen);
      for (const chunkIndex of fallbackCachedChunks) {
        if (chunkIndex < 0 || chunkIndex >= chunkCount || seen.has(chunkIndex)) {
          continue;
        }
        seen.add(chunkIndex);
        cachedChunks.push(chunkIndex);
      }
    }
  }

  cachedChunks.sort((left, right) => left - right);

  const durations = previewCacheStateDurations(metadata, chunkCount);

  return {
    fileId: metadata.fileId,
    kind: metadata.kind,
    chunkCount,
    cachedChunks,
    ...(durations ? { durations } : {})
  };
}

function previewCacheStateChunkCount(metadata) {
  if (metadata.kind === "hls") {
    const sources = hlsPreviewSources.get(metadata.fileId);
    const chunkCount = sources?.segments?.length ?? 0;
    if (Number.isSafeInteger(chunkCount) && chunkCount > 0) {
      return chunkCount;
    }
    return Number.isSafeInteger(metadata.chunkCount) && metadata.chunkCount > 0 ? metadata.chunkCount : 0;
  }

  return Number.isSafeInteger(metadata.chunkCount) && metadata.chunkCount > 0 ? metadata.chunkCount : 0;
}

function previewCacheStateDurations(metadata, chunkCount) {
  if (metadata.kind !== "hls" || !Number.isSafeInteger(chunkCount) || chunkCount <= 0) {
    return null;
  }

  const sources = hlsPreviewSources.get(metadata.fileId);
  if (!Array.isArray(sources?.durations) || sources.durations.length !== chunkCount) {
    return null;
  }

  const durations = sources.durations.map((duration) => Number(duration));
  return durations.every((duration) => Number.isFinite(duration) && duration > 0)
    ? durations
    : null;
}

async function readCachedChunkIndexesForMetadata(metadata, chunkCount, seen = new Set()) {
  if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0) {
    return [];
  }

  const cache = await caches.open(CACHE_NAME);
  const cachedChunks = [];
  const tasks = [];
  for (let index = 0; index < chunkCount; index += 1) {
    if (seen.has(index)) {
      continue;
    }
    tasks.push((async () => {
      const cacheKey = metadata.kind === "hls"
        ? hlsPartCacheKey(metadata.fileId, "segment", index)
        : chunkCacheKey(metadata.fileId, index);
      const cached = await cache.match(cacheKey);
      if (cached) {
        cachedChunks.push(index);
      }
    })());
  }

  await Promise.allSettled(tasks);
  cachedChunks.sort((left, right) => left - right);
  return cachedChunks;
}

function normalizePlaybackProgress(value) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const currentTime = normalizeNonNegativeNumber(value.currentTime);
  const duration = normalizePositiveNumber(value.duration);
  const ratio = normalizePlaybackRatio(value.ratio);
  const byteOffset = normalizeNonNegativeInteger(value.byteOffset);

  if (currentTime === null && ratio === null && byteOffset === null) {
    return null;
  }

  return {
    currentTime,
    duration,
    ratio,
    byteOffset
  };
}

function normalizeNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeNonNegativeInteger(value) {
  const parsed = Math.floor(Number(value));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizePlaybackRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.min(1, Math.max(0, parsed));
}

function updatePreviewCachePlaybackPriority(sessionId, metadata, progress) {
  const startTask = metadata.kind === "hls"
    ? startHlsPreviewCacheSession(sessionId, metadata)
    : startContinuousPreviewCache(sessionId, metadata);
  const startIndex = playbackPriorityStartIndex(metadata, progress);
  const priorityTask = startIndex === null
    ? Promise.resolve()
    : metadata.kind === "hls"
      ? prioritizeHlsPreviewCache(metadata.fileId, startIndex, metadata.cacheMaxBytes, metadata.prefetchConcurrency)
      : prioritizeContinuousPreviewCache(metadata, startIndex);

  return Promise.allSettled([startTask, priorityTask]).then(() => undefined);
}

function playbackPriorityStartIndex(metadata, progress) {
  if (metadata.kind === "hls") {
    return hlsPlaybackPriorityStartIndex(metadata.fileId, progress);
  }

  if (!Number.isSafeInteger(metadata.chunkCount) || metadata.chunkCount <= 0) {
    return null;
  }

  if (progress.byteOffset !== null && Number.isSafeInteger(metadata.chunkSize) && metadata.chunkSize > 0) {
    return normalizeChunkIndex(Math.floor(progress.byteOffset / metadata.chunkSize) + 1, metadata.chunkCount);
  }

  const ratio = playbackProgressRatio(progress);
  if (ratio === null) {
    return null;
  }

  return normalizeChunkIndex(Math.floor(ratio * metadata.chunkCount) + 1, metadata.chunkCount);
}

function hlsPlaybackPriorityStartIndex(fileId, progress) {
  const sources = hlsPreviewSources.get(fileId);
  const segmentCount = sources?.segments?.length ?? 0;
  if (!Number.isSafeInteger(segmentCount) || segmentCount <= 0) {
    return null;
  }

  const timedIndex = hlsPlaybackSegmentIndex(sources, progress.currentTime);
  if (timedIndex !== null) {
    return normalizeChunkIndex(timedIndex + 1, segmentCount);
  }

  const ratio = playbackProgressRatio(progress);
  if (ratio === null) {
    return null;
  }

  return normalizeChunkIndex(Math.floor(ratio * segmentCount) + 1, segmentCount);
}

function hlsPlaybackSegmentIndex(sources, currentTime) {
  if (currentTime === null || !Array.isArray(sources.durations) || sources.durations.length === 0) {
    return null;
  }

  let elapsed = 0;
  for (let index = 0; index < sources.segments.length; index += 1) {
    const duration = Number(sources.durations[index]);
    if (!Number.isFinite(duration) || duration <= 0) {
      return null;
    }

    if (currentTime < elapsed + duration) {
      return index;
    }

    elapsed += duration;
  }

  return sources.segments.length > 0 ? sources.segments.length - 1 : null;
}

function playbackProgressRatio(progress) {
  if (progress.ratio !== null) {
    return progress.ratio;
  }

  if (progress.currentTime === null || progress.duration === null) {
    return null;
  }

  return Math.min(1, Math.max(0, progress.currentTime / progress.duration));
}

function previewMetadataKey(metadata) {
  return [
    metadata.fileId,
    metadata.kind,
    metadata.sourceUrl || "",
    metadata.token,
    metadata.size,
    metadata.chunkSize,
    metadata.chunkCount,
    metadata.mimeType,
    metadata.cacheMaxBytes,
    metadata.prefetchConcurrency
  ].join(":");
}

function parseRange(rangeHeader, size, chunkSize = RESPONSE_WINDOW_BYTES) {
  const responseWindow = Math.min(RESPONSE_WINDOW_BYTES, Math.max(1, chunkSize));

  if (!rangeHeader) {
    return {
      start: 0,
      end: Math.min(size - 1, responseWindow - 1)
    };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    return null;
  }

  let start;
  let end;

  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, size - Math.min(suffixLength, responseWindow));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return null;
    }
  }

  const maxEnd = Math.min(size - 1, start + responseWindow - 1);
  return {
    start,
    end: Math.min(end, maxEnd)
  };
}

function rangeNotSatisfiable(size) {
  return new Response(null, {
    status: 416,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${size}`
    }
  });
}

async function createRangeStream(metadata, range) {
  const segments = collectRangeSegments(metadata, range);
  if (segments.length === 0) {
    return new ReadableStream({
      start(controller) {
        controller.close();
      }
    });
  }

  const [firstSegment, ...restSegments] = segments;
  const firstSource = await openChunkRangeSource(metadata, firstSegment);

  return new ReadableStream({
    async start(controller) {
      try {
        await pipeRangeSource(firstSource, controller);
        for (const segment of restSegments) {
          const source = await openChunkRangeSource(metadata, segment);
          await pipeRangeSource(source, controller);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
}

function collectRangeSegments(metadata, range) {
  const firstChunk = Math.floor(range.start / metadata.chunkSize);
  const lastChunk = Math.floor(range.end / metadata.chunkSize);
  const segments = [];

  for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex += 1) {
    const chunkStart = chunkIndex * metadata.chunkSize;
    const chunkEnd = chunkStart + expectedChunkSize(metadata, chunkIndex) - 1;
    const overlapStart = Math.max(range.start, chunkStart);
    const overlapEnd = Math.min(range.end, chunkEnd);

    if (overlapStart > overlapEnd) {
      continue;
    }

    segments.push({
      chunkIndex,
      start: overlapStart - chunkStart,
      endExclusive: overlapEnd - chunkStart + 1
    });
  }

  return segments;
}

async function openChunkRangeSource(metadata, segment) {
  const cached = getHotChunkBytes(metadata, segment.chunkIndex);
  if (cached) {
    return {
      bytes: new Uint8Array(cached, segment.start, segment.endExclusive - segment.start)
    };
  }

  const cachedSource = await openCachedChunkRangeSource(metadata, segment);
  if (cachedSource) {
    return cachedSource;
  }

  const expectedSize = expectedChunkSize(metadata, segment.chunkIndex);
  if (segment.start === 0 && segment.endExclusive === expectedSize) {
    const bytes = await getChunkBytes(metadata, segment.chunkIndex);
    return {
      bytes: new Uint8Array(bytes, segment.start, segment.endExclusive - segment.start)
    };
  }

  const stream = await fetchChunkByteRange(metadata, segment);
  return { stream };
}

async function openCachedChunkRangeSource(metadata, segment) {
  const expectedSize = expectedChunkSize(metadata, segment.chunkIndex);
  const cached = await getCachedChunkResponse(metadata, segment.chunkIndex);
  if (!cached) {
    return null;
  }

  if (!cached.body) {
    const bytes = await cached.arrayBuffer();
    if (bytes.byteLength !== expectedSize) {
      await deleteChunk(chunkCacheKey(metadata.fileId, segment.chunkIndex));
      return null;
    }
    putHotChunkBytes(metadata, segment.chunkIndex, bytes);
    return {
      bytes: new Uint8Array(bytes, segment.start, segment.endExclusive - segment.start)
    };
  }

  return {
    stream: sliceReadableStream(cached.body, segment.start, segment.endExclusive)
  };
}

async function fetchChunkByteRange(metadata, segment) {
  const expectedSize = expectedChunkSize(metadata, segment.chunkIndex);
  if (
    segment.start < 0 ||
    segment.endExclusive <= segment.start ||
    segment.endExclusive > expectedSize
  ) {
    throw new Error("Chunk byte range is out of range");
  }

  const response = await fetch(chunkSourceUrl(metadata, segment.chunkIndex), {
    credentials: "omit",
    headers: {
      Range: chunkRangeHeader(metadata, segment.chunkIndex, segment.start, segment.endExclusive)
    }
  });

  if (!response.ok) {
    throw new Error(`分片 ${segment.chunkIndex + 1} 预览加载失败（HTTP ${response.status}）`);
  }

  const requestedFullChunk = segment.start === 0 && segment.endExclusive === expectedSize;
  if (!requestedFullChunk && response.status !== 206) {
    throw new Error(`分片 ${segment.chunkIndex + 1} 不支持按需读取`);
  }

  if (!response.body) {
    throw new Error(`分片 ${segment.chunkIndex + 1} 预览响应为空`);
  }

  return response.body;
}

async function pipeRangeSource(source, controller) {
  if ("bytes" in source) {
    controller.enqueue(source.bytes);
    return;
  }

  const reader = source.stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        controller.enqueue(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function sliceReadableStream(stream, start, endExclusive) {
  return new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();
      let offset = 0;

      try {
        while (offset < endExclusive) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          if (!value) {
            continue;
          }

          const chunkStart = offset;
          const chunkEnd = chunkStart + value.byteLength;
          offset = chunkEnd;

          if (chunkEnd <= start) {
            continue;
          }

          const sliceStart = Math.max(0, start - chunkStart);
          const sliceEnd = Math.min(value.byteLength, endExclusive - chunkStart);
          if (sliceEnd > sliceStart) {
            controller.enqueue(value.subarray(sliceStart, sliceEnd));
          }
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  });
}

async function getCachedChunkBytes(metadata, chunkIndex) {
  if (chunkIndex < 0 || chunkIndex >= metadata.chunkCount) {
    throw new Error("Chunk index is out of range");
  }

  const hotBytes = getHotChunkBytes(metadata, chunkIndex);
  if (hotBytes) {
    return hotBytes;
  }

  try {
    const cacheKey = chunkCacheKey(metadata.fileId, chunkIndex);
    const cached = await getCachedChunkResponse(metadata, chunkIndex);

    if (!cached) {
      return null;
    }

    const bytes = await cached.arrayBuffer();
    const expectedSize = expectedChunkSize(metadata, chunkIndex);
    if (bytes.byteLength !== expectedSize) {
      await deleteChunk(cacheKey);
      return null;
    }

    putHotChunkBytes(metadata, chunkIndex, bytes);

    return bytes;
  } catch (error) {
    warnPreviewCacheError(`read chunk ${chunkIndex}`, error);
    return null;
  }
}

async function getCachedChunkResponse(metadata, chunkIndex) {
  if (chunkIndex < 0 || chunkIndex >= metadata.chunkCount) {
    throw new Error("Chunk index is out of range");
  }

  try {
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = chunkCacheKey(metadata.fileId, chunkIndex);
    const cached = await cache.match(cacheKey);

    if (!cached) {
      return null;
    }

    const expectedSize = expectedChunkSize(metadata, chunkIndex);
    const cachedSize = cachedChunkContentLength(cached);
    if (cachedSize !== null && cachedSize !== expectedSize) {
      await deleteChunk(cacheKey);
      return null;
    }

    touchChunkMetadata(metadata, chunkIndex, expectedSize, cacheKey);
    return cached;
  } catch (error) {
    warnPreviewCacheError(`match chunk ${chunkIndex}`, error);
    return null;
  }
}

function cachedChunkContentLength(response) {
  const value = Number(response.headers.get("Content-Length"));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function touchChunkMetadata(metadata, chunkIndex, size, cacheKey = chunkCacheKey(metadata.fileId, chunkIndex)) {
  touchPreviewCacheMetadata(metadata, chunkIndex, size, cacheKey);
}

function markChunkMetadataForManualCache(metadata, chunkIndex, size, cacheKey = chunkCacheKey(metadata.fileId, chunkIndex)) {
  invalidateCacheStorageMetadataSnapshot();
  return putChunkMetadata({
    cacheKey,
    fileId: metadata.fileId,
    chunkIndex,
    fileName: metadata.fileName || metadata.fileId,
    directoryPath: metadata.directoryPath || "/",
    kind: metadata.kind || "single",
    mimeType: metadata.mimeType || "application/octet-stream",
    totalSize: metadata.size || size,
    chunkSize: metadata.chunkSize || size,
    chunkCount: metadata.chunkCount || 1,
    sourceUrl: metadata.sourceUrl || "",
    token: metadata.token || "",
    cacheSource: "manual",
    size,
    manualStartedAt: metadata.manualStartedAt,
    lastAccessed: Date.now()
  }, true);
}

function touchPreviewCacheMetadata(metadataOrFileId, chunkIndex, size, cacheKey) {
  const now = Date.now();
  const metadata = typeof metadataOrFileId === "string"
    ? {
        fileId: metadataOrFileId,
        fileName: metadataOrFileId,
        directoryPath: "/",
        mimeType: "application/octet-stream",
        size,
        chunkSize: size,
        chunkCount: 1,
        cacheSource: "auto"
      }
    : metadataOrFileId;
  void putChunkMetadata({
    cacheKey,
    fileId: metadata.fileId,
    chunkIndex,
    fileName: metadata.fileName || metadata.fileId,
    directoryPath: metadata.directoryPath || "/",
    kind: metadata.kind || "single",
    mimeType: metadata.mimeType || "application/octet-stream",
    totalSize: metadata.size || size,
    chunkSize: metadata.chunkSize || size,
    chunkCount: metadata.chunkCount || 1,
    sourceUrl: metadata.sourceUrl || "",
    token: metadata.token || "",
    cacheSource: metadata.cacheSource || "auto",
    size,
    createdAt: now,
    lastAccessed: now
  }, true).catch((error) => {
    warnPreviewCacheError(`touch chunk ${chunkIndex}`, error);
  });
}

async function getChunkBytes(metadata, chunkIndex, signal = null) {
  if (chunkIndex < 0 || chunkIndex >= metadata.chunkCount) {
    throw new Error("Chunk index is out of range");
  }

  const cached = await getCachedChunkBytes(metadata, chunkIndex);
  if (cached) {
    return cached;
  }

  const loadKey = `${metadata.fileId}:${chunkIndex}`;
  const pendingLoad = fullChunkLoads.get(loadKey);
  if (pendingLoad) {
    return pendingLoad;
  }

  const load = fetchAndCacheChunkBytes(metadata, chunkIndex, signal)
    .finally(() => {
      fullChunkLoads.delete(loadKey);
    });
  fullChunkLoads.set(loadKey, load);

  return load;
}

function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

function permanentCacheError(message) {
  const error = new Error(message);
  error.permanent = true;
  return error;
}

function shouldRetryChunkStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("已中断", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("已中断", "AbortError"));
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function delayBeforeChunkRetry(attempt, signal) {
  const delay = Math.min(CHUNK_FETCH_RETRY_MAX_DELAY_MS, CHUNK_FETCH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  await abortableDelay(delay, signal);
}

// 分片下载带退避重试：瞬时错误（网络抖动 / 429 / 5xx / 大小不匹配）会重试，
// 主动中断（用户暂停 / 终止）与永久性错误（其它 4xx）立即放弃。
async function fetchChunkBytesWithRetry(metadata, chunkIndex, expectedSize, signal) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    if (signal?.aborted) {
      throw new DOMException("文件缓存已停止", "AbortError");
    }

    try {
      const response = await fetch(chunkSourceUrl(metadata, chunkIndex), {
        signal: signal || undefined,
        credentials: "omit",
        headers: metadata.kind === "single"
          ? { Range: chunkRangeHeader(metadata, chunkIndex, 0, expectedSize) }
          : undefined
      });

      if (!response.ok) {
        if (shouldRetryChunkStatus(response.status) && attempt < CHUNK_FETCH_MAX_ATTEMPTS) {
          await delayBeforeChunkRetry(attempt, signal);
          continue;
        }
        throw permanentCacheError(`分片 ${chunkIndex + 1} 预览加载失败（HTTP ${response.status}）`);
      }

      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== expectedSize) {
        throw new Error(`分片 ${chunkIndex + 1} 大小不匹配`);
      }

      return bytes;
    } catch (error) {
      if (isAbortError(error) || error?.permanent || attempt >= CHUNK_FETCH_MAX_ATTEMPTS) {
        throw error;
      }
      await delayBeforeChunkRetry(attempt, signal);
    }
  }
}

async function fetchAndCacheChunkBytes(metadata, chunkIndex, signal = null) {
  const expectedSize = expectedChunkSize(metadata, chunkIndex);
  const bytes = await fetchChunkBytesWithRetry(metadata, chunkIndex, expectedSize, signal);

  putHotChunkBytes(metadata, chunkIndex, bytes);

  try {
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = chunkCacheKey(metadata.fileId, chunkIndex);
    const now = Date.now();

    if (metadata.cacheSource !== "manual") {
      await cleanupPreviewCache(bytes.byteLength, metadata.cacheMaxBytes);
    }
    await cache.put(cacheKey, new Response(bytes.slice(0), {
      headers: cacheStorageResponseHeaders({
        fileId: metadata.fileId,
        metadata,
        kind: metadata.kind || "single",
        chunkIndex,
        cacheSource: metadata.cacheSource || "auto",
        contentType: "application/octet-stream",
        size: bytes.byteLength,
        now
      })
    }));
    invalidateCacheStorageMetadataSnapshot();
    await putChunkMetadata({
      cacheKey,
      fileId: metadata.fileId,
      chunkIndex,
      fileName: metadata.fileName || metadata.fileId,
      directoryPath: metadata.directoryPath || "/",
      kind: metadata.kind || "single",
      mimeType: metadata.mimeType || "application/octet-stream",
      totalSize: metadata.size,
      chunkSize: metadata.chunkSize,
      chunkCount: metadata.chunkCount,
      sourceUrl: metadata.sourceUrl || "",
      token: metadata.token || "",
      cacheSource: metadata.cacheSource || "auto",
      size: bytes.byteLength,
      manualStartedAt: metadata.manualStartedAt,
      createdAt: now,
      lastAccessed: now
    }, true);
    if (metadata.cacheSource !== "manual") {
      await cleanupPreviewCache(0, metadata.cacheMaxBytes);
    }
  } catch (error) {
    warnPreviewCacheError(`write chunk ${chunkIndex}`, error);
  }

  return bytes;
}

function chunkSourceUrl(metadata, chunkIndex) {
  if (metadata.kind === "multipart") {
    return `/f/${encodeURIComponent(metadata.token)}/chunks/${chunkIndex}`;
  }

  return metadata.sourceUrl;
}

function chunkRangeHeader(metadata, chunkIndex, start, endExclusive) {
  if (metadata.kind === "single") {
    const absoluteStart = chunkIndex * metadata.chunkSize + start;
    const absoluteEndExclusive = chunkIndex * metadata.chunkSize + endExclusive;
    return `bytes=${absoluteStart}-${absoluteEndExclusive - 1}`;
  }

  return `bytes=${start}-${endExclusive - 1}`;
}

function expectedChunkSize(metadata, chunkIndex) {
  return chunkIndex === metadata.chunkCount - 1
    ? metadata.size - metadata.chunkSize * chunkIndex
    : metadata.chunkSize;
}

async function prefetchChunks(metadata, startIndex, count) {
  const tasks = [];
  for (let index = startIndex; index < Math.min(metadata.chunkCount, startIndex + count); index += 1) {
    tasks.push((async () => {
      try {
        await ensureChunkCached(metadata, index);
      } catch {
        // Best-effort lookahead; playback requests will retry on demand.
      }
    })());
  }

  await Promise.allSettled(tasks);
}

async function ensureChunkCached(metadata, chunkIndex) {
  if (getHotChunkBytes(metadata, chunkIndex)) {
    return;
  }

  const cached = await getCachedChunkResponse(metadata, chunkIndex);
  if (cached) {
    return;
  }

  await getChunkBytes(metadata, chunkIndex);
}

function startContinuousPreviewCache(sessionId, metadata) {
  const metadataKey = previewMetadataKey(metadata);
  const existing = continuousPrefetchSessions.get(sessionId);

  if (existing && existing.metadataKey === metadataKey) {
    existing.lastHeartbeat = Date.now();
    existing.active = true;
    if (existing.completed) {
      scheduleContinuousPrefetchExpiry(existing, continuousPrefetchSessions);
      return Promise.resolve();
    }
    return scheduleContinuousPrefetchSession(existing);
  }

  if (existing) {
    existing.active = false;
  }

  const session = {
    sessionId,
    metadata,
    metadataKey,
    active: true,
    completed: false,
    lastHeartbeat: Date.now(),
    priorityStart: 0,
    queue: createPriorityChunkQueue(metadata.chunkCount, 0),
    generation: 0,
    task: null,
    retryTimer: null
  };
  continuousPrefetchSessions.set(sessionId, session);

  return scheduleContinuousPrefetchSession(session);
}

function prioritizeContinuousPreviewCache(metadata, startIndex) {
  const metadataKey = previewMetadataKey(metadata);
  const tasks = [];

  for (const session of continuousPrefetchSessions.values()) {
    if (session.metadataKey === metadataKey) {
      tasks.push(setContinuousPrefetchPriority(session, startIndex));
    }
  }

  return Promise.allSettled(tasks).then(() => undefined);
}

function setContinuousPrefetchPriority(session, startIndex) {
  const priorityStart = normalizeChunkIndex(startIndex, session.metadata.chunkCount);
  if (session.priorityStart !== priorityStart || session.completed) {
    session.priorityStart = priorityStart;
    session.queue = createPriorityChunkQueue(session.metadata.chunkCount, priorityStart);
    session.completed = false;
    session.generation += 1;
    clearContinuousPrefetchRetry(session);
  } else if (session.queue.length === 0 && !session.task) {
    session.queue = createPriorityChunkQueue(session.metadata.chunkCount, priorityStart);
  }

  return scheduleContinuousPrefetchSession(session);
}

function scheduleContinuousPrefetchSession(session) {
  if (session.completed) {
    return Promise.resolve();
  }

  if (session.queue.length === 0 && !session.task) {
    session.queue = createPriorityChunkQueue(session.metadata.chunkCount, session.priorityStart);
  }

  if (session.task) {
    return session.task;
  }

  const generation = session.generation;
  const task = runContinuousPrefetchQueue(session, generation)
    .then(() => {
      if (continuousPrefetchSessions.get(session.sessionId) !== session) {
        return;
      }

      if (session.task === task) {
        session.task = null;
      }

      if (generation !== session.generation) {
        if (session.active) {
          return scheduleContinuousPrefetchSession(session);
        }
        continuousPrefetchSessions.delete(session.sessionId);
        return;
      }

      const completed = session.queue.length === 0;

      if (session.active && completed) {
        session.completed = true;
        scheduleContinuousPrefetchExpiry(session, continuousPrefetchSessions);
      } else if (session.active && !completed) {
        scheduleContinuousPrefetchRetry(session, continuousPrefetchSessions, scheduleContinuousPrefetchSession);
      } else if (!session.active) {
        continuousPrefetchSessions.delete(session.sessionId);
      }
    });

  session.task = task;
  return session.task;
}

function stopContinuousPreviewCache(sessionId) {
  const session = continuousPrefetchSessions.get(sessionId);
  if (!session) {
    return;
  }

  session.active = false;
  clearContinuousPrefetchRetry(session);
  continuousPrefetchSessions.delete(sessionId);
}

async function runContinuousPrefetchQueue(session, generation) {
  await runConcurrentPrefetchWorkers(session, generation, continuousPrefetchSessions, async (chunkIndex) => {
    try {
      await ensureChunkCached(session.metadata, chunkIndex);
    } catch (error) {
      warnPreviewCacheError(`continuous prefetch chunk ${chunkIndex}`, error);
      throw error;
    }
  });
}

function createPriorityChunkQueue(chunkCount, startIndex) {
  if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0) {
    return [];
  }

  const start = normalizeChunkIndex(startIndex, chunkCount);
  const queue = [];

  for (let index = start; index < chunkCount; index += 1) {
    queue.push(index);
  }

  for (let index = 0; index < start; index += 1) {
    queue.push(index);
  }

  return queue;
}

function normalizeChunkIndex(startIndex, chunkCount) {
  if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0) {
    return 0;
  }

  const parsed = Math.floor(Number(startIndex));
  if (!Number.isSafeInteger(parsed)) {
    return 0;
  }

  return Math.min(chunkCount - 1, Math.max(0, parsed));
}

function isContinuousPrefetchSessionActive(session, sessions) {
  return session.active &&
    sessions.get(session.sessionId) === session &&
    Date.now() - session.lastHeartbeat <= CONTINUOUS_PREFETCH_SESSION_TTL_MS;
}

function scheduleContinuousPrefetchExpiry(session, sessions) {
  setTimeout(() => {
    if (
      sessions.get(session.sessionId) === session &&
      Date.now() - session.lastHeartbeat > CONTINUOUS_PREFETCH_SESSION_TTL_MS
    ) {
      sessions.delete(session.sessionId);
    }
  }, CONTINUOUS_PREFETCH_SESSION_TTL_MS + 1_000);
}

function scheduleContinuousPrefetchRetry(session, sessions, schedule) {
  if (session.retryTimer) {
    return;
  }

  const generation = session.generation;
  session.retryTimer = setTimeout(() => {
    session.retryTimer = null;
    if (
      sessions.get(session.sessionId) !== session ||
      !session.active ||
      generation !== session.generation ||
      Date.now() - session.lastHeartbeat > CONTINUOUS_PREFETCH_SESSION_TTL_MS
    ) {
      return;
    }

    void schedule(session);
  }, CONTINUOUS_PREFETCH_RETRY_DELAY_MS);
}

function clearContinuousPrefetchRetry(session) {
  if (!session.retryTimer) {
    return;
  }

  clearTimeout(session.retryTimer);
  session.retryTimer = null;
}

function getHotChunkBytes(metadata, chunkIndex) {
  const cacheKey = chunkCacheKey(metadata.fileId, chunkIndex);
  const entry = hotChunkCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  const expectedSize = expectedChunkSize(metadata, chunkIndex);
  if (entry.bytes.byteLength !== expectedSize) {
    deleteHotChunk(cacheKey);
    return null;
  }

  entry.lastAccessed = Date.now();
  hotChunkCache.delete(cacheKey);
  hotChunkCache.set(cacheKey, entry);
  return entry.bytes;
}

function putHotChunkBytes(metadata, chunkIndex, bytes) {
  if (!bytes || bytes.byteLength <= 0 || bytes.byteLength > HOT_CHUNK_CACHE_MAX_BYTES) {
    return;
  }

  const cacheKey = chunkCacheKey(metadata.fileId, chunkIndex);
  deleteHotChunk(cacheKey);
  hotChunkCache.set(cacheKey, {
    bytes,
    size: bytes.byteLength,
    lastAccessed: Date.now()
  });
  hotChunkCacheBytes += bytes.byteLength;
  pruneHotChunkCache();
}

function pruneHotChunkCache() {
  while (hotChunkCacheBytes > HOT_CHUNK_CACHE_MAX_BYTES) {
    const oldestKey = hotChunkCache.keys().next().value;
    if (!oldestKey) {
      hotChunkCacheBytes = 0;
      return;
    }
    deleteHotChunk(oldestKey);
  }
}

function deleteHotChunk(cacheKey) {
  const entry = hotChunkCache.get(cacheKey);
  if (!entry) {
    return;
  }
  hotChunkCache.delete(cacheKey);
  hotChunkCacheBytes -= safeSize(entry.size);
}

function chunkCacheKey(fileId, chunkIndex) {
  return `${self.location.origin}/__preview-cache/files/${encodeURIComponent(fileId)}/chunks/${chunkIndex}`;
}

function fileRecordCacheKey(fileId) {
  return `${FILE_RECORD_CACHE_KEY_PREFIX}${encodeURIComponent(fileId)}`;
}

function isFileRecordMetadata(entry) {
  return Boolean(entry?.recordType === "file" || (typeof entry?.cacheKey === "string" && entry.cacheKey.startsWith(FILE_RECORD_CACHE_KEY_PREFIX)));
}

async function cleanupPreviewCache(incomingBytes = 0, cacheMaxBytes = DEFAULT_MAX_CACHE_BYTES) {
  const entries = await getAllChunkMetadata();
  const autoEntries = entries.filter((entry) => entry?.cacheSource !== "manual" && !isFileRecordMetadata(entry));
  let total = autoEntries.reduce((sum, entry) => sum + safeSize(entry.size), 0) + safeSize(incomingBytes);
  const maxBytes = Math.max(1, cacheMaxBytes);
  const targetBytes = Math.floor(maxBytes * 0.9);

  if (total <= maxBytes) {
    return;
  }

  const victims = autoEntries
    .slice()
    .sort((left, right) => safeTime(left.lastAccessed) - safeTime(right.lastAccessed));

  for (const entry of victims) {
    await deleteChunk(entry.cacheKey);
    total -= safeSize(entry.size);
    if (total <= targetBytes) {
      break;
    }
  }
}

async function deleteChunk(cacheKey) {
  deleteHotChunk(cacheKey);
  const cache = await caches.open(CACHE_NAME);
  await cache.delete(cacheKey);
  invalidateCacheStorageMetadataSnapshot();
  await deleteChunkMetadata(cacheKey);
}

async function putFileRecordMetadata(metadata, extra = {}) {
  const now = Date.now();
  const recordKey = fileRecordCacheKey(metadata.fileId);
  const existingRecord = await getChunkMetadata(recordKey).catch(() => null);
  const chunks = await getAllChunkMetadata();
  const keepManual = metadata.cacheSource === "manual" || existingRecord?.cacheSource === "manual";
  const keepRecord = keepManual || extra.keepFileRecord === true;
  const relatedChunks = chunks.filter((chunk) => chunk?.fileId === metadata.fileId && !isFileRecordMetadata(chunk));
  const hasManualCacheStatus = Object.prototype.hasOwnProperty.call(extra, "manualCacheStatus");
  const nextManualCacheStatus = hasManualCacheStatus
    ? normalizeManualCacheStatus(extra.manualCacheStatus)
    : normalizeManualCacheStatus(metadata.manualCacheStatus) || normalizeManualCacheStatus(existingRecord?.manualCacheStatus);

  if (keepRecord) {
    await putChunkMetadata({
      cacheKey: recordKey,
      recordType: "file",
      fileId: metadata.fileId,
      chunkIndex: -1,
      fileName: metadata.fileName || existingRecord?.fileName || metadata.fileId,
      directoryPath: metadata.directoryPath || existingRecord?.directoryPath || "/",
      kind: metadata.kind || existingRecord?.kind || "single",
      mimeType: metadata.mimeType || existingRecord?.mimeType || "application/octet-stream",
      totalSize: metadata.size || existingRecord?.totalSize || 0,
      chunkSize: metadata.chunkSize || existingRecord?.chunkSize || 1,
      chunkCount: metadata.chunkCount || existingRecord?.chunkCount || 1,
      sourceUrl: metadata.sourceUrl || existingRecord?.sourceUrl || "",
      token: metadata.token || existingRecord?.token || "",
      cacheSource: keepManual ? "manual" : metadata.cacheSource || existingRecord?.cacheSource || "auto",
      size: 0,
      manualCacheStatus: nextManualCacheStatus,
      manualStartedAt: extra.manualStartedAt || metadata.manualStartedAt || existingRecord?.manualStartedAt,
      createdAt: existingRecord?.createdAt || now,
      lastAccessed: now
    }, true);
  }

  await Promise.all(relatedChunks.map((chunk) => putChunkMetadata({
      ...chunk,
      fileName: metadata.fileName || chunk.fileName || metadata.fileId,
      directoryPath: metadata.directoryPath || chunk.directoryPath || "/",
      kind: metadata.kind || chunk.kind || "single",
      mimeType: metadata.mimeType || chunk.mimeType || "application/octet-stream",
      totalSize: metadata.size || chunk.totalSize || chunk.size,
      chunkSize: metadata.chunkSize || chunk.chunkSize || chunk.size,
      chunkCount: metadata.chunkCount || chunk.chunkCount || 1,
      sourceUrl: metadata.sourceUrl || chunk.sourceUrl || "",
      token: metadata.token || chunk.token || "",
      cacheSource: keepManual ? "manual" : metadata.cacheSource || chunk.cacheSource || "auto",
      manualCacheStatus: hasManualCacheStatus
        ? normalizeManualCacheStatus(extra.manualCacheStatus)
        : normalizeManualCacheStatus(metadata.manualCacheStatus) || normalizeManualCacheStatus(chunk.manualCacheStatus),
      manualStartedAt: extra.manualStartedAt || metadata.manualStartedAt || chunk.manualStartedAt,
      lastAccessed: Date.now()
    }, true)));
}

async function getChunkMetadata(cacheKey) {
  return withStore("readonly", (store) =>
    new Promise((resolve, reject) => {
      const request = store.get(cacheKey);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Failed to read cache metadata"));
    })
  );
}

async function readFileCacheSummary() {
  const entries = await getAllChunkMetadata();
  const byFile = new Map();

  for (const entry of entries) {
    if (!entry?.fileId || !entry.cacheKey) {
      continue;
    }

    const isFileRecord = isFileRecordMetadata(entry);
    const current = byFile.get(entry.fileId) || {
      fileId: entry.fileId,
      fileName: entry.fileName || entry.fileId,
      directoryPath: entry.directoryPath || "/",
      kind: entry.kind || "single",
      mimeType: entry.mimeType || "application/octet-stream",
      size: safeSize(entry.totalSize),
      chunkSize: safeSize(entry.chunkSize),
      chunkCount: Number.isSafeInteger(entry.chunkCount) && entry.chunkCount > 0 ? entry.chunkCount : 1,
      sourceUrl: entry.sourceUrl || "",
      token: entry.token || "",
      cachedChunkIndexes: new Set(),
      cachedBytes: 0,
      manualBytes: 0,
      autoBytes: 0,
      cacheSource: "auto",
      manualCacheStatus: undefined,
      manualStartedAt: 0,
      lastAccessed: 0
    };

    if (isFileRecord || !current.hasFileRecord) {
      current.fileName = entry.fileName || current.fileName;
      current.directoryPath = entry.directoryPath || current.directoryPath || "/";
      current.kind = entry.kind || current.kind || "single";
      current.mimeType = entry.mimeType || current.mimeType;
      current.sourceUrl = entry.sourceUrl || current.sourceUrl || "";
      current.token = entry.token || current.token || "";
    }
    if (isFileRecord) {
      current.hasFileRecord = true;
    }
    current.size = Math.max(current.size, safeSize(entry.totalSize));
    current.chunkSize = Math.max(current.chunkSize, safeSize(entry.chunkSize));
    current.chunkCount = Math.max(current.chunkCount, Number.isSafeInteger(entry.chunkCount) ? entry.chunkCount : 1);
    if (!isFileRecord) {
      current.cachedChunkIndexes.add(Number(entry.chunkIndex));
      current.cachedBytes += safeSize(entry.size);
    }
    current.lastAccessed = Math.max(current.lastAccessed, safeTime(entry.lastAccessed));
    current.manualStartedAt = current.manualStartedAt || safeTime(entry.manualStartedAt);

    if (entry.cacheSource === "manual") {
      if (!isFileRecord) {
        current.manualBytes += safeSize(entry.size);
      }
      current.cacheSource = "manual";
      current.manualCacheStatus = entry.manualCacheStatus || current.manualCacheStatus;
      current.manualStartedAt = current.manualStartedAt || safeTime(entry.manualStartedAt) || safeTime(entry.createdAt);
    } else if (!isFileRecord) {
      current.autoBytes += safeSize(entry.size);
    }

    byFile.set(entry.fileId, current);
  }

  const normalizedEntries = Array.from(byFile.values())
    .map((entry) => {
      const complete = entry.cachedBytes >= entry.size && entry.size > 0;
      return {
        fileId: entry.fileId,
        fileName: entry.fileName,
        directoryPath: entry.directoryPath || "/",
        kind: entry.kind || "single",
        mimeType: entry.mimeType,
        size: entry.size,
        chunkSize: entry.chunkSize,
        chunkCount: entry.chunkCount,
        sourceUrl: entry.sourceUrl || undefined,
        token: entry.token || undefined,
        cachedChunks: Array.from(entry.cachedChunkIndexes).filter((index) => Number.isSafeInteger(index) && index >= 0).length,
        cachedBytes: entry.cachedBytes,
        manualBytes: entry.manualBytes,
        autoBytes: entry.autoBytes,
        cacheSource: entry.cacheSource,
        manualCacheStatus: entry.cacheSource === "manual" && !complete ? normalizeManualCacheStatus(entry.manualCacheStatus) || "paused" : undefined,
        manualStartedAt: entry.manualStartedAt || 0,
        lastAccessed: entry.lastAccessed,
        complete
      };
    })
    .sort(compareFileCacheEntries);

  const fallbackEntries = await readCacheStorageFileSummaries();
  for (const fallback of fallbackEntries) {
    if (!fallback?.fileId) {
      continue;
    }

    const existing = normalizedEntries.find((entry) => entry.fileId === fallback.fileId);
    if (existing) {
      const existingCachedBytes = existing.cachedBytes;
      existing.cachedBytes = Math.max(existing.cachedBytes, fallback.cachedBytes);
      existing.cachedChunks = Math.max(existing.cachedChunks, fallback.cachedChunks.length);
      existing.size = Math.max(existing.size, safeSize(fallback.size));
      existing.chunkSize = Math.max(existing.chunkSize, safeSize(fallback.chunkSize));
      existing.chunkCount = Math.max(existing.chunkCount, Number.isSafeInteger(fallback.chunkCount) ? fallback.chunkCount : 1);
      existing.lastAccessed = Math.max(safeTime(existing.lastAccessed), safeTime(fallback.lastAccessed));
      if (!existing.sourceUrl && fallback.sourceUrl) existing.sourceUrl = fallback.sourceUrl;
      if (!existing.token && fallback.token) existing.token = fallback.token;
      if (fallback.cacheSource === "manual") {
        existing.cacheSource = "manual";
        existing.manualBytes = Math.max(existing.manualBytes, fallback.manualBytes || fallback.cachedBytes);
        existing.manualStartedAt = existing.manualStartedAt || fallback.manualStartedAt || 0;
      } else if (existing.cacheSource !== "manual") {
        existing.autoBytes = Math.max(existing.autoBytes, fallback.autoBytes || fallback.cachedBytes);
      }
      if (existing.cachedBytes !== existingCachedBytes) {
        existing.complete = existing.cachedBytes >= existing.size && existing.size > 0;
      }
      existing.manualCacheStatus = existing.cacheSource === "manual" && !existing.complete
        ? normalizeManualCacheStatus(existing.manualCacheStatus || fallback.manualCacheStatus) || "paused"
        : undefined;
      continue;
    }

    normalizedEntries.push({
      fileId: fallback.fileId,
      fileName: fallback.fileName || fallback.fileId,
      directoryPath: fallback.directoryPath || "/",
      kind: fallback.kind || "single",
      mimeType: fallback.mimeType || "application/octet-stream",
      size: safeSize(fallback.size),
      chunkSize: safeSize(fallback.chunkSize),
      chunkCount: Number.isSafeInteger(fallback.chunkCount) && fallback.chunkCount > 0 ? fallback.chunkCount : Math.max(1, fallback.cachedChunks.length || 1),
      sourceUrl: fallback.sourceUrl || undefined,
      token: fallback.token || undefined,
      cachedChunks: fallback.cachedChunks.length,
      cachedBytes: fallback.cachedBytes,
      manualBytes: fallback.manualBytes,
      autoBytes: fallback.autoBytes,
      cacheSource: fallback.cacheSource,
      manualCacheStatus: fallback.cacheSource === "manual" && !fallback.complete ? normalizeManualCacheStatus(fallback.manualCacheStatus) || "paused" : undefined,
      manualStartedAt: fallback.manualStartedAt || 0,
      lastAccessed: fallback.lastAccessed || 0,
      complete: fallback.complete
    });
  }

  normalizedEntries.sort(compareFileCacheEntries);

  for (const session of fileCacheSessions.values()) {
    if (session.status !== "caching" && session.status !== "paused") {
      continue;
    }

    const existing = normalizedEntries.find((entry) => entry.fileId === session.fileId);
    if (existing) {
      existing.manualCacheStatus = session.status;
      existing.cacheSource = "manual";
      existing.manualStartedAt = session.manualStartedAt || existing.manualStartedAt || Date.now();
      continue;
    }

    normalizedEntries.unshift({
      fileId: session.metadata.fileId,
      fileName: session.metadata.fileName,
      directoryPath: session.metadata.directoryPath || "/",
      kind: session.metadata.kind,
      mimeType: session.metadata.mimeType || "application/octet-stream",
      size: safeSize(session.metadata.size),
      chunkSize: safeSize(session.metadata.chunkSize),
      chunkCount: Number.isSafeInteger(session.metadata.chunkCount) && session.metadata.chunkCount > 0 ? session.metadata.chunkCount : 1,
      sourceUrl: session.metadata.sourceUrl || undefined,
      token: session.metadata.token || undefined,
      cachedChunks: 0,
      cachedBytes: 0,
      manualBytes: 0,
      autoBytes: 0,
      cacheSource: "manual",
      manualCacheStatus: session.status,
      manualStartedAt: session.manualStartedAt || Date.now(),
      lastAccessed: Date.now(),
      complete: false
    });
  }

  normalizedEntries.sort(compareFileCacheEntries);
  scheduleCacheStorageMetadataRebuild();

  return {
    entries: normalizedEntries,
    totalBytes: normalizedEntries.reduce((sum, entry) => sum + entry.cachedBytes, 0),
    manualBytes: normalizedEntries.reduce((sum, entry) => sum + entry.manualBytes, 0),
    autoBytes: normalizedEntries.reduce((sum, entry) => sum + entry.autoBytes, 0)
  };
}

function compareFileCacheEntries(left, right) {
  const leftManual = left.cacheSource === "manual" || Boolean(left.manualCacheStatus) || safeTime(left.manualStartedAt) > 0;
  const rightManual = right.cacheSource === "manual" || Boolean(right.manualCacheStatus) || safeTime(right.manualStartedAt) > 0;

  if (leftManual !== rightManual) {
    return leftManual ? -1 : 1;
  }

  if (leftManual && rightManual) {
    return (safeTime(right.manualStartedAt) || safeTime(right.lastAccessed)) -
      (safeTime(left.manualStartedAt) || safeTime(left.lastAccessed));
  }

  return safeTime(right.lastAccessed) - safeTime(left.lastAccessed);
}

async function readCacheStorageMetadataForFile(fileId) {
  const normalizedFileId = normalizeFileId(fileId);
  if (!normalizedFileId) {
    return { entries: [], cachedChunks: [] };
  }

  const entries = await readCacheStorageMetadataSnapshot();
  const fileEntries = entries.filter((entry) => entry.fileId === normalizedFileId);
  const seen = new Set();
  const cachedChunks = [];

  for (const entry of fileEntries) {
    if (!Number.isSafeInteger(entry.chunkIndex) || entry.chunkIndex < 0 || seen.has(entry.chunkIndex)) {
      continue;
    }
    seen.add(entry.chunkIndex);
    cachedChunks.push(entry.chunkIndex);
  }

  cachedChunks.sort((left, right) => left - right);
  return { entries: fileEntries, cachedChunks };
}

async function readCacheStorageFileSummaries() {
  const entries = await readCacheStorageMetadataSnapshot();
  const byFile = new Map();

  for (const entry of entries) {
    if (!entry?.fileId || !entry.cacheKey) {
      continue;
    }

    const current = byFile.get(entry.fileId) || {
      fileId: entry.fileId,
      fileName: entry.fileName || entry.fileId,
      directoryPath: entry.directoryPath || "/",
      kind: entry.kind || "single",
      mimeType: entry.mimeType || "application/octet-stream",
      size: 0,
      chunkSize: 0,
      chunkCount: 0,
      sourceUrl: entry.sourceUrl || "",
      token: entry.token || "",
      cachedChunkIndexes: new Set(),
      maxChunkIndex: -1,
      cachedBytes: 0,
      manualBytes: 0,
      autoBytes: 0,
      cacheSource: "auto",
      manualCacheStatus: undefined,
      hasKnownTotalSize: false,
      hasKnownChunkCount: false,
      manualStartedAt: 0,
      lastAccessed: 0
    };

    current.fileName = entry.fileName || current.fileName || entry.fileId;
    current.directoryPath = entry.directoryPath || current.directoryPath || "/";
    current.kind = entry.kind || current.kind || "single";
    current.mimeType = entry.mimeType || current.mimeType || "application/octet-stream";
    if (safeSize(entry.totalSize) > 0) {
      current.hasKnownTotalSize = true;
      current.size = Math.max(current.size, safeSize(entry.totalSize));
    }
    current.chunkSize = Math.max(current.chunkSize, safeSize(entry.chunkSize));
    if (Number.isSafeInteger(entry.chunkCount) && entry.chunkCount > 0) {
      current.hasKnownChunkCount = true;
      current.chunkCount = Math.max(current.chunkCount, entry.chunkCount);
    }
    current.sourceUrl = entry.sourceUrl || current.sourceUrl || "";
    current.token = entry.token || current.token || "";
    current.lastAccessed = Math.max(current.lastAccessed, safeTime(entry.lastAccessed));
    current.manualStartedAt = current.manualStartedAt || safeTime(entry.manualStartedAt);

    if (Number.isSafeInteger(entry.chunkIndex) && entry.chunkIndex >= 0) {
      current.cachedChunkIndexes.add(entry.chunkIndex);
      current.maxChunkIndex = Math.max(current.maxChunkIndex, entry.chunkIndex);
      current.cachedBytes += safeSize(entry.size);
    }

    if (entry.cacheSource === "manual") {
      current.manualBytes += safeSize(entry.size);
      current.cacheSource = "manual";
      current.manualCacheStatus = normalizeManualCacheStatus(entry.manualCacheStatus) || current.manualCacheStatus;
      current.manualStartedAt = current.manualStartedAt || safeTime(entry.manualStartedAt) || safeTime(entry.createdAt);
    } else {
      current.autoBytes += safeSize(entry.size);
    }

    byFile.set(entry.fileId, current);
  }

  return Array.from(byFile.values()).map((entry) => {
    const cachedChunks = Array.from(entry.cachedChunkIndexes)
      .filter((index) => Number.isSafeInteger(index) && index >= 0)
      .sort((left, right) => left - right);
    const inferredChunkCount = entry.hasKnownChunkCount && entry.chunkCount > 0
      ? entry.chunkCount
      : Math.max(1, entry.maxChunkIndex + 1);
    const inferredChunkSize = entry.chunkSize > 0
      ? entry.chunkSize
      : inferChunkSizeFromCachedBytes(entry.cachedBytes, cachedChunks.length);
    const inferredSize = entry.hasKnownTotalSize && entry.size > 0
      ? entry.size
      : 0;
    const complete = entry.hasKnownTotalSize
      ? entry.cachedBytes >= inferredSize && inferredSize > 0
      : entry.hasKnownChunkCount && cachedChunks.length > 0 && cachedChunks.length >= inferredChunkCount;

    return {
      fileId: entry.fileId,
      fileName: entry.fileName || entry.fileId,
      directoryPath: entry.directoryPath || "/",
      kind: entry.kind || "single",
      mimeType: entry.mimeType || "application/octet-stream",
      size: inferredSize,
      chunkSize: inferredChunkSize,
      chunkCount: inferredChunkCount,
      sourceUrl: entry.sourceUrl || "",
      token: entry.token || "",
      cachedChunks,
      cachedBytes: entry.cachedBytes,
      manualBytes: entry.manualBytes,
      autoBytes: entry.autoBytes,
      cacheSource: entry.cacheSource,
      manualCacheStatus: normalizeManualCacheStatus(entry.manualCacheStatus),
      manualStartedAt: entry.manualStartedAt || 0,
      lastAccessed: entry.lastAccessed || 0,
      complete
    };
  });
}

function inferChunkSizeFromCachedBytes(cachedBytes, chunkCount) {
  if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0) {
    return safeSize(cachedBytes) || 1;
  }

  return Math.max(1, Math.ceil(safeSize(cachedBytes) / chunkCount));
}

async function readCacheStorageMetadataSnapshot() {
  const now = Date.now();
  if (cacheStorageMetadataSnapshot && now - cacheStorageMetadataSnapshotAt < CACHE_STORAGE_METADATA_SNAPSHOT_TTL_MS) {
    return cacheStorageMetadataSnapshot;
  }

  if (!cacheStorageMetadataSnapshotPromise) {
    cacheStorageMetadataSnapshotPromise = readCacheStorageMetadataEntries()
      .then((entries) => {
        cacheStorageMetadataSnapshot = entries;
        cacheStorageMetadataSnapshotAt = Date.now();
        return entries;
      })
      .finally(() => {
        cacheStorageMetadataSnapshotPromise = null;
      });
  }

  return cacheStorageMetadataSnapshotPromise;
}

async function readCacheStorageMetadataEntries() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    const entries = [];

    for (const request of requests) {
      const parsed = parseCacheStorageCacheKey(request.url);
      if (!parsed) {
        continue;
      }

      entries.push(cacheStorageEntryFromRequest(parsed));
    }

    return entries;
  } catch (error) {
    warnPreviewCacheError("scan CacheStorage metadata", error);
    return [];
  }
}

function parseCacheStorageCacheKey(cacheKey) {
  try {
    const url = new URL(cacheKey);
    if (url.origin !== self.location.origin) {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "__preview-cache") {
      return null;
    }

    if (parts[1] === "files" && parts[3] === "chunks") {
      const fileId = decodeURIComponent(parts[2] || "");
      const chunkIndex = Math.floor(Number(parts[4]));
      if (!fileId || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
        return null;
      }
      return {
        cacheKey: url.href,
        fileId,
        chunkIndex,
        partKind: "chunk",
        partIndex: chunkIndex
      };
    }

    if (parts[1] === "hls") {
      const fileId = decodeURIComponent(parts[2] || "");
      const partKind = parts[3] === "init" ? "init" : "segment";
      const partIndex = Math.floor(Number(parts[4]));
      if (!fileId || !Number.isSafeInteger(partIndex) || partIndex < 0) {
        return null;
      }
      return {
        cacheKey: url.href,
        fileId,
        chunkIndex: hlsChunkIndex(partKind, partIndex),
        partKind,
        partIndex
      };
    }
  } catch {
    return null;
  }

  return null;
}

function cacheStorageEntryFromRequest(parsed) {
  return {
    cacheKey: parsed.cacheKey,
    fileId: parsed.fileId,
    chunkIndex: parsed.chunkIndex,
    fileName: parsed.fileId,
    directoryPath: "/",
    kind: parsed.partKind === "chunk" ? "single" : "hls",
    mimeType: "application/octet-stream",
    totalSize: 0,
    chunkSize: 0,
    chunkCount: 0,
    sourceUrl: "",
    token: "",
    cacheSource: "auto",
    manualCacheStatus: undefined,
    manualStartedAt: 0,
    partKind: parsed.partKind,
    partIndex: parsed.partIndex,
    size: 0,
    createdAt: 0,
    lastAccessed: Date.now()
  };
}

function cacheStorageEntryFromResponse(parsed, response) {
  const headers = response.headers;
  const responseSize = safeSize(Number(headers.get("Content-Length")));
  const totalSize = safeSize(Number(headers.get("X-Preview-Cache-Total-Size")));
  const chunkSize = safeSize(Number(headers.get("X-Preview-Cache-Chunk-Size"))) || responseSize;
  const chunkCount = Math.floor(Number(headers.get("X-Preview-Cache-Chunk-Count")));
  const partKind = headers.get("X-Preview-Cache-Part-Kind") || parsed.partKind;
  const fileName = decodeMetadataHeader(headers.get("X-Preview-Cache-File-Name")) || parsed.fileId;
  const directoryPath = normalizeDirectoryPath(decodeMetadataHeader(headers.get("X-Preview-Cache-Directory-Path")) || "/");
  const cacheSource = normalizeCacheSource(headers.get("X-Preview-Cache-Source"));

  return {
    cacheKey: parsed.cacheKey,
    fileId: parsed.fileId,
    chunkIndex: parsed.chunkIndex,
    fileName,
    directoryPath,
    kind: parsed.partKind === "chunk" ? normalizeFileCacheKind(headers.get("X-Preview-Cache-Kind")) || "single" : "hls",
    mimeType: headers.get("X-Preview-Cache-Mime") || response.headers.get("Content-Type") || "application/octet-stream",
    totalSize,
    chunkSize,
    chunkCount: Number.isSafeInteger(chunkCount) && chunkCount > 0 ? chunkCount : 0,
    sourceUrl: decodeMetadataHeader(headers.get("X-Preview-Cache-Source-Url")) || "",
    token: decodeMetadataHeader(headers.get("X-Preview-Cache-Token")) || "",
    cacheSource,
    manualCacheStatus: normalizeManualCacheStatus(headers.get("X-Preview-Cache-Manual-Status")),
    manualStartedAt: safeTime(Number(headers.get("X-Preview-Cache-Manual-Started-At"))),
    partKind,
    partIndex: parsed.partIndex,
    size: responseSize,
    createdAt: safeTime(Number(headers.get("X-Preview-Cache-Created-At"))),
    lastAccessed: safeTime(Number(headers.get("X-Preview-Cache-Last-Accessed"))) || safeTime(Number(headers.get("Date")))
  };
}

function scheduleCacheStorageMetadataRebuild() {
  if (cacheStorageMetadataRebuildPromise) {
    return;
  }

  cacheStorageMetadataRebuildPromise = rebuildCacheStorageMetadata()
    .catch((error) => {
      warnPreviewCacheError("rebuild CacheStorage metadata", error);
    })
    .finally(() => {
      cacheStorageMetadataRebuildPromise = null;
    });
}

async function rebuildCacheStorageMetadata() {
  const cache = await caches.open(CACHE_NAME);
  const requests = await cache.keys();

  for (const request of requests) {
    const parsed = parseCacheStorageCacheKey(request.url);
    if (!parsed) {
      continue;
    }

    const existing = await getChunkMetadata(parsed.cacheKey).catch(() => null);
    if (existing && safeSize(existing.size) > 0 && safeSize(existing.totalSize) > 0 && existing.fileName && existing.fileName !== existing.fileId) {
      continue;
    }

    const response = await cache.match(request);
    if (!response) {
      continue;
    }

    const entry = cacheStorageEntryFromResponse(parsed, response);
    if (safeSize(entry.size) <= 0) {
      continue;
    }
    await putChunkMetadata(entry, true);
  }

  invalidateCacheStorageMetadataSnapshot();
}

function decodeMetadataHeader(value) {
  if (typeof value !== "string" || !value) {
    return "";
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function invalidateCacheStorageMetadataSnapshot() {
  cacheStorageMetadataSnapshot = null;
  cacheStorageMetadataSnapshotAt = 0;
}

async function readFileCacheEntry(fileId) {
  const normalizedFileId = normalizeFileId(fileId);
  if (!normalizedFileId) {
    return null;
  }

  const summary = await readFileCacheSummary();
  return summary.entries.find((entry) => entry.fileId === normalizedFileId) || null;
}

async function deleteFileCache(fileId) {
  const normalizedFileId = normalizeFileId(fileId);
  if (!normalizedFileId) {
    return;
  }

  const entries = await getAllChunkMetadata();
  for (const entry of entries) {
    if (entry?.fileId === normalizedFileId) {
      await deleteChunk(entry.cacheKey);
    }
  }

  await deleteCacheStorageEntriesForFile(normalizedFileId);
  await deleteCachedHlsPlaylist(normalizedFileId);
}

async function clearAutomaticCacheEntries() {
  const entries = await getAllChunkMetadata();
  const manualCacheKeys = new Set();
  const manualFileIds = new Set();
  for (const entry of entries) {
    if (entry?.cacheSource === "manual") {
      if (entry.fileId) {
        manualFileIds.add(entry.fileId);
      }
      if (entry.cacheKey) {
        manualCacheKeys.add(entry.cacheKey);
      }
    } else if (entry?.cacheKey) {
      await deleteChunk(entry.cacheKey);
    }
  }

  const fallbackEntries = await readCacheStorageMetadataSnapshot();
  for (const entry of fallbackEntries) {
    if (entry?.cacheSource === "manual" || manualCacheKeys.has(entry.cacheKey) || manualFileIds.has(entry.fileId)) {
      continue;
    }
    await deleteChunk(entry.cacheKey);
  }
}

async function deleteCacheStorageEntriesForFile(fileId) {
  const fallbackEntries = await readCacheStorageMetadataForFile(fileId);
  for (const entry of fallbackEntries.entries) {
    await deleteChunk(entry.cacheKey);
  }
}

function normalizeFileId(value) {
  return typeof value === "string" && value.trim() ? value : "";
}

function safeSize(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function safeTime(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function warnPreviewCacheError(operation, error) {
  console.warn(
    `[video-preview-sw] preview cache ${operation} failed`,
    error instanceof Error ? error.message : error
  );
}

function openMetadataDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
        store.createIndex("lastAccessed", "lastAccessed");
        store.createIndex("fileId", "fileId");
      } else {
        const store = request.transaction.objectStore(STORE_NAME);
        if (!store.indexNames.contains("lastAccessed")) {
          store.createIndex("lastAccessed", "lastAccessed");
        }
        if (!store.indexNames.contains("fileId")) {
          store.createIndex("fileId", "fileId");
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open preview cache metadata"));
  });
}

async function withStore(mode, callback) {
  const db = await openMetadataDb();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const result = callback(store);

      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error("Preview cache metadata transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("Preview cache metadata transaction aborted"));
    });
  } finally {
    db.close();
  }
}

async function putChunkMetadata(entry, preserveCreatedAt) {
  await withStore("readwrite", (store) => {
    if (!preserveCreatedAt) {
      store.put(entry);
      return undefined;
    }

    const getRequest = store.get(entry.cacheKey);
    getRequest.onsuccess = () => {
      const existing = getRequest.result;
      const existingManual = existing?.cacheSource === "manual";
      const nextManual = entry.cacheSource === "manual";
      store.put({
        ...existing,
        ...entry,
        cacheSource: existingManual || nextManual ? "manual" : entry.cacheSource || "auto",
        createdAt: existing?.createdAt || entry.createdAt,
        fileName: entry.fileName || existing?.fileName || entry.fileId,
        directoryPath: entry.directoryPath || existing?.directoryPath || "/",
        kind: entry.kind || existing?.kind || "single",
        mimeType: entry.mimeType || existing?.mimeType || "application/octet-stream",
        totalSize: entry.totalSize || existing?.totalSize || entry.size,
        chunkSize: entry.chunkSize || existing?.chunkSize || entry.size,
        chunkCount: entry.chunkCount || existing?.chunkCount || 1,
        sourceUrl: entry.sourceUrl || existing?.sourceUrl || "",
        token: entry.token || existing?.token || "",
        manualCacheStatus: Object.prototype.hasOwnProperty.call(entry, "manualCacheStatus")
          ? normalizeManualCacheStatus(entry.manualCacheStatus)
          : normalizeManualCacheStatus(existing?.manualCacheStatus),
        manualStartedAt: entry.manualStartedAt || existing?.manualStartedAt
      });
    };
    return undefined;
  });
}

async function deleteChunkMetadata(cacheKey) {
  await withStore("readwrite", (store) => {
    store.delete(cacheKey);
    return undefined;
  });
}

async function getAllChunkMetadata() {
  return withStore("readonly", (store) =>
    new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error("Failed to read preview cache metadata"));
    })
  );
}
