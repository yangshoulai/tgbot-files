export function renderLoginPage(params: { hasError: boolean }): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>管理员登录 - tgbot-files</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #20252b;
      --muted: #69717c;
      --line: #d8ddd8;
      --paper: #fbfcf8;
      --panel: #ffffff;
      --accent: #0e766f;
      --accent-strong: #0a514c;
      --danger: #b42318;
      --shadow: 0 24px 80px rgba(24, 34, 42, 0.13);
    }

    * { box-sizing: border-box; }

    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      background:
        linear-gradient(90deg, rgba(32,37,43,0.045) 1px, transparent 1px),
        linear-gradient(0deg, rgba(32,37,43,0.04) 1px, transparent 1px),
        var(--paper);
      background-size: 36px 36px;
      color: var(--ink);
      font-family: "Avenir Next", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }

    main {
      width: min(420px, calc(100vw - 32px));
      padding: 34px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.92);
      box-shadow: var(--shadow);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 28px;
    }

    .mark {
      width: 36px;
      height: 36px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      background: var(--ink);
      color: #fff;
      font-weight: 800;
      letter-spacing: 0;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.2;
      letter-spacing: 0;
    }

    p {
      margin: 5px 0 0;
      color: var(--muted);
      font-size: 14px;
    }

    label {
      display: block;
      margin: 18px 0 7px;
      color: #363d44;
      font-size: 13px;
      font-weight: 700;
    }

    input {
      width: 100%;
      height: 44px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 13px;
      color: var(--ink);
      background: #fff;
      font: inherit;
      outline: none;
    }

    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(14, 118, 111, 0.14);
    }

    button {
      width: 100%;
      height: 44px;
      margin-top: 24px;
      border: 0;
      border-radius: 8px;
      background: var(--accent);
      color: #fff;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
    }

    button:hover { background: var(--accent-strong); }

    .error {
      margin-top: 18px;
      padding: 11px 12px;
      border: 1px solid rgba(180, 35, 24, 0.25);
      border-radius: 8px;
      background: rgba(180, 35, 24, 0.08);
      color: var(--danger);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <main>
    <div class="brand">
      <div class="mark">TF</div>
      <div>
        <h1>文件管理后台</h1>
        <p>登录后管理 Telegram 文件索引</p>
      </div>
    </div>
    <form method="post" action="/api/admin/login">
      <label for="username">管理员用户名</label>
      <input id="username" name="username" autocomplete="username" required autofocus>
      <label for="password">管理员密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">登录</button>
    </form>
    ${params.hasError ? '<div class="error">用户名或密码不正确，请重新输入。</div>' : ""}
  </main>
</body>
</html>`;
}

export function renderAdminPage(params: { maxFileBytes: number; username: string }): string {
  const config = escapeScriptJson(
    JSON.stringify({
      maxFileBytes: params.maxFileBytes,
      username: params.username
    })
  );

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>文件管理后台 - tgbot-files</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #20252b;
      --muted: #68717c;
      --soft: #8b949e;
      --paper: #f6f8f3;
      --panel: #ffffff;
      --line: #d9dfda;
      --line-strong: #bfc8c0;
      --accent: #0e766f;
      --accent-strong: #0a514c;
      --warning: #b56a00;
      --danger: #b42318;
      --danger-soft: #fff1ef;
      --code: #24313a;
      --shadow: 0 18px 52px rgba(30, 37, 43, 0.1);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background:
        linear-gradient(90deg, rgba(32,37,43,0.035) 1px, transparent 1px),
        linear-gradient(0deg, rgba(32,37,43,0.03) 1px, transparent 1px),
        var(--paper);
      background-size: 40px 40px;
      font-family: "Avenir Next", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }

    button, input {
      font: inherit;
    }

    a {
      color: inherit;
      text-decoration: none;
    }

    .shell {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 24px 0 42px;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 18px 0 22px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 13px;
      min-width: 0;
    }

    .mark {
      width: 40px;
      height: 40px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      background: var(--ink);
      color: #fff;
      font-weight: 900;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.15;
      letter-spacing: 0;
    }

    .subtitle {
      margin-top: 4px;
      color: var(--muted);
      font-size: 13px;
    }

    .account {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }

    .layout {
      display: grid;
      grid-template-columns: 310px minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }

    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.92);
      box-shadow: var(--shadow);
    }

    .upload-panel {
      position: sticky;
      top: 18px;
      padding: 18px;
    }

    .panel-title {
      margin: 0 0 4px;
      font-size: 15px;
      line-height: 1.3;
    }

    .panel-note {
      margin: 0 0 16px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }

    .dropzone {
      position: relative;
      display: grid;
      gap: 10px;
      place-items: center;
      min-height: 164px;
      padding: 22px;
      border: 1px dashed var(--line-strong);
      border-radius: 8px;
      background: #fbfcf8;
      text-align: center;
      transition: border-color 0.18s ease, background 0.18s ease;
    }

    .dropzone.is-dragging {
      border-color: var(--accent);
      background: rgba(14, 118, 111, 0.08);
    }

    .upload-glyph {
      width: 46px;
      height: 46px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      background: var(--ink);
      color: #fff;
      font-size: 22px;
      font-weight: 900;
    }

    .dropzone input {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
    }

    .dropzone strong {
      display: block;
      font-size: 15px;
    }

    .dropzone span {
      color: var(--muted);
      font-size: 12px;
    }

    .selected-file {
      min-height: 38px;
      margin: 12px 0;
      padding: 10px 11px;
      border-radius: 8px;
      background: #f0f4ef;
      color: var(--code);
      font-size: 12px;
      line-height: 1.4;
      word-break: break-all;
    }

    .toolbar {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) auto auto;
      gap: 10px;
      padding: 14px;
      align-items: center;
    }

    .search {
      position: relative;
    }

    .search input {
      width: 100%;
      height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 13px 0 36px;
      color: var(--ink);
      background: #fff;
      outline: none;
    }

    .search input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(14, 118, 111, 0.12);
    }

    .search::before {
      content: "";
      position: absolute;
      left: 13px;
      top: 50%;
      width: 12px;
      height: 12px;
      border: 2px solid var(--soft);
      border-radius: 50%;
      transform: translateY(-50%);
    }

    .search::after {
      content: "";
      position: absolute;
      left: 25px;
      top: 25px;
      width: 7px;
      height: 2px;
      background: var(--soft);
      transform: rotate(45deg);
    }

    .segmented {
      display: flex;
      gap: 3px;
      padding: 3px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #f1f4ef;
    }

    .icon-button,
    .text-button {
      height: 34px;
      border: 1px solid transparent;
      border-radius: 7px;
      background: transparent;
      color: var(--ink);
      cursor: pointer;
    }

    .icon-button {
      width: 34px;
      display: grid;
      place-items: center;
      font-weight: 800;
    }

    .text-button {
      padding: 0 12px;
      font-size: 13px;
      font-weight: 700;
    }

    .icon-button:hover,
    .text-button:hover {
      border-color: var(--line-strong);
      background: #fff;
    }

    .icon-button.is-active {
      background: #fff;
      border-color: var(--line-strong);
      color: var(--accent-strong);
      box-shadow: 0 2px 8px rgba(30, 37, 43, 0.08);
    }

    .primary-button {
      width: 100%;
      height: 40px;
      border: 0;
      border-radius: 8px;
      background: var(--accent);
      color: #fff;
      font-weight: 800;
      cursor: pointer;
    }

    .primary-button:hover {
      background: var(--accent-strong);
    }

    .primary-button:disabled,
    .text-button:disabled,
    .icon-button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .danger-button {
      color: var(--danger);
    }

    .content {
      min-height: 540px;
      overflow: hidden;
    }

    .summary {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 0 14px 12px;
      color: var(--muted);
      font-size: 12px;
    }

    .table-wrap {
      overflow-x: auto;
      border-top: 1px solid var(--line);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 820px;
    }

    th {
      padding: 11px 14px;
      color: var(--muted);
      background: #f4f6f1;
      font-size: 12px;
      font-weight: 800;
      text-align: left;
      border-bottom: 1px solid var(--line);
    }

    td {
      padding: 13px 14px;
      border-bottom: 1px solid var(--line);
      vertical-align: middle;
      font-size: 13px;
    }

    tr:hover td {
      background: #fbfcf8;
    }

    .file-main {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .file-icon {
      width: 34px;
      height: 34px;
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #f2f5f1;
      color: var(--accent-strong);
      font-size: 12px;
      font-weight: 900;
    }

    .file-name {
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 800;
    }

    .file-meta {
      margin-top: 3px;
      color: var(--muted);
      font-size: 12px;
    }

    .mono {
      color: var(--code);
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      justify-content: flex-end;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
      gap: 12px;
      padding: 14px;
      border-top: 1px solid var(--line);
    }

    .file-card {
      min-height: 202px;
      display: flex;
      flex-direction: column;
      gap: 13px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }

    .file-card:hover {
      border-color: var(--line-strong);
      box-shadow: 0 14px 34px rgba(30, 37, 43, 0.09);
    }

    .file-card .file-name {
      max-width: none;
      white-space: normal;
      overflow-wrap: anywhere;
      line-height: 1.35;
    }

    .card-spacer {
      flex: 1;
    }

    .empty,
    .loading {
      min-height: 320px;
      display: grid;
      place-items: center;
      color: var(--muted);
      text-align: center;
      padding: 32px;
    }

    .pagination {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 10px;
      padding: 13px 14px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 13px;
    }

    .toast {
      position: fixed;
      left: 50%;
      bottom: 22px;
      z-index: 20;
      min-width: min(360px, calc(100vw - 32px));
      padding: 12px 14px;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      background: #fff;
      color: var(--ink);
      box-shadow: var(--shadow);
      transform: translate(-50%, 120%);
      opacity: 0;
      transition: transform 0.2s ease, opacity 0.2s ease;
    }

    .toast.is-visible {
      transform: translate(-50%, 0);
      opacity: 1;
    }

    @media (max-width: 860px) {
      .shell {
        width: min(100vw - 20px, 720px);
        padding-top: 14px;
      }

      .topbar {
        align-items: flex-start;
        flex-direction: column;
      }

      .layout {
        grid-template-columns: 1fr;
      }

      .upload-panel {
        position: static;
      }

      .toolbar {
        grid-template-columns: 1fr;
      }

      .summary {
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="mark">TF</div>
        <div>
          <h1>文件管理后台</h1>
          <div class="subtitle">检索、上传和维护 Telegram 文件索引</div>
        </div>
      </div>
      <div class="account">
        <span id="accountName"></span>
        <button class="text-button" id="logoutButton" type="button">退出</button>
      </div>
    </header>

    <div class="layout">
      <aside class="panel upload-panel">
        <h2 class="panel-title">上传文件</h2>
        <p class="panel-note">文件会发送到 Telegram 存储聊天，后台只保存 D1 元数据。单文件上限 <strong id="maxSizeLabel"></strong>。</p>
        <form id="uploadForm">
          <label class="dropzone" id="dropzone">
            <input id="fileInput" name="file" type="file" required>
            <span class="upload-glyph">+</span>
            <span>
              <strong>选择或拖入文件</strong>
              <span>上传后自动写入索引</span>
            </span>
          </label>
          <div class="selected-file" id="selectedFile">尚未选择文件</div>
          <button class="primary-button" id="uploadButton" type="submit">上传</button>
        </form>
      </aside>

      <main class="panel content">
        <div class="toolbar">
          <label class="search">
            <input id="searchInput" type="search" placeholder="搜索文件名、类型、MD5 或 file_id">
          </label>
          <div class="segmented" aria-label="展示方式">
            <button class="icon-button" id="listViewButton" type="button" title="列表视图" aria-label="列表视图">☰</button>
            <button class="icon-button" id="gridViewButton" type="button" title="网格视图" aria-label="网格视图">▦</button>
          </div>
          <button class="text-button" id="refreshButton" type="button">刷新</button>
        </div>
        <div class="summary">
          <span id="resultSummary">正在读取文件索引</span>
          <span id="storageSummary"></span>
        </div>
        <section id="fileContainer" aria-live="polite">
          <div class="loading">正在加载...</div>
        </section>
        <div class="pagination">
          <button class="text-button" id="prevButton" type="button">上一页</button>
          <span id="pageLabel">第 1 页</span>
          <button class="text-button" id="nextButton" type="button">下一页</button>
        </div>
      </main>
    </div>
  </div>
  <div class="toast" id="toast"></div>

  <script>
    window.__APP_CONFIG__ = ${config};
  </script>
  <script>
    const config = window.__APP_CONFIG__;
    const state = {
      q: "",
      page: 1,
      limit: 24,
      total: 0,
      view: localStorage.getItem("tgbot-files:view") || "list",
      files: []
    };

    const elements = {
      accountName: document.getElementById("accountName"),
      maxSizeLabel: document.getElementById("maxSizeLabel"),
      uploadForm: document.getElementById("uploadForm"),
      uploadButton: document.getElementById("uploadButton"),
      fileInput: document.getElementById("fileInput"),
      selectedFile: document.getElementById("selectedFile"),
      dropzone: document.getElementById("dropzone"),
      searchInput: document.getElementById("searchInput"),
      listViewButton: document.getElementById("listViewButton"),
      gridViewButton: document.getElementById("gridViewButton"),
      refreshButton: document.getElementById("refreshButton"),
      resultSummary: document.getElementById("resultSummary"),
      storageSummary: document.getElementById("storageSummary"),
      fileContainer: document.getElementById("fileContainer"),
      prevButton: document.getElementById("prevButton"),
      nextButton: document.getElementById("nextButton"),
      pageLabel: document.getElementById("pageLabel"),
      logoutButton: document.getElementById("logoutButton"),
      toast: document.getElementById("toast")
    };

    let searchTimer;
    let toastTimer;

    elements.accountName.textContent = config.username;
    elements.maxSizeLabel.textContent = formatBytes(config.maxFileBytes);
    syncViewButtons();
    bindEvents();
    loadFiles();

    function bindEvents() {
      elements.searchInput.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          state.q = elements.searchInput.value.trim();
          state.page = 1;
          loadFiles();
        }, 220);
      });

      elements.listViewButton.addEventListener("click", () => setView("list"));
      elements.gridViewButton.addEventListener("click", () => setView("grid"));
      elements.refreshButton.addEventListener("click", () => loadFiles());
      elements.prevButton.addEventListener("click", () => {
        if (state.page > 1) {
          state.page -= 1;
          loadFiles();
        }
      });
      elements.nextButton.addEventListener("click", () => {
        if (state.page < totalPages()) {
          state.page += 1;
          loadFiles();
        }
      });

      elements.fileInput.addEventListener("change", updateSelectedFile);
      elements.uploadForm.addEventListener("submit", uploadSelectedFile);
      elements.logoutButton.addEventListener("click", logout);

      ["dragenter", "dragover"].forEach((eventName) => {
        elements.dropzone.addEventListener(eventName, (event) => {
          event.preventDefault();
          elements.dropzone.classList.add("is-dragging");
        });
      });
      ["dragleave", "drop"].forEach((eventName) => {
        elements.dropzone.addEventListener(eventName, (event) => {
          event.preventDefault();
          elements.dropzone.classList.remove("is-dragging");
        });
      });
      elements.dropzone.addEventListener("drop", (event) => {
        const file = event.dataTransfer && event.dataTransfer.files[0];
        if (!file) return;
        const transfer = new DataTransfer();
        transfer.items.add(file);
        elements.fileInput.files = transfer.files;
        updateSelectedFile();
      });
    }

    async function loadFiles() {
      elements.fileContainer.innerHTML = '<div class="loading">正在加载...</div>';
      const params = new URLSearchParams({
        q: state.q,
        page: String(state.page),
        limit: String(state.limit)
      });

      try {
        const response = await fetch("/api/admin/files?" + params.toString());
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.message || "读取文件列表失败");

        state.files = body.files;
        state.total = body.pagination.total;
        renderFiles();
      } catch (error) {
        elements.fileContainer.innerHTML = '<div class="empty">读取失败，请稍后重试。</div>';
        showToast(error.message || "读取失败");
      }
    }

    function renderFiles() {
      syncViewButtons();
      elements.resultSummary.textContent = state.q
        ? "找到 " + state.total + " 个匹配文件"
        : "共 " + state.total + " 个文件";
      elements.storageSummary.textContent = "当前页 " + formatBytes(sumCurrentPageBytes());
      elements.pageLabel.textContent = "第 " + state.page + " / " + totalPages() + " 页";
      elements.prevButton.disabled = state.page <= 1;
      elements.nextButton.disabled = state.page >= totalPages();

      if (state.files.length === 0) {
        elements.fileContainer.innerHTML = '<div class="empty">没有文件记录。</div>';
        return;
      }

      elements.fileContainer.innerHTML = state.view === "grid" ? renderGrid() : renderTable();
      elements.fileContainer.querySelectorAll("[data-action]").forEach((button) => {
        button.addEventListener("click", handleFileAction);
      });
    }

    function renderTable() {
      return '<div class="table-wrap"><table><thead><tr>' +
        '<th>文件</th><th>大小</th><th>MD5</th><th>上传时间</th><th></th>' +
        '</tr></thead><tbody>' +
        state.files.map((file) => '<tr>' +
          '<td>' + renderFileMain(file) + '</td>' +
          '<td>' + formatBytes(file.size) + '</td>' +
          '<td><span class="mono">' + escapeHtml(shorten(file.md5, 16)) + '</span></td>' +
          '<td>' + formatDate(file.created_at) + '</td>' +
          '<td><div class="actions">' + renderActions(file) + '</div></td>' +
        '</tr>').join("") +
        '</tbody></table></div>';
    }

    function renderGrid() {
      return '<div class="grid">' + state.files.map((file) =>
        '<article class="file-card">' +
          renderFileMain(file) +
          '<div class="mono">' + escapeHtml(shorten(file.md5, 18)) + '</div>' +
          '<div class="file-meta">' + formatDate(file.created_at) + '</div>' +
          '<div class="card-spacer"></div>' +
          '<div class="actions">' + renderActions(file) + '</div>' +
        '</article>'
      ).join("") + '</div>';
    }

    function renderFileMain(file) {
      return '<div class="file-main">' +
        '<div class="file-icon">' + fileBadge(file.mime_type) + '</div>' +
        '<div>' +
          '<div class="file-name" title="' + escapeHtml(file.file_name) + '">' + escapeHtml(file.file_name) + '</div>' +
          '<div class="file-meta">' + escapeHtml(file.mime_type) + ' · ' + formatBytes(file.size) + '</div>' +
        '</div>' +
      '</div>';
    }

    function renderActions(file) {
      return '<a class="text-button" href="' + escapeAttribute(file.url) + '" target="_blank" rel="noreferrer">打开</a>' +
        '<a class="text-button" href="' + escapeAttribute(file.download_url) + '">下载</a>' +
        '<button class="text-button" data-action="copy" data-id="' + escapeAttribute(file.id) + '" type="button">复制</button>' +
        '<button class="text-button danger-button" data-action="delete" data-id="' + escapeAttribute(file.id) + '" type="button">删除</button>';
    }

    async function handleFileAction(event) {
      const button = event.currentTarget;
      const file = state.files.find((item) => item.id === button.dataset.id);
      if (!file) return;

      if (button.dataset.action === "copy") {
        await navigator.clipboard.writeText(file.url);
        showToast("链接已复制");
        return;
      }

      if (button.dataset.action === "delete") {
        if (!confirm("只会从后台列表删除记录，不会删除 Telegram 中的文件。确定继续？")) return;
        await deleteFile(file.id);
      }
    }

    async function deleteFile(id) {
      try {
        const response = await fetch("/api/admin/files/" + encodeURIComponent(id), { method: "DELETE" });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.message || "删除失败");
        showToast("记录已删除");
        loadFiles();
      } catch (error) {
        showToast(error.message || "删除失败");
      }
    }

    async function uploadSelectedFile(event) {
      event.preventDefault();
      const file = elements.fileInput.files[0];
      if (!file) {
        showToast("请选择文件");
        return;
      }
      if (file.size > config.maxFileBytes) {
        showToast("文件超过 " + formatBytes(config.maxFileBytes));
        return;
      }

      const formData = new FormData();
      formData.set("file", file);
      elements.uploadButton.disabled = true;
      elements.uploadButton.textContent = "上传中...";

      try {
        const response = await fetch("/api/admin/files", { method: "POST", body: formData });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.message || "上传失败");
        elements.uploadForm.reset();
        updateSelectedFile();
        state.page = 1;
        showToast("上传完成");
        loadFiles();
      } catch (error) {
        showToast(error.message || "上传失败");
      } finally {
        elements.uploadButton.disabled = false;
        elements.uploadButton.textContent = "上传";
      }
    }

    async function logout() {
      await fetch("/api/admin/logout", { method: "POST" });
      location.href = "/login";
    }

    function updateSelectedFile() {
      const file = elements.fileInput.files[0];
      elements.selectedFile.textContent = file ? file.name + " · " + formatBytes(file.size) : "尚未选择文件";
    }

    function setView(view) {
      state.view = view;
      localStorage.setItem("tgbot-files:view", view);
      renderFiles();
    }

    function syncViewButtons() {
      elements.listViewButton.classList.toggle("is-active", state.view === "list");
      elements.gridViewButton.classList.toggle("is-active", state.view === "grid");
    }

    function totalPages() {
      return Math.max(1, Math.ceil(state.total / state.limit));
    }

    function sumCurrentPageBytes() {
      return state.files.reduce((sum, file) => sum + file.size, 0);
    }

    function showToast(message) {
      clearTimeout(toastTimer);
      elements.toast.textContent = message;
      elements.toast.classList.add("is-visible");
      toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2600);
    }

    function fileBadge(mimeType) {
      if (!mimeType) return "FILE";
      if (mimeType.startsWith("image/")) return "IMG";
      if (mimeType.startsWith("video/")) return "VID";
      if (mimeType.startsWith("audio/")) return "AUD";
      if (mimeType.includes("pdf")) return "PDF";
      if (mimeType.includes("zip") || mimeType.includes("archive")) return "ZIP";
      if (mimeType.startsWith("text/")) return "TXT";
      return "FILE";
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return "-";
      const units = ["B", "KB", "MB", "GB"];
      let value = bytes;
      let index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
      }
      return (index === 0 ? value.toFixed(0) : value.toFixed(1)) + " " + units[index];
    }

    function formatDate(value) {
      return new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date(value));
    }

    function shorten(value, length) {
      if (!value || value.length <= length) return value || "";
      return value.slice(0, length) + "...";
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function escapeAttribute(value) {
      return escapeHtml(value);
    }
  </script>
</body>
</html>`;
}

function escapeScriptJson(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}
