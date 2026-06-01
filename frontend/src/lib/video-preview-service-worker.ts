export const VIDEO_PREVIEW_SW_PATH = "/video-preview-sw.js";

export function canUseVideoPreviewServiceWorker(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

export function isVideoPreviewServiceWorkerControlling(): boolean {
  return canUseVideoPreviewServiceWorker() && Boolean(navigator.serviceWorker.controller);
}

export async function registerVideoPreviewServiceWorker(): Promise<boolean> {
  if (!canUseVideoPreviewServiceWorker()) {
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.register(VIDEO_PREVIEW_SW_PATH, {
      scope: "/"
    });
    await navigator.serviceWorker.ready;
    if (registration.waiting) {
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    }
    return true;
  } catch {
    return false;
  }
}
