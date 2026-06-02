const CACHE_NAME = "tgbot-files-video-preview-v1";
const DB_NAME = "tgbot-files-video-preview-cache";
const STORE_NAME = "chunks";
const DB_VERSION = 1;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const TARGET_CACHE_BYTES = Math.floor(1.8 * 1024 * 1024 * 1024);
const RESPONSE_WINDOW_BYTES = 2 * 1024 * 1024;
const PREFETCH_CHUNKS = 3;
const fullChunkLoads = new Map();

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
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
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

  const range = parseRange(request.headers.get("Range"), metadata.size);
  if (!range) {
    return rangeNotSatisfiable(metadata.size);
  }

  try {
    const body = await createRangeStream(metadata, range);
    const endChunk = Math.floor(range.end / metadata.chunkSize);
    event.waitUntil(prefetchChunks(metadata, endChunk + 1, PREFETCH_CHUNKS));

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

function parsePreviewMetadata(url) {
  const fileId = url.pathname.split("/").filter(Boolean)[1];
  const token = url.searchParams.get("token");
  const size = Number(url.searchParams.get("size"));
  const chunkSize = Number(url.searchParams.get("chunk_size"));
  const chunkCount = Number(url.searchParams.get("chunk_count"));
  const mimeType = url.searchParams.get("mime") || "application/octet-stream";

  if (
    !fileId ||
    !token ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize <= 0 ||
    !Number.isSafeInteger(chunkCount) ||
    chunkCount <= 0
  ) {
    return null;
  }

  return {
    fileId,
    token,
    size,
    chunkSize,
    chunkCount,
    mimeType
  };
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) {
    return {
      start: 0,
      end: Math.min(size - 1, RESPONSE_WINDOW_BYTES - 1)
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
    start = Math.max(0, size - Math.min(suffixLength, RESPONSE_WINDOW_BYTES));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return null;
    }
  }

  const maxEnd = Math.min(size - 1, start + RESPONSE_WINDOW_BYTES - 1);
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
  const cached = await getCachedChunkBytes(metadata, segment.chunkIndex);
  if (cached) {
    return {
      bytes: new Uint8Array(cached, segment.start, segment.endExclusive - segment.start)
    };
  }

  const stream = await fetchChunkByteRange(metadata, segment);
  return { stream };
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

  const response = await fetch(`/f/${encodeURIComponent(metadata.token)}/chunks/${segment.chunkIndex}`, {
    credentials: "omit",
    headers: {
      Range: `bytes=${segment.start}-${segment.endExclusive - 1}`
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

async function getCachedChunkBytes(metadata, chunkIndex) {
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

    const bytes = await cached.arrayBuffer();
    const expectedSize = expectedChunkSize(metadata, chunkIndex);
    if (bytes.byteLength !== expectedSize) {
      await deleteChunk(cacheKey);
      return null;
    }

    const now = Date.now();
    await putChunkMetadata({
      cacheKey,
      fileId: metadata.fileId,
      chunkIndex,
      size: bytes.byteLength,
      createdAt: now,
      lastAccessed: now
    }, true);

    return bytes;
  } catch (error) {
    warnPreviewCacheError(`read chunk ${chunkIndex}`, error);
    return null;
  }
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
  const response = await fetch(`/f/${encodeURIComponent(metadata.token)}/chunks/${chunkIndex}`, {
    credentials: "omit"
  });

  if (!response.ok) {
    throw new Error(`分片 ${chunkIndex + 1} 预览加载失败（HTTP ${response.status}）`);
  }

  const bytes = await response.arrayBuffer();
  const expectedSize = expectedChunkSize(metadata, chunkIndex);
  if (bytes.byteLength !== expectedSize) {
    throw new Error(`分片 ${chunkIndex + 1} 大小不匹配`);
  }

  try {
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = chunkCacheKey(metadata.fileId, chunkIndex);
    const now = Date.now();

    await cleanupPreviewCache(bytes.byteLength);
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
    await cleanupPreviewCache();
  } catch (error) {
    warnPreviewCacheError(`write chunk ${chunkIndex}`, error);
  }

  return bytes;
}

function expectedChunkSize(metadata, chunkIndex) {
  return chunkIndex === metadata.chunkCount - 1
    ? metadata.size - metadata.chunkSize * chunkIndex
    : metadata.chunkSize;
}

async function prefetchChunks(metadata, startIndex, count) {
  for (let index = startIndex; index < Math.min(metadata.chunkCount, startIndex + count); index += 1) {
    try {
      await getChunkBytes(metadata, index);
    } catch {
      return;
    }
  }
}

function chunkCacheKey(fileId, chunkIndex) {
  return `${self.location.origin}/__preview-cache/files/${encodeURIComponent(fileId)}/chunks/${chunkIndex}`;
}

async function cleanupPreviewCache(incomingBytes = 0) {
  const entries = await getAllChunkMetadata();
  let total = entries.reduce((sum, entry) => sum + safeSize(entry.size), 0) + safeSize(incomingBytes);

  if (total <= MAX_CACHE_BYTES) {
    return;
  }

  const victims = entries
    .slice()
    .sort((left, right) => safeTime(left.lastAccessed) - safeTime(right.lastAccessed));

  for (const entry of victims) {
    await deleteChunk(entry.cacheKey);
    total -= safeSize(entry.size);
    if (total <= TARGET_CACHE_BYTES) {
      break;
    }
  }
}

async function deleteChunk(cacheKey) {
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
