# API

## 通用约定

- Base URL：`https://<worker-domain>`
- 编码：UTF-8
- CORS：支持跨域（预检`OPTIONS`会返回允许头）；但部分接口仍会做来源域名白名单校验。

### 来源域名白名单

`/log`、`/total`、`/page-stats`会校验请求的`Origin`（优先）或`Referer`的origin是否在白名单内。

- 白名单来自D1的`config`表：`key = 'allowed_domains'`
- 值为JSON数组，例如：`["https://yourblog.com","http://localhost:4321"]`
- 允许任意来源可设为：`["*"]`

白名单不通过时返回：

```json
{ "error": "Origin not allowed" }
```

HTTP状态码：`403`

### Path规范化

所有带`path`参数的接口都会做规范化：

- 既支持pathname：`/posts/hello-world`
- 也支持完整URL：`https://example.com/posts/hello-world?x=1`
- 自动补齐前导`/`
- 除根路径`/`外，会移除尾部`/`，避免同一页面统计口径分裂

### 文章页路径判定

`/page-stats`仅允许文章页路径；`/log`只有在文章页路径时才会增量写入`page_stats`。

当前版本代码的判定流程是：

1、先对`path`参数做规范化（`normalizePagePath(input)`）：

- `input`既可以是pathname，也可以是完整URL
- 会提取pathname，补齐前导`/`
- 非根路径会去掉尾部 `/`

2、再对规范化后的pathname做正则严格匹配（`isPostPagePath(pagePath)`）：

- `^/post/[A-Za-z0-9_-]+$`
- `^/posts/[A-Za-z0-9_-]+$`
- `^/xxxx/[A-Za-z0-9_-]+$`

## 接口列表

### 1、记录访问（像素埋点）

`GET /log?path=<pathname|url>`

用途：记录一次访问。

行为：

- 写入`visits`（明细表，后续会被定时清理）
- 增量更新全站永久累计：`global_stats`/`unique_visitors`
- 如果是文章页路径：增量更新`page_stats`

Query 参数：

- `path`（必填）：页面路径或完整URL

响应：

- Content-Type：`image/gif`
- Body：1x1透明GIF
- Cache-Control：`no-store`

常见错误：

- `403`：来源域名不在白名单
- `500`：服务端异常

示例：

```text
https://<worker-domain>/log?path=/posts/hello-world
https://<worker-domain>/log?path=https%3A%2F%2Fyourblog.com%2Fposts%2Fhello-world%2F
```

### 2、查询文章累计PV（并带回全站累计）

`GET /page-stats?path=<pathname|url>`

用途：获取单篇文章累计PV（永久口径），并附带全站累计PV/UV（永久口径）。

限制：

- 仅允许文章页路径（见“文章页路径判定”）

Query参数：

- `path`（必填）：文章路径或完整URL

成功响应（200）：

```json
{
  "path": "/posts/hello-world",
  "articleTotal": 10,
  "articleLastUpdated": 1700000000000,
  "siteTotal": 1234,
  "siteUnique": 456,
  "siteLastUpdated": 1700000000000
}
```

字段说明：

- `path`：规范化后的文章路径
- `articleTotal`：该文章累计PV（来自`page_stats`）
- `articleLastUpdated`：文章累计最后更新时间（毫秒时间戳）
- `siteTotal`：全站累计PV（来自`global_stats`）
- `siteUnique`：全站累计UV（来自`global_stats/unique_visitors`）
- `siteLastUpdated`：全站累计最后更新时间（毫秒时间戳）

常见错误：

- `400`：`path`非文章页路径

```json
{ "error": "Invalid path" }
```

- `403`：来源域名不在白名单
- `405`：非GET
- `500`：服务端异常

示例：

```text
https://<worker-domain>/page-stats?path=/post/abc123
https://<worker-domain>/page-stats?path=/posts/hello-world/
```

### 3、查询全站累计PV/UV（带60秒缓存）

`GET /total`

用途：获取全站累计PV/UV（永久口径）。

响应（200）：

```json
{
  "siteTotal": 1234,
  "siteUnique": 456,
  "siteLastUpdated": 1700000000000
}
```

缓存：

- 返回头：`Cache-Control: public, max-age=60`
- Worker边缘也会使用`caches.default`做60秒复用，降低D1压力

常见错误：

- `403`：来源域名不在白名单
- `405`：非GET
- `500`：服务端异常

### 4、实时统计查询（需要API Key）

`GET /stats?period=today|all[&path=<pathname|url>]`

用途：实时统计（基于`visits`表COUNT），适合后台/管理页。

口径说明：

- 统计基于`visits`表

鉴权：

Header必须包含：

```text
Authorization: Bearer <API_KEY>
```

Query 参数：

- `period`：
  - `today`：统计从“本地时间当天00:00”到现在
  - `all`：统计`visits`表内的全部数据（仍受90天清理影响）
- `path`（可选）：指定页面路径或完整URL（会做规范化）

响应（200）：

```json
{
  "total": 12,
  "unique": 7,
  "period": "today",
  "path": "/posts/hello-world"
}
```

其中`path`字段仅在传入`path`查询参数时出现。

常见错误：

- `401`：未授权

```json
{ "error": "Unauthorized" }
```

- `500`：服务端异常

示例：

```text
GET /stats?period=today
GET /stats?period=all
GET /stats?period=today&path=/posts/hello-world
```

### 5、健康检查

`GET /health`

响应（200）：

```json
{ "status": "ok" }
```

### 6、默认响应

未匹配到以上路由时返回：

- HTTP 200
- Body：`Visitor Stats Worker`
