# Cloudflare Worker + Telegram Bot 文件存储部署说明

本文档说明如何部署 `tgbot-files`：一个基于 Cloudflare Worker、D1、Worker 静态资源和 Telegram Bot API 的轻量文件存储后台。

## 1. 前置条件

- Cloudflare 账号。
- Node.js 20+ 和 pnpm。
- Telegram 账号。
- 项目依赖已安装：

```bash
cd /Users/yangshoulai/Development/PersonalProjects/tgbot-files
pnpm install
```

## 2. 准备 Telegram Bot

1. 在 Telegram 中打开 `@BotFather`。
2. 发送 `/newbot`。
3. 按提示创建 bot。
4. 保存 BotFather 返回的 token，后续作为 `TELEGRAM_BOT_TOKEN`。

> Bot token 是高权限密钥，不要提交到 Git，也不要写进公开文档。

## 3. 准备 Telegram 存储聊天

推荐使用私有频道或私有群作为文件存储区。

私有频道：

1. 新建 Telegram 私有频道。
2. 把 bot 添加为频道管理员。
3. 给 bot 开启发送消息/发布消息权限。
4. 获取频道 `chat_id`，私有频道 ID 通常形如 `-1001234567890`。

私有群：

1. 新建私有群。
2. 把 bot 拉入群。
3. 在群里发送一条消息。
4. 调用以下接口查看更新，并从返回 JSON 中找到 `message.chat.id`：

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates"
```

## 4. 配置 Wrangler

首次使用 Wrangler 时登录 Cloudflare：

```bash
pnpm --filter backend exec wrangler login
```

`backend/wrangler.jsonc` 中需要保留：

- `main`: Worker 入口 `src/index.ts`
- `assets.directory`: 前端构建产物 `../frontend/dist`
- `assets.run_worker_first`: `/api/*` 和 `/f/*` 先进入 Worker
- `d1_databases`: `FILES_DB` 绑定

如果你使用自己的 D1 数据库，需要把 `database_id` 替换为实际值。

## 5. 创建并迁移 D1

创建数据库：

```bash
pnpm --filter backend exec wrangler d1 create tgbot-files
```

本地应用迁移：

```bash
pnpm --filter backend exec wrangler d1 migrations apply tgbot-files --local
```

生产应用迁移：

```bash
pnpm --filter backend exec wrangler d1 migrations apply tgbot-files --remote
```

当前迁移包含：

- `0001_create_files.sql`：文件元数据表，包含 `remark TEXT` 备注字段。
- `0002_create_api_keys.sql`：上传 API key 表，明文保存 key。
- `0003_add_multipart_files.sql`：分片上传会话、分片索引和文件存储类型字段。

## 6. 设置 Secrets 和变量

生产环境 secrets：

```bash
pnpm --filter backend exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm --filter backend exec wrangler secret put TELEGRAM_STORAGE_CHAT_ID
pnpm --filter backend exec wrangler secret put LINK_SIGNING_SECRET
pnpm --filter backend exec wrangler secret put ADMIN_USERNAME
pnpm --filter backend exec wrangler secret put ADMIN_PASSWORD
pnpm --filter backend exec wrangler secret put ADMIN_SESSION_SECRET
```

变量含义：

| 名称 | 必填 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 是 | BotFather 返回的 Telegram bot token |
| `TELEGRAM_STORAGE_CHAT_ID` | 是 | 用于保存文件的频道/群/聊天 ID |
| `LINK_SIGNING_SECRET` | 是 | 文件访问链接 HMAC 签名密钥 |
| `ADMIN_USERNAME` | 是 | 管理员后台用户名 |
| `ADMIN_PASSWORD` | 是 | 管理员后台密码 |
| `ADMIN_SESSION_SECRET` | 建议 | 管理员登录 Cookie 签名密钥；未设置时回退使用 `LINK_SIGNING_SECRET` |
| `PUBLIC_BASE_URL` | 否 | 自定义公开访问域名，例如 `https://files.example.com` |
| `MAX_FILE_BYTES` | 否 | 单文件直传大小，默认 `20971520`；后台分片上传固定使用 18MiB 分片和 432MiB 上限 |

`UPLOAD_API_KEY` 已废弃，不再作为上传鉴权来源。上传 API key 需要在后台 `/settings` 创建，并写入 D1 的 `api_keys` 表。

本地 `backend/.dev.vars` 示例：

```dotenv
TELEGRAM_BOT_TOKEN="123456789:replace-with-your-bot-token"
TELEGRAM_STORAGE_CHAT_ID="-1001234567890"
LINK_SIGNING_SECRET="replace-with-a-long-random-link-signing-secret"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="replace-with-a-long-random-admin-password"
ADMIN_SESSION_SECRET="replace-with-a-long-random-admin-session-secret"
PUBLIC_BASE_URL="http://localhost:8787"
MAX_FILE_BYTES="20971520"
```

## 7. 本地运行

```bash
pnpm dev
```

打开：

```text
http://localhost:8787/admin
```

首次使用流程：

1. 使用 `backend/.dev.vars` 中的管理员账号登录。
2. 进入 `/settings`。
3. 创建上传 API key。
4. 使用该 key 调用 `POST /api/v1/files`。

上传测试：

```bash
curl -X POST "http://localhost:8787/api/v1/files" \
  -H "Authorization: Bearer <API_KEY>" \
  -F "file=@./README.md"
```

URL 上传测试：

```bash
curl -X POST "http://localhost:8787/api/v1/files" \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/report.pdf"}'
```

## 8. 部署

部署前检查：

```bash
pnpm test
pnpm typecheck
pnpm build
```

应用远程迁移并部署：

```bash
pnpm --filter backend exec wrangler d1 migrations apply tgbot-files --remote
pnpm deploy
```

部署完成后：

1. 打开 `https://<your-worker-domain>/admin`。
2. 登录后台。
3. 在 `/settings` 创建生产上传 API key。
4. 更新所有调用 `POST /api/v1/files` 的脚本。

注意：当前版本不再读取 `UPLOAD_API_KEY`。部署后到新 key 配置完成前，旧上传脚本会返回 `401 Unauthorized`。

## 9. 自定义域名

1. 在 Cloudflare Dashboard 中进入对应 Worker。
2. 打开 `Triggers` / `触发器`。
3. 添加自定义域名，例如 `files.example.com`。
4. 在 `backend/wrangler.jsonc` 的 `vars.PUBLIC_BASE_URL` 中设置同一个域名。
5. 重新部署：

```bash
pnpm deploy
```

这样上传接口返回的 URL 会固定使用自定义域名。

## 10. 鉴权与安全说明

上传接口必须带：

```http
Authorization: Bearer <API_KEY>
```

API key 由后台创建，明文保存在 D1。这是当前项目的明确取舍；数据库泄露时 API key 会直接暴露。生产环境应限制后台账号访问，并避免在日志中输出 key 明文。

文件访问链接本身就是授权凭证：

- 链接包含 HMAC 签名 token。
- D1 保存的是后台索引记录和相对访问路径，不是文件本体。
- 后台删除只会软删除 D1 记录，不会删除 Telegram 消息，也不会让已生成链接失效。
- 如需让所有旧链接失效，轮换 `LINK_SIGNING_SECRET` 后重新部署。

管理员登录使用 HttpOnly Cookie，生产环境建议单独设置 `ADMIN_SESSION_SECRET`。

## 11. 文件访问流程

```text
校验签名 token -> 调用 Telegram getFile -> 代理下载 Telegram 文件内容
```

文件访问接口默认使用 `Content-Disposition: inline`。如果需要强制下载，可以在链接后追加：

```text
?download=1
```

## 12. 常见问题排查

### 上传返回 `401 Unauthorized`

检查请求头格式：

```http
Authorization: Bearer your-upload-api-key
```

同时确认后台 `/settings` 中存在该 key，且状态为启用。

### 上传返回 `413 FileTooLarge`

小文件直传超过当前 `MAX_FILE_BYTES` 时会返回该错误。默认直传上限是 `20971520` 字节，即 20MiB。

后台上传页会对更大的本地文件启用 Telegram 分片上传：每片 18MiB，最多 24 片，最大 432MiB。URL 大文件也可分片导入，但远端必须支持 HTTP Range；否则会返回 `RangeNotSupported`。

### 上传返回 `TelegramUploadFailed`

常见原因：

- `TELEGRAM_BOT_TOKEN` 错误。
- `TELEGRAM_STORAGE_CHAT_ID` 错误。
- bot 没有被加入目标频道/群。
- bot 在频道/群中没有发送消息权限。

可以直接测试 Telegram API：

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage" \
  -d "chat_id=<TELEGRAM_STORAGE_CHAT_ID>" \
  -d "text=hello"
```

### 后台返回 `Missing required D1 binding: FILES_DB`

检查 `backend/wrangler.jsonc` 是否配置了 `d1_databases`，并确认已经执行过 D1 迁移。

### 后台无法登录

检查 `ADMIN_USERNAME`、`ADMIN_PASSWORD` 是否已经通过 Cloudflare Secret 或 `backend/.dev.vars` 配置。生产环境如果轮换了 `ADMIN_SESSION_SECRET`，旧登录态会立即失效，需要重新登录。

### 访问链接返回 `InvalidFileToken`

说明 token 格式错误或签名校验失败。常见原因：

- URL 被截断或复制不完整。
- 修改过 `/f/<token>/...` 中的 token 部分。
- 生产环境轮换过 `LINK_SIGNING_SECRET`。

### 访问链接返回 `TelegramFileLookupFailed`

说明 Worker 能验证链接，但 Telegram `getFile` 失败。常见原因：

- Telegram 文件超过官方 `getFile` 可下载限制。
- bot token 被轮换或失效。
- Telegram 侧文件不可用。
