export const VIDEO_PREVIEW_SW_PATH = "/video-preview-sw.js";
const VIDEO_PREVIEW_SW_READY_TIMEOUT_MS = 5000;
const VIDEO_PREVIEW_SW_CONTROL_TIMEOUT_MS = 10000;

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

    // 后台检查更新，并催促任何安装中 / 等待中的新版本尽快激活
    //（新 SW 的 install 里也会自行 skipWaiting，这里是双保险）。
    void registration.update().catch(() => {});
    requestSkipWaiting(registration);

    // 只要当前页面已经被我们的 SW 接管，就视为可用——即便此刻有新版本正在后台更新。
    // 旧版本会继续正常代理请求；新版本通过 skipWaiting + clients.claim() 自动接管，
    // 由各处的 controllerchange 监听完成热切换，用户无需手动刷新。
    // 这修复了"部署后刷新经常提示未接管"：之前只要检测到有待激活的新版本，
    // 就无视旧版本仍在控制页面，强行要求新版本 3 秒内接管，否则误报未接管。
    if (isVideoPreviewServiceWorkerControlling()) {
      return {
        supported: true,
        registered: true,
        controlled: true,
        needsReload: false,
        updated: Boolean(registration.waiting || registration.installing),
        scope: registration.scope
      };
    }

    // 尚未被接管：首次安装，或硬刷新（Ctrl+Shift+R）后页面没有控制者。
    // 等待 SW 激活，并请已激活的 SW 立即 claim 当前页。
    await waitForServiceWorkerReady(VIDEO_PREVIEW_SW_READY_TIMEOUT_MS);
    requestSkipWaiting(registration);
    requestClientsClaim(registration);
    const controlled = await waitForVideoPreviewController(VIDEO_PREVIEW_SW_CONTROL_TIMEOUT_MS);

    return {
      supported: true,
      registered: true,
      controlled,
      needsReload: !controlled,
      scope: registration.scope
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

// 已有激活的 SW 却没有控制当前页（首次安装 / 硬刷新后）时，请它立即接管。
// 对应 SW 里的 CLAIM_CLIENTS 处理：调用 self.clients.claim()。
function requestClientsClaim(registration: ServiceWorkerRegistration): void {
  const worker = registration.active || navigator.serviceWorker.controller;
  worker?.postMessage({ type: "CLAIM_CLIENTS" });
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
