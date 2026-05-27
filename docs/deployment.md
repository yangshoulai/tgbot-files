# Cloudflare Worker + Telegram Bot 文件存储部署说明

本文档说明如何部署 `tgbot-files`：一个基于 Cloudflare Worker 和 Telegram Bot API 的小文件存储服务。

## 1. 前置条件

- 一个 Cloudflare 账号。
- 本机已安装 Node.js 20+ 和 pnpm。
- 一个 Telegram 账号。
- 本项目代码已准备好：

```bash
cd /Users/yangshoulai/Development/PersonalProjects/tgbot-files
pnpm install
```

## 2. 创建 Telegram Bot

1. 在 Telegram 中打开 `@BotFather`。
2. 发送 `/newbot`。
3. 按提示填写 bot 名称和用户名。
4. 保存 BotFather 返回的 token，后续作为 `TELEGRAM_BOT_TOKEN`。

示例格式：

```text
123456789:AAExampleTokenValue
```

> 注意：Bot token 是高权限密钥，不要提交到 Git，也不要写进公开文档。

## 3. 准备 Telegram 存储聊天

推荐使用私有频道或私有群作为文件存储区。

### 方案 A：私有频道

1. 新建一个 Telegram 私有频道。
2. 把 bot 添加为频道管理员。
3. 给 bot 开启发送消息/发布消息权限。
4. 获取频道 `chat_id`：
   - 可以先在频道里发一条消息。
   - 通过 bot API 或调试工具读取 update。
   - 私有频道 ID 通常形如 `-1001234567890`。

### 方案 B：私有群

1. 新建一个私有群。
2. 把 bot 拉入群。
3. 在群里发一条消息。
4. 调用以下接口查看更新：

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates"
```

在返回 JSON 中找到 `message.chat.id`，作为 `TELEGRAM_STORAGE_CHAT_ID`。

> 如果 `getUpdates` 没有返回消息，可以给 bot 发一条私聊消息，或在群里重新发一条消息后再试。

## 4. 配置 Cloudflare Wrangler

首次使用 Wrangler 时登录 Cloudflare：

```bash
pnpm wrangler login
```

确认 `wrangler.jsonc` 中的 Worker 名称：

```jsonc
{
  "name": "tgbot-files",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-16"
}
```

如果你想使用其他 Worker 名称，可以修改 `name` 字段。

## 5. 创建并绑定 D1 数据库

管理员后台依赖 D1 保存文件元数据。先创建数据库：

```bash
pnpm wrangler d1 create tgbot-files
```

把命令输出里的 `database_id` 填入 `wrangler.jsonc`：

```jsonc
{
  "d1_databases": [
    {
      "binding": "FILES_DB",
      "database_name": "tgbot-files",
      "database_id": "<your-d1-database-id>"
    }
  ]
}
```

本地开发时先应用本地迁移：

```bash
pnpm wrangler d1 migrations apply tgbot-files --local
```

生产部署前应用远程迁移：

```bash
pnpm wrangler d1 migrations apply tgbot-files --remote
```

## 6. 设置生产环境 secrets

依次执行：

```bash
pnpm wrangler secret put TELEGRAM_BOT_TOKEN
pnpm wrangler secret put TELEGRAM_STORAGE_CHAT_ID
pnpm wrangler secret put UPLOAD_API_KEY
pnpm wrangler secret put LINK_SIGNING_SECRET
pnpm wrangler secret put ADMIN_USERNAME
pnpm wrangler secret put ADMIN_PASSWORD
pnpm wrangler secret put ADMIN_SESSION_SECRET
```

建议密钥生成方式：

```bash
openssl rand -base64 32
```

变量含义：

| 名称 | 必填 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 是 | BotFather 返回的 Telegram bot token |
| `TELEGRAM_STORAGE_CHAT_ID` | 是 | 用于保存文件的频道/群/聊天 ID |
| `UPLOAD_API_KEY` | 是 | 上传接口 Bearer token |
| `LINK_SIGNING_SECRET` | 是 | 文件访问链接 HMAC 签名密钥 |
| `ADMIN_USERNAME` | 是 | 管理员后台用户名 |
| `ADMIN_PASSWORD` | 是 | 管理员后台密码 |
| `ADMIN_SESSION_SECRET` | 建议 | 管理员登录 Cookie 签名密钥；未设置时回退使用 `LINK_SIGNING_SECRET` |
| `PUBLIC_BASE_URL` | 否 | 自定义公开访问域名，例如 `https://files.example.com` |
| `MAX_FILE_BYTES` | 否 | 最大文件大小，默认 `20971520` |

`MAX_FILE_BYTES` 默认已经写在 `wrangler.jsonc` 的 `vars` 中。如需自定义生产域名，可以在 `wrangler.jsonc` 中加入：

```jsonc
{
  "vars": {
    "MAX_FILE_BYTES": "20971520",
    "PUBLIC_BASE_URL": "https://files.example.com"
  }
}
```

## 7. 本地运行与联调

复制本地环境变量模板：

```bash
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，填入真实值：

```dotenv
TELEGRAM_BOT_TOKEN="123456789:replace-with-your-bot-token"
TELEGRAM_STORAGE_CHAT_ID="-1001234567890"
UPLOAD_API_KEY="replace-with-a-long-random-upload-api-key"
LINK_SIGNING_SECRET="replace-with-a-long-random-link-signing-secret"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="replace-with-a-long-random-admin-password"
ADMIN_SESSION_SECRET="replace-with-a-long-random-admin-session-secret"
PUBLIC_BASE_URL="http://localhost:8787"
MAX_FILE_BYTES="20971520"
```

应用本地 D1 迁移：

```bash
pnpm wrangler d1 migrations apply tgbot-files --local
```

启动本地 Worker：

```bash
pnpm dev
```

上传测试：

```bash
curl -X POST "http://localhost:8787/api/v1/files" \
  -H "Authorization: Bearer <UPLOAD_API_KEY>" \
  -F "file=@./README.md"
```

拿到响应里的 `url` 后访问：

```bash
curl -L "<返回的 url>" -o downloaded-file
```

管理员后台：

```text
http://localhost:8787/admin
```

## 8. 部署到 Cloudflare

运行测试和类型检查：

```bash
pnpm test
pnpm typecheck
```

应用远程 D1 迁移并部署：

```bash
pnpm wrangler d1 migrations apply tgbot-files --remote
pnpm deploy
```

部署完成后，Wrangler 会输出 Worker 访问域名，例如：

```text
https://tgbot-files.<your-subdomain>.workers.dev
```

生产上传示例：

```bash
curl -X POST "https://tgbot-files.<your-subdomain>.workers.dev/api/v1/files" \
  -H "Authorization: Bearer <UPLOAD_API_KEY>" \
  -F "file=@./example.txt"
```

## 9. 可选：绑定自定义域名

1. 在 Cloudflare Dashboard 中进入对应 Worker。
2. 打开 `Triggers` / `触发器`。
3. 添加自定义域名，例如 `files.example.com`。
4. 在 `wrangler.jsonc` 中设置：

```jsonc
{
  "vars": {
    "MAX_FILE_BYTES": "20971520",
    "PUBLIC_BASE_URL": "https://files.example.com"
  }
}
```

5. 重新部署：

```bash
pnpm deploy
```

这样上传接口返回的 URL 会固定使用自定义域名。

## 10. 鉴权与安全说明

- 上传接口必须带：

```http
Authorization: Bearer <UPLOAD_API_KEY>
```

- 文件访问链接本身就是授权凭证：
  - 链接包含 HMAC 签名 token。
  - D1 保存的是后台索引记录和相对访问路径，不是文件本体。
  - 后台删除只会软删除 D1 记录，不会删除 Telegram 消息，也不会让已生成链接失效。
  - 如需让所有旧链接失效，轮换 `LINK_SIGNING_SECRET` 后重新部署即可。

- 管理员登录使用 HttpOnly Cookie，生产环境建议单独设置 `ADMIN_SESSION_SECRET`。
- 不要把 `TELEGRAM_BOT_TOKEN`、`UPLOAD_API_KEY`、`LINK_SIGNING_SECRET`、`ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET` 提交到 Git。
- 建议使用私有频道/群保存文件，避免人工误删消息。

## 11. 文件访问流程说明

```txt
校验签名 token -> 调用 Telegram getFile -> 代理下载 Telegram 文件内容
```

文件访问接口不再使用 Cloudflare Workers Cache API，也不再输出 `X-TGBOT-Cache` 观测头。重复访问同一个链接时，Worker 会重新向 Telegram 查询并代理返回。

文件访问默认使用 `Content-Disposition: inline`。如果需要强制下载，可以在链接后追加：

```text
?download=1
```

## 12. 常见问题排查

### 上传返回 `401 Unauthorized`

检查 `Authorization` 是否为 Bearer 格式：

```http
Authorization: Bearer your-upload-api-key
```

同时确认 Cloudflare secret 中的 `UPLOAD_API_KEY` 与请求值完全一致。

### 上传返回 `413 FileTooLarge`

文件超过当前 `MAX_FILE_BYTES`。默认是 `20971520` 字节，即 20MB。

Telegram 官方 Bot API 的 `getFile` 下载链路对 bot 可下载文件大小有限制，因此本项目默认按 20MB 设计。

### 上传返回 `TelegramUploadFailed`

常见原因：

- `TELEGRAM_BOT_TOKEN` 错误。
- `TELEGRAM_STORAGE_CHAT_ID` 错误。
- bot 没有被加入目标频道/群。

### 后台返回 `Missing required D1 binding: FILES_DB`

检查 `wrangler.jsonc` 是否配置了 `d1_databases`，并确认已经执行过 D1 迁移。

### 后台无法登录

检查 `ADMIN_USERNAME`、`ADMIN_PASSWORD` 是否已经通过 Cloudflare Secret 或 `.dev.vars` 配置。生产环境如果轮换了 `ADMIN_SESSION_SECRET`，旧登录态会立即失效，需要重新登录。
- bot 在频道/群中没有发送消息权限。

可以直接测试 Telegram API：

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage" \
  -d "chat_id=<TELEGRAM_STORAGE_CHAT_ID>" \
  -d "text=hello"
```

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

## 12. 设计边界

- 本项目不记录文件列表，因此不能搜索、删除、分页、统计文件。
- 本项目不使用 Cloudflare R2/KV，因此没有额外存储成本，但依赖 Telegram 文件可用性。
- 链接永久有效的前提是：Telegram 文件仍可通过 bot 访问，且 `LINK_SIGNING_SECRET` 未轮换。
