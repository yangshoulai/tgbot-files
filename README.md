# tgbot-files

基于 **Cloudflare Worker** 和 **Telegram Bot API** 的文件存储服务。

核心思路：上传接口把文件发送到指定 Telegram 私有频道/群/聊天，Worker 只把 Telegram 返回的 `file_id` 写入签名链接。访问文件时，Worker 校验签名链接，再通过 Telegram `getFile` 获取真实文件地址并代理返回文件内容。

## 功能

- `POST /api/v1/files`：上传文件，返回可直接访问的 HTTPS 链接。
- `GET /f/:token/:filename?`：访问文件，链接自带 HMAC 签名鉴权。
- 上传接口使用 `Authorization: Bearer <UPLOAD_API_KEY>`。
- 不使用数据库、R2、KV、Durable Object 或其他持久化存储。
- 默认限制文件大小为 `20MB`，匹配 Telegram 官方 Bot API `getFile` 的稳定下载边界。
- 文件访问接口每次校验签名后直接回源 Telegram 并代理返回文件内容。

## API 示例

上传：

```bash
curl -X POST "https://<your-worker-domain>/api/v1/files" \
  -H "Authorization: Bearer <UPLOAD_API_KEY>" \
  -F "file=@./example.txt"
```

响应：

```json
{
  "ok": true,
  "url": "https://<your-worker-domain>/f/<signed-token>/example.txt",
  "name": "example.txt",
  "size": 12345,
  "mime_type": "text/plain"
}
```

访问：

```bash
curl -L "https://<your-worker-domain>/f/<signed-token>/example.txt" -o example.txt
```

## 本地开发

```bash
pnpm install
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入真实 token、chat_id 和密钥
pnpm dev
```

测试：

```bash
pnpm test
pnpm typecheck
```

完整部署说明见 [`docs/deployment.md`](docs/deployment.md)。
