import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Languages, Music2 } from "lucide-react";
import { listFiles, type FileItem } from "../../../api";
import { hasFileLinkAccess } from "../../../lib/file-access";
import { formatBytes } from "../../../utils";
import { cn } from "../../../lib/cn";
import type { PreviewComponentProps } from "./types";
import { MediaControls } from "./MediaControls";
import { PreviewError } from "./PreviewFrame";
import { Spinner } from "../../ui/Spinner";

interface AudioPreviewProps extends PreviewComponentProps {
  onToggleMaximized: () => void;
  nativeFullscreen: boolean;
  onToggleNativeFullscreen: () => void;
}

interface LoadedLyricsTrack {
  id: string;
  label: string;
  kind: "timed" | "plain";
  sourceFileName: string;
  lines: LyricsLine[];
}

interface LyricsLine {
  id: string;
  time: number | null;
  text: string;
}

const AUDIO_PREVIEW_TIMEOUT_MS = 30_000;
const LYRICS_PREVIEW_TIMEOUT_MS = 20_000;

export function AudioPreview({ file, fullscreen, onToggleMaximized, nativeFullscreen, onToggleNativeFullscreen }: AudioPreviewProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricsFailed, setLyricsFailed] = useState(false);
  const [lyricsTracks, setLyricsTracks] = useState<LoadedLyricsTrack[]>([]);
  const [selectedLyricsId, setSelectedLyricsId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const linkFile = hasFileLinkAccess(file) ? file : null;
  const coverUrl = file.thumbnail_url && !coverFailed ? file.thumbnail_url : null;
  const selectedLyrics = useMemo(
    () => lyricsTracks.find((track) => track.id === selectedLyricsId) ?? null,
    [lyricsTracks, selectedLyricsId]
  );
  const activeLyricsIndex = useMemo(
    () => selectedLyrics?.kind === "timed" ? activeLyricsLineIndex(selectedLyrics.lines, currentTime) : -1,
    [currentTime, selectedLyrics]
  );
  const showLyricsPanel = lyricsFailed || lyricsTracks.length > 0;

  useEffect(() => {
    setLoading(true);
    setFailed(false);
    setCoverFailed(false);
    setCurrentTime(0);
  }, [file.id]);

  useEffect(() => {
    if (!loading || failed || !linkFile) return;

    const timeout = window.setTimeout(() => {
      setLoading(false);
      setFailed(true);
    }, AUDIO_PREVIEW_TIMEOUT_MS);

    return () => window.clearTimeout(timeout);
  }, [linkFile, failed, loading]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;

    const syncCurrentTime = () => setCurrentTime(audio.currentTime || 0);
    const events = ["loadedmetadata", "timeupdate", "seeking", "seeked", "play", "pause", "ended"];
    events.forEach((eventName) => audio.addEventListener(eventName, syncCurrentTime));
    syncCurrentTime();

    return () => {
      events.forEach((eventName) => audio.removeEventListener(eventName, syncCurrentTime));
    };
  }, [file.id]);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), LYRICS_PREVIEW_TIMEOUT_MS);

    setLyricsLoading(true);
    setLyricsFailed(false);
    setLyricsTracks([]);
    setSelectedLyricsId(null);

    async function loadLyricsTracks() {
      const stem = fileStem(file.file_name);
      if (!stem) {
        setLyricsLoading(false);
        return;
      }

      const result = await listFiles({
        q: stem,
        dir: file.directory_path || "/",
        limit: "all",
        type: "all"
      });
      if (disposed) return;

      const lyricsFiles = matchingLyricsFiles(result.files, file);
      const loaded = (await Promise.all(lyricsFiles.map((lyricsFile) => loadLyricsFile(lyricsFile, file.file_name, controller.signal))))
        .filter((track): track is LoadedLyricsTrack => Boolean(track));
      if (disposed) return;

      setLyricsTracks(loaded);
      setSelectedLyricsId((current) => {
        if (current && loaded.some((track) => track.id === current)) {
          return current;
        }
        return loaded[0]?.id ?? null;
      });
      setLyricsFailed(lyricsFiles.length > 0 && loaded.length === 0);
      setLyricsLoading(false);
    }

    void loadLyricsTracks()
      .catch(() => {
        if (!disposed) {
          setLyricsTracks([]);
          setSelectedLyricsId(null);
          setLyricsFailed(true);
          setLyricsLoading(false);
        }
      })
      .finally(() => window.clearTimeout(timeoutId));

    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [file.directory_path, file.file_name, file.id]);

  if (!linkFile) {
    return <PreviewError message="该音频不提供完整访问链接，无法直接在线播放" dark />;
  }

  return (
    <div
      className={cn(
        "relative isolate flex min-h-0 w-full items-center justify-center overflow-hidden bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(239,251,246,0.92))] p-3 text-foreground sm:p-4",
        fullscreen ? "h-full" : "h-[min(64dvh,650px)] min-h-[28rem]"
      )}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <span className="absolute -top-14 left-[8%] h-[24rem] w-32 -rotate-12 bg-[linear-gradient(180deg,rgba(16,185,129,0.22),rgba(16,185,129,0.045)_62%,transparent)] blur-sm [clip-path:polygon(34%_0,66%_0,100%_100%,0_100%)] sm:w-44" />
        <span className="absolute -top-16 right-[10%] h-[25rem] w-36 rotate-12 bg-[linear-gradient(180deg,rgba(59,130,246,0.14),rgba(16,185,129,0.04)_58%,transparent)] blur-sm [clip-path:polygon(34%_0,66%_0,100%_100%,0_100%)] sm:w-48" />
        <span className="absolute inset-x-0 bottom-0 h-28 bg-[linear-gradient(180deg,transparent,rgba(16,185,129,0.08))]" />
      </div>

      <div className="relative flex h-full min-h-0 w-full max-w-5xl flex-col justify-center gap-3">
        <div className="flex min-w-0 shrink-0 items-center gap-3 rounded-[1.2rem] border border-white/80 bg-white/[0.72] p-3 shadow-[0_18px_44px_rgba(15,23,42,0.1)] ring-1 ring-border/70 backdrop-blur-md">
          <div className="size-16 shrink-0 overflow-hidden rounded-2xl border border-white/80 bg-background shadow-[0_18px_42px_rgba(15,23,42,0.16)] ring-1 ring-border/70 sm:size-20">
            {coverUrl ? (
              <img
                src={coverUrl}
                alt={`${file.file_name} 封面`}
                onError={() => setCoverFailed(true)}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="grid h-full w-full place-items-center bg-primary-soft text-primary-strong">
                <Music2 size={30} />
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-foreground sm:text-lg" title={file.file_name}>{file.file_name}</p>
            <p className="mt-1 text-sm text-muted">{formatBytes(file.size)} · {file.mime_type}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {loading ? (
                <span className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted">
                  <Spinner size={15} />
                  音频加载中…
                </span>
              ) : null}
              {showLyricsPanel ? (
                <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-primary/15 bg-primary-soft px-3 py-1.5 text-xs font-medium text-primary-strong">
                  <FileText size={14} />
                  已加载歌词
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {failed ? (
          <p className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
            音频加载失败，请尝试下载后播放。
          </p>
        ) : null}

        <audio
          ref={audioRef}
          src={file.file_path}
          preload="metadata"
          onLoadStart={() => setLoading(true)}
          onLoadedMetadata={() => {
            setLoading(false);
            setFailed(false);
          }}
          onCanPlay={() => {
            setLoading(false);
            setFailed(false);
          }}
          onPlaying={() => {
            setLoading(false);
            setFailed(false);
          }}
          onError={() => {
            setLoading(false);
            setFailed(true);
          }}
        >
          当前浏览器不支持该音频预览。
        </audio>

        {showLyricsPanel ? (
          <LyricsPanel
            tracks={lyricsTracks}
            selectedTrack={selectedLyrics}
            selectedTrackId={selectedLyricsId}
            activeLineIndex={activeLyricsIndex}
            loading={lyricsLoading}
            failed={lyricsFailed}
            fullscreen={fullscreen}
            onSelectedTrackChange={setSelectedLyricsId}
          />
        ) : null}

        <div className="w-full shrink-0">
          <MediaControls
            mediaRef={audioRef}
            maximized={fullscreen}
            onToggleMaximized={onToggleMaximized}
            nativeFullscreen={nativeFullscreen}
            onToggleNativeFullscreen={onToggleNativeFullscreen}
            compact
            variant="inline"
            className="w-full"
          />
        </div>
      </div>
    </div>
  );
}

function LyricsPanel({
  tracks,
  selectedTrack,
  selectedTrackId,
  activeLineIndex,
  loading,
  failed,
  fullscreen,
  onSelectedTrackChange
}: {
  tracks: LoadedLyricsTrack[];
  selectedTrack: LoadedLyricsTrack | null;
  selectedTrackId: string | null;
  activeLineIndex: number;
  loading: boolean;
  failed: boolean;
  fullscreen: boolean;
  onSelectedTrackChange: (trackId: string | null) => void;
}) {
  const activeLineRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (!selectedTrack || selectedTrack.kind !== "timed" || activeLineIndex < 0) return;
    activeLineRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeLineIndex, selectedTrack]);

  const statusLabel = loading
    ? "查找中"
    : selectedTrack?.kind === "timed"
      ? "同步歌词"
      : selectedTrack?.kind === "plain"
        ? "文本歌词"
        : tracks.length > 0
          ? "可选择"
          : "歌词";

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.2rem] border border-white/80 bg-white/[0.72] p-3 shadow-[0_18px_44px_rgba(15,23,42,0.12)] ring-1 ring-border/70 backdrop-blur-md">
      <div className="mb-2 flex min-w-0 shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-strong ring-1 ring-primary/15">
            <FileText size={18} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">歌词</p>
            <p className="truncate text-xs text-muted">{statusLabel}</p>
          </div>
        </div>

        {tracks.length > 0 ? (
          <label className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted" title={tracks.length > 1 ? "切换歌词" : "歌词"}>
            <Languages size={15} className="text-foreground/55" />
            <select
              value={selectedTrackId ?? ""}
              onChange={(event) => onSelectedTrackChange(event.target.value || null)}
              className="h-8 max-w-[9.5rem] rounded-full border border-border bg-surface px-2 text-xs text-foreground outline-none transition-colors hover:bg-primary-soft/50 focus-visible:focus-ring"
              aria-label="切换歌词"
            >
              <option value="" className="bg-surface text-foreground">歌词关</option>
              {tracks.map((track) => (
                <option key={track.id} value={track.id} className="bg-surface text-foreground">
                  {track.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border/70 bg-[linear-gradient(180deg,rgba(248,250,252,0.92),rgba(236,253,245,0.66))] px-4 py-4",
          fullscreen ? "max-h-none" : "max-h-none",
          selectedTrack?.kind === "timed" && "[mask-image:linear-gradient(to_bottom,transparent,black_10%,black_90%,transparent)]"
        )}
      >
        {loading ? (
          <div className="grid min-h-32 place-items-center text-sm text-muted">
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5">
              <Spinner size={15} />
              正在查找同名歌词…
            </span>
          </div>
        ) : failed && tracks.length === 0 ? (
          <div className="grid min-h-32 place-items-center text-center text-sm text-danger">
            <p>歌词读取失败，请确认同名歌词文件可访问。</p>
          </div>
        ) : tracks.length > 0 && !selectedTrack ? (
          <div className="grid min-h-32 place-items-center text-center text-sm text-muted">
            <p>已发现同名歌词，可在右上角选择加载。</p>
          </div>
        ) : selectedTrack ? (
          selectedTrack.lines.length > 0 ? (
            selectedTrack.kind === "timed" ? (
              <div className="space-y-1 py-10">
                {selectedTrack.lines.map((line, index) => {
                  const active = index === activeLineIndex;
                  return (
                    <p
                      key={line.id}
                      ref={active ? activeLineRef : undefined}
                      className={cn(
                        "origin-center py-1.5 text-center text-sm leading-7 transition-all duration-300",
                        active
                          ? "scale-[1.03] font-semibold text-primary-strong drop-shadow-[0_8px_18px_rgba(16,185,129,0.18)]"
                          : "text-foreground/58",
                        activeLineIndex >= 0 && index < activeLineIndex && !active ? "text-muted/45" : null
                      )}
                    >
                      {line.text || "♪"}
                    </p>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-2 text-sm leading-7 text-foreground/72">
                {selectedTrack.lines.map((line) => (
                  <p key={line.id}>{line.text}</p>
                ))}
              </div>
            )
          ) : (
            <div className="grid min-h-32 place-items-center text-center text-sm text-muted">
              <p>歌词文件为空。</p>
            </div>
          )
        ) : null}
      </div>

      {selectedTrack ? (
        <p className="mt-2 shrink-0 truncate text-xs text-muted" title={selectedTrack.sourceFileName}>
          来源：{selectedTrack.sourceFileName}
        </p>
      ) : null}
    </section>
  );
}

async function loadLyricsFile(
  lyricsFile: FileItem,
  audioFileName: string,
  signal: AbortSignal
): Promise<LoadedLyricsTrack | null> {
  if (!hasFileLinkAccess(lyricsFile)) return null;

  const extension = lyricsExtension(lyricsFile.file_name);
  if (!extension) return null;

  try {
    const response = await fetch(lyricsFile.file_path, {
      credentials: "include",
      signal
    });
    if (!response.ok) {
      throw new Error(response.statusText || "歌词读取失败");
    }

    const text = await response.text();
    const parsed = lyricsTextToLines(text, extension);
    const language = lyricsLanguageCode(lyricsFile.file_name, audioFileName);

    return {
      id: `lyrics-${lyricsFile.id}`,
      label: lyricsLabel(lyricsFile.file_name, audioFileName, language, extension),
      kind: parsed.kind,
      sourceFileName: lyricsFile.file_name,
      lines: parsed.lines
    };
  } catch {
    return null;
  }
}

function matchingLyricsFiles(files: FileItem[], audioFile: FileItem): FileItem[] {
  const audioStem = fileStem(audioFile.file_name);
  const directoryPath = audioFile.directory_path || "/";

  return files
    .filter((candidate) =>
      candidate.id !== audioFile.id &&
      (candidate.directory_path || "/") === directoryPath &&
      lyricsStemMatchesAudio(candidate.file_name, audioStem) &&
      lyricsExtension(candidate.file_name) !== null
    )
    .sort((left, right) =>
      lyricsPriority(left.file_name, audioFile.file_name) - lyricsPriority(right.file_name, audioFile.file_name) ||
      left.file_name.localeCompare(right.file_name)
    );
}

function fileStem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").trim().toLocaleLowerCase();
}

function lyricsStemMatchesAudio(fileName: string, audioStem: string): boolean {
  const lyricsStem = lyricsFileStem(fileName);
  return lyricsStem === audioStem || lyricsStem.startsWith(`${audioStem}.`);
}

function lyricsFileStem(fileName: string): string {
  return fileName.replace(/\.(?:lrc|txt)$/i, "").trim().toLocaleLowerCase();
}

function lyricsExtension(fileName: string): "lrc" | "txt" | null {
  const normalized = fileName.toLocaleLowerCase();
  if (normalized.endsWith(".lrc")) return "lrc";
  if (normalized.endsWith(".txt")) return "txt";
  return null;
}

function lyricsPriority(fileName: string, audioFileName: string): number {
  const hasLanguageSuffix = Boolean(lyricsLanguageSuffix(fileName, audioFileName));
  const extensionPriority = lyricsExtension(fileName) === "lrc" ? 0 : 1;
  return (hasLanguageSuffix ? 10 : 0) + extensionPriority;
}

function lyricsLabel(
  fileName: string,
  audioFileName: string,
  language: string | undefined,
  extension: "lrc" | "txt"
): string {
  const suffix = lyricsLanguageSuffix(fileName, audioFileName);
  const languageLabel = language ? languageName(language) : suffix ? suffix : "默认歌词";
  return `${languageLabel}（${extension.toUpperCase()}）`;
}

function lyricsLanguageCode(fileName: string, audioFileName: string): string | undefined {
  const suffix = lyricsLanguageSuffix(fileName, audioFileName);
  if (!suffix) return undefined;

  const normalized = suffix.replace(/_/g, "-").toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function lyricsLanguageSuffix(fileName: string, audioFileName: string): string | undefined {
  const audioStem = fileStem(audioFileName);
  const lyricsStem = lyricsFileStem(fileName);
  if (!lyricsStem.startsWith(`${audioStem}.`)) {
    return undefined;
  }

  return lyricsStem.slice(audioStem.length + 1) || undefined;
}

function languageName(language: string): string {
  const normalized = language.toLowerCase();
  const direct: Record<string, string> = {
    "zh": "中文",
    "zh-cn": "简体中文",
    "zh-hans": "简体中文",
    "zh-tw": "繁体中文",
    "zh-hk": "繁体中文",
    "zh-hant": "繁体中文",
    en: "English",
    "en-us": "English",
    "en-gb": "English",
    ja: "日本語",
    jp: "日本語",
    ko: "한국어",
    kr: "한국어",
    fr: "Français",
    de: "Deutsch",
    es: "Español",
    ru: "Русский",
    it: "Italiano",
    pt: "Português",
    ar: "العربية",
    hi: "हिन्दी"
  };

  return direct[normalized] ?? language;
}

function lyricsTextToLines(text: string, extension: "lrc" | "txt"): { kind: LoadedLyricsTrack["kind"]; lines: LyricsLine[] } {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return { kind: extension === "lrc" ? "timed" : "plain", lines: [] };

  if (extension === "lrc") {
    const timedLines = parseLrcLines(normalized);
    if (timedLines.length > 0) {
      return { kind: "timed", lines: timedLines };
    }
  }

  return {
    kind: "plain",
    lines: normalized
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^\[[a-z]+:/i.test(line))
      .map((line, index) => ({ id: `plain-${index}`, time: null, text: line }))
  };
}

function parseLrcLines(text: string): LyricsLine[] {
  const offsetSeconds = lrcOffsetSeconds(text);
  const timestampPattern = /\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const parsed: Array<{ time: number; text: string }> = [];

  text.split("\n").forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || /^\[[a-z]+:/i.test(line)) return;

    const timestamps = Array.from(line.matchAll(timestampPattern));
    if (timestamps.length === 0) return;

    const lyricText = line.replace(timestampPattern, "").trim();
    timestamps.forEach((match) => {
      const hours = match[1] ? Number(match[1]) : 0;
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      const fraction = match[4] ? Number(`0.${match[4].padEnd(3, "0").slice(0, 3)}`) : 0;
      const time = Math.max(0, hours * 3600 + minutes * 60 + seconds + fraction + offsetSeconds);
      if (Number.isFinite(time)) {
        parsed.push({ time, text: lyricText });
      }
    });
  });

  return parsed
    .sort((left, right) => left.time - right.time)
    .map((line, index) => ({
      id: `timed-${index}-${line.time.toFixed(3)}`,
      time: line.time,
      text: line.text
    }));
}

function lrcOffsetSeconds(text: string): number {
  const offsetMatch = text.match(/^\s*\[offset:([+-]?\d+)\]/im);
  if (!offsetMatch) return 0;

  const milliseconds = Number(offsetMatch[1]);
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : 0;
}

function activeLyricsLineIndex(lines: LyricsLine[], currentTime: number): number {
  let activeIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const lineTime = lines[index]?.time;
    if (lineTime === null || lineTime === undefined) continue;
    if (lineTime <= currentTime + 0.12) {
      activeIndex = index;
      continue;
    }
    break;
  }

  return activeIndex;
}
