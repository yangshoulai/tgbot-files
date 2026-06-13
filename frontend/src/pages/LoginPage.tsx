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
  const [rememberMe, setRememberMe] = useState(true);
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
      await login(username, password, rememberMe);
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
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_-10%,rgba(16,185,129,0.2),transparent_34%),radial-gradient(circle_at_86%_14%,rgba(56,189,248,0.13),transparent_26%),linear-gradient(180deg,rgba(236,253,245,0.78),rgba(255,255,255,0)_26rem)]"
      />
      <div className="relative w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="grid size-14 place-items-center rounded-3xl bg-primary text-white shadow-[0_22px_54px_rgba(16,185,129,0.28)]">
            <ShieldCheck size={22} />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">飞梭云盘</h1>
          <p className="text-sm text-muted">管理员入口 · 轻量、私有、可分发的文件存储</p>
        </div>

        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 rounded-3xl border border-border bg-surface/92 p-6 shadow-dialog backdrop-blur-xl"
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

          <label className="flex items-start gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(event) => setRememberMe(event.target.checked)}
              className="mt-0.5 size-4 rounded border-border text-primary accent-primary focus-visible:outline-none focus-visible:focus-ring"
            />
            <span>
              记住我
              <span className="block text-[11px] text-subtle">勾选后保留 30 天；取消勾选则关闭浏览器后失效。</span>
            </span>
          </label>

          <Button type="submit" variant="primary" size="lg" block loading={submitting} leadingIcon={<LogIn size={16} />}>
            进入控制台
          </Button>

          <p className="text-center text-[11px] text-subtle">
            有效访问会按当前选择自动续期。
          </p>
        </form>
      </div>
    </main>
  );
}
