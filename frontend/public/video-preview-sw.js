const CACHE_NAME = "tgbot-files-video-preview-v1";
const DB_NAME = "tgbot-files-video-preview-cache";
const STORE_NAME = "chunks";
const DB_VERSION = 2;
const FILE_RECORD_CACHE_KEY_PREFIX = `${self.location.origin}/__preview-cache/file-records/`;
const DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const RESPONSE_WINDOW_BYTES = 2 * 1024 * 1024;
const DEFAULT_PREVIEW_PREFETCH_CONCURRENCY = 5;
const MAX_PREVIEW_PREFETCH_CONCURRENCY = 32;
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
const previewFileCacheSessions = new Map();
let cacheStorageMetadataSnapshot = null;
let cacheStorageMetadataSnapshotAt = 0;
let cacheStorageMetadataSnapshotPromise = null;
let hotChunkCacheBytes = 0;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    void cleanupPreviewCache().catch((error) => {
      warnPreviewCacheError("cleanup on activate", error);
    });
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
  event.waitUntil(writeCachedHlsPlaylistText(metadata.fileId, playlistText));
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
    const response = await fetchAndCacheHlsPart({ fileId, partKind, partIndex, sourceUrl, cacheMaxBytes, metadata });
    if (partKind === "segment") {
      event.waitUntil(prioritizeHlsPreviewCache(fileId, partIndex, cacheMaxBytes, prefetchConcurrency));
      event.waitUntil(prefetchHlsSegments(fileId, partIndex + 1, prefetchConcurrency, cacheMaxBytes));
    }

    const rangeHeader = request.headers.get("Range");
    if (!rangeHeader) {
      return response;
    }

    const bytes = await response.arrayBuffer();
    const range = parseRange(rangeHeader, bytes.byteLength, bytes.byteLength);
    if (!range) {
      return rangeNotSatisfiable(bytes.byteLength);
    }

    return createHlsPartRangeResponse(bytes, range, response.headers.get("Content-Type") || "application/octet-stream");
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
    let result = null;

    if (event.data.type === "FILE_CACHE_START_PREVIEW") {
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
    } else if (event.data.type === "FILE_CACHE_STATE_REQUEST") {
      const metadata = normalizeFileCacheMetadata(event.data.metadata);
      if (!metadata) throw new Error("文件缓存参数无效");
      result = await readFileCacheEntry(metadata.fileId);
    } else if (event.data.type === "FILE_CACHE_LIST_REQUEST") {
      result = await readFileCacheSummary();
    } else if (event.data.type === "FILE_CACHE_CLEAR_FILE") {
      await deleteFileCache(normalizeFileId(event.data.fileId));
      result = await readFileCacheSummary();
    } else if (event.data.type === "FILE_CACHE_CLEAR_FILES") {
      const fileIds = Array.isArray(event.data.fileIds) ? event.data.fileIds.map(normalizeFileId).filter(Boolean) : [];
      for (const fileId of fileIds) {
        await deleteFileCache(fileId);
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
  await runConcurrentCacheWorkers(session, queue, async (chunkIndex) => {
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

async function runConcurrentCacheWorkers(session, queue, loadNext) {
  const workerCount = Math.min(DEFAULT_PREVIEW_PREFETCH_CONCURRENCY, Math.max(1, queue.length));

  async function runWorker() {
    while (queue.length > 0) {
      throwIfPreviewFileCacheStopped(session);
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

async function cacheWholeHlsFile(metadata, session) {
  const response = await fetch(metadata.sourceUrl, { credentials: "omit", signal: session.controller.signal });
  if (!response.ok) {
    throw new Error(`HLS 播放列表加载失败（HTTP ${response.status}）`);
  }

  const playlistText = await response.text();
  await writeCachedHlsPlaylistText(metadata.fileId, playlistText);
  const rewritten = rewriteHlsPlaylist(playlistText, metadata);
  hlsPreviewSources.set(metadata.fileId, rewritten.sources);
  const queue = createHlsPriorityQueue(rewritten.sources, 0);
  await runConcurrentCacheWorkers(session, queue, async (part) => {
    if (!part?.sourceUrl) {
      return;
    }

    const partMetadata = part.partKind === "segment"
      ? {
          ...metadata,
          chunkCount: rewritten.sources.segments.length
        }
      : metadata;
    await fetchAndCacheHlsPart({
      fileId: metadata.fileId,
      partKind: part.partKind,
      partIndex: part.partIndex,
      sourceUrl: part.sourceUrl,
      cacheMaxBytes: metadata.cacheMaxBytes,
      cacheSource: metadata.cacheSource || "auto",
      metadata: partMetadata,
      signal: session.controller.signal
    });
  });
}

async function updateFileCacheAccess(metadata, chunkIndex) {
  await putFileRecordMetadata(metadata);

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
        cacheSource: metadata.cacheSource || "auto",
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

  await cleanupPreviewCache(bytes.byteLength, cacheMaxBytes);
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
    createdAt: now,
    lastAccessed: now
  }, true);
  await cleanupPreviewCache(0, cacheMaxBytes);

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

function createHlsPartRangeResponse(bytes, range, contentType) {
  const slice = bytes.slice(range.start, range.end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Type": contentType,
      "Content-Length": String(slice.byteLength),
      "Content-Range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
      "X-Preview-Cache": "hls-segment-range"
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
  return "auto";
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
    const cache = await caches.open(CACHE_NAME);

    for (const entry of entries) {
      if (entry?.fileId !== metadata.fileId) {
        continue;
      }

      const chunkIndex = Math.floor(Number(entry.chunkIndex));
      if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount || seen.has(chunkIndex)) {
        continue;
      }

      const cacheKey = metadata.kind === "hls"
        ? hlsPartCacheKey(metadata.fileId, "segment", chunkIndex)
        : chunkCacheKey(metadata.fileId, chunkIndex);
      const cached = await cache.match(cacheKey);
      if (!isUsableCachedChunkResponse(metadata, chunkIndex, cached)) {
        await deleteChunk(cacheKey).catch(() => undefined);
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
      if (isUsableCachedChunkResponse(metadata, index, cached)) {
        cachedChunks.push(index);
      }
    })());
  }

  await Promise.allSettled(tasks);
  cachedChunks.sort((left, right) => left - right);
  return cachedChunks;
}

function isUsableCachedChunkResponse(metadata, chunkIndex, response) {
  if (!response) {
    return false;
  }

  if (metadata.kind === "hls") {
    const contentLength = cachedChunkContentLength(response);
    return contentLength === null || contentLength > 0;
  }

  const expectedSize = expectedChunkSize(metadata, chunkIndex);
  const contentLength = cachedChunkContentLength(response);
  return contentLength === null || contentLength === expectedSize;
}

function isUsableFileCacheEntry(entry, response) {
  if (!response) {
    return false;
  }

  const contentLength = cachedChunkContentLength(response);
  if (contentLength === null) {
    return true;
  }

  if (contentLength <= 0) {
    return false;
  }

  const recordedSize = safeSize(entry.size);
  if (recordedSize > 0 && contentLength !== recordedSize) {
    return false;
  }

  if (entry.kind === "hls") {
    return true;
  }

  const chunkIndex = Math.floor(Number(entry.chunkIndex));
  const totalSize = safeSize(entry.totalSize);
  const chunkSize = safeSize(entry.chunkSize);
  const chunkCount = Math.floor(Number(entry.chunkCount));
  if (
    !Number.isSafeInteger(chunkIndex) ||
    chunkIndex < 0 ||
    !Number.isSafeInteger(chunkCount) ||
    chunkCount <= 0 ||
    totalSize <= 0 ||
    chunkSize <= 0
  ) {
    return true;
  }

  const expectedSize = chunkIndex === chunkCount - 1
    ? totalSize - chunkSize * chunkIndex
    : chunkSize;
  return expectedSize > 0 && contentLength === expectedSize;
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

  const bytes = await fetchChunkByteRangeBytesWithRetry(metadata, segment);
  return {
    bytes: new Uint8Array(bytes)
  };
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

async function fetchChunkByteRangeBytesWithRetry(metadata, segment) {
  const expectedSize = expectedChunkSize(metadata, segment.chunkIndex);
  if (
    segment.start < 0 ||
    segment.endExclusive <= segment.start ||
    segment.endExclusive > expectedSize
  ) {
    throw new Error("Chunk byte range is out of range");
  }

  const expectedRangeSize = segment.endExclusive - segment.start;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      const response = await fetch(chunkSourceUrl(metadata, segment.chunkIndex), {
        credentials: "omit",
        headers: {
          Range: chunkRangeHeader(metadata, segment.chunkIndex, segment.start, segment.endExclusive)
        }
      });

      if (!response.ok) {
        if (shouldRetryChunkStatus(response.status) && attempt < CHUNK_FETCH_MAX_ATTEMPTS) {
          await delayBeforeChunkRetry(attempt);
          continue;
        }
        throw permanentCacheError(`Chunk ${segment.chunkIndex + 1} preview load failed (HTTP ${response.status})`);
      }

      const requestedFullChunk = segment.start === 0 && segment.endExclusive === expectedSize;
      if (!requestedFullChunk && response.status !== 206) {
        throw permanentCacheError(`Chunk ${segment.chunkIndex + 1} does not support range preview`);
      }

      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== expectedRangeSize) {
        throw new Error(`Chunk ${segment.chunkIndex + 1} preview range size mismatch`);
      }

      return bytes;
    } catch (error) {
      if (error?.permanent || attempt >= CHUNK_FETCH_MAX_ATTEMPTS) {
        throw error;
      }
      await delayBeforeChunkRetry(attempt);
    }
  }
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

    await cleanupPreviewCache(bytes.byteLength, metadata.cacheMaxBytes);
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
      createdAt: now,
      lastAccessed: now
    }, true);
    await cleanupPreviewCache(0, metadata.cacheMaxBytes);
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
  const cacheEntries = entries.filter((entry) => entry?.cacheKey && !isFileRecordMetadata(entry));
  let total = cacheEntries.reduce((sum, entry) => sum + safeSize(entry.size), 0) + safeSize(incomingBytes);
  const maxBytes = Math.max(1, cacheMaxBytes);
  const targetBytes = Math.floor(maxBytes * 0.9);

  if (total <= maxBytes) {
    return;
  }

  const victims = cacheEntries
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
  const keepRecord = extra.keepFileRecord === true;
  const relatedChunks = chunks.filter((chunk) => chunk?.fileId === metadata.fileId && !isFileRecordMetadata(chunk));

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
      cacheSource: "auto",
      size: 0,
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
      cacheSource: "auto",
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
      autoBytes: 0,
      cacheSource: "auto",
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
    if (!isFileRecord) {
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
        autoBytes: entry.autoBytes,
        cacheSource: "auto",
        lastAccessed: entry.lastAccessed,
        complete
      };
    })
    .sort(compareFileCacheEntries);

  const totalBytes = normalizedEntries.reduce((sum, entry) => sum + entry.cachedBytes, 0);
  const recentEntries = normalizedEntries.slice(0, 80);

  return {
    entries: recentEntries,
    entryCount: normalizedEntries.length,
    totalBytes,
    autoBytes: totalBytes
  };
}

function compareFileCacheEntries(left, right) {
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
    partKind: parsed.partKind,
    partIndex: parsed.partIndex,
    size: 0,
    createdAt: 0,
    lastAccessed: Date.now()
  };
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

  const entries = await getAllChunkMetadata();
  const fileEntries = entries.filter((entry) => entry?.fileId === normalizedFileId && entry.cacheKey);
  if (fileEntries.length === 0) {
    return null;
  }

  const cachedChunkIndexes = new Set();
  let fileName = normalizedFileId;
  let directoryPath = "/";
  let kind = "single";
  let mimeType = "application/octet-stream";
  let size = 0;
  let chunkSize = 0;
  let chunkCount = 1;
  let sourceUrl = "";
  let token = "";
  let cachedBytes = 0;
  let lastAccessed = 0;
  let hasFileRecord = false;

  for (const entry of fileEntries) {
    const isFileRecord = isFileRecordMetadata(entry);
    if (isFileRecord || !hasFileRecord) {
      fileName = entry.fileName || fileName;
      directoryPath = entry.directoryPath || directoryPath;
      kind = entry.kind || kind;
      mimeType = entry.mimeType || mimeType;
      sourceUrl = entry.sourceUrl || sourceUrl;
      token = entry.token || token;
    }
    if (isFileRecord) {
      hasFileRecord = true;
    } else {
      cachedChunkIndexes.add(Number(entry.chunkIndex));
      cachedBytes += safeSize(entry.size);
    }

    size = Math.max(size, safeSize(entry.totalSize));
    chunkSize = Math.max(chunkSize, safeSize(entry.chunkSize));
    chunkCount = Math.max(chunkCount, Number.isSafeInteger(entry.chunkCount) ? entry.chunkCount : 1);
    lastAccessed = Math.max(lastAccessed, safeTime(entry.lastAccessed));
  }

  return {
    fileId: normalizedFileId,
    fileName,
    directoryPath,
    kind,
    mimeType,
    size,
    chunkSize,
    chunkCount,
    sourceUrl: sourceUrl || undefined,
    token: token || undefined,
    cachedChunks: Array.from(cachedChunkIndexes).filter((index) => Number.isSafeInteger(index) && index >= 0).length,
    cachedBytes,
    autoBytes: cachedBytes,
    cacheSource: "auto",
    lastAccessed,
    complete: cachedBytes >= size && size > 0
  };
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
  for (const entry of entries) {
    if (entry?.cacheKey) {
      await deleteChunk(entry.cacheKey);
    }
  }

  const fallbackEntries = await readCacheStorageMetadataSnapshot();
  for (const entry of fallbackEntries) {
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
      store.put({
        ...existing,
        ...entry,
        cacheSource: "auto",
        createdAt: existing?.createdAt || entry.createdAt,
        fileName: entry.fileName || existing?.fileName || entry.fileId,
        directoryPath: entry.directoryPath || existing?.directoryPath || "/",
        kind: entry.kind || existing?.kind || "single",
        mimeType: entry.mimeType || existing?.mimeType || "application/octet-stream",
        totalSize: entry.totalSize || existing?.totalSize || entry.size,
        chunkSize: entry.chunkSize || existing?.chunkSize || entry.size,
        chunkCount: entry.chunkCount || existing?.chunkCount || 1,
        sourceUrl: entry.sourceUrl || existing?.sourceUrl || "",
        token: entry.token || existing?.token || ""
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
