-- visits：每次访问一行
CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_time INTEGER NOT NULL,                 -- 访问时间戳（毫秒）
    page_path TEXT NOT NULL,                     -- 访问页面路径，如 '/posts/hello-world'
    ip_hash TEXT NOT NULL,                       -- 哈希后的 IP（SHA-256 前 16 位），用于去重
    user_agent TEXT,                             -- 用户代理
    referer TEXT,                                -- 来源页面
    country TEXT,                                -- 国家代码（从CF头部获取）
    created_at INTEGER DEFAULT (CAST(unixepoch() * 1000 AS INTEGER)) -- 记录创建时间
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_visits_time ON visits(visit_time);
CREATE INDEX IF NOT EXISTS idx_visits_path ON visits(page_path);
CREATE INDEX IF NOT EXISTS idx_visits_ip ON visits(ip_hash);

-- global_stats：全站永久累计（仅一行）
CREATE TABLE IF NOT EXISTS global_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),            -- 确保只有一行数据
    total_visits INTEGER NOT NULL DEFAULT 0,          -- 历史累计总访问量（昨日及之前）
    total_unique_visitors INTEGER NOT NULL DEFAULT 0, -- 历史累计独立访客数
    last_updated INTEGER NOT NULL                     -- 最后更新时间戳
);

-- 初始化
INSERT OR IGNORE INTO global_stats (id, total_visits, total_unique_visitors, last_updated) 
VALUES (1, 0, 0, 0);

-- unique_visitors：全站UV去重集合
CREATE TABLE IF NOT EXISTS unique_visitors (
    ip_hash TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unique_visitors_first_seen ON unique_visitors(first_seen);

-- page_stats：文章页累计PV（仅/posts/<slug>或/post/<id>）
CREATE TABLE IF NOT EXISTS page_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_path TEXT UNIQUE NOT NULL,              -- 页面路径
    total_visits INTEGER NOT NULL DEFAULT 0,     -- 该页面总访问次数
    last_updated INTEGER NOT NULL,               -- 最后更新时间
    created_at INTEGER DEFAULT (CAST(unixepoch() * 1000 AS INTEGER))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_page_stats_visits ON page_stats(total_visits DESC);
CREATE INDEX IF NOT EXISTS idx_page_stats_path ON page_stats(page_path);

-- config：配置
-- allowed_domains控制哪些站点可以调用/log、/page-stats、/total
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,                        -- 配置键名
    value TEXT NOT NULL,                         -- 配置值（通常为JSON）
    updated_at INTEGER DEFAULT (CAST(unixepoch() * 1000 AS INTEGER)),
    comment TEXT                                 -- 配置说明
);

-- 初始化
INSERT OR IGNORE INTO config (key, value, comment) VALUES 
('allowed_domains', '["https://your.com", "http://localhost:4321"]', '允许调用统计API的域名列表，请替换为你自己的域名');

-- v_daily_stats：基于visits的实时视图（受visits清理影响）
CREATE VIEW IF NOT EXISTS v_daily_stats AS
SELECT 
    date(visit_time / 1000, 'unixepoch') AS date,
    COUNT(*) AS total_visits,
    COUNT(DISTINCT ip_hash) AS unique_visitors
FROM visits
GROUP BY date
ORDER BY date DESC;
