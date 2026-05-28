# AGENTS.md

给 AI 代理 / Codex 协作者使用的工程速览。如果你是新加入这个 repo 的代理，先读这一页再动手。

---

## 一句话总结

基于 **Cloudflare Worker + D1 + Telegram Bot API** 的轻量个人文件存储服务。后端把文件转存到 Telegram 私有频道并签发签名链接，前端是一个内嵌在 Worker 静态资源中的 React SPA 管理后台。

## Monorepo 结构

```
tgbot-files/
├── backend/                # Cloudflare Worker（API + 文件签名 + 静态资源托管）
│   ├── src/index.ts        # 路由总入口
│   ├── migrations/         # D1 schema 演进
│   ├── test/               # vitest，针对 Worker 逻辑
│   └── wrangler.jsonc      # 资源与变量绑定
├── frontend/               # React + Vite + Tailwind v4 管理后台
│   ├── index.html
│   ├── src/                # 见 "前端目录速览"
│   └── vite.config.ts
├── docs/
│   ├── deployment.md       # 部署步骤
│   ├── 原型设计/            # 早期 HTML/CSS 原型（仅参考）
│   └── superpowers/        # 设计文档
├── package.json            # pnpm workspace 根，定义聚合脚本
├── pnpm-workspace.yaml
└── AGENTS.md               # 本文件
```

> 不要把构建产物 `frontend/dist/` 提交进 git；它通过 `pnpm build:frontend` 重新生成，由 Wrangler 作为静态资源服务。

## 关键命令（在 repo 根执行）

| 目的 | 命令 |
|---|---|
| 安装依赖 | `pnpm install` |
| 仅启动前端 dev server（Vite，热更新，无后端） | `pnpm dev:frontend` |
| 仅启动 Worker dev（带已构建的前端） | `pnpm dev:worker` |
| **本地全栈**：构建前端 + 启动 Worker | `pnpm dev` |
| TypeScript 类型检查（前后端都过） | `pnpm typecheck` |
| 后端单元测试 | `pnpm test` |
| 仅构建前端产物 | `pnpm build:frontend` |
| 部署（构建前端 → wrangler deploy） | `pnpm deploy` |
| D1 迁移（本地） | `pnpm --filter backend exec wrangler d1 migrations apply tgbot-files --local` |

`backend/.dev.vars` 存放本地密钥（Telegram bot token、admin 用户名密码、签名密钥等）。`backend/.dev.vars.example` 是模板，不要把真实的 `.dev.vars` 提交。

## 后端 API 合约（管理后台用）

所有 `/api/admin/*` 端点使用 HttpOnly Cookie 鉴权。前端 `fetch` 必须带 `credentials: "include"`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/login` | body `{username, password}` |
| POST | `/api/admin/logout` | — |
| GET | `/api/admin/session` | 返回 `username` / `max_file_bytes` / `config{...}` 布尔标志 |
| GET | `/api/admin/files` | 查询 `q`, `page`, `limit`（≤100） |
| POST | `/api/admin/files` | multipart `file` + 可选 `remark` |
| DELETE | `/api/admin/files/:id` | 软删除索引（不动 Telegram 原消息） |
| GET | `/api/admin/api-keys` | 列表只回 masked key |
| POST | `/api/admin/api-keys` | body `{name}`，响应包含明文 key |
| GET | `/api/admin/api-keys/:id` | 显式 reveal 明文 |
| PATCH | `/api/admin/api-keys/:id` | body `{name?, status?}` (`active`/`disabled`) |
| DELETE | `/api/admin/api-keys/:id` | 删除 |

公共端点（无需 admin cookie）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/files` | `Authorization: Bearer <API_KEY>`，multipart 上传 |
| GET | `/f/:token/:filename?` | 签名访问文件，`?download=1` 强制下载 |

修改字段名时同步 `frontend/src/api.ts` 的 TypeScript 类型，不要解耦。

## 前端目录速览

```
frontend/src/
├── main.tsx              # 仅 ReactDOM 挂载
├── App.tsx               # 路由、session、上传状态、全局 dropzone、Toast/Confirm Provider
├── api.ts                # 端点定义 + ApiError + requestJson()
├── utils.ts              # formatBytes / formatDateTime / fileKind / sumFileSize
├── styles.css            # Tailwind 入口 + @theme 设计 token + 极少 utilities/keyframes
├── lib/
│   ├── cn.ts             # className 合并
│   ├── toast.tsx         # ToastProvider + useToast()
│   ├── confirm.tsx       # ConfirmProvider + useConfirm()（替代 window.confirm）
│   └── dropzone.tsx      # 全局拖拽监听 + 全屏蒙层
├── components/
│   ├── ui/               # 通用 UI（Button、Modal、Input、Badge 等）
│   ├── layout/Shell.tsx  # 顶部导航 + 移动端 tab 栏 + main 容器
│   ├── files/            # 业务：MetricsRow / FileTable / FileGrid / Pagination / UploadDialog / PreviewDialog
│   └── settings/         # ApiKeysPanel / ApiKeyRow / RevealKeyDialog / ConfigPanel
└── pages/
    ├── LoginPage.tsx
    ├── DashboardPage.tsx
    └── SettingsPage.tsx
```

## 前端约定（重要）

- **样式只用 Tailwind utility**：不要再回到 `@layer components` 写大量自定义 class。设计 token 写在 `styles.css` 的 `@theme` 里。
- **Tailwind v4**：通过 `@tailwindcss/vite` 加载，**不要**新建 `tailwind.config.js`。新增 token → 改 `@theme`。
- **图标**：只用 `lucide-react`。不要再引入新图标库。
- **对话框**：禁止 `window.confirm` / `window.alert` / `window.prompt`。用 `useConfirm()` 和 `useToast()`。
- **复制提示**：复制成功必须发 toast，复制失败显示 danger toast。
- **路由**：客户端用纯 `history.pushState`，仅 `/login` `/admin` `/settings` 三条；`/api/*` 和 `/f/*` 是 Worker 保留路径。
- **构建产物位置**：Vite `build.outDir` 必须保持 `frontend/dist/`（Wrangler `assets.directory` 指向这里），且 `index.html` 在根。
- **Vite `base`**：保持默认 `/`。修改会破坏 SPA fallback。
- **响应式断点**：`sm`(640) `md`(768) `lg`(1024) `xl`(1280)。表格在 `<md` 隐藏次要列；卡片网格在 `<sm` 单列。
- **A11y**：Modal 必须有 ESC 关闭 + focus trap（已封装在 `components/ui/Modal.tsx`）。按钮务必有 aria-label。

## 后端约束（前端工程师视角）

- 上传大小由 `wrangler.jsonc → vars.MAX_FILE_BYTES` 控制，前端在 `session.max_file_bytes` 拿到，应该在前端做提前校验，不要直接发巨大文件出去再让后端拒绝。
- API key 明文存储在 D1（用户已知权衡）。前端列表只展示 masked，明文必须通过 `GET /api/admin/api-keys/:id` 显式 reveal。
- 删除文件是软删除，**不会**删除 Telegram 中的原始消息，已分发的签名链接仍然有效。该语义要在删除确认对话框里说清楚。

## 工作约定

- 改前端 UI 后先跑 `pnpm typecheck`，再 `pnpm build:frontend`，最后用 `pnpm dev` 起来在浏览器里点一遍 happy path（登录、上传、预览、删除、API key 管理）。
- 改后端字段名 → 同步前端 `api.ts` 类型 → 跑 `pnpm typecheck` 两端都过。
- 不要把破坏 SPA fallback 的路径放进客户端路由（如 `/api/foo`、`/f/foo`）。
- 提交前 `git status` 检查没有把 `.dev.vars`、`.wrangler/`、`frontend/dist/`、`node_modules/` 误入。
