import { FormEvent, useState } from "react";
import { KeyRound, LogIn, ShieldCheck, User } from "lucide-react";
import { ApiError, login } from "../api";
import { useToast } from "../lib/toast";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";

interface LoginPageProps {
  onLoggedIn: () => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "登录失败";
}

export function LoginPage({ onLoggedIn }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!username || !password) {
      toast.danger("请输入账号与密码");
      return;
    }
    setSubmitting(true);
    try {
      await login(username, password);
      onLoggedIn();
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-background px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-32 h-96 bg-[radial-gradient(circle_at_50%_0%,var(--color-primary-soft),transparent_70%)]"
      />
      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="grid size-12 place-items-center rounded-2xl bg-primary text-white shadow-dialog">
            <ShieldCheck size={22} />
          </span>
          <h1 className="text-xl font-semibold text-foreground">文件仓库</h1>
          <p className="text-sm text-muted">管理员入口 · 基于 Telegram 的轻量个人文件存储</p>
        </div>

        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 rounded-3xl border border-border bg-surface p-6 shadow-dialog"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-username" className="text-xs font-medium text-muted">
              管理员账号
            </label>
            <Input
              id="login-username"
              autoComplete="username"
              autoFocus
              leadingIcon={<User size={15} />}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-password" className="text-xs font-medium text-muted">
              密码
            </label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              leadingIcon={<KeyRound size={15} />}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          <Button type="submit" variant="primary" size="lg" block loading={submitting} leadingIcon={<LogIn size={16} />}>
            进入控制台
          </Button>

          <p className="text-center text-[11px] text-subtle">
            登录后会话保持 30 天；有效访问会自动续期。
          </p>
        </form>
      </div>
    </main>
  );
}
