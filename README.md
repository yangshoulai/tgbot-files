# tgbot-files

基于 **Cloudflare Worker**、**D1** 和 **Telegram Bot API** 的轻量文件存储后台。

上传接口把文件发送到 Telegram 私有频道/群，Worker 使用 Telegram 返回的 `file_id` 生成签名访问路径，并把文件元数据写入 D1。前端由 Vite + React 构建，部署产物通过 Worker 静态资源能力托管；`/api/*` 和 `/f/*` 继续由 Worker 运行时代码处理。

## 功能

- `POST /api/v1/files`：上传文件，返回可直接访问的 HTTPS 链接。
- `GET /f/:token/:filename?`：访问文件，链接自带 HMAC 签名鉴权。
- `GET /f/:token/:filename?download=1`：强制以附件方式下载文件。
- `/admin`：管理员后台，支持登录、上传、备注、搜索、分页、预览、复制链接、下载和删除索引。
- `/settings`：上传 API key 管理，支持新增、查看、启用、禁用和删除。
- 上传接口继续使用 `Authorization: Bearer <API_KEY>`，API key 明文保存在 D1 的 `api_keys` 表。
- D1 保存文件元数据、备注 `remark` 和相对访问路径 `file_path`。
- 默认限制文件大小为 `20MB`，匹配 Telegram 官方 Bot API `getFile` 的稳定下载边界。

## API 示例

先登录后台 `/settings` 创建上传 API key，然后调用：

```bash
curl -X POST "https://<your-worker-domain>/api/v1/files" \
  -H "Authorization: Bearer <API_KEY>" \
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

## 本地开发

```bash
pnpm install
cp backend/.dev.vars.example backend/.dev.vars
# 编辑 backend/.dev.vars，填入真实 Telegram、管理员和签名密钥
pnpm --filter backend exec wrangler d1 migrations apply tgbot-files --local
pnpm dev
```

`pnpm dev` 会先构建前端，再启动后端目录下的 `wrangler dev`。如果只开发前端界面，也可以运行：

```bash
pnpm dev:frontend
```

常用检查：

```bash
pnpm test
pnpm typecheck
pnpm build
```

完整部署说明见 [docs/deployment.md](docs/deployment.md)。
