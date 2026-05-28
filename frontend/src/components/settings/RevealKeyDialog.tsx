import { Copy } from "lucide-react";
import type { ApiKeyItem } from "../../api";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";

interface RevealKeyDialogProps {
  apiKey: ApiKeyItem | null;
  onClose: () => void;
  onCopy: (value: string) => void;
}

export function RevealKeyDialog({ apiKey, onClose, onCopy }: RevealKeyDialogProps) {
  const key = apiKey?.key ?? "";

  return (
    <Modal
      open={apiKey !== null}
      onClose={onClose}
      size="md"
      title={apiKey ? apiKey.name : "API key"}
      description="请妥善保管该密钥；建议立即复制到密码管理器中。"
      footer={
        <>
          <Button
            variant="secondary"
            leadingIcon={<Copy size={15} />}
            onClick={() => key && onCopy(key)}
            disabled={!key}
          >
            复制
          </Button>
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      <div className="rounded-xl border border-border bg-background p-3">
        <code className="block overflow-anywhere font-mono text-xs leading-6 text-foreground">
          {key || "未能获取明文密钥"}
        </code>
      </div>
    </Modal>
  );
}
