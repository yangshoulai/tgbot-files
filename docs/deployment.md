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

## 5. 设置生产环境 secrets

依次执行：

```bash
pnpm wrangler secret put TELEGRAM_BOT_TOKEN
pnpm wrangler secret put TELEGRAM_STORAGE_CHAT_ID
pnpm wrangler secret put UPLOAD_API_KEY
pnpm wrangler secret put LINK_SIGNING_SECRET
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
| `PUBLIC_BASE_URL` | 否 | 自定义公开访问域名，例如 `https://files.example.com` |
| `MAX_FILE_BYTES` | 否 | 最大文件大小，默认 `20971520` |
| `FILE_CACHE_ENABLED` | 否 | 是否启用 Cloudflare Workers Cache API，默认 `true` |
| `FILE_CACHE_TTL_SECONDS` | 否 | 文件缓存 TTL，默认最大值 `31536000` 秒 |

`MAX_FILE_BYTES` 默认已经写在 `wrangler.jsonc` 的 `vars` 中。如需自定义生产域名，可以在 `wrangler.jsonc` 中加入：

```jsonc
{
  "vars": {
    "MAX_FILE_BYTES": "20971520",
    "FILE_CACHE_ENABLED": "true",
    "FILE_CACHE_TTL_SECONDS": "31536000",
    "PUBLIC_BASE_URL": "https://files.example.com"
  }
}
```

## 6. 本地运行与联调

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
PUBLIC_BASE_URL="http://localhost:8787"
MAX_FILE_BYTES="20971520"
FILE_CACHE_ENABLED="true"
FILE_CACHE_TTL_SECONDS="31536000"
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

## 7. 部署到 Cloudflare

运行测试和类型检查：

```bash
pnpm test
pnpm typecheck
```

部署：

```bash
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

## 8. 可选：绑定自定义域名

1. 在 Cloudflare Dashboard 中进入对应 Worker。
2. 打开 `Triggers` / `触发器`。
3. 添加自定义域名，例如 `files.example.com`。
4. 在 `wrangler.jsonc` 中设置：

```jsonc
{
  "vars": {
    "MAX_FILE_BYTES": "20971520",
    "FILE_CACHE_ENABLED": "true",
    "FILE_CACHE_TTL_SECONDS": "31536000",
    "PUBLIC_BASE_URL": "https://files.example.com"
  }
}
```

5. 重新部署：

```bash
pnpm deploy
```

这样上传接口返回的 URL 会固定使用自定义域名。

## 9. 鉴权与安全说明

- 上传接口必须带：

```http
Authorization: Bearer <UPLOAD_API_KEY>
```

- 文件访问链接本身就是授权凭证：
  - 链接包含 HMAC 签名 token。
  - Worker 不保存文件记录，不支持单个链接吊销。
  - 如需让所有旧链接失效，轮换 `LINK_SIGNING_SECRET` 后重新部署即可。

- 不要把 `TELEGRAM_BOT_TOKEN`、`UPLOAD_API_KEY`、`LINK_SIGNING_SECRET` 提交到 Git。
- 建议使用私有频道/群保存文件，避免人工误删消息。

## 10. 文件缓存说明

文件访问默认启用 Cloudflare Workers Cache API：

```txt
FILE_CACHE_ENABLED=true
FILE_CACHE_TTL_SECONDS=31536000
```

访问流程是：

```txt
校验签名 token -> 查 Cloudflare 边缘缓存 -> 未命中才回源 Telegram -> 写入缓存
```

响应头 `X-TGBOT-Cache` 可用于判断缓存状态：

- `MISS`：未命中 Cloudflare 缓存，已从 Telegram 回源并写入缓存。
- `HIT`：命中 Cloudflare 缓存，没有再请求 Telegram。
- `BYPASS`：绕过缓存，例如 Range 分片请求。

缓存注意事项：

- `31536000` 秒约等于 1 年，是本项目允许的最大 TTL。
- Cache API 是边缘节点本地缓存，不是全局永久存储；不同地区首次访问仍可能回源 Telegram。
- Worker 会先校验签名 token 再查缓存，因此轮换 `LINK_SIGNING_SECRET` 后旧链接无法继续命中缓存。

## 11. 常见问题排查

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

### 如何确认文件是否命中 Cloudflare 缓存

连续请求同一个文件链接：

```bash
curl -sD - -o /dev/null "<文件访问链接>"
curl -sD - -o /dev/null "<文件访问链接>"
```

如果第二次返回：

```http
X-TGBOT-Cache: HIT
```

说明本次命中了 Cloudflare Worker Cache，没有再从 Telegram 下载文件。

## 12. 设计边界

- 本项目不记录文件列表，因此不能搜索、删除、分页、统计文件。
- 本项目不使用 Cloudflare R2/KV，因此没有额外存储成本，但依赖 Telegram 文件可用性。
- 链接永久有效的前提是：Telegram 文件仍可通过 bot 访问，且 `LINK_SIGNING_SECRET` 未轮换。
