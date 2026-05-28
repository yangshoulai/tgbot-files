# 前后端分离重构设计

日期：2026-05-28

## 背景

当前项目是单个 Cloudflare Worker：

- `backend/src/index.ts` 承载 API 路由和文件代理。
- 原 `src/admin-ui.ts` 以内嵌 HTML/CSS/JS 的方式输出登录页和文件管理页，重构后删除。
- `POST /api/v1/files` 已在生产使用，用于上传文件到 Telegram 并写入 D1 元数据。
- `GET /f/:token/:filename?` 已在生产使用，用于通过签名链接代理下载文件。
- 生产数据库的 `files` 表已有 `remark TEXT NULL` 字段，用于保存文件备注。
- `docs/原型设计/` 中已有登录页、控制台、设置页原型。

本次目标是重构 UI 和接口边界，使前端从内嵌 HTML 中拆出，形成可维护的工程化前端，同时保留 Worker 部署和现有生产接口兼容性。

## 已确认决策

### 部署形态

采用方案 2：Worker 同时服务静态前端资源和 API。

实现方式：

- 新增前端工程目录 `frontend/`，使用 pnpm 管理依赖。
- 前端构建产物输出到 `frontend/dist`。
- Worker 通过 Cloudflare Worker 静态资源能力托管前端产物。
- `/api/*` 和 `/f/*` 继续由 Worker 运行时代码处理。
- 其他前端路由回退到前端入口 HTML。

该方案不再引入独立 Cloudflare Pages 项目，部署入口仍集中在 Worker，避免 CORS、Cookie Domain 和跨项目路由配置复杂度。

### API key 存储

上传 API key 使用 D1 明文保存。

设计约束：

- `POST /api/v1/files` 的请求路径、请求方式、`Authorization: Bearer <key>` 格式保持不变。
- 鉴权来源从环境变量 `UPLOAD_API_KEY` 切换为 D1 的 `api_keys` 表。
- `UPLOAD_API_KEY` 不再作为上传鉴权来源。
- 后台设置页可以创建、复制、启用、禁用、删除 API key。
- 创建 API key 后明文可再次查看或复制，因为用户已确认使用明文存储。

风险说明：

- 明文存储会扩大数据库泄露后的影响范围。
- 后台 UI 必须只允许管理员会话访问。
- API 响应和日志不得无意输出所有 key 明文；列表页默认可遮罩展示，复制时可通过明确操作获取。

### 备注字段

生产库已存在 `files.remark TEXT NULL`。

本次代码应把 `remark` 作为真实字段处理：

- 管理员上传文件时可提交 `remark`。
- 文件列表和详情返回 `remark`。
- 搜索支持匹配 `remark`。
- 初始建表脚本 `backend/migrations/0001_create_files.sql` 补全 `remark TEXT`，用于新环境初始化。
- 生产环境不依赖重新执行 `0001`。

## 范围

### 本次包含

- 移除内嵌管理员 UI 的主要职责，改为前端工程构建。
- 保留 Worker API 与文件下载代理。
- 新增 D1 API key 管理能力。
- 文件备注 `remark` 的读写、展示与搜索。
- 登录页、控制台、设置页的前端重构。
- 上传、搜索、分页、预览、复制链接、下载、软删除。
- 更新部署文档和本地开发命令。
- 补充后端测试和必要的前端类型检查。

### 本次不包含

- 网页直接修改 Telegram Bot Token。
- 网页直接修改管理员密码。
- 网页直接修改 `LINK_SIGNING_SECRET`、`ADMIN_SESSION_SECRET` 等 Cloudflare Secrets。
- 删除 Telegram 存储聊天里的原始消息。
- 让已生成的 `/f/:token` 签名链接因后台删除而失效。

## 架构设计

### 目录结构

目标结构：

```text
tgbot-files/
  frontend/
    src/
      api/
      components/
      pages/
      styles/
      main.tsx
    index.html
    package.json
    tsconfig.json
    vite.config.ts
  backend/
    src/
      index.ts
      admin-auth.ts
      database.ts
      telegram.ts
      http.ts
      crypto.ts
      md5.ts
    migrations/
      0001_create_files.sql
      0002_create_api_keys.sql
    test/
```

根目录继续作为 pnpm workspace，`backend/` 和 `frontend/` 分别是独立包，根目录只负责统一安装、构建和测试编排。

### 路由边界

Worker 路由优先级：

1. `OPTIONS *`：返回安全头。
2. `/api/*`：后端 JSON API。
3. `/f/*`：签名文件代理下载。
4. 静态资源：返回前端构建产物。
5. 其他路径：返回前端入口 HTML，支持前端路由刷新。

保留的公开接口：

- `POST /api/v1/files`
- `GET /f/:token/:filename?`
- `GET /f/:token/:filename?download=1`

管理员接口：

- `POST /api/admin/login`
- `POST /api/admin/logout`
- `GET /api/admin/session`
- `GET /api/admin/files`
- `POST /api/admin/files`
- `DELETE /api/admin/files/:id`
- `GET /api/admin/api-keys`
- `POST /api/admin/api-keys`
- `GET /api/admin/api-keys/:id`
- `PATCH /api/admin/api-keys/:id`
- `DELETE /api/admin/api-keys/:id`

## 数据库设计

### files 表

`files` 表继续作为文件元数据表，补充使用 `remark`：

```sql
remark TEXT
```

查询能力：

- 默认只查 `deleted_at IS NULL`。
- 搜索字段：`file_name`、`mime_type`、`md5`、`telegram_file_id`、`remark`。
- 排序默认 `created_at DESC`。

### api_keys 表

新增迁移 `0002_create_api_keys.sql`：

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);
CREATE INDEX IF NOT EXISTS idx_api_keys_deleted_at ON api_keys(deleted_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_last_used_at ON api_keys(last_used_at);
```

约束：

- `status` 使用 `active` / `disabled`。
- 删除采用软删除，写入 `deleted_at`。
- 上传鉴权只接受 `deleted_at IS NULL AND status = 'active'` 的 key。
- 成功鉴权后更新 `last_used_at`。

## 后端设计

### 上传鉴权

当前逻辑：

- `requireBearerAuth(request, env.UPLOAD_API_KEY)`

目标逻辑：

- 从 `Authorization` 读取 Bearer token。
- 查询 D1 `api_keys` 表。
- 未找到、禁用或已删除返回 `401 Unauthorized`。
- 成功后更新 `last_used_at`。
- `POST /api/v1/files` 和后台上传复用同一个文件上传管线，但后台上传继续以管理员会话鉴权。

### 文件上传

保留现有行为：

- 读取 multipart 字段 `file`。
- 校验文件大小。
- 上传到 Telegram。
- 生成签名 `/f/:token/:filename`。
- 写入 D1 元数据。
- 返回兼容 JSON 字段：`ok`、`url`、`name`、`size`、`mime_type`。

后台上传增强：

- 接收可选 `remark` 字段。
- 写入 `files.remark`。
- 响应中返回 `remark`。

### 文件列表

`GET /api/admin/files` 支持：

- `q`：搜索。
- `page`：页码。
- `limit`：每页数量。
- 可选 `type` 和 `sort` 由前端驱动；后端先支持默认排序，后续可扩展。

返回：

- `files[]`：包含 `remark`、`url`、`download_url`。
- `pagination`：`page`、`limit`、`total`、`total_pages`。
- `max_file_bytes`。

### 设置页 API

API key 管理：

- 列表：返回 id、name、masked_key、status、created_at、updated_at、last_used_at，不默认返回所有 key 明文。
- 创建：前端提交名称，服务端生成随机 key；创建响应返回完整 key。
- 查看/复制单个 key：管理员明确点击后请求单个详情接口，返回该 key 的明文。
- 更新：允许修改 name、status。
- 删除：软删除。

Secrets 状态展示：

- 设置页只展示环境配置是否存在，例如 Telegram 存储后端已配置、最大上传大小。
- 不返回 Telegram Bot Token、Chat ID、签名密钥、管理员密码明文。

## 前端设计

### 技术栈

- Vite
- React
- TypeScript
- pnpm
- CSS 可使用现代轻量方案；优先保持原型中的清爽后台风格。

不强制引入大型组件库。若实现时需要图标，可使用 `lucide-react`。

### 页面

登录页：

- 表单提交到 `POST /api/admin/login`。
- 登录成功后进入控制台。
- 已登录访问登录页时跳转控制台。

控制台：

- 顶部导航：文件仓库、控制台、设置、退出。
- 汇总指标：文件总数、存储占用、最近上传、后端状态。
- 文件列表：搜索、分页、类型展示、文件大小、上传时间、备注。
- 上传弹窗：文件选择、备注输入、进度/状态、错误提示。
- 详情弹窗：链接、类型、大小、MD5、Telegram file id、备注。
- 操作：预览、复制链接、下载、删除索引。

设置页：

- API key 列表：名称、明文/遮罩、状态、最近使用时间。
- 新增 key：输入名称，创建后展示完整 key。
- 启用/禁用 key。
- 删除 key。
- 配置状态：展示 Secrets 是否配置、最大上传大小、存储后端状态。

### 状态和错误处理

- 未登录 API 返回 401 时跳转登录页。
- 上传超限显示后端返回的 `max_file_bytes`。
- Telegram 上传失败展示可理解错误。
- 删除使用确认弹窗。
- 复制链接成功显示 toast。

## 安全设计

- 管理 API 全部要求管理员 Cookie。
- 管理员 Cookie 继续使用 HttpOnly、SameSite=Strict。
- API key 明文保存是用户确认的需求；实现上避免写入日志。
- 管理页默认遮罩 key，用户点击复制或显示时才展示明文。
- 文件下载签名逻辑不改变，避免影响现有链接。

## 兼容性

必须保持：

- `POST /api/v1/files` 路径不变。
- `Authorization: Bearer <key>` 格式不变。
- 上传响应字段不变。
- `/f/:token/:filename?` 路径不变。
- `download=1` 强制下载不变。
- 已生成的签名链接继续可访问。

有意改变：

- `UPLOAD_API_KEY` 不再生效。
- 上传 key 必须先在后台设置页创建。
- 老的内嵌 `/admin` HTML 页面将由新前端入口替代。

## 测试策略

后端测试：

- 上传接口使用 D1 API key 鉴权。
- 禁用、删除、缺失 key 返回 401。
- 成功上传更新 `last_used_at`。
- 后台上传写入 `remark`。
- 文件列表搜索可匹配 `remark`。
- 现有 `/f/*` 下载、range、download 参数测试保持通过。

前端验证：

- TypeScript 类型检查。
- Vite 构建通过。
- 本地 Worker 启动后浏览器验证登录、列表、上传、设置页 key 管理。

## 部署与迁移步骤

1. 更新代码并部署前，先在测试环境执行新迁移。
2. 执行 `0002_create_api_keys.sql` 创建 API key 表。
3. 部署新版 Worker。
4. 登录后台设置页创建新的上传 API key。
5. 更新所有调用 `POST /api/v1/files` 的生产脚本。
6. 验证上传、下载、后台列表、备注搜索。

注意：因为选择了一次性切换到 D1 key，部署后到新 key 配置完成前，旧上传脚本会返回 401。

## 开放风险

- API key 明文存储降低了数据库泄露场景下的安全边界，这是已确认取舍。
- 当前生产迁移历史和仓库 `0001` 曾存在差异；后续实现应避免假设所有环境都严格等同于仓库迁移文件。
- Worker 同时托管静态前端和 API，部署简单，但前后端不是 Cloudflare Pages 级别的物理分离。
