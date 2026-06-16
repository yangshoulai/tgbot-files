import { ReactNode, useState } from "react";
import { BookOpenText, ChevronDown, LayoutDashboard, LogOut, Settings, UploadCloud, User } from "lucide-react";
import type { SessionResponse } from "../../api";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";

export type ShellRoute = "admin" | "docs" | "settings";

interface ShellProps {
  active: ShellRoute;
  session: SessionResponse;
  onNavigate: (route: ShellRoute) => void;
  onLogout: () => void;
  onUpload: () => void;
  children: ReactNode;
}

const NAV: Array<{ key: ShellRoute; label: string; icon: typeof LayoutDashboard }> = [
  { key: "admin", label: "控制台", icon: LayoutDashboard },
  { key: "docs", label: "API 文档", icon: BookOpenText },
  { key: "settings", label: "设置", icon: Settings }
];

export function Shell({ active, session, onNavigate, onLogout, onUpload, children }: ShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-x-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(circle_at_12%_-8%,rgba(16,185,129,0.16),transparent_32%),radial-gradient(circle_at_88%_0%,rgba(56,189,248,0.12),transparent_30%),linear-gradient(180deg,rgba(236,253,245,0.72),rgba(255,255,255,0)_22rem)]"
      />
      <header className="sticky top-0 z-30 border-b border-border/80 bg-surface/85 shadow-[0_1px_0_rgba(15,23,42,0.03)] backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[104rem] items-center gap-3 px-4 sm:h-16 sm:px-6 lg:px-8 xl:px-10">
          <button
            type="button"
            onClick={() => onNavigate("admin")}
            className="flex items-center gap-2 rounded-lg px-1.5 py-1 focus-visible:outline-none focus-visible:focus-ring"
          >
            <span className="grid size-8 place-items-center rounded-xl bg-primary text-white shadow-[0_10px_24px_rgba(16,185,129,0.28)]">
              <Logo />
            </span>
            <span className="text-base font-semibold tracking-tight text-foreground">飞梭云盘</span>
          </button>

          <nav className="ml-2 hidden items-center gap-1 sm:flex" aria-label="主导航">
            {NAV.map((item) => {
              const Icon = item.icon;
              const isActive = item.key === active;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onNavigate(item.key)}
                  className={cn(
                    "inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors duration-150",
                    "focus-visible:outline-none focus-visible:focus-ring",
                    isActive
                      ? "bg-primary-soft text-primary-strong"
                      : "text-muted hover:bg-background hover:text-foreground"
                  )}
                >
                  <Icon size={15} />
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="primary"
              size="md"
              leadingIcon={<UploadCloud size={16} />}
              onClick={onUpload}
              title="上传文件（快捷键 U）"
              className="hidden sm:inline-flex"
            >
              上传文件
            </Button>
            <IconButton
              variant="default"
              size="md"
              label="上传文件（快捷键 U）"
              onClick={onUpload}
              className="sm:hidden"
            >
              <UploadCloud size={18} />
            </IconButton>

            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                onBlur={() => window.setTimeout(() => setMenuOpen(false), 120)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className={cn(
                  "inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-sm font-medium text-foreground shadow-card",
                  "transition-colors duration-150 hover:border-border-strong hover:bg-background",
                  "focus-visible:outline-none focus-visible:focus-ring"
                )}
              >
                <span className="grid size-6 place-items-center rounded-full bg-primary-soft text-primary-strong">
                  <User size={13} />
                </span>
                <span className="hidden max-w-24 truncate sm:inline">{session.username}</span>
                <ChevronDown size={14} className={cn("transition-transform", menuOpen && "rotate-180")} />
              </button>
              {menuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-12 z-40 w-56 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-dialog animate-fade-in"
                >
                  <div className="px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wide text-muted">登录身份</p>
                    <p className="truncate text-sm font-medium text-foreground" title={session.username}>
                      {session.username}
                    </p>
                  </div>
                  <div className="my-1 h-px bg-border" />
                  <button
                    type="button"
                    role="menuitem"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      setMenuOpen(false);
                      onLogout();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-danger-soft hover:text-danger"
                  >
                    <LogOut size={15} />
                    退出登录
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <nav
          aria-label="主导航"
          className="flex border-t border-border bg-surface/80 px-3 backdrop-blur-md sm:hidden"
        >
          {NAV.map((item) => {
            const Icon = item.icon;
            const isActive = item.key === active;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onNavigate(item.key)}
                className={cn(
                  "flex h-11 flex-1 items-center justify-center gap-1.5 text-sm font-medium",
                  "transition-colors duration-150 focus-visible:outline-none focus-visible:focus-ring",
                  isActive
                    ? "text-primary-strong"
                    : "text-muted hover:text-foreground"
                )}
              >
                <Icon size={15} />
                {item.label}
                {isActive ? <span className="ml-1 size-1.5 rounded-full bg-primary" aria-hidden /> : null}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-[104rem] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8 xl:px-10">{children}</main>
    </div>
  );
}

function Logo() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 3.5A1.5 1.5 0 0 1 4.5 2h3.379a1.5 1.5 0 0 1 1.06.44l1.122 1.121A1.5 1.5 0 0 0 11.121 4H13a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 13 13H4.5A1.5 1.5 0 0 1 3 11.5v-8Z"
        fill="currentColor"
        opacity="0.95"
      />
    </svg>
  );
}
