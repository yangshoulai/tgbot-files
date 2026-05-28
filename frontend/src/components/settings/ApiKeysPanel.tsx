import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, RefreshCw } from "lucide-react";
import { ApiError, ApiKeyItem, createApiKey, deleteApiKey, getApiKey, listApiKeys, updateApiKey } from "../../api";
import { useToast } from "../../lib/toast";
import { useConfirm } from "../../lib/confirm";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { EmptyState } from "../ui/EmptyState";
import { Spinner } from "../ui/Spinner";
import { ApiKeyRow } from "./ApiKeyRow";
import { RevealKeyDialog } from "./RevealKeyDialog";
import { CreateApiKeyDialog } from "./CreateApiKeyDialog";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "请求失败";
}

interface ApiKeysPanelProps {
  copyText: (value: string) => void;
}

export function ApiKeysPanel({ copyText }: ApiKeysPanelProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ApiKeyItem | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await listApiKeys();
      setApiKeys(response.api_keys);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(name: string) {
    setCreating(true);
    try {
      const response = await createApiKey(name);
      setCreateOpen(false);
      setRevealed(response.api_key);
      toast.success("密钥已创建");
      await load();
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  async function onReveal(key: ApiKeyItem) {
    setBusyId(key.id);
    try {
      const response = await getApiKey(key.id);
      setRevealed(response.api_key);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  async function onToggle(key: ApiKeyItem) {
    setBusyId(key.id);
    try {
      const nextStatus = key.status === "active" ? "disabled" : "active";
      await updateApiKey(key.id, { status: nextStatus });
      toast.success(nextStatus === "active" ? "密钥已启用" : "密钥已禁用");
      await load();
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(key: ApiKeyItem) {
    const ok = await confirm({
      title: "删除该密钥？",
      description: (
        <>
          密钥 <span className="font-mono text-foreground">{key.name}</span> 将立即失效，使用该密钥的客户端会被拒绝。
        </>
      ),
      tone: "danger",
      confirmText: "删除"
    });
    if (!ok) return;

    setBusyId(key.id);
    try {
      await deleteApiKey(key.id);
      toast.success("密钥已删除");
      await load();
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">上传接口</p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">API keys</h2>
          <p className="mt-0.5 text-xs text-muted">{apiKeys.length} 个密钥</p>
        </div>
        <div className="flex items-center gap-2">
          <IconButton variant="default" size="sm" label="刷新" onClick={() => void load()}>
            {loading ? <Spinner size={14} /> : <RefreshCw size={14} />}
          </IconButton>
          <Button
            variant="primary"
            size="sm"
            leadingIcon={<Plus size={15} />}
            onClick={() => setCreateOpen(true)}
          >
            新增密钥
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-2">
        {apiKeys.length === 0 ? (
          loading ? (
            <div className="grid place-items-center py-8 text-muted">
              <Spinner size={20} />
            </div>
          ) : (
            <EmptyState
              title="还没有密钥"
              description="为不同的客户端创建独立的 API key，便于撤销与审计。"
              icon={<KeyRound size={20} />}
              action={
                <Button
                  variant="primary"
                  size="sm"
                  leadingIcon={<Plus size={15} />}
                  onClick={() => setCreateOpen(true)}
                >
                  创建第一个密钥
                </Button>
              }
            />
          )
        ) : (
          apiKeys.map((key) => (
            <ApiKeyRow
              key={key.id}
              apiKey={key}
              busy={busyId === key.id}
              onReveal={() => void onReveal(key)}
              onToggle={() => void onToggle(key)}
              onDelete={() => void onDelete(key)}
            />
          ))
        )}
      </div>

      <CreateApiKeyDialog
        open={createOpen}
        submitting={creating}
        onSubmit={(name) => void onCreate(name)}
        onClose={() => {
          if (creating) return;
          setCreateOpen(false);
        }}
      />

      <RevealKeyDialog
        apiKey={revealed}
        onClose={() => setRevealed(null)}
        onCopy={copyText}
      />
    </section>
  );
}
