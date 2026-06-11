# AGENTS.md

给 AI 代理 / Codex 协作者使用的工程速览。如果你是新加入这个 repo 的代理，先读这一页再动手。

---

## 一句话总结

基于 **Node.js + SQLite + Telegram Bot API** 的文件存储服务。后端把文件转存到 Telegram 私有频道并签发签名链接，前端是同一个 Node 服务托管的 React SPA 管理后台。

## Monorepo 结构

```
tgbot-files/
├── backend/                # Node 后端（API + 文件签名 + 静态资源托管）
│   ├── src/index.ts        # 路由与核心业务入口
│   ├── src/server/         # Node 服务入口、SQLite、静态资源服务、Telegram 限速器
│   ├── migrations/         # SQLite schema 演进
│   └── test/               # vitest，针对后端 API 逻辑
├── frontend/               # React + Vite + Tailwind v4 管理后台
│   ├── index.html
│   ├── public/
│   └── src/                # 见“前端目录速览”
├── docs/
│   ├── deployment.md       # 部署说明
│   └── superpowers/        # 设计文档
├── .github/workflows/      # Docker 镜像自动构建
├── Dockerfile
├── docker-compose.yml
├── package.json            # pnpm workspace 根，定义聚合脚本
├── pnpm-workspace.yaml
└── AGENTS.md
```

> 不要把构建产物 `frontend/dist/`、`backend/dist/`、真实 `.env`、`data/` 或 `node_modules/` 提交进 git。

## 关键命令（在 repo 根执行）

| 目的 | 命令 |
|---|---|
| 安装依赖 | `pnpm install` |
| 仅启动前端 dev server（Vite，热更新，无后端） | `pnpm dev:frontend` |
| 构建前端和后端服务 | `pnpm build` |
| 启动后端服务（需要已构建） | `pnpm start` |
| 构建后启动本地全栈 | `pnpm dev` |
| TypeScript 类型检查（前后端都过） | `pnpm typecheck` |
| 后端单元测试 | `pnpm test` |
| 仅构建前端产物 | `pnpm build:frontend` |

本地密钥放在根目录 `.env`。`.env.example` 是模板，不要把真实 `.env` 提交。

后端启动时会自动执行 `backend/migrations` 里的 SQLite 迁移，并记录到 `schema_migrations` 表。

## 后端 API 合约（管理后台用）

所有 `/api/admin/*` 端点使用 HttpOnly Cookie 鉴权。前端 `fetch` 必须带 `credentials: "include"`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/login` | body `{username, password}` |
| POST | `/api/admin/logout` | 退出登录 |
| GET | `/api/admin/session` | 返回 `username` / 上传限制 / 上传并发 / 分片大小 / 视频预览缓存 / `config{...}` 布尔标志 |
| PATCH | `/api/admin/settings` | 更新系统设置，支持 `upload_concurrency` / `telegram_chunk_size_bytes` / `video_preview_cache_bytes` |
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
| POST | `/api/v1/files` | `Authorization: Bearer <API_KEY>`，multipart 或 URL 上传 |
| GET | `/f/:token/:filename?` | 签名访问文件，`?download=1` 强制下载 |

修改字段名时同步 `frontend/src/api.ts` 的 TypeScript 类型，不要解耦。

## 前端目录速览

```
frontend/src/
├── main.tsx
├── App.tsx
├── api.ts
├── utils.ts
├── styles.css
├── lib/
│   ├── cn.ts
│   ├── toast.tsx
│   ├── confirm.tsx
│   ├── dropzone.tsx
│   └── video-preview-service-worker.ts
├── components/
│   ├── ui/
│   ├── layout/Shell.tsx
│   ├── files/
│   └── settings/
└── pages/
    ├── LoginPage.tsx
    ├── DashboardPage.tsx
    ├── ApiDocsPage.tsx
    └── SettingsPage.tsx
```

## 前端约定（重要）

- **样式只用 Tailwind utility**：不要再回到 `@layer components` 写大量自定义 class。设计 token 写在 `styles.css` 的 `@theme` 里。
- **Tailwind v4**：通过 `@tailwindcss/vite` 加载，**不要**新建 `tailwind.config.js`。新增 token 改 `@theme`。
- **图标**：只用 `lucide-react`。不要再引入新图标库。
- **对话框**：禁止 `window.confirm` / `window.alert` / `window.prompt`。用 `useConfirm()` 和 `useToast()`。
- **复制提示**：复制成功必须发 toast，复制失败显示 danger toast。
- **路由**：客户端用纯 `history.pushState`，仅 `/login` `/admin` `/docs` `/settings` 四条；`/api/*` 和 `/f/*` 是后端保留路径。
- **构建产物位置**：Vite `build.outDir` 必须保持 `frontend/dist/`，且 `index.html` 在根。
- **Vite `base`**：保持默认 `/`。修改会破坏 SPA fallback。
- **A11y**：Modal 必须有 ESC 关闭 + focus trap（已封装在 `components/ui/Modal.tsx`）。按钮务必有 aria-label。

## 后端约束（前端工程师视角）

- 上传大小由 `MAX_FILE_BYTES` 环境变量控制，前端在 `session.max_file_bytes` 拿到，应在前端提前校验。
- 分片大小可通过设置页配置（1MB-18MB），默认 10MB，保存到 `app_settings` 表的 `telegram_chunk_size_bytes` 键。
- API key 明文存储在 SQLite（用户已知权衡）。前端列表只展示 masked，明文必须通过 `GET /api/admin/api-keys/:id` 显式 reveal。
- 删除文件是软删除，**不会**删除 Telegram 中的原始消息，已分发的签名链接仍然有效。该语义要在删除确认对话框里说清楚。
- 分片并发由设置页 `upload_concurrency` 控制，默认 `5`，保存到 `app_settings` 表。
- 视频预览缓存上限由设置页 `video_preview_cache_bytes` 控制，默认 2GiB，范围 256MiB-20GiB。

## 工作约定

- 改前端 UI 后先跑 `pnpm typecheck`，再 `pnpm build:frontend`，最后用 `pnpm dev` 起来在浏览器里点一遍 happy path。
- 改后端字段名，同步前端 `api.ts` 类型，再跑 `pnpm typecheck`。
- 不要把破坏 SPA fallback 的路径放进客户端路由（如 `/api/foo`、`/f/foo`）。
- 提交前 `git status` 检查没有把 `.env`、`data/`、`frontend/dist/`、`backend/dist/`、`node_modules/` 误入。
