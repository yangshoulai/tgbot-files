# tgbot-files

基于 **Node.js + SQLite + Telegram Bot API** 的文件存储服务。后端把文件转存到 Telegram 私有频道或群组，数据库保存文件索引、API key、目录、分片上传状态和系统设置；前端是 React + Vite 管理后台，由同一个 Node 服务托管。

## 功能

- `/admin`：管理员后台，支持登录、本地上传、URL 上传、HLS/m3u8 导入、分片大文件上传、暂停重试、备注、搜索、分页、预览、复制链接、下载和删除索引。
- `/settings`：管理 Telegram 存储渠道、外部上传 API key、分片并发数量和运行配置状态。
- `/docs`：内置 API 文档。
- `POST /api/v1/files`：外部客户端使用 `Authorization: Bearer <API_KEY>` 上传文件或导入 URL。
- `GET /f/:token/:filename?`：访问签名文件链接，`?download=1` 强制下载。
- 默认直传限制为 `20MiB`，大文件使用 `10MiB` Telegram 分片，分片总上限为 `5GiB`。
- 上传并发数量保存在 `app_settings` 表，默认 `5`，可在设置页调整。

后台删除是软删除：只删除数据库中的索引记录，不删除 Telegram 中的原始文件消息，也不会让已经生成的签名链接失效。

## 本地开发

```bash
pnpm install
cp .env.example .env
# 编辑 .env，填入真实 Telegram、管理员和签名密钥
pnpm build
pnpm start
```

`pnpm start` 会启动同一个 Node 服务，默认监听 `http://localhost:8787`，并自动执行 `backend/migrations` 中尚未应用的 SQLite 迁移。

如果只开发前端界面，可以运行：

```bash
pnpm dev:frontend
```

常用检查：

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Docker

GitHub Actions 会在推送到 `main`、`master` 或 `v*` tag 时构建并推送镜像：

```text
ghcr.io/<owner>/<repo>:latest
ghcr.io/<owner>/<repo>:<branch-or-tag>
ghcr.io/<owner>/<repo>:sha-<commit>
```

使用 Compose：

```bash
cp .env.example .env
# 编辑 .env
docker compose up -d
```

SQLite 文件默认挂载到 `./data/tgbot-files.sqlite`，容器内路径是 `/data/tgbot-files.sqlite`。

更多部署参数见 [docs/deployment.md](docs/deployment.md)。
