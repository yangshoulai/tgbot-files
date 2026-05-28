import { FormEvent, useEffect, useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

interface CreateApiKeyDialogProps {
  open: boolean;
  submitting: boolean;
  onSubmit: (name: string) => void;
  onClose: () => void;
}

export function CreateApiKeyDialog({ open, submitting, onSubmit, onClose }: CreateApiKeyDialogProps) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (!open) setName("");
  }, [open]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    onSubmit(trimmed);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="创建 API 密钥"
      description="为每个客户端创建独立的密钥，便于撤销和审计。"
      size="md"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      footer={
        <>
          <Button variant="secondary" disabled={submitting} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            form="create-api-key-form"
            variant="primary"
            loading={submitting}
            leadingIcon={<Plus size={16} />}
            disabled={!name.trim()}
          >
            创建密钥
          </Button>
        </>
      }
    >
      <form id="create-api-key-form" onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="api-key-name" className="text-xs font-medium text-muted">
            密钥名称
          </label>
          <Input
            id="api-key-name"
            placeholder="如 ios-app、internal-cron"
            leadingIcon={<KeyRound size={15} />}
            value={name}
            maxLength={64}
            autoFocus
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <p className="text-xs text-muted">
          创建后会显示一次明文密钥，请立即复制并妥善保管；后续可随时撤销或禁用。
        </p>
      </form>
    </Modal>
  );
}
