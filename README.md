# tgbot-files

基于 **Cloudflare Worker** 和 **Telegram Bot API** 的文件存储服务。

核心思路：上传接口把文件发送到指定 Telegram 私有频道/群/聊天，Worker 使用 Telegram 返回的 `file_id` 生成签名访问路径，并把文件元数据写入 D1。访问文件时，Worker 校验签名链接，再通过 Telegram `getFile` 获取真实文件地址并代理返回文件内容。

## 功能

- `POST /api/v1/files`：上传文件，返回可直接访问的 HTTPS 链接。
- `GET /f/:token/:filename?`：访问文件，链接自带 HMAC 签名鉴权。
- `GET /f/:token/:filename?download=1`：强制以附件方式下载文件。
- `GET /admin`：管理员文件后台，支持登录、上传、搜索、列表/网格切换、下载和删除索引记录。
- 上传接口使用 `Authorization: Bearer <UPLOAD_API_KEY>`。
- D1 只保存文件元数据和相对访问路径 `file_path`，不保存完整域名，后续可直接更换 `PUBLIC_BASE_URL`。
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

后台删除只会软删除 D1 中的索引记录，不会删除 Telegram 存储聊天里的原始文件消息，也不会让已经生成的签名链接失效。

访问：

```bash
curl -L "https://<your-worker-domain>/f/<signed-token>/example.txt" -o example.txt
```

## 本地开发

```bash
pnpm install
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入真实 token、chat_id 和密钥
pnpm wrangler d1 migrations apply tgbot-files --local
pnpm dev
```

测试：

```bash
pnpm test
pnpm typecheck
```

完整部署说明见 [`docs/deployment.md`](docs/deployment.md)。
