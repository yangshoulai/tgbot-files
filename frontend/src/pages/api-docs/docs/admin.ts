import { p } from "../doc-field";
import type { DocGroup } from "../types";
import type { DocsContext } from "./context";

export function buildAdminGroup(ctx: DocsContext): DocGroup {
  return {
      title: "管理员接口",
      description: "面向 React 管理后台。除登录外全部依赖 HttpOnly Cookie；前端 fetch 必须保留 credentials: include。",
      sections: [
        {
          id: "admin-auth",
          title: "认证与会话",
          description: "登录、退出和运行配置读取。",
          endpoints: [
            {
              id: "admin-login",
              method: "POST",
              path: "/api/admin/login",
              title: "管理员登录",
              auth: "无需 Cookie",
              summary: "验证管理员账号密码并设置会话 Cookie。",
              functionality: "支持 JSON、x-www-form-urlencoded 和 multipart/form-data；成功后写入 HttpOnly Cookie。",
              useCases: ["登录页提交账号密码。", "表单模式下支持 303 跳转到 /admin。"],
              limits: ["username/password 必须匹配环境变量配置。", "JSON 请求必须使用 application/json。"],
              specialHandling: ["remember_me=true 时创建持久会话。", "表单登录失败会跳转 /login?error=1，JSON 失败返回 401。"],
              requestParams: [
                p("username", "Body", "是", "string", "环境变量 ADMIN_USERNAME", "管理员用户名。"),
                p("password", "Body", "是", "string", "环境变量 ADMIN_PASSWORD", "管理员密码。"),
                p("remember_me", "Body", "否", "boolean", "默认 false", "是否持久登录。")
              ],
              responseParams: [
                ctx.okResponse,
                p("Set-Cookie", "Response", "是", "string", "HttpOnly", "管理员会话 Cookie。")
              ],
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/login' \\
  -H 'Content-Type: application/json' \\
  -d '{ "username": "admin", "password": "secret", "remember_me": true }'`,
              responseExample: `HTTP/1.1 200 OK
Set-Cookie: admin_session=...; HttpOnly; SameSite=Lax

{ "ok": true }`
            },
            {
              id: "admin-ctx.session",
              method: "GET",
              path: "/api/admin/ctx.session",
              title: "获取当前会话和运行配置",
              auth: "Admin Cookie",
              summary: "返回登录用户、上传限制、公开服务地址和关键配置状态。",
              functionality: "校验 Cookie 并返回前端初始化所需的运行时配置。",
              useCases: ["App 启动时恢复登录状态。", "设置页展示环境变量配置状态。", "上传前读取大小限制。"],
              limits: ["必须带有效 admin_session。", "成功响应会刷新 Cookie 有效期。"],
              specialHandling: ["config 只返回布尔状态，不泄露密钥。", "config_values 中的敏感值会被 mask。"],
              requestParams: [ctx.adminCookie],
              responseParams: [
                ctx.okResponse,
                p("username", "Response", "是", "string", "管理员用户名", "当前登录用户。"),
                p("max_file_bytes", "Response", "是", "number", "字节", "单文件直传上限。"),
                p("multipart_chunk_bytes", "Response", "是", "number", "字节", "分片大小。"),
                p("max_multipart_file_bytes", "Response", "是", "number", "字节", "分片文件总上限。"),
                p("direct_access_max_chunks", "Response", "是", "number", "兼容字段", "系统文件大小上限对应的最大分片数。"),
                p("base_url", "Response", "是", "string", "URL", "公开服务地址。"),
                p("config", "Response", "是", "object", "boolean map", "关键绑定和环境变量是否配置。"),
                p("config_values", "Response", "是", "object", "masked map", "设置页展示用配置摘要。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/admin/ctx.session' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "username": "admin",
  "max_file_bytes": ${ctx.session.max_file_bytes},
  "multipart_chunk_bytes": ${ctx.session.multipart_chunk_bytes},
  "max_multipart_file_bytes": ${ctx.session.max_multipart_file_bytes},
  "direct_access_max_chunks": ${ctx.session.direct_access_max_chunks},
  "base_url": "${ctx.baseUrl}",
  "config": { "database": true, "telegram_bot_token": true }
}`
            },
            {
              id: "admin-logout",
              method: "POST",
              path: "/api/admin/logout",
              title: "退出登录",
              auth: "Admin Cookie",
              summary: "清理管理员会话 Cookie。",
              functionality: "校验当前会话后返回过期 Cookie。",
              useCases: ["用户点击退出。", "主动清理浏览器中的管理会话。"],
              limits: ["必须带有效 admin_session。"],
              specialHandling: ["响应会覆盖 Set-Cookie，把会话设置为过期。"],
              requestParams: [ctx.adminCookie],
              responseParams: [
                ctx.okResponse,
                p("Set-Cookie", "Response", "是", "string", "过期 Cookie", "清理浏览器会话。")
              ],
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/logout' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `HTTP/1.1 200 OK
Set-Cookie: admin_session=; Max-Age=0

{ "ok": true }`
            }
          ]
        },
        {
          id: "admin-files",
          title: "文件列表与文件管理",
          description: "文件列表、统计、上传、编辑、移动、删除和 HLS 下载计划。",
          endpoints: [
            {
              id: "admin-files-list",
              method: "GET",
              path: "/api/admin/files",
              title: "列出文件、目录和统计",
              auth: "Admin Cookie",
              summary: "管理后台首页的数据源，返回当前目录、子目录、文件分页和全局统计。",
              functionality: "按目录和筛选条件查询 files 表，同时返回直属子目录使用量和全局容量统计。",
              useCases: ["文件管理首页。", "目录切换、搜索、类型筛选、日期筛选。", "顶部指标卡片展示容量。"],
              limits: ["搜索只作用于当前目录，不递归。", "page/limit 必须为正整数；limit=all 或 all=1 返回全部。"],
              specialHandling: ["current_directory 为根目录时 id 为 null。", "global_stats 不受当前目录和筛选条件影响。"],
              requestParams: [
                ctx.adminCookie,
                p("dir", "Query", "否", "string", "默认 /", "当前目录路径。"),
                p("q", "Query", "否", "string", "空字符串允许", "文件名或备注搜索词。"),
                p("type", "Query", "否", "string", "image / video / text / pdf / archive / other", "文件类型筛选。"),
                p("created_from", "Query", "否", "string", "ISO 时间", "创建时间起点。"),
                p("created_to", "Query", "否", "string", "ISO 时间", "创建时间终点。"),
                p("page", "Query", "否", "number", ">=1", "页码。"),
                p("limit", "Query", "否", "number | all", ">=1", "每页数量；all 返回全部。"),
                p("all", "Query", "否", "string", "1", "返回全部记录。")
              ],
              responseParams: [
                ctx.okResponse,
                p("current_directory", "Response", "是", "object", "目录对象", "当前目录信息。"),
                p("directories", "Response", "是", "array", "直属子目录", "当前目录的子目录列表，包含 file_count 和 total_size。"),
                p("files", "Response", "是", "array<FileItem>", "分页结果", "文件记录列表。"),
                p("pagination", "Response", "是", "object", "page/limit/total/total_pages", "分页信息。"),
                p("global_stats", "Response", "是", "object", "file_count/total_size", "全局文件统计。"),
                p("max_file_bytes", "Response", "是", "number", "字节", "单文件直传上限。"),
                p("multipart_chunk_bytes", "Response", "是", "number", "字节", "分片大小。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/admin/files?dir=/photos&q=trip&type=image&page=1&limit=24' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "current_directory": { "id": null, "path": "/" },
  "directories": [
    { "id": "dir-id", "name": "photos", "path": "/photos", "file_count": 12, "total_size": 1048576 }
  ],
  "files": [
    {
      "id": "file-id",
      "file_name": "trip.jpg",
      "directory_path": "/photos",
      "url": "${ctx.baseUrl}/f/<token>/trip.jpg",
      "download_url": "${ctx.baseUrl}/f/<token>/trip.jpg?download=1"
    }
  ],
  "pagination": { "page": 1, "limit": 24, "total": 1, "total_pages": 1 },
  "global_stats": { "file_count": 128, "total_size": 987654321 }
}`
            },
            {
              id: "admin-files-create",
              method: "POST",
              path: "/api/admin/files",
              title: "管理员小文件上传或 URL 拉取",
              auth: "Admin Cookie",
              summary: "支持 multipart 文件上传或 JSON URL 拉取，适合小文件。",
              functionality: "读取本地文件或远程 URL，受 MAX_FILE_BYTES 限制，转存到 Telegram 并创建文件索引。",
              useCases: ["控制台上传小文件。", "从 URL 快速导入小文件。"],
              limits: [`文件大小必须小于等于 ${ctx.maxFile}。`, "URL 最长 4096 字符。", "Content-Type 必须是 multipart/form-data 或 application/json。"],
              specialHandling: ["远程 URL 可附加 headers/source_headers/request_headers。", "同名冲突默认返回 409，可用 on_conflict=overwrite 覆盖。"],
              requestParams: [
                ctx.adminCookie,
                p("file", "FormData", "条件", "File", `<=${ctx.maxFile}`, "本地上传文件；与 JSON url 二选一。"),
                p("url", "Body", "条件", "string", "http/https", "远程文件 URL；JSON 模式使用。"),
                p("headers", "Body/FormData", "否", "object | array | string", "最多 32 个，总计 16KB", "拉取远端 URL 时附加请求头。"),
                p("file_name", "Body/FormData", "否", "string", "1-180 字符", "覆盖文件名。"),
                p("directory_path", "Body/FormData", "否", "string", "默认 /", "目标目录。"),
                p("remark", "Body/FormData", "否", "string", "最多 1000 字符", "备注。"),
                p("on_conflict", "Body/FormData", "否", "string", "error / overwrite", "同名处理。")
              ],
              responseParams: ctx.fileResponseFields,
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/files' \\
  -H 'Cookie: admin_session=...' \\
  -F 'file=@./hello.txt' \\
  -F 'directory_path=/docs'

curl -X POST '${ctx.baseUrl}/api/admin/files' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "url": "https://example.com/hello.txt", "directory_path": "/docs" }'`,
              responseExample: `{
  "ok": true,
  "file": {
    "id": "file-id",
    "file_name": "hello.txt",
    "storage_backend": "telegram_single",
    "file_path": "/f/<token>/hello.txt",
    "url": "${ctx.baseUrl}/f/<token>/hello.txt",
    "download_url": "${ctx.baseUrl}/f/<token>/hello.txt?download=1"
  }
}`
            },
            {
              id: "admin-files-update",
              method: "PATCH",
              path: "/api/admin/files/:id",
              title: "修改文件名和备注",
              auth: "Admin Cookie",
              summary: "更新文件展示名和备注。",
              functionality: "读取现有文件记录，校验新文件名并在需要时重新签发 file_path。",
              useCases: ["重命名文件。", "编辑备注。"],
              limits: ["至少提供 file_name 或 remark。", "file_name 必须 1-180 字符且同目录唯一。"],
              specialHandling: ["remark=null 或空字符串会清空备注。", "文件名变更会生成新的签名路径，旧链接不主动失效。"],
              requestParams: [
                ctx.adminCookie,
                p("id", "Path", "是", "string", "文件 id", "文件记录 id。"),
                p("file_name", "Body", "否", "string", "1-180 字符", "新的文件名。"),
                p("remark", "Body", "否", "string | null", "最多 1000 字符", "新的备注；null 清空。")
              ],
              responseParams: ctx.fileResponseFields,
              requestExample: `curl -X PATCH '${ctx.baseUrl}/api/admin/files/<FILE_ID>' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "file_name": "new-name.txt", "remark": "新的备注" }'`,
              responseExample: `{
  "ok": true,
  "file": {
    "id": "file-id",
    "file_name": "new-name.txt",
    "remark": "新的备注",
    "file_path": "/f/<new-token>/new-name.txt"
  }
}`
            },
            {
              id: "admin-files-move",
              method: "PATCH",
              path: "/api/admin/files/move",
              title: "移动文件到目录",
              auth: "Admin Cookie",
              summary: "批量移动文件索引到目标目录。",
              functionality: "解析目标目录，必要时自动创建，然后更新文件记录 directory_path。",
              useCases: ["旧版单类型批量移动。", "只移动文件不移动目录。"],
              limits: ["file_ids 必须非空。", "目标目录内不能出现同名冲突。"],
              specialHandling: ["新前端更推荐使用 /api/admin/entries/move。", "支持通过 new_directory_parent_path + new_directory_name 创建目标目录。"],
              requestParams: [
                ctx.adminCookie,
                p("file_ids", "Body", "是", "string[]", "非空", "要移动的文件 id 列表。"),
                p("directory_path", "Body", "条件", "string", "目标目录", "移动到已有或自动创建的目录。"),
                p("new_directory_parent_path", "Body", "条件", "string", "父目录", "创建新目录时的父路径。"),
                p("new_directory_name", "Body", "条件", "string", "1-80 字符", "创建新目录时的名称。")
              ],
              responseParams: [
                ctx.okResponse,
                p("moved", "Response", "是", "number", ">=0", "移动成功的文件数。"),
                p("directory_path", "Response", "是", "string", "目标目录", "最终目录路径。")
              ],
              requestExample: `curl -X PATCH '${ctx.baseUrl}/api/admin/files/move' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "file_ids": ["file-id-1", "file-id-2"], "directory_path": "/archive" }'`,
              responseExample: `{
  "ok": true,
  "moved": 2,
  "directory_path": "/archive"
}`
            },
            {
              id: "admin-files-delete",
              method: "DELETE",
              path: "/api/admin/files/:id",
              title: "删除单个文件索引",
              auth: "Admin Cookie",
              summary: "软删除一个文件记录。",
              functionality: "把文件记录标记为 deleted，不删除 Telegram 原始消息。",
              useCases: ["从控制台移除单个文件。", "清理索引记录。"],
              limits: ["id 必须指向存在的未删除文件。"],
              specialHandling: ["已分发的签名链接仍可能继续可用。", "不会回收 Telegram 中的消息或文件。"],
              requestParams: [
                ctx.adminCookie,
                p("id", "Path", "是", "string", "文件 id", "文件记录 id。")
              ],
              responseParams: [ctx.okResponse],
              requestExample: `curl -X DELETE '${ctx.baseUrl}/api/admin/files/<FILE_ID>' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{ "ok": true }`
            },
            {
              id: "admin-hls-download-plan",
              method: "GET",
              path: "/api/admin/files/:id/hls-download",
              title: "获取 HLS 加速下载计划",
              auth: "Admin Cookie",
              summary: "为 HLS package 生成可并发下载的 part 列表。",
              functionality: "把 HLS init segment、media segment 和 segment chunk 展开成有序 parts，并生成签名 URL。",
              useCases: ["控制台加速下载 HLS 文件。", "客户端并发下载后按 offset 合并为 TS 或 fMP4 文件。"],
              limits: ["仅支持 storage_backend=hls_package。", "支持 TS HLS 与单 init segment fMP4 HLS 顺序合并。"],
              specialHandling: ["如果 HLS 不可合并会返回 UnsupportedHlsDownload。", "direct_access=false 时仍可使用 parts 加速下载。"],
              requestParams: [
                ctx.adminCookie,
                p("id", "Path", "是", "string", "文件 id", "HLS 文件记录 id。")
              ],
              responseParams: [
                ctx.okResponse,
                p("hls_download.file_id", "Response", "是", "string", "文件 id", "源文件 id。"),
                p("hls_download.file_name", "Response", "是", "string", "*.ts / *.mp4", "合并下载文件名。"),
                p("hls_download.kind", "Response", "是", "string", "ts / fmp4", "顺序合并的容器类型。"),
                p("hls_download.total_size", "Response", "是", "number", "字节", "所有 part 总大小。"),
                p("hls_download.part_count", "Response", "是", "number", ">=1", "可下载 part 数量。"),
                p("hls_download.parts", "Response", "是", "array", "按 index 排序", "每个 part 的 offset、size、url。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/admin/files/<HLS_FILE_ID>/hls-download' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "hls_download": {
    "file_id": "file-hls",
    "file_name": "movie.ts",
    "total_size": 73400320,
    "part_count": 12,
    "direct_access": true,
    "parts": [
      { "index": 0, "segment_index": 0, "chunk_index": null, "offset": 0, "size": 5242880, "url": "${ctx.baseUrl}/api/hls/<token>/segments/0/seg-0.ts" }
    ]
  }
}`
            }
          ]
        },
        {
          id: "admin-directories",
          title: "目录管理",
          description: "虚拟目录的查询、创建、重命名、移动和递归删除。",
          endpoints: [
            {
              id: "admin-directories-list",
              method: "GET",
              path: "/api/admin/directories",
              title: "列出目录",
              auth: "Admin Cookie",
              summary: "返回直属子目录或全部目录。",
              functionality: "flat=1 时读取所有目录；否则按 parent_path 读取子目录。",
              useCases: ["侧边目录树。", "移动弹窗目录选择。"],
              limits: ["parent_path 必须是可读目录。", "目录路径最长 512 字符。"],
              specialHandling: ["flat=true 和 flat=1 等价。", "非 flat 模式会校验父目录存在。"],
              requestParams: [
                ctx.adminCookie,
                p("parent_path", "Query", "否", "string", "默认 /", "父目录路径。"),
                p("flat", "Query", "否", "boolean string", "1 / true", "是否返回所有目录。")
              ],
              responseParams: [
                ctx.okResponse,
                p("directories", "Response", "是", "array<DirectoryItem>", "目录列表", "目录记录，含 id、parent_id、name、path、file_count、total_size。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/admin/directories?parent_path=/' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "directories": [
    { "id": "dir-id", "parent_id": null, "name": "photos", "path": "/photos", "file_count": 12, "total_size": 1048576 }
  ]
}`
            },
            {
              id: "admin-directories-create",
              method: "POST",
              path: "/api/admin/directories",
              title: "新建目录",
              auth: "Admin Cookie",
              summary: "在指定父目录下创建虚拟目录。",
              functionality: "校验目录名和父路径后写入 directories 记录。",
              useCases: ["用户点击新建文件夹。", "移动文件时自动创建目标目录。"],
              limits: ["name 必须 1-80 字符。", "name 不能包含 /、\\、控制字符、. 或 ..。"],
              specialHandling: ["同级目录重名返回 DirectoryExists。", "根目录 parent_path 使用 /。"],
              requestParams: [
                ctx.adminCookie,
                p("name", "Body", "是", "string", "1-80 字符", "目录名称。"),
                p("parent_path", "Body", "否", "string", "默认 /", "父目录路径。")
              ],
              responseParams: [
                ctx.okResponse,
                p("directory", "Response", "是", "DirectoryItem", "目录对象", "创建后的目录记录。")
              ],
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/directories' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "name": "photos", "parent_path": "/" }'`,
              responseExample: `{
  "ok": true,
  "directory": { "id": "dir-id", "name": "photos", "path": "/photos" }
}`
            },
            {
              id: "admin-directories-rename",
              method: "PATCH",
              path: "/api/admin/directories/:id",
              title: "重命名目录",
              auth: "Admin Cookie",
              summary: "重命名目录并递归更新子路径。",
              functionality: "更新目录名称后，同步调整子目录 path 和目录下文件 directory_path。",
              useCases: ["文件夹重命名。"],
              limits: ["不能重命名不存在的目录。", "新名称同样受目录名规则约束。"],
              specialHandling: ["会返回受影响目录数和文件数。", "路径更新是递归操作。"],
              requestParams: [
                ctx.adminCookie,
                p("id", "Path", "是", "string", "目录 id", "目录记录 id。"),
                p("name", "Body", "是", "string", "1-80 字符", "新目录名称。")
              ],
              responseParams: [
                ctx.okResponse,
                p("directory", "Response", "是", "DirectoryItem", "目录对象", "更新后的目录。"),
                p("renamed_directories", "Response", "是", "number", ">=1", "更新路径的目录数量。"),
                p("updated_files", "Response", "是", "number", ">=0", "更新路径的文件数量。")
              ],
              requestExample: `curl -X PATCH '${ctx.baseUrl}/api/admin/directories/<DIR_ID>' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "name": "images" }'`,
              responseExample: `{
  "ok": true,
  "renamed_directories": 2,
  "updated_files": 12,
  "directory": { "id": "dir-id", "path": "/images" }
}`
            },
            {
              id: "admin-directories-move",
              method: "PATCH",
              path: "/api/admin/directories/:id/move",
              title: "移动目录树",
              auth: "Admin Cookie",
              summary: "把目录移动到新的父目录下。",
              functionality: "校验目标父目录后递归更新目录树和文件路径。",
              useCases: ["拖拽移动文件夹。", "整理目录层级。"],
              limits: ["禁止移动到自身或子目录。", "目标父目录必须可写。"],
              specialHandling: ["会返回移动目录数和文件数。", "目录名保持不变。"],
              requestParams: [
                ctx.adminCookie,
                p("id", "Path", "是", "string", "目录 id", "要移动的目录。"),
                p("parent_path", "Body", "是", "string", "目标父目录", "新的父目录路径。")
              ],
              responseParams: [
                ctx.okResponse,
                p("directory", "Response", "是", "DirectoryItem", "目录对象", "移动后的目录。"),
                p("moved_directories", "Response", "是", "number", ">=1", "移动的目录数量。"),
                p("moved_files", "Response", "是", "number", ">=0", "受影响文件数量。")
              ],
              requestExample: `curl -X PATCH '${ctx.baseUrl}/api/admin/directories/<DIR_ID>/move' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "parent_path": "/archive" }'`,
              responseExample: `{
  "ok": true,
  "moved_directories": 2,
  "moved_files": 12,
  "directory": { "id": "dir-id", "path": "/archive/photos" }
}`
            },
            {
              id: "admin-directories-delete",
              method: "DELETE",
              path: "/api/admin/directories/:id",
              title: "递归删除目录树",
              auth: "Admin Cookie",
              summary: "软删除目录、子目录和目录内文件索引。",
              functionality: "递归标记目录树 deleted_at，并软删除目录下文件记录。",
              useCases: ["删除文件夹。", "批量清理目录内容。"],
              limits: ["目录必须存在。"],
              specialHandling: ["不会删除 Telegram 原始消息。", "已分发的签名链接仍可能继续可用。"],
              requestParams: [
                ctx.adminCookie,
                p("id", "Path", "是", "string", "目录 id", "要删除的目录。")
              ],
              responseParams: [
                ctx.okResponse,
                p("deleted_directories", "Response", "是", "number", ">=1", "软删除目录数量。"),
                p("deleted_files", "Response", "是", "number", ">=0", "软删除文件数量。"),
                p("directory", "Response", "是", "DirectoryItem", "目录对象", "被删除的根目录。")
              ],
              requestExample: `curl -X DELETE '${ctx.baseUrl}/api/admin/directories/<DIR_ID>' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "deleted_directories": 2,
  "deleted_files": 12,
  "directory": { "id": "dir-id", "path": "/photos" }
}`
            }
          ]
        },
        {
          id: "admin-entries",
          title: "文件和目录批量操作",
          description: "面向多选 UI 的统一移动和删除接口。",
          endpoints: [
            {
              id: "admin-entries-move",
              method: "PATCH",
              path: "/api/admin/entries/move",
              title: "移动文件和目录",
              auth: "Admin Cookie",
              summary: "支持文件和目录混合移动。",
              functionality: "校验选择项、目标目录、目录树关系和文件名冲突后执行移动。",
              useCases: ["多选移动。", "文件和文件夹一起整理。"],
              limits: ["file_ids 和 directory_ids 至少一个非空。", "目录不能移动到自身或子目录。"],
              specialHandling: ["支持创建新目标目录。", "移动目录时会递归更新子路径。"],
              requestParams: [
                ctx.adminCookie,
                p("file_ids", "Body", "否", "string[]", "可空", "要移动的文件 id。"),
                p("directory_ids", "Body", "否", "string[]", "可空", "要移动的目录 id。"),
                p("directory_path", "Body", "条件", "string", "目标目录", "已有或自动创建的目标目录。"),
                p("new_directory_parent_path", "Body", "条件", "string", "父目录", "创建新目录时使用。"),
                p("new_directory_name", "Body", "条件", "string", "1-80 字符", "新目录名称。")
              ],
              responseParams: [
                ctx.okResponse,
                p("moved", "Response", "是", "number", ">=0", "移动总数。"),
                p("moved_directories", "Response", "是", "number", ">=0", "移动目录数。"),
                p("moved_files", "Response", "是", "number", ">=0", "移动文件数。"),
                p("directory_path", "Response", "是", "string", "目标目录", "最终目标路径。")
              ],
              requestExample: `curl -X PATCH '${ctx.baseUrl}/api/admin/entries/move' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "file_ids": ["file-id"], "directory_ids": ["dir-id"], "directory_path": "/archive" }'`,
              responseExample: `{
  "ok": true,
  "moved": 3,
  "moved_directories": 1,
  "moved_files": 2,
  "directory_path": "/archive"
}`
            },
            {
              id: "admin-entries-delete",
              method: "POST",
              path: "/api/admin/entries/delete",
              title: "批量删除文件和目录",
              auth: "Admin Cookie",
              summary: "支持文件和目录混合软删除。",
              functionality: "软删除选中文件索引，并递归软删除选中目录树。",
              useCases: ["多选删除。", "批量清理文件夹。"],
              limits: ["file_ids 和 directory_ids 至少一个非空。"],
              specialHandling: ["不会删除 Telegram 原始消息。", "目录删除会把目录下文件计入 deleted_files。"],
              requestParams: [
                ctx.adminCookie,
                p("file_ids", "Body", "否", "string[]", "可空", "要删除的文件 id。"),
                p("directory_ids", "Body", "否", "string[]", "可空", "要删除的目录 id。")
              ],
              responseParams: [
                ctx.okResponse,
                p("deleted_directories", "Response", "是", "number", ">=0", "删除目录数。"),
                p("deleted_files", "Response", "是", "number", ">=0", "删除文件数。")
              ],
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/entries/delete' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "file_ids": ["file-id"], "directory_ids": ["dir-id"] }'`,
              responseExample: `{
  "ok": true,
  "deleted_directories": 1,
  "deleted_files": 3
}`
            }
          ]
        },
        {
          id: "admin-multipart",
          title: "管理员分片上传",
          description: "控制台本地文件、URL 导入、预检、状态查询和完成提交。",
          endpoints: [
            {
              id: "admin-upload-preflight",
              method: "POST",
              path: "/api/admin/uploads/preflight",
              title: "上传前文件名预检",
              auth: "Admin Cookie",
              summary: "批量检查目标目录下是否存在同名冲突。",
              functionality: "在创建上传会话前检查 files 表和当前批次内的重复文件名。",
              useCases: ["拖拽批量上传前一次性提示冲突。", "为冲突文件生成 suggested_name。"],
              limits: ["entries 必须非空，最多 1000 项。", "file_name 和 directory_path 会按后端规则清洗。"],
              specialHandling: ["source=file 表示数据库已有文件冲突。", "source=batch 表示本次批量内重复。"],
              requestParams: [
                ctx.adminCookie,
                p("entries", "Body", "是", "array", "1-1000", "待检查文件列表。"),
                p("entries[].client_id", "Body", "是", "string", "客户端自定义", "用于前端映射结果。"),
                p("entries[].directory_path", "Body", "是", "string", "目录路径", "目标目录。"),
                p("entries[].file_name", "Body", "是", "string", "1-180 字符", "文件名。"),
                p("entries[].relative_path", "Body", "否", "string", "最多 512 字符", "批量目录上传时的相对路径。"),
                p("entries[].size", "Body", "否", "number", ">=0", "文件大小。")
              ],
              responseParams: [
                ctx.okResponse,
                p("entries", "Response", "是", "array", "与请求项对应", "每项 status 为 ready 或 conflict。"),
                p("entries[].suggested_name", "Response", "否", "string", "冲突时返回", "建议改名。"),
                p("summary.total", "Response", "是", "number", ">=1", "总项数。"),
                p("summary.ready", "Response", "是", "number", ">=0", "可上传项数。"),
                p("summary.conflicts", "Response", "是", "number", ">=0", "冲突项数。")
              ],
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/uploads/preflight' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "entries": [{ "client_id": "1", "directory_path": "/docs", "file_name": "readme.txt", "size": 12 }] }'`,
              responseExample: `{
  "ok": true,
  "entries": [
    { "client_id": "1", "directory_path": "/docs", "file_name": "readme.txt", "status": "ready" }
  ],
  "summary": { "total": 1, "ready": 1, "conflicts": 0 }
}`
            },
            {
              id: "admin-uploads-init",
              method: "POST",
              path: "/api/admin/uploads/init",
              title: "初始化本地分片上传",
              auth: "Admin Cookie",
              summary: "创建管理员本地文件分片上传会话。",
              functionality: "与 API Key 分片初始化一致，但会记录 uploaded_by 为当前管理员用户名。",
              useCases: ["控制台上传大文件。", "控制台统一用分片流程上传小文件。"],
              limits: [`size 必须大于 0 且小于等于 ${ctx.maxMultipart}。`, `chunk_size 固定为 ${ctx.chunkSize}。`],
              specialHandling: ["目标目录不存在时自动创建。", "同名冲突可用 on_conflict=overwrite。"],
              requestParams: [
                ctx.adminCookie,
                p("file_name", "Body", "是", "string", "1-180 字符", "最终文件名。"),
                p("mime_type", "Body", "否", "string", "默认 application/octet-stream", "文件类型。"),
                p("size", "Body", "是", "number", `1-${ctx.session.max_multipart_file_bytes}`, "文件总大小。"),
                p("directory_path", "Body", "否", "string", "默认 /", "目标目录。"),
                p("remark", "Body", "否", "string", "最多 1000 字符", "备注。"),
                p("on_conflict", "Body", "否", "string", "error / overwrite", "同名处理。")
              ],
              responseParams: ctx.uploadResponseFields,
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/uploads/init' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "file_name": "backup.zip", "mime_type": "application/zip", "size": ${ctx.exampleMultipartSize}, "directory_path": "/backup" }'`,
              responseExample: `{
  "ok": true,
  "upload": {
    "id": "upload-id",
    "file_name": "backup.zip",
    "chunk_size": ${ctx.session.multipart_chunk_bytes},
    "chunk_count": ${ctx.exampleMultipartChunkCount},
    "direct_access": true
  }
}`
            },
            {
              id: "admin-url-init",
              method: "POST",
              path: "/api/admin/uploads/url/init",
              title: "初始化 URL 分片导入",
              auth: "Admin Cookie",
              summary: "创建管理员远程 URL 分片导入会话。",
              functionality: "探测远程文件大小和类型，保存 URL、可选请求头和目录信息。",
              useCases: ["控制台从远程 URL 导入大文件。", "视频 URL 导入后生成缩略图源。"],
              limits: [`远端文件小于等于 ${ctx.maxMultipart}。`, "URL 最长 4096 字符。", "headers 最多 32 个，总计 16KB。"],
              specialHandling: ["管理员 URL 上传同样固定走 multipart。", "thumbnail_source 只在图片/视频且大小合规时返回。"],
              requestParams: [
                ctx.adminCookie,
                p("url", "Body", "是", "string", "http/https", "远程文件 URL。"),
                p("headers", "Body", "否", "object | array | string", "最多 32 个", "远端请求头。"),
                p("file_name", "Body", "否", "string", "1-180 字符", "覆盖文件名。"),
                p("directory_path", "Body", "否", "string", "默认 /", "目标目录。"),
                p("remark", "Body", "否", "string", "最多 1000 字符", "备注。"),
                p("on_conflict", "Body", "否", "string", "error / overwrite", "同名处理。")
              ],
              responseParams: [
                ctx.okResponse,
                p("mode", "Response", "是", "string", "multipart", "固定为 multipart。"),
                ...ctx.uploadResponseFields.slice(1)
              ],
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/uploads/url/init' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "url": "https://example.com/video.mp4", "directory_path": "/videos" }'`,
              responseExample: `{
  "ok": true,
  "mode": "multipart",
  "upload": {
    "id": "upload-id",
    "source_kind": "url",
    "file_name": "video.mp4",
    "chunk_count": 42,
    "thumbnail_source": {
      "available": true,
      "kind": "video",
      "url": "/api/admin/uploads/url-thumbnail-source?token=..."
    }
  }
}`
            },
            {
              id: "admin-upload-status",
              method: "GET",
              path: "/api/admin/uploads/:uploadId/status",
              title: "查询分片上传状态",
              auth: "Admin Cookie",
              summary: "返回上传会话和已完成/缺失分片列表。",
              functionality: "读取 multipart_uploads 和 file_chunks，用于恢复未完成上传。",
              useCases: ["上传中断后恢复。", "刷新页面后继续上传。"],
              limits: ["uploadId 必须存在且未被清理。"],
              specialHandling: ["source_kind 区分 local 与 url。", "missing_chunks 可直接作为重试队列。"],
              requestParams: [
                ctx.adminCookie,
                p("uploadId", "Path", "是", "string", "上传会话 id", "初始化返回的 upload.id。")
              ],
              responseParams: ctx.statusResponseFields,
              requestExample: `curl '${ctx.baseUrl}/api/admin/uploads/<UPLOAD_ID>/status' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "upload": { "id": "upload-id", "source_kind": "local", "file_name": "backup.zip", "chunk_count": ${ctx.exampleMultipartChunkCount} },
  "uploaded_chunks": [0, 1],
  "missing_chunks": [2, 3, 4]
}`
            },
            {
              id: "admin-upload-chunk",
              method: "POST",
              path: "/api/admin/uploads/:uploadId/chunks/:index",
              title: "上传本地分片",
              auth: "Admin Cookie",
              summary: "上传管理员本地文件的一个分片。",
              functionality: "读取 FormData chunk，校验大小，发送到 Telegram 并保存分片记录。",
              useCases: ["控制台并发上传。", "失败分片重传。"],
              limits: ["uploadId 必须是 local 会话。", "chunk 大小必须匹配 expectedChunkSize。"],
              specialHandling: ["重复 index 会更新分片记录。", "上传通道会在多个 Telegram channel 间调度。"],
              requestParams: [
                ctx.adminCookie,
                p("uploadId", "Path", "是", "string", "上传会话 id", "初始化返回 id。"),
                p("index", "Path", "是", "number", "0 <= index < chunk_count", "分片序号。"),
                p("chunk", "FormData", "是", "File", "期望大小", "分片 Blob。")
              ],
              responseParams: ctx.chunkResponseFields,
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/uploads/<UPLOAD_ID>/chunks/0' \\
  -H 'Cookie: admin_session=...' \\
  -F 'chunk=@./backup.zip.part0'`,
              responseExample: `{
  "ok": true,
  "chunk": { "chunk_index": 0, "size": ${ctx.session.multipart_chunk_bytes}, "telegram_file_id": "BQACAg..." },
  "uploaded_chunks": 1
}`
            },
            {
              id: "admin-url-chunk",
              method: "POST",
              path: "/api/admin/uploads/:uploadId/url-chunks/:index",
              title: "导入 URL 分片",
              auth: "Admin Cookie",
              summary: "从远端 URL 导入一个指定分片。",
              functionality: "使用 Range 拉取远端分片，校验响应大小后转存到 Telegram。",
              useCases: ["控制台 URL 导入进度调度。", "失败分片重试。"],
              limits: ["uploadId 必须是 url 会话。", "远端必须稳定支持 Range。"],
              specialHandling: ["会复用初始化时保存的 headers。", "远端读取失败会返回 UrlFetchFailed。"],
              requestParams: [
                ctx.adminCookie,
                p("uploadId", "Path", "是", "string", "URL 上传会话 id", "url/init 返回 id。"),
                p("index", "Path", "是", "number", "0 <= index < chunk_count", "分片序号。")
              ],
              responseParams: ctx.chunkResponseFields,
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/uploads/<UPLOAD_ID>/url-chunks/0' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "chunk": { "chunk_index": 0, "size": ${ctx.session.multipart_chunk_bytes}, "telegram_file_id": "BQACAg..." },
  "uploaded_chunks": 1
}`
            },
            {
              id: "admin-upload-complete",
              method: "POST",
              path: "/api/admin/uploads/:uploadId/complete",
              title: "完成分片上传",
              auth: "Admin Cookie",
              summary: "提交最终文件记录，可选附带缩略图。",
              functionality: "校验所有分片，生成签名 file_path，事务写入 files 并完成上传会话。",
              useCases: ["本地分片上传完成。", "URL 分片导入完成。"],
              limits: ["缺少分片返回 UploadIncomplete。", "缩略图最大 512KB，类型限 JPEG/PNG/WebP。"],
              specialHandling: ["完成阶段仍会检查文件名冲突。", "缩略图失败只影响 thumbnail_status。"],
              requestParams: [
                ctx.adminCookie,
                p("uploadId", "Path", "是", "string", "上传会话 id", "初始化返回 id。"),
                p("on_conflict", "Query/Body/FormData", "否", "string", "error / overwrite", "同名处理。"),
                p("thumbnail", "FormData", "否", "File", "<=512KB", "缩略图文件。"),
                p("thumbnail_width", "FormData", "否", "number", "1-8192", "缩略图宽度。"),
                p("thumbnail_height", "FormData", "否", "number", "1-8192", "缩略图高度。")
              ],
              responseParams: ctx.fileResponseFields,
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/uploads/<UPLOAD_ID>/complete' \\
  -H 'Cookie: admin_session=...'

curl -X POST '${ctx.baseUrl}/api/admin/uploads/<UPLOAD_ID>/complete' \\
  -H 'Cookie: admin_session=...' \\
  -F 'thumbnail=@./thumbnail.jpg'`,
              responseExample: `{
  "ok": true,
  "file": {
    "id": "upload-id",
    "storage_backend": "telegram_multipart",
    "chunk_count": ${ctx.exampleMultipartChunkCount},
    "direct_access": true,
    "download_strategy": "direct_or_accelerated",
    "thumbnail_status": "ready"
  }
}`
            },
            {
              id: "admin-thumbnail-source",
              method: "GET",
              path: "/api/admin/uploads/url-thumbnail-source?token=...",
              title: "读取管理员 URL 缩略图源",
              auth: "Signed thumbnail token",
              summary: "给控制台缩略图生成流程使用的同源媒体代理。",
              functionality: "与 API Key thumbnail-source 相同，但路径位于管理员命名空间。",
              useCases: ["控制台 URL 视频抽帧。", "控制台 URL 图片生成缩略图。"],
              limits: ["token 默认 10 分钟过期。", "视频默认只代理前 2MB。"],
              specialHandling: ["该接口由签名 token 鉴权，不额外要求 admin Cookie。", "会复用 URL 上传会话中的远端请求头。"],
              requestParams: [
                p("token", "Query", "是", "string", "签名 token", "url/init 返回的 thumbnail_source.url。"),
                p("Range", "Header", "否", "string", "bytes=start-end", "范围读取。")
              ],
              responseParams: [
                p("Content-Type", "Response", "是", "string", "源 MIME", "媒体类型。"),
                p("Content-Length", "Response", "条件", "number", "字节", "响应大小。"),
                p("Content-Range", "Response", "条件", "string", "Range 时返回", "范围信息。"),
                p("Accept-Ranges", "Response", "条件", "string", "bytes", "远端 Range 能力。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/admin/uploads/url-thumbnail-source?token=<TOKEN>' \\
  -H 'Range: bytes=0-2097151' \\
  -o source.part`,
              responseExample: `HTTP/1.1 206 Partial Content
Content-Type: video/mp4
Content-Range: bytes 0-2097151/104857600`
            }
          ]
        },
        {
          id: "admin-hls",
          title: "HLS 导入与预览",
          description: "探测 HLS playlist，导入 segment，生成预览和最终 HLS package 文件。",
          endpoints: [
            {
              id: "admin-hls-probe",
              method: "POST",
              path: "/api/admin/uploads/hls/probe",
              title: "探测 HLS 源",
              auth: "Admin Cookie",
              summary: "读取 HLS playlist，返回 master/media 信息和可选变体。",
              functionality: "拉取 m3u8，解析 master playlist 或 media playlist，估算 segment 信息。",
              useCases: ["用户输入 HLS URL 后预览变体。", "选择分辨率/码率后初始化导入。"],
              limits: ["playlist 最大 2MB。", "variant_id 最长 80 字符。", "仅支持 HTTP/HTTPS 源。"],
              specialHandling: ["master playlist 会返回 variants；media playlist 会返回 media 摘要。", "headers 可用于访问鉴权源。"],
              requestParams: [
                ctx.adminCookie,
                p("url", "Body", "是", "string", "m3u8 URL", "HLS playlist 地址。"),
                p("variant_id", "Body", "否", "string", "最多 80 字符", "选择 master playlist 中的变体。"),
                p("headers", "Body", "否", "object | array | string", "最多 32 个", "远端请求头。")
              ],
              responseParams: [
                ctx.okResponse,
                p("hls.playlist_url", "Response", "是", "string", "URL", "被探测的 playlist。"),
                p("hls.kind", "Response", "是", "string", "master / media", "playlist 类型。"),
                p("hls.variants", "Response", "是", "array", "master 时可能非空", "可选码率/分辨率列表。"),
                p("hls.media", "Response", "否", "object | null", "media playlist", "目标 media 信息。")
              ],
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/uploads/hls/probe' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "url": "https://example.com/master.m3u8" }'`,
              responseExample: `{
  "ok": true,
  "hls": {
    "playlist_url": "https://example.com/master.m3u8",
    "kind": "master",
    "selected_variant_id": null,
    "variants": [
      { "id": "v0", "bandwidth": 2500000, "resolution": "1280x720", "codecs": "avc1.64001f" }
    ],
    "media": null
  }
}`
            },
            {
              id: "admin-hls-init",
              method: "POST",
              path: "/api/admin/uploads/hls/init",
              title: "初始化 HLS 导入",
              auth: "Admin Cookie",
              summary: "创建 HLS 导入任务和 segment 记录。",
              functionality: "解析目标 media playlist，写入 hls_assets 和 hls_segments 临时记录。",
              useCases: ["开始导入 HLS 视频。", "保存用户选择的 variant_id、目录和备注。"],
              limits: ["不限制 segment 数量。", "文件名必须 1-180 字符。", "目录路径最长 512 字符。"],
              specialHandling: ["HLS 最终会保存为 storage_backend=hls_package。", "同名冲突在初始化和完成阶段都会校验。"],
              requestParams: [
                ctx.adminCookie,
                p("url", "Body", "是", "string", "m3u8 URL", "HLS playlist 地址。"),
                p("variant_id", "Body", "否", "string", "最多 80 字符", "选中的变体。"),
                p("file_name", "Body", "否", "string", "1-180 字符", "最终文件名。"),
                p("directory_path", "Body", "否", "string", "默认 /", "目标目录。"),
                p("remark", "Body", "否", "string", "最多 1000 字符", "备注。"),
                p("headers", "Body", "否", "object | array | string", "最多 32 个", "远端请求头。"),
                p("on_conflict", "Body", "否", "string", "error / overwrite", "同名处理。")
              ],
              responseParams: ctx.hlsUploadFields,
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/uploads/hls/init' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "url": "https://example.com/master.m3u8", "variant_id": "v0", "file_name": "movie.m3u8", "directory_path": "/videos" }'`,
              responseExample: `{
  "ok": true,
  "hls": {
    "asset": {
      "id": "hls-id",
      "file_name": "movie.m3u8",
      "status": "pending",
      "segment_count": 120,
      "preview_playlist_url": "${ctx.baseUrl}/api/admin/uploads/hls/hls-id/preview.m3u8"
    },
    "segments": [
      { "segment_index": 0, "status": "pending", "storage_backend": null }
    ]
  }
}`
            },
            {
              id: "admin-hls-status",
              method: "GET",
              path: "/api/admin/uploads/hls/:assetId/status",
              title: "查询 HLS 导入状态",
              auth: "Admin Cookie",
              summary: "返回 HLS asset 和所有 segment 的当前状态。",
              functionality: "读取 HLS 临时记录，用于前端展示导入进度和缺失分片。",
              useCases: ["页面刷新后恢复 HLS 导入。", "轮询导入进度。"],
              limits: ["assetId 必须存在。"],
              specialHandling: ["segment 内可能包含 uploaded_chunks 和 missing_chunks。", "done segment 可用于预览。"],
              requestParams: [
                ctx.adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "初始化返回的 asset.id。")
              ],
              responseParams: ctx.hlsUploadFields,
              requestExample: `curl '${ctx.baseUrl}/api/admin/uploads/hls/<ASSET_ID>/status' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "hls": {
    "asset": { "id": "hls-id", "status": "importing", "segment_count": 120 },
    "segments": [
      { "segment_index": 0, "status": "done", "uploaded_chunks": [], "missing_chunks": [] }
    ]
  }
}`
            },
            {
              id: "admin-hls-preview-playlist",
              method: "GET",
              path: "/api/admin/uploads/hls/:assetId/preview.m3u8",
              title: "读取 HLS 预览 Playlist",
              auth: "Admin Cookie",
              summary: "返回已导入前几个 segment 组成的临时 m3u8。",
              functionality: "选取连续已完成 segment，重写 segment URL 指向管理员预览接口。",
              useCases: ["导入过程中预览视频。", "确认导入源是否可播放。"],
              limits: ["至少完成 1 个 segment。", "最多使用前 4 个已完成 segment。"],
              specialHandling: ["响应 Cache-Control 为 no-store。", "没有可预览 segment 时返回 HlsPreviewNotReady。"],
              requestParams: [
                ctx.adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "HLS 导入任务 id。")
              ],
              responseParams: [
                p("Content-Type", "Response", "是", "string", "application/vnd.apple.mpegurl", "HLS playlist。"),
                p("body", "Response", "是", "string", "m3u8 文本", "重写后的 media playlist。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/admin/uploads/hls/<ASSET_ID>/preview.m3u8' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `HTTP/1.1 200 OK
Content-Type: application/vnd.apple.mpegurl; charset=utf-8

#EXTM3U
#EXTINF:6.000,
${ctx.baseUrl}/api/admin/uploads/hls/<ASSET_ID>/preview-segments/0`
            },
            {
              id: "admin-hls-preview-segment",
              method: "GET",
              path: "/api/admin/uploads/hls/:assetId/preview-segments/:index",
              title: "读取 HLS 预览 Segment",
              auth: "Admin Cookie",
              summary: "返回已导入的 HLS segment 文件流。",
              functionality: "从 Telegram 读取指定 segment，支持 Range，用于 HLS 播放器预览。",
              useCases: ["video/hls.js 播放预览 playlist。"],
              limits: ["segment 必须已导入完成。", "index 必须在 segment_count 范围内。"],
              specialHandling: ["不强制下载，Content-Disposition 为 inline。", "分片存储的 segment 会继续转到 chunk 读取逻辑。"],
              requestParams: [
                ctx.adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "导入任务 id。"),
                p("index", "Path", "是", "number", "0 <= index < segment_count", "segment 序号。"),
                p("Range", "Header", "否", "string", "bytes=start-end", "媒体拖动时使用。")
              ],
              responseParams: [
                p("Content-Type", "Response", "是", "string", "video/mp2t 或源 MIME", "segment 媒体流。"),
                p("Content-Length", "Response", "条件", "number", "字节", "响应大小。"),
                p("Content-Range", "Response", "条件", "string", "Range 时返回", "范围信息。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/admin/uploads/hls/<ASSET_ID>/preview-segments/0' \\
  -H 'Cookie: admin_session=...' \\
  -o seg-0.ts`,
              responseExample: `HTTP/1.1 200 OK
Content-Type: video/mp2t
Content-Length: 5242880`
            },
            {
              id: "admin-hls-segment-import",
              method: "POST",
              path: "/api/admin/uploads/hls/:assetId/segments/:index/import",
              title: "导入 HLS Segment",
              auth: "Admin Cookie",
              summary: "导入一个 HLS segment；小 segment 直接存 Telegram，大 segment 会创建内部分片。",
              functionality: "下载源 segment，必要时解密 AES-128，再上传到 Telegram。",
              useCases: ["按 segment 顺序导入 HLS 视频。", "失败 segment 重试。"],
              limits: ["asset 必须处于可变状态。", "加密 segment 解密后最大支持单分片大小。"],
              specialHandling: ["超过单分片大小的普通 segment 会进入 telegram_multipart。", "返回 missing_chunks 时需继续调用 chunks/import。"],
              requestParams: [
                ctx.adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "导入任务 id。"),
                p("index", "Path", "是", "number", "segment 序号", "要导入的 segment。")
              ],
              responseParams: [
                ctx.okResponse,
                p("segment", "Response", "是", "HlsSegment", "segment 对象", "最新 segment 状态。"),
                p("uploaded_chunks", "Response", "是", "number[]", "已上传 chunk", "大 segment 的已上传分片。"),
                p("missing_chunks", "Response", "是", "number[]", "缺失 chunk", "大 segment 还需导入的分片。")
              ],
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/uploads/hls/<ASSET_ID>/segments/0/import' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "segment": { "segment_index": 0, "status": "done", "storage_backend": "telegram_single" },
  "uploaded_chunks": [],
  "missing_chunks": []
}`
            },
            {
              id: "admin-hls-segment-chunk-import",
              method: "POST",
              path: "/api/admin/uploads/hls/:assetId/segments/:index/chunks/:chunkIndex/import",
              title: "导入 HLS Segment 分片",
              auth: "Admin Cookie",
              summary: "导入大 HLS segment 的指定内部 chunk。",
              functionality: "对已经创建 multipart_upload_id 的 segment，按 chunkIndex 拉取源 Range 并上传 Telegram。",
              useCases: ["大 segment 分片导入。", "重试缺失 HLS segment chunk。"],
              limits: ["segment 必须是 multipart 导入状态。", "chunkIndex 必须在 segment.chunk_count 范围内。"],
              specialHandling: ["返回 missing_chunks 为空后再调用 segment complete。"],
              requestParams: [
                ctx.adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "导入任务 id。"),
                p("index", "Path", "是", "number", "segment 序号", "segment index。"),
                p("chunkIndex", "Path", "是", "number", "chunk 序号", "segment 内部分片序号。")
              ],
              responseParams: [
                ctx.okResponse,
                p("segment", "Response", "是", "HlsSegment", "segment 对象", "最新 segment 状态。"),
                p("uploaded_chunks", "Response", "是", "number[]", "已上传 chunk", "已完成分片。"),
                p("missing_chunks", "Response", "是", "number[]", "缺失 chunk", "未完成分片。")
              ],
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/uploads/hls/<ASSET_ID>/segments/1/chunks/0/import' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "segment": { "segment_index": 1, "status": "importing", "storage_backend": "telegram_multipart", "chunk_count": 3 },
  "uploaded_chunks": [0],
  "missing_chunks": [1, 2]
}`
            },
            {
              id: "admin-hls-segment-complete",
              method: "POST",
              path: "/api/admin/uploads/hls/:assetId/segments/:index/complete",
              title: "完成 HLS Segment 分片导入",
              auth: "Admin Cookie",
              summary: "把大 segment 的内部 multipart 状态标记为完成。",
              functionality: "校验 segment 的所有内部 chunk 已存在，然后把 segment 状态更新为 done。",
              useCases: ["大 segment 所有 chunks/import 完成后提交。"],
              limits: ["缺少任意内部 chunk 会返回 UploadIncomplete。"],
              specialHandling: ["仅用于大 segment；普通 telegram_single segment 不需要调用。"],
              requestParams: [
                ctx.adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "导入任务 id。"),
                p("index", "Path", "是", "number", "segment 序号", "segment index。")
              ],
              responseParams: [
                ctx.okResponse,
                p("segment", "Response", "是", "HlsSegment", "segment 对象", "完成后的 segment。"),
                p("uploaded_chunks", "Response", "是", "number[]", "全部 chunk", "已完成分片。"),
                p("missing_chunks", "Response", "是", "number[]", "空数组", "应为空。")
              ],
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/uploads/hls/<ASSET_ID>/segments/1/complete' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "segment": { "segment_index": 1, "status": "done", "storage_backend": "telegram_multipart", "chunk_count": 3 },
  "uploaded_chunks": [0, 1, 2],
  "missing_chunks": []
}`
            },
            {
              id: "admin-hls-complete",
              method: "POST",
              path: "/api/admin/uploads/hls/:assetId/complete",
              title: "完成 HLS 导入",
              auth: "Admin Cookie",
              summary: "把所有已导入 segment 组装为最终 HLS package 文件记录。",
              functionality: "校验全部 segment 完成，写入 files 表，生成 /api/hls 签名访问路径。",
              useCases: ["HLS 导入全部完成后出现在文件列表。", "可选上传视频封面缩略图。"],
              limits: ["全部 segment 必须 done。", "缩略图最大 512KB，类型限 JPEG/PNG/WebP。"],
              specialHandling: ["最终文件 storage_backend=hls_package。", "整包 download=1 支持 TS 或 fMP4 顺序合并，直链能力按总大小上限判断。"],
              requestParams: [
                ctx.adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "导入任务 id。"),
                p("on_conflict", "Query/Body/FormData", "否", "string", "error / overwrite", "同名处理。"),
                p("thumbnail", "FormData", "否", "File", "<=512KB", "缩略图文件。"),
                p("thumbnail_width", "FormData", "否", "number", "1-8192", "缩略图宽度。"),
                p("thumbnail_height", "FormData", "否", "number", "1-8192", "缩略图高度。")
              ],
              responseParams: ctx.fileResponseFields,
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/uploads/hls/<ASSET_ID>/complete' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "file": {
    "id": "hls-id",
    "file_name": "movie.m3u8",
    "storage_backend": "hls_package",
    "file_path": "/api/hls/<token>/movie.m3u8",
    "download_strategy": "direct_or_accelerated"
  }
}`
            },
            {
              id: "admin-hls-cancel",
              method: "DELETE",
              path: "/api/admin/uploads/hls/:assetId",
              title: "取消并清理 HLS 导入",
              auth: "Admin Cookie",
              summary: "删除 HLS 临时任务数据。",
              functionality: "清理 HLS asset、segment 和相关临时分片记录。",
              useCases: ["用户取消导入。", "清理失败任务。"],
              limits: ["assetId 必须存在或可清理。"],
              specialHandling: ["返回 cleanup 摘要。", "已上传到 Telegram 的原始文件不会被删除。"],
              requestParams: [
                ctx.adminCookie,
                p("assetId", "Path", "是", "string", "HLS asset id", "导入任务 id。")
              ],
              responseParams: [
                ctx.okResponse,
                p("cleanup", "Response", "是", "object", "清理摘要", "被清理的临时记录数量。")
              ],
              requestExample: `curl -X DELETE '${ctx.baseUrl}/api/admin/uploads/hls/<ASSET_ID>' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "cleanup": { "assets": 1, "segments": 120, "chunks": 0 }
}`
            }
          ]
        },
        {
          id: "admin-settings",
          title: "API Key 与 Telegram 通道",
          description: "外部访问密钥和 Telegram 存储通道的管理接口。",
          endpoints: [
            {
              id: "admin-api-keys-list",
              method: "GET",
              path: "/api/admin/api-keys",
              title: "列出 API Keys",
              auth: "Admin Cookie",
              summary: "返回所有未删除 API Key，列表只包含 masked_key。",
              functionality: "读取 api_keys 表并隐藏明文 key。",
              useCases: ["设置页展示外部客户端密钥。"],
              limits: ["只返回未软删除记录。"],
              specialHandling: ["列表永不返回 key 明文。", "需要明文时调用 GET /api/admin/api-keys/:id。"],
              requestParams: [ctx.adminCookie],
              responseParams: [
                ctx.okResponse,
                p("api_keys", "Response", "是", "array<ApiKeyItem>", "列表", "API Key 列表。"),
                p("api_keys[].masked_key", "Response", "是", "string", "脱敏", "可展示的密钥摘要。"),
                p("api_keys[].status", "Response", "是", "string", "active / disabled", "是否可用于外部接口。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/admin/api-keys' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "api_keys": [
    { "id": "key-id", "name": "backup-client", "masked_key": "tgf_1234••••abcd", "status": "active", "last_used_at": null }
  ]
}`
            },
            {
              id: "admin-api-keys-create",
              method: "POST",
              path: "/api/admin/api-keys",
              title: "创建 API Key",
              auth: "Admin Cookie",
              summary: "创建外部客户端 API Key，并在本次响应返回明文。",
              functionality: "生成 tgf_ 前缀随机密钥，明文存储到数据库。",
              useCases: ["为备份脚本、CLI 或第三方服务创建独立密钥。"],
              limits: ["name 必须 1-80 字符。"],
              specialHandling: ["只有创建响应和显式 reveal 会返回 key 明文。", "数据库泄露时 API Key 会直接暴露，这是当前项目的已知权衡。"],
              requestParams: [
                ctx.adminCookie,
                p("name", "Body", "是", "string", "1-80 字符", "密钥名称。")
              ],
              responseParams: [
                ctx.okResponse,
                p("api_key", "Response", "是", "ApiKeyItem", "含 key 明文", "创建后的密钥。"),
                p("api_key.key", "Response", "是", "string", "tgf_ 前缀", "明文 API Key，仅此时需要立即复制保存。")
              ],
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/api-keys' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "name": "backup-client" }'`,
              responseExample: `{
  "ok": true,
  "api_key": {
    "id": "key-id",
    "name": "backup-client",
    "key": "tgf_plaintext_key",
    "masked_key": "tgf_plai••••_key",
    "status": "active"
  }
}`
            },
            {
              id: "admin-api-keys-reveal",
              method: "GET",
              path: "/api/admin/api-keys/:id",
              title: "显式查看明文 API Key",
              auth: "Admin Cookie",
              summary: "返回指定 API Key 的明文。",
              functionality: "按 id 读取未删除密钥，并包含 key 字段。",
              useCases: ["用户重新复制已有密钥。"],
              limits: ["id 必须存在且未删除。"],
              specialHandling: ["前端 reveal 操作应有明确用户动作。", "响应包含敏感明文，不应写入日志。"],
              requestParams: [
                ctx.adminCookie,
                p("id", "Path", "是", "string", "API Key id", "密钥记录 id。")
              ],
              responseParams: [
                ctx.okResponse,
                p("api_key", "Response", "是", "ApiKeyItem", "含 key 明文", "密钥详情。"),
                p("api_key.key", "Response", "是", "string", "明文", "可用于 Authorization Bearer。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/admin/api-keys/<KEY_ID>' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "api_key": { "id": "key-id", "name": "backup-client", "key": "tgf_plaintext_key", "status": "active" }
}`
            },
            {
              id: "admin-api-keys-update",
              method: "PATCH",
              path: "/api/admin/api-keys/:id",
              title: "重命名或启停 API Key",
              auth: "Admin Cookie",
              summary: "更新 API Key 名称或状态。",
              functionality: "PATCH name/status 字段并更新时间。",
              useCases: ["禁用泄露或停用客户端密钥。", "重命名密钥用途。"],
              limits: ["name 可选但必须 1-80 字符。", "status 只能是 active 或 disabled。"],
              specialHandling: ["禁用后外部接口会返回 Unauthorized。", "响应不包含 key 明文。"],
              requestParams: [
                ctx.adminCookie,
                p("id", "Path", "是", "string", "API Key id", "密钥记录 id。"),
                p("name", "Body", "否", "string", "1-80 字符", "新名称。"),
                p("status", "Body", "否", "string", "active / disabled", "新状态。")
              ],
              responseParams: [
                ctx.okResponse,
                p("api_key", "Response", "否", "ApiKeyItem", "不含 key", "更新后的密钥。")
              ],
              requestExample: `curl -X PATCH '${ctx.baseUrl}/api/admin/api-keys/<KEY_ID>' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "name": "backup-client", "status": "disabled" }'`,
              responseExample: `{
  "ok": true,
  "api_key": { "id": "key-id", "name": "backup-client", "masked_key": "tgf_1234••••abcd", "status": "disabled" }
}`
            },
            {
              id: "admin-api-keys-delete",
              method: "DELETE",
              path: "/api/admin/api-keys/:id",
              title: "删除 API Key",
              auth: "Admin Cookie",
              summary: "软删除外部客户端密钥。",
              functionality: "设置 deleted_at，之后 Bearer 鉴权不会再匹配该 key。",
              useCases: ["撤销不再使用的脚本密钥。"],
              limits: ["id 必须存在且未删除。"],
              specialHandling: ["删除不可恢复。", "不会删除由该 key 已上传的文件。"],
              requestParams: [
                ctx.adminCookie,
                p("id", "Path", "是", "string", "API Key id", "密钥记录 id。")
              ],
              responseParams: [ctx.okResponse],
              requestExample: `curl -X DELETE '${ctx.baseUrl}/api/admin/api-keys/<KEY_ID>' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{ "ok": true }`
            },
            {
              id: "admin-telegram-channels-list",
              method: "GET",
              path: "/api/admin/telegram-channels",
              title: "列出 Telegram 通道",
              auth: "Admin Cookie",
              summary: "返回可用于存储文件的 Telegram 通道配置。",
              functionality: "读取通道记录并返回脱敏 bot token、chat_id、状态和默认通道标记。",
              useCases: ["设置页管理多个 Telegram 存储通道。", "检查默认通道是否配置。"],
              limits: ["只返回配置摘要，不返回 bot token 明文。"],
              specialHandling: ["default 通道可能来自环境变量回退。", "configured=false 表示还不能用于上传。"],
              requestParams: [ctx.adminCookie],
              responseParams: [
                ctx.okResponse,
                p("channels", "Response", "是", "array<TelegramChannelItem>", "通道列表", "每个通道含 id、name、chat_id、masked_bot_token、status、is_default、configured。")
              ],
              requestExample: `curl '${ctx.baseUrl}/api/admin/telegram-channels' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{
  "ok": true,
  "channels": [
    { "id": "default", "name": "default", "masked_bot_token": "123456:••••test", "chat_id": "-100123", "status": "active", "is_default": true, "configured": true }
  ]
}`
            },
            {
              id: "admin-telegram-channels-create",
              method: "POST",
              path: "/api/admin/telegram-channels",
              title: "创建 Telegram 通道",
              auth: "Admin Cookie",
              summary: "新增一个 Telegram bot token + chat_id 存储通道。",
              functionality: "校验名称、bot token 格式、chat_id 和唯一性，bot token 加密后保存。",
              useCases: ["扩展上传通道以分散 Telegram 限流。"],
              limits: ["name 必须 1-80 字符。", "bot_token 必须匹配 Telegram bot token 格式。", "chat_id 最长 128 字符。"],
              specialHandling: ["名称唯一；bot token + chat_id 组合唯一。", "status 默认为 active。"],
              requestParams: [
                ctx.adminCookie,
                p("name", "Body", "是", "string", "1-80 字符", "通道名称。"),
                p("bot_token", "Body", "是", "string", "Telegram bot token", "用于上传文件的 Bot Token。"),
                p("chat_id", "Body", "是", "string", "最长 128 字符", "Telegram 私有频道或群 chat id。"),
                p("status", "Body", "否", "string", "active / disabled", "通道状态。")
              ],
              responseParams: [
                ctx.okResponse,
                p("channel", "Response", "是", "TelegramChannelItem | null", "脱敏", "创建后的通道摘要。")
              ],
              requestExample: `curl -X POST '${ctx.baseUrl}/api/admin/telegram-channels' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "name": "backup-1", "bot_token": "123456:telegram-token", "chat_id": "-1001234567890", "status": "active" }'`,
              responseExample: `{
  "ok": true,
  "channel": { "id": "channel-id", "name": "backup-1", "masked_bot_token": "123456:••••oken", "chat_id": "-1001234567890", "status": "active", "configured": true }
}`
            },
            {
              id: "admin-telegram-channels-update",
              method: "PATCH",
              path: "/api/admin/telegram-channels/:id",
              title: "更新 Telegram 通道",
              auth: "Admin Cookie",
              summary: "修改通道名称、bot token、chat_id 或状态。",
              functionality: "合并现有配置并重新校验唯一性，必要时重新加密 bot token。",
              useCases: ["替换 Bot Token。", "禁用某个上传通道。", "调整 chat_id。"],
              limits: ["default 通道名称固定为 default。", "status 只能 active 或 disabled。"],
              specialHandling: ["如果通道缺少 bot token，保存前必须补齐。", "响应只返回 masked_bot_token。"],
              requestParams: [
                ctx.adminCookie,
                p("id", "Path", "是", "string", "通道 id", "Telegram 通道记录 id。"),
                p("name", "Body", "否", "string", "1-80 字符", "新名称；default 通道忽略。"),
                p("bot_token", "Body", "否", "string", "Telegram bot token", "新 Bot Token。"),
                p("chat_id", "Body", "否", "string", "最长 128 字符", "新 chat id。"),
                p("status", "Body", "否", "string", "active / disabled", "新状态。")
              ],
              responseParams: [
                ctx.okResponse,
                p("channel", "Response", "是", "TelegramChannelItem", "脱敏", "更新后的通道。")
              ],
              requestExample: `curl -X PATCH '${ctx.baseUrl}/api/admin/telegram-channels/<CHANNEL_ID>' \\
  -H 'Cookie: admin_session=...' \\
  -H 'Content-Type: application/json' \\
  -d '{ "status": "disabled" }'`,
              responseExample: `{
  "ok": true,
  "channel": { "id": "channel-id", "name": "backup-1", "status": "disabled", "configured": true }
}`
            },
            {
              id: "admin-telegram-channels-delete",
              method: "DELETE",
              path: "/api/admin/telegram-channels/:id",
              title: "删除 Telegram 通道",
              auth: "Admin Cookie",
              summary: "删除未被引用的非默认 Telegram 通道。",
              functionality: "检查 files/chunks 引用后删除通道配置。",
              useCases: ["移除不再使用的上传通道。"],
              limits: ["default 通道不能删除。", "仍被文件或分片引用的通道不能删除。"],
              specialHandling: ["引用冲突返回 TelegramChannelInUse，并带 files/chunks 计数。"],
              requestParams: [
                ctx.adminCookie,
                p("id", "Path", "是", "string", "通道 id", "Telegram 通道记录 id。")
              ],
              responseParams: [ctx.okResponse],
              requestExample: `curl -X DELETE '${ctx.baseUrl}/api/admin/telegram-channels/<CHANNEL_ID>' \\
  -H 'Cookie: admin_session=...'`,
              responseExample: `{ "ok": true }`
            }
          ]
        }
      ]
  };
}
