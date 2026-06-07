# 部署说明

本项目使用同一个 Docker 镜像运行 Node.js 后端和已构建的 React 前端，默认使用 SQLite 文件保存数据。

部署后仍然受服务器 CPU/内存/带宽、源 URL 限速和 Telegram Bot API 限速影响。

## 镜像

GitHub Actions 会在推送到 `main`、`master` 或 `v*` tag 时构建并推送镜像：

```text
ghcr.io/<owner>/<repo>:latest
ghcr.io/<owner>/<repo>:<branch-or-tag>
ghcr.io/<owner>/<repo>:sha-<commit>
```

workflow 文件在 `.github/workflows/docker.yml`。如果仓库的 Package 可见性不是公开的，需要在 GitHub Packages 里调整访问权限，或者登录 GHCR 后拉取。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `HOST` | `0.0.0.0` | Node 服务监听地址 |
| `PORT` | `8787` | Node 服务监听端口 |
| `SQLITE_DB_PATH` | `/data/tgbot-files.sqlite` | SQLite 数据库文件路径 |
| `DATABASE_PATH` | - | `SQLITE_DB_PATH` 的兼容别名 |
| `PUBLIC_BASE_URL` | 请求来源 | 生成公开链接时使用的外部访问地址 |
| `MAX_FILE_BYTES` | `20971520` | 小文件直传上限 |
| `STALE_MULTIPART_UPLOAD_TTL_HOURS` | `24` | 未完成上传清理 TTL |
| `CLEANUP_INTERVAL_MINUTES` | `360` | 定时清理间隔 |
| `TELEGRAM_BOT_TOKEN` | - | 默认 Telegram bot token |
| `TELEGRAM_STORAGE_CHAT_ID` | - | 默认 Telegram 存储频道或群 ID |
| `LINK_SIGNING_SECRET` | - | 文件链接签名密钥 |
| `ADMIN_USERNAME` | - | 管理员用户名 |
| `ADMIN_PASSWORD` | - | 管理员密码 |
| `ADMIN_SESSION_SECRET` | 回退到 `LINK_SIGNING_SECRET` | 管理后台 Cookie 签名密钥 |
| `TG_CHANNEL_SECRET` | 回退到 `LINK_SIGNING_SECRET` | 多 Telegram 渠道 token 加密密钥 |
| `ENV_FILE` | 自动查找 `.env` | 指定本地环境变量文件 |
| `STATIC_DIR` / `ASSETS_DIR` | `frontend/dist` | 前端静态资源目录 |
| `SQLITE_MIGRATIONS_DIR` | `backend/migrations` | SQLite 迁移目录 |

## Docker Compose

复制 `.env`，填入真实密钥：

```bash
cp .env.example .env
```

启动：

```bash
docker compose up -d
```

SQLite 文件默认挂载到 `./data/tgbot-files.sqlite`，容器内路径是 `/data/tgbot-files.sqlite`。

查看日志：

```bash
docker compose logs -f
```

## 本地 Node 运行

```bash
pnpm install
cp .env.example .env
pnpm build
pnpm start
```

`pnpm start` 默认监听 `http://localhost:8787`。服务启动时会自动执行 `backend/migrations` 里的迁移，并记录到 `schema_migrations` 表。迁移器会跳过常见的“表已存在、列已存在、索引已存在”错误，方便挂载已有 SQLite 数据库文件。

## 使用已有 SQLite 数据

如果你已经有 SQLite 数据库文件，直接挂载到容器的 `SQLITE_DB_PATH` 即可：

```bash
mkdir -p data
cp /path/to/existing.sqlite data/tgbot-files.sqlite
docker compose up -d
```

如果你手上是 SQL dump，可以先导入 SQLite 文件：

```bash
mkdir -p data
sqlite3 data/tgbot-files.sqlite < export.sql
docker compose up -d
```

## 上传并发

系统设置页提供“分片并发”配置，默认值是 `5`。保存后会写入 `app_settings` 表，并影响下一次本地文件、URL 和 HLS 上传。

调大这个值能减少浏览器侧排队时间，但 Telegram 上传仍然会经过服务端限速器：同一个 Telegram 渠道一次只持有一个 `sendDocument` 上传槽位，并对 Telegram 429 `retry_after` 做惩罚等待。建议先保持 `5`，如果有多个 Telegram 渠道和足够服务器带宽，再逐步提高。
