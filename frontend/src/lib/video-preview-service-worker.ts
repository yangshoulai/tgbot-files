export const VIDEO_PREVIEW_SW_PATH = "/video-preview-sw.js";
const VIDEO_PREVIEW_SW_READY_TIMEOUT_MS = 5000;
const VIDEO_PREVIEW_SW_CONTROL_TIMEOUT_MS = 3000;

export interface VideoPreviewServiceWorkerRegistrationResult {
  supported: boolean;
  registered: boolean;
  controlled: boolean;
  needsReload: boolean;
  updated?: boolean;
  scope?: string;
  error?: string;
}

export function canUseVideoPreviewServiceWorker(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

export function isVideoPreviewServiceWorkerControlling(): boolean {
  return Boolean(getVideoPreviewServiceWorkerController());
}

export function getVideoPreviewServiceWorkerController(): ServiceWorker | null {
  if (!canUseVideoPreviewServiceWorker()) {
    return null;
  }

  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    return null;
  }

  try {
    const scriptUrl = new URL(controller.scriptURL);
    return scriptUrl.origin === window.location.origin && scriptUrl.pathname === VIDEO_PREVIEW_SW_PATH
      ? controller
      : null;
  } catch {
    return null;
  }
}

export async function registerVideoPreviewServiceWorker(): Promise<boolean> {
  const result = await ensureVideoPreviewServiceWorker();
  return result.registered;
}

export async function ensureVideoPreviewServiceWorker(): Promise<VideoPreviewServiceWorkerRegistrationResult> {
  if (!canUseVideoPreviewServiceWorker()) {
    return {
      supported: false,
      registered: false,
      controlled: false,
      needsReload: false,
      error: "当前浏览器不支持 Service Worker"
    };
  }

  try {
    const registration = await navigator.serviceWorker.register(VIDEO_PREVIEW_SW_PATH, {
      scope: "/"
    });
    const currentRegistration = await registration.update().catch(() => registration);
    const hadPendingWorker = Boolean(currentRegistration.installing || currentRegistration.waiting);

    requestSkipWaiting(currentRegistration);
    await waitForServiceWorkerReady(VIDEO_PREVIEW_SW_READY_TIMEOUT_MS);
    requestSkipWaiting(currentRegistration);

    const controlled = hadPendingWorker
      ? await waitForUpdatedVideoPreviewController(VIDEO_PREVIEW_SW_CONTROL_TIMEOUT_MS)
      : await waitForVideoPreviewController(VIDEO_PREVIEW_SW_CONTROL_TIMEOUT_MS);

    return {
      supported: true,
      registered: true,
      controlled,
      needsReload: !controlled,
      updated: hadPendingWorker,
      scope: currentRegistration.scope
    };
  } catch (error) {
    return {
      supported: true,
      registered: false,
      controlled: false,
      needsReload: false,
      error: error instanceof Error ? error.message : "Service Worker 注册失败"
    };
  }
}

function requestSkipWaiting(registration: ServiceWorkerRegistration): void {
  registration.installing?.postMessage({ type: "SKIP_WAITING" });
  registration.waiting?.postMessage({ type: "SKIP_WAITING" });
}

async function waitForServiceWorkerReady(timeoutMs: number): Promise<ServiceWorkerRegistration> {
  return withTimeout(
    navigator.serviceWorker.ready,
    timeoutMs,
    "Service Worker 已注册，但没有在预期时间内完成激活"
  );
}

async function waitForVideoPreviewController(timeoutMs: number): Promise<boolean> {
  if (isVideoPreviewServiceWorkerControlling()) {
    return true;
  }

  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      cleanup();
      resolve(isVideoPreviewServiceWorkerControlling());
    }, timeoutMs);

    const onControllerChange = () => {
      if (!isVideoPreviewServiceWorkerControlling()) {
        return;
      }

      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
  });
}

async function waitForUpdatedVideoPreviewController(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let changed = false;
    const timer = window.setTimeout(() => {
      cleanup();
      resolve(changed && isVideoPreviewServiceWorkerControlling());
    }, timeoutMs);

    const onControllerChange = () => {
      changed = true;
      if (!isVideoPreviewServiceWorkerControlling()) {
        return;
      }

      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      });
  });
}
