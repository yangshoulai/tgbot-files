import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ApiError, SessionResponse, getSession, logout } from "./api";
import { Spinner } from "./components/ui/Spinner";
import { Shell, ShellRoute } from "./components/layout/Shell";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ApiDocsPage } from "./pages/ApiDocsPage";
import { UploadDialog, type UploadDialogHandle, type UploadTaskSnapshot } from "./components/files/UploadDialog";
import { UploadTaskCenter } from "./components/files/UploadTaskCenter";
import { GlobalDropzone } from "./lib/dropzone";
import { ToastProvider, useToast } from "./lib/toast";
import { ConfirmProvider } from "./lib/confirm";
import { registerVideoPreviewServiceWorker } from "./lib/video-preview-service-worker";

type Route = "/login" | "/admin" | "/docs" | "/settings";

function currentRoute(): Route {
  const pathname = window.location.pathname;
  if (pathname === "/login") return "/login";
  if (pathname === "/docs") return "/docs";
  if (pathname === "/settings") return "/settings";
  return "/admin";
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "请求失败";
}

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppShell />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function AppShell() {
  const toast = useToast();
  const uploadLayerRef = useRef<UploadLayerHandle>(null);
  const [path, setPath] = useState<Route>(currentRoute());
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  const [uploadVersion, setUploadVersion] = useState(0);
  const [dashboardDirectoryPath, setDashboardDirectoryPath] = useState("/");
  const [uploadDropzoneBlocked, setUploadDropzoneBlocked] = useState(false);

  const navigate = useCallback((route: Route) => {
    if (window.location.pathname !== route) {
      window.history.pushState(null, "", route);
    }
    setPath(route);
  }, []);

  const copyText = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        toast.success("已复制到剪贴板");
      } catch {
        toast.danger("复制失败，请手动复制");
      }
    },
    [toast]
  );

  const refreshSession = useCallback(async () => {
    setSessionLoading(true);
    try {
      const nextSession = await getSession();
      setSession(nextSession);
      if (currentRoute() === "/login") navigate("/admin");
    } catch (error) {
      setSession(null);
      if (!(error instanceof ApiError) || error.status !== 401) {
        toast.danger(errorMessage(error));
      }
    } finally {
      setSessionLoading(false);
    }
  }, [navigate, toast]);

  useEffect(() => {
    function onPopState() {
      setPath(currentRoute());
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [path, refreshSession]);

  useEffect(() => {
    if (!sessionLoading && !session && path !== "/login") {
      navigate("/login");
    }
  }, [navigate, path, session, sessionLoading]);

  useEffect(() => {
    void registerVideoPreviewServiceWorker();
  }, []);

  const openUpload = useCallback((files: File[] = [], directoryPath = dashboardDirectoryPath) => {
    uploadLayerRef.current?.open(files, directoryPath);
  }, [dashboardDirectoryPath]);

  const openUploadInCurrentDirectory = useCallback(() => {
    openUpload([]);
  }, [openUpload]);

  const openUploadToDirectory = useCallback((directoryPath: string) => {
    openUpload([], directoryPath);
  }, [openUpload]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "u") return;
      if (isEditableShortcutTarget(event.target)) return;

      event.preventDefault();
      openUpload([]);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openUpload]);

  const onLogout = useCallback(async () => {
    try {
      await logout();
      setSession(null);
      navigate("/login");
      toast.success("已退出");
    } catch (error) {
      toast.danger(errorMessage(error));
    }
  }, [navigate, toast]);

  const handleUploaded = useCallback((count: number) => {
    if (count > 0) {
      setUploadVersion((value) => value + 1);
      toast.success(count === 1 ? "文件已上传" : `已上传 ${count} 个文件`);
    }
  }, [toast]);

  const handleUploadError = useCallback((message: string) => {
    toast.danger(message);
  }, [toast]);

  const dropzoneEnabled = useMemo(
    () => session !== null && path !== "/login" && !uploadDropzoneBlocked,
    [session, path, uploadDropzoneBlocked]
  );

  if (path === "/login" || !session) {
    if (sessionLoading) {
      return <Splash />;
    }
    return (
      <LoginPage
        onLoggedIn={() => {
          toast.success("已登录");
          void refreshSession();
        }}
      />
    );
  }

  const active: ShellRoute = path === "/settings" ? "settings" : path === "/docs" ? "docs" : "admin";

  return (
    <>
      <Shell
        active={active}
        session={session}
        onNavigate={(route) => navigate(route === "settings" ? "/settings" : route === "docs" ? "/docs" : "/admin")}
        onLogout={() => void onLogout()}
        onUpload={openUploadInCurrentDirectory}
      >
        {active === "settings" ? (
          <SettingsPage session={session} onSessionChange={setSession} copyText={copyText} />
        ) : active === "docs" ? (
          <ApiDocsPage session={session} />
        ) : (
          <DashboardPage
            session={session}
            uploadVersion={uploadVersion}
            copyText={copyText}
            onDirectoryChange={setDashboardDirectoryPath}
            onUploadToDirectory={openUploadToDirectory}
          />
        )}
      </Shell>

      <UploadLayer
        ref={uploadLayerRef}
        session={session}
        defaultDirectoryPath={dashboardDirectoryPath}
        onDropzoneBlockedChange={setUploadDropzoneBlocked}
        onUploaded={handleUploaded}
        onError={handleUploadError}
      />

      <GlobalDropzone enabled={dropzoneEnabled} onDrop={openUpload} />
    </>
  );
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    Boolean(target.closest("[contenteditable='true']"));
}

interface UploadLayerHandle {
  open: (files?: File[], directoryPath?: string) => void;
}

interface UploadLayerProps {
  session: SessionResponse;
  defaultDirectoryPath: string;
  onUploaded: (uploadedCount: number) => void;
  onError: (message: string) => void;
  onDropzoneBlockedChange: (blocked: boolean) => void;
}

const UploadLayer = forwardRef<UploadLayerHandle, UploadLayerProps>(function UploadLayer({
  session,
  defaultDirectoryPath,
  onUploaded,
  onError,
  onDropzoneBlockedChange
}, ref) {
  const uploadDialogRef = useRef<UploadDialogHandle>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadDirectoryPath, setUploadDirectoryPath] = useState("/");
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const uploadTaskSnapshotRef = useRef<UploadTaskSnapshot | null>(null);
  const uploadTaskSnapshotListenersRef = useRef(new Set<() => void>());
  const dropzoneBlockedRef = useRef(false);

  const handleUploadTaskSnapshotChange = useCallback((snapshot: UploadTaskSnapshot | null) => {
    uploadTaskSnapshotRef.current = snapshot;
    const blocked = uploadOpen || Boolean(snapshot?.running);
    if (dropzoneBlockedRef.current !== blocked) {
      dropzoneBlockedRef.current = blocked;
      onDropzoneBlockedChange(blocked);
    }
    uploadTaskSnapshotListenersRef.current.forEach((listener) => listener());
  }, [onDropzoneBlockedChange, uploadOpen]);

  const getUploadTaskSnapshot = useCallback(() => uploadTaskSnapshotRef.current, []);

  const subscribeUploadTaskSnapshot = useCallback((listener: () => void) => {
    uploadTaskSnapshotListenersRef.current.add(listener);
    return () => uploadTaskSnapshotListenersRef.current.delete(listener);
  }, []);

  const openUpload = useCallback((files: File[] = [], directoryPath = defaultDirectoryPath) => {
    const snapshot = uploadTaskSnapshotRef.current;
    if (snapshot?.summary.error) {
      const waitingLocalTask = snapshot.items.some((item) =>
        item.kind === "local" && item.status === "error" && item.progressLabel?.includes("重新选择本地文件")
      );
      if (waitingLocalTask && files.length > 0) {
        uploadDialogRef.current?.resumeLocalFile(files[0]);
      }
      setUploadOpen(true);
      setTaskCenterOpen(true);
      return;
    }

    uploadDialogRef.current?.clearSettledTasks();
    setUploadDirectoryPath(directoryPath);
    setUploadFiles(files);
    setUploadOpen(true);
  }, [defaultDirectoryPath]);

  useImperativeHandle(ref, () => ({
    open: openUpload
  }), [openUpload]);

  useEffect(() => {
    const blocked = uploadOpen || Boolean(uploadTaskSnapshotRef.current?.running);
    if (dropzoneBlockedRef.current === blocked) {
      return;
    }
    dropzoneBlockedRef.current = blocked;
    onDropzoneBlockedChange(blocked);
  }, [onDropzoneBlockedChange, uploadOpen]);

  return (
    <>
      <UploadDialog
        ref={uploadDialogRef}
        open={uploadOpen}
        initialFiles={uploadFiles}
        maxBytes={session.max_file_bytes}
        maxMultipartBytes={session.max_multipart_file_bytes}
        uploadConcurrency={session.upload_concurrency}
        directoryPath={uploadDirectoryPath}
        onClose={() => setUploadOpen(false)}
        onUploaded={onUploaded}
        onError={onError}
        onTaskSnapshotChange={handleUploadTaskSnapshotChange}
      />

      <UploadTaskCenter
        getSnapshot={getUploadTaskSnapshot}
        subscribe={subscribeUploadTaskSnapshot}
        open={taskCenterOpen}
        onOpenChange={setTaskCenterOpen}
        onShowDetails={() => {
          setUploadOpen(true);
          setTaskCenterOpen(false);
        }}
        onStop={() => uploadDialogRef.current?.stopCurrentUpload()}
        onDelete={(id) => uploadDialogRef.current?.deleteTask(id)}
      />
    </>
  );
});

function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center bg-background">
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner size={18} />
        加载中…
      </div>
    </div>
  );
}
