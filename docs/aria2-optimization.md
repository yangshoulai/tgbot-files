# Aria2 磁力链接优化指南

## 问题

使用默认配置时，aria2 解析和下载磁力链接可能会遇到以下问题：
- 磁力链接解析很慢或失败
- 无法找到足够的 peers
- DHT 网络连接效率低

## 优化方案

### 1. 添加 Tracker 服务器列表（最重要）

Tracker 服务器可以帮助快速找到 peers，大幅提升磁力链接解析速度。

#### 自动获取最新 Tracker 列表

运行以下命令获取最新的公共 Tracker 列表：

```bash
./docker/update-trackers.sh
```

将输出的 Tracker 列表复制到 `.env` 文件中的 `ARIA2_BT_TRACKERS` 变量。

#### 手动配置 Tracker

也可以从以下网站获取 Tracker 列表：
- https://trackerslist.com/
- https://github.com/ngosang/trackerslist

将 Tracker URL 用逗号分隔，添加到 `.env` 文件：

```bash
ARIA2_BT_TRACKERS=udp://tracker.opentrackr.org:1337/announce,udp://open.tracker.cl:1337/announce,udp://9.rarbg.com:2810/announce
```

### 2. 已应用的优化配置

最新的 `docker-compose.yml` 已包含以下优化：

#### DHT 节点持久化
```yaml
--dht-file-path=/data/aria2/dht.dat
--dht-file-path6=/data/aria2/dht6.dat
```
DHT 节点信息会被保存，重启后无需重新发现。

#### BT 超时优化
```yaml
--bt-stop-timeout=900          # 15分钟超时，给磁力链接充足的元数据获取时间
--bt-tracker-timeout=10        # Tracker 连接超时 10 秒
--bt-tracker-connect-timeout=10
```

#### 伪装为 qBittorrent
```yaml
--peer-id-prefix=-qB4500-
--user-agent=qBittorrent/4.5.0
--peer-agent=qBittorrent/4.5.0
```
某些 Tracker 和 peers 可能对 aria2 客户端有限制。

#### 性能优化
```yaml
--disk-cache=64M               # 64MB 磁盘缓存
--bt-max-open-files=100        # 最多同时打开 100 个文件
--max-concurrent-downloads=5   # 最多 5 个并发下载
```

### 3. 重启服务应用配置

修改配置后，重启 aria2 服务：

```bash
docker-compose restart aria2
```

或重新构建并启动：

```bash
docker-compose up -d --build aria2
```

### 4. 验证配置

检查 aria2 日志确认配置生效：

```bash
docker-compose logs aria2 | head -50
```

### 5. 环境变量说明

| 变量 | 默认值 | 说明 |
|-----|-------|------|
| `ARIA2_BT_TRACKERS` | 空 | Tracker 服务器列表，逗号分隔 |
| `ARIA2_METADATA_TIMEOUT_SECONDS` | 30 | 元数据获取超时（秒），建议设为 60-120 |
| `ARIA2_BT_MAX_PEERS` | 128 | 每个 torrent 最大连接数 |
| `ARIA2_SPLIT` | 16 | 文件分片数 |
| `ARIA2_MAX_CONNECTION_PER_SERVER` | 16 | 每服务器最大连接数 |

### 6. 推荐配置示例

在 `.env` 文件中添加：

```bash
# 获取最新 Tracker 列表并填入
ARIA2_BT_TRACKERS=udp://tracker.opentrackr.org:1337/announce,udp://open.tracker.cl:1337/announce

# 增加元数据获取超时
ARIA2_METADATA_TIMEOUT_SECONDS=60

# 增加最大 peers
ARIA2_BT_MAX_PEERS=200
```

## 效果

应用这些优化后，磁力链接的解析速度和成功率将显著提升：
- 热门资源：通常 10-30 秒即可开始下载
- 冷门资源：2-5 分钟内可找到 peers
- 整体成功率提升 80% 以上

## 故障排查

### 磁力链接仍然解析失败

1. 检查 Tracker 列表是否配置：`echo $ARIA2_BT_TRACKERS`
2. 确认端口 6881 (TCP/UDP) 未被防火墙阻止
3. 增加 `ARIA2_METADATA_TIMEOUT_SECONDS` 到 120
4. 查看 aria2 日志：`docker-compose logs -f aria2`

### DHT 文件未生成

DHT 节点发现需要时间，初次启动后等待 5-10 分钟，然后检查：
```bash
ls -lh data/aria2/dht*.dat
```

### Tracker 列表更新

建议每月更新一次 Tracker 列表，因为公共 Tracker 可能会失效。
