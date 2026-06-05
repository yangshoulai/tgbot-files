import { useCallback, useEffect, useState, type ReactNode, type RefObject } from "react";
import { FastForward, Maximize2, Minimize2, Pause, Play, Rewind, Square, Volume2, VolumeX } from "lucide-react";
import { cn } from "../../../lib/cn";

interface MediaControlsProps {
  mediaRef: RefObject<HTMLMediaElement>;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  compact?: boolean;
  variant?: "panel" | "floating" | "inline";
  density?: "regular" | "narrow" | "tiny";
  interactive?: boolean;
  className?: string;
}

interface MediaState {
  playing: boolean;
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  volume: number;
  muted: boolean;
  rate: number;
}

const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function MediaControls({
  mediaRef,
  fullscreen,
  onToggleFullscreen,
  compact = false,
  variant = "panel",
  density = "regular",
  interactive = true,
  className
}: MediaControlsProps) {
  const floating = variant === "floating";
  const inline = variant === "inline";
  const dense = compact || fullscreen || floating;
  const narrow = density === "narrow" || density === "tiny";
  const tiny = density === "tiny";
  const controlTabIndex = interactive ? undefined : -1;
  const [state, setState] = useState<MediaState>({
    playing: false,
    currentTime: 0,
    duration: 0,
    bufferedEnd: 0,
    volume: 1,
    muted: false,
    rate: 1
  });

  const syncState = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;

    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    const bufferedEnd = bufferedEndTime(media);
    setState({
      playing: !media.paused && !media.ended,
      currentTime: media.currentTime || 0,
      duration,
      bufferedEnd,
      volume: media.volume,
      muted: media.muted,
      rate: media.playbackRate
    });
  }, [mediaRef]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;

    const events = [
      "loadedmetadata",
      "durationchange",
      "timeupdate",
      "progress",
      "play",
      "pause",
      "ended",
      "volumechange",
      "ratechange"
    ];
    events.forEach((eventName) => media.addEventListener(eventName, syncState));
    syncState();

    return () => {
      events.forEach((eventName) => media.removeEventListener(eventName, syncState));
    };
  }, [mediaRef, syncState]);

  const togglePlay = async () => {
    const media = mediaRef.current;
    if (!media) return;

    if (media.paused || media.ended) {
      await media.play().catch(() => undefined);
    } else {
      media.pause();
    }
    syncState();
  };

  const stop = () => {
    const media = mediaRef.current;
    if (!media) return;
    media.pause();
    media.currentTime = 0;
    syncState();
  };

  const seekBy = (seconds: number) => {
    const media = mediaRef.current;
    if (!media) return;
    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    media.currentTime = Math.min(Math.max(media.currentTime + seconds, 0), duration || Number.MAX_SAFE_INTEGER);
    syncState();
  };

  const seekTo = (value: string) => {
    const media = mediaRef.current;
    if (!media) return;
    media.currentTime = Number(value);
    syncState();
  };

  const setVolume = (value: string) => {
    const media = mediaRef.current;
    if (!media) return;
    const volume = Number(value);
    media.volume = volume;
    media.muted = volume === 0 ? true : media.muted && volume === 0;
    if (volume > 0 && media.muted) media.muted = false;
    syncState();
  };

  const toggleMute = () => {
    const media = mediaRef.current;
    if (!media) return;
    media.muted = !media.muted;
    syncState();
  };

  const setRate = (value: string) => {
    const media = mediaRef.current;
    if (!media) return;
    media.playbackRate = Number(value);
    syncState();
  };

  const duration = Math.max(state.duration, 0);
  const currentTime = Math.min(state.currentTime, duration || state.currentTime);
  const bufferedPercent = duration > 0 ? Math.min(100, (state.bufferedEnd / duration) * 100) : 0;
  const progressPercent = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      className={cn(
        inline ? "text-foreground" : "text-white",
        floating
          ? "w-full drop-shadow-[0_2px_12px_rgba(0,0,0,0.65)]"
          : inline
            ? "rounded-2xl border border-border bg-background p-3 shadow-card"
            : "rounded-2xl border border-white/10 bg-black/70 p-3 shadow-dialog backdrop-blur-md",
        !floating && !inline && dense ? "p-2.5" : null,
        !floating && !inline && tiny ? "p-2" : null,
        inline && dense ? "p-3" : null,
        className
      )}
      aria-hidden={interactive ? undefined : true}
    >
      <div
        className={cn(
          "relative rounded-full",
          floating ? "mb-2 h-1.5 bg-white/30 sm:h-2" : inline ? "mb-3 h-2 bg-border" : dense ? "mb-2 h-2.5 bg-white/15" : "mb-3 h-3 bg-white/15",
          tiny && "mb-1.5 h-1.5"
        )}
      >
        <div className={cn("absolute inset-y-0 left-0 rounded-full", inline ? "bg-border-strong/60" : "bg-white/35")} style={{ width: `${bufferedPercent}%` }} />
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full", floating ? "bg-[#ff0033]" : "bg-primary")}
          style={{ width: `${progressPercent}%` }}
        />
        <input
          type="range"
          min={0}
          max={duration || 0}
          step="0.1"
          value={duration ? currentTime : 0}
          onChange={(event) => seekTo(event.target.value)}
          aria-label="播放进度"
          tabIndex={controlTabIndex}
          className={cn("absolute inset-x-0 -inset-y-2 h-5 w-full cursor-pointer opacity-0", floating && "sm:-inset-y-2.5 sm:h-6")}
        />
      </div>

      <div className={cn("flex min-w-0 flex-nowrap items-center", floating ? "gap-1.5 sm:gap-2" : "gap-2", tiny && "gap-1")}>
        <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
          <MediaButton
            label={state.playing ? "暂停" : "播放"}
            onClick={() => void togglePlay()}
            emphasis
            dense={dense}
            floating={floating}
            inline={inline}
            tabIndex={controlTabIndex}
          >
            {state.playing ? <Pause size={16} /> : <Play size={16} />}
          </MediaButton>
          {!floating && !inline ? (
            <MediaButton label="停止" onClick={stop} dense={dense} floating={floating} inline={inline} tabIndex={controlTabIndex} className="max-sm:hidden">
              <Square size={15} />
            </MediaButton>
          ) : null}
          {!narrow ? (
            <>
              <MediaButton
                label="快退 10 秒"
                onClick={() => seekBy(-10)}
                dense={dense}
                floating={floating}
                inline={inline}
                tabIndex={controlTabIndex}
                className="max-[520px]:hidden"
              >
                <Rewind size={15} />
              </MediaButton>
              <MediaButton
                label="快进 10 秒"
                onClick={() => seekBy(10)}
                dense={dense}
                floating={floating}
                inline={inline}
                tabIndex={controlTabIndex}
                className="max-[520px]:hidden"
              >
                <FastForward size={15} />
              </MediaButton>
            </>
          ) : null}
        </div>

        <div
          className={cn(
            "shrink-0 text-center font-mono text-xs text-white/75",
            dense ? "min-w-[5.75rem]" : "min-w-[6.75rem]",
            floating && "min-w-[5.1rem] text-white/90 sm:min-w-[6.5rem]",
            inline && "text-muted",
            tiny && "min-w-[3.5rem] text-[11px]"
          )}
        >
          {tiny
            ? formatMediaTime(currentTime)
            : floating
              ? `${formatMediaTime(currentTime)}${duration ? ` / ${formatMediaTime(duration)}` : ""}`
              : `${formatMediaTime(currentTime)} / ${duration ? formatMediaTime(duration) : "--:--"}`}
        </div>

        <div className={cn("ml-auto flex min-w-0 shrink-0 items-center", floating ? "gap-1 sm:gap-1.5" : "gap-1.5")}>
          <MediaButton label={state.muted ? "取消静音" : "静音"} onClick={toggleMute} dense={dense} floating={floating} inline={inline} tabIndex={controlTabIndex}>
            {state.muted || state.volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </MediaButton>
          <input
            type="range"
            min={0}
            max={1}
            step="0.01"
            value={state.muted ? 0 : state.volume}
            onChange={(event) => setVolume(event.target.value)}
            aria-label="音量"
            tabIndex={controlTabIndex}
            className={cn(
              "h-1.5 cursor-pointer",
              floating ? "hidden w-16 accent-[#ff0033] min-[560px]:block" : inline ? "hidden w-16 accent-primary sm:block" : dense ? "hidden w-14 accent-primary lg:block" : "hidden w-20 accent-primary md:block"
            )}
          />
          {!tiny ? (
            <label className={cn("inline-flex shrink-0 items-center gap-1 text-xs", inline ? "text-muted" : "text-white/70")}>
              <span className={dense ? "sr-only" : "hidden xl:inline"}>倍速</span>
              <select
                value={state.rate}
                onChange={(event) => setRate(event.target.value)}
                tabIndex={controlTabIndex}
                className={cn(
                  "border text-xs outline-none transition-colors focus-visible:focus-ring",
                  floating ? "h-8 w-[3.1rem] rounded-md px-1 sm:w-[3.35rem] sm:rounded-full sm:px-1.5" : "rounded-md",
                  inline ? "h-8 w-[3.35rem] border-border bg-surface px-1.5 text-foreground hover:bg-primary-soft/50" : "border-white/10 bg-white/10 text-white hover:bg-white/15",
                  dense && !floating ? "h-8 w-14 px-1.5" : null,
                  !dense ? "h-9 w-16 px-2" : null
                )}
                aria-label="切换播放速度"
              >
                {playbackRates.map((rate) => (
                  <option key={rate} value={rate} className={inline ? "bg-surface text-foreground" : "bg-foreground text-white"}>
                    {rate}x
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <MediaButton label={fullscreen ? "退出全屏" : "全屏"} onClick={onToggleFullscreen} dense={dense} floating={floating} inline={inline} tabIndex={controlTabIndex}>
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </MediaButton>
        </div>
      </div>
    </div>
  );
}

function MediaButton({ label, onClick, children, emphasis = false, dense = false, floating = false, inline = false, tabIndex, className }: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  emphasis?: boolean;
  dense?: boolean;
  floating?: boolean;
  inline?: boolean;
  tabIndex?: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      tabIndex={tabIndex}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 border text-xs font-medium transition-colors focus-visible:outline-none focus-visible:focus-ring",
        dense ? "size-8 rounded-lg px-0" : "h-9 rounded-lg px-2.5",
        floating && "size-8 rounded-full border-transparent bg-transparent text-white/92 hover:bg-white/15 hover:text-white active:bg-white/20 sm:size-9",
        inline && "border-border bg-surface text-muted hover:bg-primary-soft/50 hover:text-primary-strong",
        emphasis && !floating
          ? inline
            ? "border-primary bg-primary text-white hover:bg-primary-strong"
            : "border-primary bg-primary text-white hover:bg-primary-strong"
          : !floating
            ? inline
              ? null
              : "border-white/10 bg-white/10 text-white/85 hover:bg-white/15 hover:text-white"
            : null,
        emphasis && floating && "text-white",
        className
      )}
    >
      {children}
      {!dense ? <span className="hidden 2xl:inline">{label}</span> : null}
    </button>
  );
}

function bufferedEndTime(media: HTMLMediaElement): number {
  if (!media.buffered.length) return 0;

  try {
    return media.buffered.end(media.buffered.length - 1);
  } catch {
    return 0;
  }
}

export function formatMediaTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "00:00";
  }

  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
