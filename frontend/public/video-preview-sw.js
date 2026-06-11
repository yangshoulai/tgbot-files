const CACHE_NAME = "tgbot-files-video-preview-v1";
const DB_NAME = "tgbot-files-video-preview-cache";
const STORE_NAME = "chunks";
const DB_VERSION = 1;
const DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const RESPONSE_WINDOW_BYTES = 2 * 1024 * 1024;
const DEFAULT_PREVIEW_PREFETCH_CONCURRENCY = 5;
const MAX_PREVIEW_PREFETCH_CONCURRENCY = 32;
const CONTINUOUS_PREFETCH_SESSION_TTL_MS = 12_000;
const HOT_CHUNK_CACHE_MAX_BYTES = 160 * 1024 * 1024;
const fullChunkLoads = new Map();
const hlsPartLoads = new Map();
const continuousPrefetchSessions = new Map();
const hotChunkCache = new Map();
const hlsPreviewSources = new Map();
const hlsPreviewCacheSessions = new Map();
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
  const response = await fetch(metadata.sourceUrl, { credentials: "omit" });
  if (!response.ok) {
    return new Response(`HLS playlist load failed (${response.status})`, { status: 502 });
  }

  const playlistText = await response.text();
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

  if (!fileId || !Number.isSafeInteger(partIndex) || partIndex < 0 || !sourceUrl) {
    return new Response("Invalid HLS preview part", { status: 400 });
  }

  try {
    const response = await fetchAndCacheHlsPart({ fileId, partKind, partIndex, sourceUrl, cacheMaxBytes });
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
    prefetch_concurrency: String(metadata.prefetchConcurrency)
  });
  return `/__video-preview/hls-part/${encodeURIComponent(metadata.fileId)}/${partKind}/${index}?${params.toString()}`;
}

async function fetchAndCacheHlsPart({ fileId, partKind, partIndex, sourceUrl, cacheMaxBytes }) {
  const cacheKey = `${self.location.origin}/__preview-cache/hls/${encodeURIComponent(fileId)}/${partKind}/${partIndex}`;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (cached) {
    touchPreviewCacheMetadata(fileId, hlsChunkIndex(partKind, partIndex), safeSize(Number(cached.headers.get("Content-Length"))), cacheKey);
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
      cacheKey
    }).finally(() => {
      hlsPartLoads.delete(loadKey);
    });
    hlsPartLoads.set(loadKey, load);
  }

  const result = await load;
  return createHlsPartResponse(result.bytes, result.contentType);
}

async function fetchAndCacheHlsPartBytes({ fileId, partKind, partIndex, sourceUrl, cacheMaxBytes, cacheKey }) {
  const response = await fetch(sourceUrl, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`HLS ${partKind} ${partIndex} preview load failed (HTTP ${response.status})`);
  }

  const bytes = await response.arrayBuffer();
  const now = Date.now();
  const contentType = response.headers.get("Content-Type") || "application/octet-stream";

  await cleanupPreviewCache(bytes.byteLength, cacheMaxBytes);
  const cache = await caches.open(CACHE_NAME);
  await cache.put(cacheKey, new Response(bytes.slice(0), {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable"
    }
  }));
  await putChunkMetadata({
    cacheKey,
    fileId,
    chunkIndex: hlsChunkIndex(partKind, partIndex),
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
  let failed = false;

  async function runWorker() {
    while (
      !failed &&
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
        failed = true;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

function hlsChunkIndex(partKind, partIndex) {
  return partKind === "init" ? -1 : partIndex;
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
    task: null
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
      sourceUrl,
      chunkCount: Number.isSafeInteger(chunkCount) && chunkCount > 0 ? chunkCount : undefined,
      mimeType,
      cacheMaxBytes,
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

  return {
    kind,
    fileId,
    token,
    sourceUrl,
    size,
    chunkSize,
    chunkCount,
    mimeType,
    cacheMaxBytes,
    prefetchConcurrency
  };
}

function normalizePreviewMetadata(value) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const fileId = typeof value.fileId === "string" ? value.fileId : "";
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
      sourceUrl,
      mimeType,
      cacheMaxBytes,
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

  return {
    kind,
    fileId,
    token,
    sourceUrl,
    size,
    chunkSize,
    chunkCount,
    mimeType,
    cacheMaxBytes,
    prefetchConcurrency
  };
}

function normalizePreviewKind(value) {
  return value === "single" || value === "multipart" || value === "hls" ? value : null;
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
  }

  cachedChunks.sort((left, right) => left - right);

  return {
    fileId: metadata.fileId,
    kind: metadata.kind,
    chunkCount,
    cachedChunks
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
  touchPreviewCacheMetadata(metadata.fileId, chunkIndex, size, cacheKey);
}

function touchPreviewCacheMetadata(fileId, chunkIndex, size, cacheKey) {
  const now = Date.now();
  void putChunkMetadata({
    cacheKey,
    fileId,
    chunkIndex,
    size,
    createdAt: now,
    lastAccessed: now
  }, true).catch((error) => {
    warnPreviewCacheError(`touch chunk ${chunkIndex}`, error);
  });
}

async function getChunkBytes(metadata, chunkIndex) {
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

  const load = fetchAndCacheChunkBytes(metadata, chunkIndex)
    .finally(() => {
      fullChunkLoads.delete(loadKey);
    });
  fullChunkLoads.set(loadKey, load);

  return load;
}

async function fetchAndCacheChunkBytes(metadata, chunkIndex) {
  const expectedSize = expectedChunkSize(metadata, chunkIndex);
  const response = await fetch(chunkSourceUrl(metadata, chunkIndex), {
    credentials: "omit",
    headers: metadata.kind === "single"
      ? { Range: chunkRangeHeader(metadata, chunkIndex, 0, expectedSize) }
      : undefined
  });

  if (!response.ok) {
    throw new Error(`分片 ${chunkIndex + 1} 预览加载失败（HTTP ${response.status}）`);
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== expectedSize) {
    throw new Error(`分片 ${chunkIndex + 1} 大小不匹配`);
  }

  putHotChunkBytes(metadata, chunkIndex, bytes);

  try {
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = chunkCacheKey(metadata.fileId, chunkIndex);
    const now = Date.now();

    await cleanupPreviewCache(bytes.byteLength, metadata.cacheMaxBytes);
    await cache.put(cacheKey, new Response(bytes.slice(0), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable"
      }
    }));
    await putChunkMetadata({
      cacheKey,
      fileId: metadata.fileId,
      chunkIndex,
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
    task: null
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

async function cleanupPreviewCache(incomingBytes = 0, cacheMaxBytes = DEFAULT_MAX_CACHE_BYTES) {
  const entries = await getAllChunkMetadata();
  let total = entries.reduce((sum, entry) => sum + safeSize(entry.size), 0) + safeSize(incomingBytes);
  const maxBytes = Math.max(1, cacheMaxBytes);
  const targetBytes = Math.floor(maxBytes * 0.9);

  if (total <= maxBytes) {
    return;
  }

  const victims = entries
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
  await deleteChunkMetadata(cacheKey);
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
        ...entry,
        createdAt: existing?.createdAt || entry.createdAt
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
