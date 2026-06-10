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
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted">系统设置</p>
        <h1 className="mt-1 text-2xl font-semibold text-foreground sm:text-3xl">密钥与运行状态</h1>
        <p className="mt-1 text-sm text-muted">管理 API key、TG 存储渠道、传输并发、预览缓存，并查看运行配置项的就绪情况。</p>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
        <TelegramChannelsPanel />
        <ApiKeysPanel copyText={copyText} />
        <UploadSettingsPanel session={session} onSessionChange={onSessionChange} />
        <ConfigPanel session={session} />
      </div>
    </div>
  );
}
