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
| `ARIA2_RPC_URL` | - | aria2 JSON-RPC 地址，Docker Compose 默认 `http://aria2:6800/jsonrpc` |
| `ARIA2_RPC_SECRET` | - | aria2 JSON-RPC token，启用磁力链接上传时必须配置 |
| `ARIA2_DOWNLOAD_DIR` | `/data/aria2/downloads` | aria2 下载目录，必须和后端容器共享同一个 `/data` 卷 |
| `ARIA2_METADATA_TIMEOUT_SECONDS` | `30` | 磁力链接元数据解析首轮等待时间，范围 5-300 秒 |
| `ARIA2_DOWNLOAD_MAX_BYTES` | `21474836480` | aria2 下载目录软上限，默认 20 GiB；设为 `0` 表示不按目录总量限制 |
| `ARIA2_DOWNLOAD_MIN_FREE_BYTES` | `5368709120` | 开始磁力下载前要求磁盘至少保留的空闲空间，默认 5 GiB；设为 `0` 表示不检查 |
| `ARIA2_DOWNLOAD_RETENTION_HOURS` | `24` | 已完成、失败、取消或已下载未导入任务的下载目录保留小时数，范围 0-720 |
| `ARIA2_BT_TRACKERS` | 空 | 可选，逗号或换行分隔的 BT tracker 列表；后端会在新增 magnet 任务时传给 aria2 |
| `ARIA2_SPLIT` | `16` | aria2 单任务分片连接数，范围 1-64；主要影响 HTTP/直链下载任务 |
| `ARIA2_MAX_CONNECTION_PER_SERVER` | `16` | aria2 对单个服务器的最大连接数，范围 1-16；过高可能被源站限速 |
| `ARIA2_MIN_SPLIT_SIZE` | `1M` | aria2 拆分下载的最小分片大小，支持如 `1M`、`4M`、`1024K` |
| `ARIA2_BT_MAX_PEERS` | `128` | 单个 BT/磁力任务最多连接 peer 数，范围 1-1000；越高越依赖网络和 tracker 质量 |
| `ENV_FILE` | 自动查找 `.env` | 指定本地环境变量文件 |
| `STATIC_DIR` / `ASSETS_DIR` | `frontend/dist` | 前端静态资源目录 |
| `SQLITE_MIGRATIONS_DIR` | `backend/migrations` | SQLite 迁移目录 |

## Docker Compose

复制 `.env`，填入真实密钥。磁力链接上传依赖 `ARIA2_RPC_SECRET`，建议使用和管理员密码不同的长随机字符串：

```bash
cp .env.example .env
```

启动：

```bash
docker compose up -d
```

Compose 会启动两个服务：

| 服务 | 说明 |
|---|---|
| `tgbot-files` | Node 后端、React 前端、SQLite 迁移和 Telegram 上传 |
| `aria2` | 解析 magnet 元数据并下载被选择的 BT 文件 |

SQLite 文件默认挂载到 `./data/tgbot-files.sqlite`，容器内路径是 `/data/tgbot-files.sqlite`。aria2 下载文件默认落在 `./data/aria2/downloads/`，容器内路径是 `/data/aria2/downloads/`。两个容器共享同一个 `./data:/data` 卷，后端才能读取 aria2 已下载的文件并继续上传到 Telegram。

查看日志：

```bash
docker compose logs -f
```

检查 aria2 RPC 是否只在 Compose 网络内暴露：

```bash
docker compose ps
```

`docker-compose.yml` 默认只映射 BT 传输端口 `6881/tcp` 和 `6881/udp`，不会把 aria2 RPC 端口 `6800` 暴露到宿主机。不要把 `6800:6800` 加到公网服务器上；如果必须临时调试，也应只绑定 `127.0.0.1` 并使用 `ARIA2_RPC_SECRET`。

### 磁力链接上传流程

管理后台的“URL / 磁力”上传支持 `magnet:?` 链接，流程分两步：

1. 第一次点击上传时，后端把 magnet 交给 aria2 解析元数据，返回磁力链接中的文件列表。
2. 用户勾选要导入的文件后再次点击上传，aria2 只下载被选中的文件。
3. 下载完成后，后端逐个读取本地文件，按现有大文件分片规则上传到 Telegram。
4. 每个被选中的磁力文件都会生成一条独立文件记录，后续预览、下载、删除和目录管理都复用现有能力。

当前版本不做边下边传，也不生成新的 BT 磁力链接。换句话说，选中文件必须先完整下载到 `ARIA2_DOWNLOAD_DIR`，然后后端再上传 Telegram。磁力文件仍受系统大文件上限约束，单个文件不能超过当前 Telegram multipart 上限（默认 20 GiB）。

后端会在磁力任务开始前清理旧下载目录，并按 `ARIA2_DOWNLOAD_MAX_BYTES` 和 `ARIA2_DOWNLOAD_MIN_FREE_BYTES` 做容量预检；如果选中文件会导致下载目录超限或磁盘空闲空间不足，请求会直接返回错误，不会启动新的 aria2 下载。定时清理会删除超过保留时间的已完成、失败、取消或“已下载未导入”任务目录，也会在目录超出软上限时优先删除超过保留时间的最旧孤儿 UUID 目录；正在解析、等待选择、下载中或导入中的任务默认不会被清理。重复提交同一个 magnet 时，后端会优先复用正在解析、等待选择、下载中或已下载的任务；失败或取消的同源任务会先从 aria2 和下载目录中清理，再重新创建。

如果你的服务器经常卡在“解析中”，可以通过 `ARIA2_BT_TRACKERS` 配置一组公共或自有 tracker。该配置只追加到本服务创建的 magnet 任务，不会修改 aria2 的全局配置。

如果磁力链接长时间停在“解析中”或“下载中”，优先检查：

```bash
docker compose logs -f aria2
docker compose logs -f tgbot-files
```

常见原因包括：服务器无法连接 BT 网络、Tracker 不可达、没有可用 peer、`ARIA2_RPC_SECRET` 与后端环境变量不一致、`./data` 卷权限异常。

## 本地 Node 运行

```bash
pnpm install
cp .env.example .env
pnpm build
pnpm start
```

`pnpm start` 默认监听 `http://localhost:8787`。服务启动时会自动执行 `backend/migrations` 里的迁移，并记录到 `schema_migrations` 表。迁移器会跳过常见的“表已存在、列已存在、索引已存在”错误，方便挂载已有 SQLite 数据库文件。

本地 Node 模式如果要测试磁力链接上传，需要另外启动 aria2：

```bash
mkdir -p data/aria2/downloads
touch data/aria2/session.txt
aria2c \
  --enable-rpc=true \
  --rpc-listen-all=false \
  --rpc-listen-port=6800 \
  --rpc-secret="$ARIA2_RPC_SECRET" \
  --dir="$PWD/data/aria2/downloads" \
  --save-session="$PWD/data/aria2/session.txt" \
  --input-file="$PWD/data/aria2/session.txt" \
  --save-session-interval=60 \
  --force-save=true \
  --bt-save-metadata=true \
  --listen-port=6881 \
  --enable-dht=true \
  --enable-peer-exchange=true \
  --bt-enable-lpd=true \
  --seed-time=0 \
  --max-overall-upload-limit=64K \
  --split="${ARIA2_SPLIT:-16}" \
  --max-connection-per-server="${ARIA2_MAX_CONNECTION_PER_SERVER:-16}" \
  --min-split-size="${ARIA2_MIN_SPLIT_SIZE:-1M}" \
  --bt-max-peers="${ARIA2_BT_MAX_PEERS:-128}"
```

本地 `.env` 对应设置：

```text
ARIA2_RPC_URL=http://127.0.0.1:6800/jsonrpc
ARIA2_DOWNLOAD_DIR=/absolute/path/to/tgbot-files/data/aria2/downloads
ARIA2_RPC_SECRET=replace-with-a-long-random-aria2-rpc-secret
ARIA2_DOWNLOAD_MAX_BYTES=21474836480
ARIA2_DOWNLOAD_MIN_FREE_BYTES=5368709120
ARIA2_DOWNLOAD_RETENTION_HOURS=24
ARIA2_BT_TRACKERS=
```

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
