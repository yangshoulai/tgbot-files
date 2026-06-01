const CACHE_NAME = "tgbot-files-video-preview-v1";
const DB_NAME = "tgbot-files-video-preview-cache";
const STORE_NAME = "chunks";
const DB_VERSION = 1;
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const TARGET_CACHE_BYTES = Math.floor(1.8 * 1024 * 1024 * 1024);
const RESPONSE_WINDOW_CHUNKS = 2;
const PREFETCH_CHUNKS = 2;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    await cleanupPreviewCache();
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

  const range = parseRange(request.headers.get("Range"), metadata.size, metadata.chunkSize);
  if (!range) {
    return rangeNotSatisfiable(metadata.size);
  }

  try {
    const body = await readRangeBytes(metadata, range);
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

function parseRange(rangeHeader, size, chunkSize) {
  if (!rangeHeader) {
    return {
      start: 0,
      end: Math.min(size - 1, chunkSize * RESPONSE_WINDOW_CHUNKS - 1)
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
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return null;
    }
  }

  const maxEnd = Math.min(size - 1, start + chunkSize * RESPONSE_WINDOW_CHUNKS - 1);
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

async function readRangeBytes(metadata, range) {
  const firstChunk = Math.floor(range.start / metadata.chunkSize);
  const lastChunk = Math.floor(range.end / metadata.chunkSize);
  const parts = [];
  let total = 0;

  for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex += 1) {
    const chunkBytes = new Uint8Array(await getChunkBytes(metadata, chunkIndex));
    const chunkStart = chunkIndex * metadata.chunkSize;
    const sliceStart = Math.max(0, range.start - chunkStart);
    const sliceEnd = Math.min(chunkBytes.byteLength, range.end - chunkStart + 1);
    const part = chunkBytes.slice(sliceStart, sliceEnd);
    parts.push(part);
    total += part.byteLength;
  }

  return concatParts(parts, total);
}

async function getChunkBytes(metadata, chunkIndex) {
  if (chunkIndex < 0 || chunkIndex >= metadata.chunkCount) {
    throw new Error("Chunk index is out of range");
  }

  const cache = await caches.open(CACHE_NAME);
  const cacheKey = chunkCacheKey(metadata.fileId, chunkIndex);
  const cached = await cache.match(cacheKey);
  const now = Date.now();

  if (cached) {
    const bytes = await cached.arrayBuffer();
    await putChunkMetadata({
      cacheKey,
      fileId: metadata.fileId,
      chunkIndex,
      size: bytes.byteLength,
      createdAt: now,
      lastAccessed: now
    }, true);
    return bytes;
  }

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

function concatParts(parts, totalBytes) {
  const result = new Uint8Array(totalBytes);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }

  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
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
