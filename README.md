# visitor-stats

基于Cloudflare Workers+D1 Database的访问统计服务。

支持：

- 全站 PV / UV（永久累计 + 实时统计）
- 文章页 PV / UV（永久累计）

## AI部分

部分冲突代码的解决和注释使用AI完成，其余部分为手动编写。

## 部署

纯网页部署流程：

1、创建D1 Database

创建好后粘贴[DB.sql](./DB.sql)，执行run all。

如果是老数据库升级到文章 UV 版本，需要额外执行迁移：

```sql
ALTER TABLE page_stats ADD COLUMN total_unique_visitors INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS page_unique_visitors (
  page_path TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (page_path, ip_hash)
);
CREATE INDEX IF NOT EXISTS idx_page_unique_visitors_path ON page_unique_visitors(page_path);
CREATE INDEX IF NOT EXISTS idx_page_unique_visitors_first_seen ON page_unique_visitors(first_seen);
```

2、创建Worker

创建时关联数据库，绑定变量`DB`。然后部署好后修改代码为[`index.js`](./index.js)。

3、配置变量

`SALT`：随遍写，数字+英文
`API_KEY`：随便写，数字+英文

4、设置定时清理

`0 0 * * *`每天凌晨1点执行，清理前一天的访问数据。

5、配置域名

worker给的域名`workers.dev`不一定能访问，最好使用自己的域名。

## 完成

访问`/health`，返回`{ "status": "ok" }`表示部署成功。调用接口查看[API](./API.md)。
