import type { SessionResponse } from "../api";
import { ApiKeysPanel } from "../components/settings/ApiKeysPanel";
import { ConfigPanel } from "../components/settings/ConfigPanel";
import { TelegramChannelsPanel } from "../components/settings/TelegramChannelsPanel";
import { UploadSettingsPanel } from "../components/settings/UploadSettingsPanel";

interface SettingsPageProps {
  session: SessionResponse;
  onSessionChange: (session: SessionResponse) => void;
  copyText: (value: string) => void;
}

export function SettingsPage({ session, onSessionChange, copyText }: SettingsPageProps) {
  return (
    <div className="flex flex-col gap-5">
      <section className="overflow-hidden rounded-3xl border border-border bg-surface shadow-card">
        <div className="relative px-5 py-6 sm:px-7 lg:px-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_0%,rgba(16,185,129,0.16),transparent_34%),linear-gradient(135deg,rgba(236,253,245,0.78),rgba(255,255,255,0)_48%)]" />
          <div className="relative max-w-4xl">
            <p className="inline-flex items-center rounded-full border border-primary/20 bg-primary-soft px-3 py-1 text-xs font-medium uppercase tracking-wide text-primary-strong">
              系统设置
            </p>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">密钥与运行状态</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
              管理 API key、Telegram 存储渠道、传输并发、预览缓存，并查看运行配置项的就绪情况。
            </p>
          </div>
        </div>
      </section>

      <div className="flex w-full flex-col gap-4">
        <div className="w-full">
          <TelegramChannelsPanel />
        </div>
        <div className="w-full">
          <ApiKeysPanel copyText={copyText} />
        </div>
        <div className="w-full">
          <UploadSettingsPanel session={session} onSessionChange={onSessionChange} />
        </div>
        <div className="w-full">
          <ConfigPanel session={session} />
        </div>
      </div>
    </div>
  );
}
