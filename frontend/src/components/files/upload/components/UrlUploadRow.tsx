import { memo, useSyncExternalStore } from "react";
import { CheckCircle2, ClipboardPaste, Link2, Plus, Trash2, X } from "lucide-react";
import { Input } from "../../../ui/Input";
import { chunkProgressEqual } from "../equality";
import { extractFirstUrl } from "../item-factories";
import { isLikelyMagnetUrl } from "../magnet-helpers";
import { remoteFileLabel } from "../snapshot";
import { ConflictResolutionActions } from "./ConflictControls";
import { EditableFileName } from "./EditableFileName";
import { HlsUploadDetails } from "./HlsUploadDetails";
import { MagnetUploadDetails } from "./MagnetUploadDetails";
import { ProgressBar, StatusBadge } from "./ProgressIndicators";
import { ThumbnailPicker, UploadThumbnailVisual, thumbnailHint } from "./ThumbnailPicker";
import { UploadChunkList } from "./UploadChunks";
import type {
  ChunkProgress,
  FileNameConflictState,
  HlsUrlState,
  ItemStatus,
  MagnetUrlState,
  SourceHeaderRow,
  UploadChunkState,
  UploadRuntimeStore,
  UploadThumbnailState
} from "../types";

interface UrlUploadRowProps {
  url: string;
  status: ItemStatus;
  message?: string;
  progress?: ChunkProgress;
  onClear: () => void;
  chunks?: UploadChunkState[];
  runtimeStore: UploadRuntimeStore;
  fileNameOverride?: string;
  editingFileName?: boolean;
  conflict?: FileNameConflictState;
  hls?: HlsUrlState;
  magnet?: MagnetUrlState;
  maxMultipartBytes: number;
  directoryPath: string;
  thumbnail?: UploadThumbnailState;
  onRetry?: () => void;
  onStop?: () => void;
  stopping?: boolean;
  onFileNameChange: (value: string) => void;
  onFileNameEditingChange: (editing: boolean) => void;
  onHlsVariantChange: (variantId: string) => void;
  onMagnetFileToggle: (fileIndex: number, selected: boolean) => void;
  onMagnetSelectAll: () => void;
  onMagnetClearSelection: () => void;
  onMagnetFileNameChange: (fileIndex: number, value: string) => void;
  onMagnetFileNameEditingChange: (fileIndex: number, editing: boolean) => void;
  onMagnetRenameConflict: (fileIndex: number) => void;
  onMagnetOverwriteConflict: (fileIndex: number) => void;
  onMagnetOverwriteAllConflicts: () => void;
  onRenameConflict?: () => void;
  onOverwriteConflict?: () => void;
  onThumbnailChange: (file: File) => void;
  onThumbnailUrl: () => void;
  onThumbnailRemove: () => void;
  disabled: boolean;
}

interface UrlSourceEditorProps {
  sourceUrl: string;
  uploadBusy: boolean;
  invalid: boolean;
  isMagnetSource: boolean;
  onSourceUrlChange: (value: string) => void;
  onOpenCurlImport: () => void;
}

export const UrlSourceEditor = memo(function UrlSourceEditor({
  sourceUrl,
  uploadBusy,
  invalid,
  isMagnetSource,
  onSourceUrlChange,
  onOpenCurlImport
}: UrlSourceEditorProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor="upload-source-url" className="text-xs font-medium text-muted">
          粘贴文件 URL 或磁力链接
        </label>
        {!isMagnetSource ? (
          <button
            type="button"
            disabled={uploadBusy}
            className="rounded-md px-1.5 py-1 text-xs font-medium text-primary-strong transition-colors hover:bg-primary-soft hover:text-primary disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:focus-ring"
            onClick={onOpenCurlImport}
          >
            从 cURL 解析
          </button>
        ) : null}
      </div>
      <Input
        id="upload-source-url"
        type="text"
        placeholder="https://example.com/report.pdf 或 magnet:?xt=urn:btih:..."
        value={sourceUrl}
        disabled={uploadBusy}
        invalid={invalid}
        leadingIcon={<ClipboardPaste size={15} />}
        inputClassName="!text-sm !text-muted"
        onChange={(event) => onSourceUrlChange(event.target.value)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text");
          const pastedUrl = extractFirstUrl(pasted);
          if (pastedUrl) {
            event.preventDefault();
            onSourceUrlChange(pastedUrl);
          }
        }}
      />
      <p className="text-xs leading-5 text-muted">
        URL 导入要求远端支持 Range；磁力导入会先由 aria2 下载选中文件，再分片转存到 Telegram。
      </p>
    </div>
  );
}, (previous, next) =>
  previous.sourceUrl === next.sourceUrl &&
  previous.uploadBusy === next.uploadBusy &&
  previous.invalid === next.invalid &&
  previous.isMagnetSource === next.isMagnetSource
);

interface SourceHeadersEditorProps {
  rows: SourceHeaderRow[];
  hidden: boolean;
  uploadBusy: boolean;
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<Pick<SourceHeaderRow, "name" | "value">>) => void;
  onRemove: (id: string) => void;
}

export const SourceHeadersEditor = memo(function SourceHeadersEditor({
  rows,
  hidden,
  uploadBusy,
  onAdd,
  onUpdate,
  onRemove
}: SourceHeadersEditorProps) {
  if (hidden) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-xs font-medium text-muted">
          请求头（可选）
        </label>
        <button
          type="button"
          disabled={uploadBusy}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-primary-strong transition-colors hover:bg-primary-soft hover:text-primary disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:focus-ring"
          onClick={onAdd}
        >
          <Plus size={13} />
          新增请求头
        </button>
      </div>
      <div className="rounded-xl border border-border bg-surface/70 p-2 shadow-card">
        {rows.length > 0 ? (
          <div className="flex flex-col gap-2">
            {rows.map((row, index) => (
              <div
                key={row.id}
                className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(8rem,0.38fr)_minmax(12rem,1fr)_2rem]"
              >
                <Input
                  aria-label={`请求头 ${index + 1} 名称`}
                  placeholder="referer"
                  value={row.name}
                  disabled={uploadBusy}
                  className="!h-9 !px-2 !shadow-none"
                  inputClassName="font-mono !text-[13px] !text-muted"
                  onChange={(event) => onUpdate(row.id, { name: event.target.value })}
                />
                <Input
                  aria-label={`请求头 ${index + 1} 值`}
                  placeholder="https://example.com/"
                  value={row.value}
                  disabled={uploadBusy}
                  className="!h-9 !px-2 !shadow-none"
                  inputClassName="font-mono !text-[13px] !text-muted"
                  onChange={(event) => onUpdate(row.id, { value: event.target.value })}
                />
                <button
                  type="button"
                  aria-label={`删除请求头 ${row.name || index + 1}`}
                  title="删除请求头"
                  disabled={uploadBusy}
                  className="grid size-9 place-items-center rounded-lg text-muted transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:focus-ring"
                  onClick={() => onRemove(row.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex min-h-10 items-center justify-between gap-3 rounded-lg bg-background/70 px-3 py-2 text-xs text-subtle">
            <span>暂无自定义请求头，可从 cURL 解析或手动新增。</span>
            <button
              type="button"
              disabled={uploadBusy}
              className="shrink-0 font-medium text-primary-strong transition-colors hover:text-primary disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:focus-ring"
              onClick={onAdd}
            >
              新增
            </button>
          </div>
        )}
      </div>
      <p className="text-xs leading-5 text-muted">
        key 会自动保存为小写。服务端会自动设置 Range；不要填写 Range、Host、Content-Length 等连接控制头。
      </p>
    </div>
  );
}, (previous, next) =>
  previous.rows === next.rows &&
  previous.hidden === next.hidden &&
  previous.uploadBusy === next.uploadBusy
);

export const UrlUploadRow = memo(function UrlUploadRow({
  url,
  status,
  message,
  progress,
  chunks,
  runtimeStore,
  fileNameOverride,
  editingFileName,
  conflict,
  hls,
  magnet,
  maxMultipartBytes,
  directoryPath,
  thumbnail,
  onClear,
  onRetry,
  onStop,
  stopping,
  onFileNameChange,
  onFileNameEditingChange,
  onHlsVariantChange,
  onMagnetFileToggle,
  onMagnetSelectAll,
  onMagnetClearSelection,
  onMagnetFileNameChange,
  onMagnetFileNameEditingChange,
  onMagnetRenameConflict,
  onMagnetOverwriteConflict,
  onMagnetOverwriteAllConflicts,
  onRenameConflict,
  onOverwriteConflict,
  onThumbnailChange,
  onThumbnailUrl,
  onThumbnailRemove,
  disabled
}: UrlUploadRowProps) {
  const isMagnet = isLikelyMagnetUrl(url);
  const fileName = isMagnet ? (magnet?.import?.name ?? "磁力链接") : fileNameOverride ?? remoteFileLabel(url);
  return (
    <div className="[contain:layout_paint] flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
      <UrlUploadHeader
        url={url}
        status={status}
        message={message}
        fileName={fileName}
        fileNameOverride={fileNameOverride}
        editingFileName={editingFileName}
        conflict={conflict}
        hls={hls}
        magnet={magnet}
        maxMultipartBytes={maxMultipartBytes}
        directoryPath={directoryPath}
        thumbnail={thumbnail}
        hasProgress={Boolean(progress)}
        retryComplete={progress ? progress.failed === 0 : false}
        isMagnet={isMagnet}
        disabled={disabled}
        stopping={stopping}
        onClear={onClear}
        onRetry={onRetry}
        onStop={onStop}
        onFileNameChange={onFileNameChange}
        onFileNameEditingChange={onFileNameEditingChange}
        onHlsVariantChange={onHlsVariantChange}
        onMagnetFileToggle={onMagnetFileToggle}
        onMagnetSelectAll={onMagnetSelectAll}
        onMagnetClearSelection={onMagnetClearSelection}
        onMagnetFileNameChange={onMagnetFileNameChange}
        onMagnetFileNameEditingChange={onMagnetFileNameEditingChange}
        onMagnetRenameConflict={onMagnetRenameConflict}
        onMagnetOverwriteConflict={onMagnetOverwriteConflict}
        onMagnetOverwriteAllConflicts={onMagnetOverwriteAllConflicts}
        onRenameConflict={onRenameConflict}
        onOverwriteConflict={onOverwriteConflict}
        onThumbnailChange={onThumbnailChange}
        onThumbnailUrl={onThumbnailUrl}
        onThumbnailRemove={onThumbnailRemove}
      />
      <UrlUploadRuntimeDetails
        runtimeStore={runtimeStore}
        fallbackProgress={progress}
        fallbackChunks={chunks}
        chunkTitle={hls ? "HLS 片段明细" : "分片明细"}
        compactDuringActive={status === "uploading"}
      />
    </div>
  );
}, urlUploadRowPropsEqual);

interface UrlUploadHeaderProps {
  url: string;
  status: ItemStatus;
  message?: string;
  fileName: string;
  fileNameOverride?: string;
  editingFileName?: boolean;
  conflict?: FileNameConflictState;
  hls?: HlsUrlState;
  magnet?: MagnetUrlState;
  maxMultipartBytes: number;
  directoryPath: string;
  thumbnail?: UploadThumbnailState;
  hasProgress: boolean;
  retryComplete: boolean;
  isMagnet: boolean;
  disabled: boolean;
  stopping?: boolean;
  onClear: () => void;
  onRetry?: () => void;
  onStop?: () => void;
  onFileNameChange: (value: string) => void;
  onFileNameEditingChange: (editing: boolean) => void;
  onHlsVariantChange: (variantId: string) => void;
  onMagnetFileToggle: (fileIndex: number, selected: boolean) => void;
  onMagnetSelectAll: () => void;
  onMagnetClearSelection: () => void;
  onMagnetFileNameChange: (fileIndex: number, value: string) => void;
  onMagnetFileNameEditingChange: (fileIndex: number, editing: boolean) => void;
  onMagnetRenameConflict: (fileIndex: number) => void;
  onMagnetOverwriteConflict: (fileIndex: number) => void;
  onMagnetOverwriteAllConflicts: () => void;
  onRenameConflict?: () => void;
  onOverwriteConflict?: () => void;
  onThumbnailChange: (file: File) => void;
  onThumbnailUrl: () => void;
  onThumbnailRemove: () => void;
}

const UrlUploadHeader = memo(function UrlUploadHeader({
  url,
  status,
  message,
  fileName,
  editingFileName,
  conflict,
  hls,
  magnet,
  maxMultipartBytes,
  directoryPath,
  thumbnail,
  hasProgress,
  retryComplete,
  isMagnet,
  disabled,
  stopping,
  onClear,
  onRetry,
  onStop,
  onFileNameChange,
  onFileNameEditingChange,
  onHlsVariantChange,
  onMagnetFileToggle,
  onMagnetSelectAll,
  onMagnetClearSelection,
  onMagnetFileNameChange,
  onMagnetFileNameEditingChange,
  onMagnetRenameConflict,
  onMagnetOverwriteConflict,
  onMagnetOverwriteAllConflicts,
  onRenameConflict,
  onOverwriteConflict,
  onThumbnailChange,
  onThumbnailUrl,
  onThumbnailRemove
}: UrlUploadHeaderProps) {
  return (
    <div className="flex items-start gap-3">
      <span className="self-center">
        <UploadThumbnailVisual
          thumbnail={thumbnail}
          fallback={
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-strong">
              <Link2 size={16} />
            </span>
          }
        />
      </span>
      <div className="min-w-0 flex-1">
        {isMagnet ? (
          <p className="truncate text-sm font-semibold text-foreground" title={fileName}>{fileName}</p>
        ) : (
          <EditableFileName
            value={fileName}
            originalValue={remoteFileLabel(url)}
            editing={Boolean(editingFileName)}
            conflict={conflict}
            disabled={disabled || status === "uploading" || status === "done"}
            onChange={onFileNameChange}
            onEditingChange={onFileNameEditingChange}
          />
        )}
        <p className="truncate text-xs text-muted">
          {url}
          {thumbnailHint(thumbnail) ? <span> · {thumbnailHint(thumbnail)}</span> : null}
          {message ? <span className={status === "error" ? "text-danger" : "text-success"}> · {message}</span> : null}
        </p>
        {hls?.probe ? (
          <HlsUploadDetails
            hls={hls}
            disabled={disabled || status === "uploading" || status === "done"}
            onVariantChange={onHlsVariantChange}
          />
        ) : null}
        {magnet?.import ? (
          <MagnetUploadDetails
            magnet={magnet}
            maxMultipartBytes={maxMultipartBytes}
            directoryPath={directoryPath}
            disabled={disabled || status === "uploading" || status === "done"}
            onToggle={onMagnetFileToggle}
            onSelectAll={onMagnetSelectAll}
            onClearSelection={onMagnetClearSelection}
            onFileNameChange={onMagnetFileNameChange}
            onFileNameEditingChange={onMagnetFileNameEditingChange}
            onRenameConflict={onMagnetRenameConflict}
            onOverwriteConflict={onMagnetOverwriteConflict}
            onOverwriteAllConflicts={onMagnetOverwriteAllConflicts}
          />
        ) : null}
        <ConflictResolutionActions
          conflict={conflict}
          disabled={disabled}
          onRename={onRenameConflict}
          onOverwrite={onOverwriteConflict}
        />
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5 self-center">
        {!isMagnet ? (
          <ThumbnailPicker
            disabled={disabled || status === "uploading"}
            onChange={onThumbnailChange}
            onUrl={onThumbnailUrl}
            onRemove={onThumbnailRemove}
            hasThumbnail={thumbnail?.status === "ready"}
          />
        ) : null}
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={disabled}
            className="h-6 shrink-0 rounded-md border border-primary/30 px-2 text-[11px] font-medium text-primary-strong transition-colors hover:bg-primary-soft disabled:pointer-events-none disabled:opacity-40"
          >
            {hls?.retry
              ? hls.retry.failedSegments.length === 0 ? "继续完成上传" : "重试 HLS 片段"
              : retryComplete ? "继续完成上传" : "重试失败分片"}
          </button>
        ) : null}
        {onStop && status === "uploading" ? (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            className="h-6 shrink-0 rounded-md border border-danger/30 px-2 text-[11px] font-medium text-danger transition-colors hover:bg-danger-soft disabled:pointer-events-none disabled:opacity-40"
          >
            {stopping ? "正在停止" : "停止导入"}
          </button>
        ) : null}
        <StatusBadge status={status} multipart={hasProgress} />
        <button
          type="button"
          aria-label="清空 URL"
          onClick={onClear}
          disabled={disabled || status === "uploading"}
          className="grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-danger-soft hover:text-danger disabled:pointer-events-none disabled:opacity-40"
        >
          {status === "done" ? <CheckCircle2 size={13} className="text-success" /> : <X size={13} />}
        </button>
      </div>
    </div>
  );
}, urlUploadHeaderPropsEqual);

const UrlUploadRuntimeDetails = memo(function UrlUploadRuntimeDetails({
  runtimeStore,
  fallbackProgress,
  fallbackChunks,
  chunkTitle,
  compactDuringActive
}: {
  runtimeStore: UploadRuntimeStore;
  fallbackProgress?: ChunkProgress;
  fallbackChunks?: UploadChunkState[];
  chunkTitle: string;
  compactDuringActive: boolean;
}) {
  const runtime = useSyncExternalStore(
    runtimeStore.subscribe,
    runtimeStore.getSnapshot,
    runtimeStore.getSnapshot
  );
  const progress = runtime.progress ?? fallbackProgress;
  const chunks = runtime.chunks ?? fallbackChunks;
  const showChunks = Boolean(chunks) && (!compactDuringActive || Boolean(progress?.failed));

  return (
    <>
      {progress ? <ProgressBar progress={progress} /> : null}
      {showChunks && chunks ? <UploadChunkList chunks={chunks} title={chunkTitle} /> : null}
    </>
  );
}, (previous, next) =>
  previous.runtimeStore === next.runtimeStore &&
  chunkProgressEqual(previous.fallbackProgress, next.fallbackProgress) &&
  previous.fallbackChunks === next.fallbackChunks &&
  previous.chunkTitle === next.chunkTitle &&
  previous.compactDuringActive === next.compactDuringActive
);

function urlUploadRowPropsEqual(previous: UrlUploadRowProps, next: UrlUploadRowProps): boolean {
  return previous.url === next.url &&
    previous.status === next.status &&
    previous.message === next.message &&
    chunkProgressEqual(previous.progress, next.progress) &&
    previous.chunks === next.chunks &&
    previous.fileNameOverride === next.fileNameOverride &&
    previous.editingFileName === next.editingFileName &&
    previous.conflict === next.conflict &&
    previous.hls === next.hls &&
    previous.magnet === next.magnet &&
    previous.maxMultipartBytes === next.maxMultipartBytes &&
    previous.directoryPath === next.directoryPath &&
    previous.thumbnail === next.thumbnail &&
    previous.stopping === next.stopping &&
    previous.disabled === next.disabled &&
    Boolean(previous.onRetry) === Boolean(next.onRetry) &&
    Boolean(previous.onStop) === Boolean(next.onStop) &&
    Boolean(previous.onRenameConflict) === Boolean(next.onRenameConflict) &&
    Boolean(previous.onOverwriteConflict) === Boolean(next.onOverwriteConflict);
}

function urlUploadHeaderPropsEqual(previous: UrlUploadHeaderProps, next: UrlUploadHeaderProps): boolean {
  return previous.url === next.url &&
    previous.status === next.status &&
    previous.message === next.message &&
    previous.fileName === next.fileName &&
    previous.fileNameOverride === next.fileNameOverride &&
    previous.editingFileName === next.editingFileName &&
    previous.conflict === next.conflict &&
    previous.hls === next.hls &&
    previous.magnet === next.magnet &&
    previous.maxMultipartBytes === next.maxMultipartBytes &&
    previous.directoryPath === next.directoryPath &&
    previous.thumbnail === next.thumbnail &&
    previous.hasProgress === next.hasProgress &&
    previous.retryComplete === next.retryComplete &&
    previous.isMagnet === next.isMagnet &&
    previous.disabled === next.disabled &&
    previous.stopping === next.stopping &&
    Boolean(previous.onRetry) === Boolean(next.onRetry) &&
    Boolean(previous.onStop) === Boolean(next.onStop) &&
    Boolean(previous.onRenameConflict) === Boolean(next.onRenameConflict) &&
    Boolean(previous.onOverwriteConflict) === Boolean(next.onOverwriteConflict);
}
