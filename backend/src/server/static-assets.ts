import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { mimeTypeForFileName } from "../mime";
import type { StaticAssetHandler } from "../runtime";

export function createStaticAssetHandler(assetsDir: string): StaticAssetHandler {
  const root = path.resolve(assetsDir);

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const assetPath = await resolveAssetPath(root, url.pathname);
      if (!assetPath) {
        return new Response("Not found", { status: 404 });
      }

      const contentType = mimeTypeForFileName(assetPath) ?? "application/octet-stream";
      const headers = new Headers({
        "Content-Type": contentType.includes("text/") || contentType === "application/json" || contentType === "image/svg+xml"
          ? `${contentType}; charset=utf-8`
          : contentType
      });

      if (request.method === "HEAD") {
        const fileStat = await stat(assetPath);
        headers.set("Content-Length", String(fileStat.size));
        return new Response(null, { headers });
      }

      const stream = Readable.toWeb(createReadStream(assetPath)) as ReadableStream;
      return new Response(stream, { headers });
    }
  };
}

async function resolveAssetPath(root: string, pathname: string): Promise<string | null> {
  const relative = decodeURIComponent(pathname)
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");
  const candidates = [
    relative ? path.join(root, relative) : path.join(root, "index.html"),
    path.join(root, "index.html")
  ];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!isInsideRoot(root, resolved)) {
      continue;
    }

    try {
      const fileStat = await stat(resolved);
      if (fileStat.isFile()) {
        return resolved;
      }
    } catch {
      // Try the SPA fallback candidate.
    }
  }

  return null;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
