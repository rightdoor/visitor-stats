export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS预检
    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    // 路由
    if (path === '/log') {
      // 记录访问：需要验证来源域名（防止被他站滥刷）
      return handleLog(request, env);
    } else if (path === '/page-stats') {
      // 单页统计（文章页）：需要验证来源域名
      return handlePageStats(request, env);
    } else if (path === '/total') {
      // 全站统计：需要验证来源域名；返回带缓存头
      return handleTotal(request, env, ctx);
    } else if (path === '/stats') {
      // 实时统计：需要验证API Key（适合管理端，不建议公开）
      return handleStats(request, env);
    } else if (path === '/health') {
      // 健康检查
      return new Response(JSON.stringify({ status: 'ok' }), { headers: corsHeaders });
    } else {
      return new Response('Visitor Stats Worker', { status: 200 });
    }
  },

  // 定时任务：清理旧数据（由Cron Trigger触发）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupOldData(env));
  }
};

// --- CORS / 鉴权 / 路径 ---
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Origin, X-Requested-With, Accept'
};

function handleCors() {
  return new Response(null, { headers: corsHeaders });
}

// 校验来源域名是否允许
async function validateOrigin(request, env) {
  // 优先Origin，其次Referer
  const origin = request.headers.get('Origin') || new URL(request.headers.get('Referer') || 'http://error.error').origin;
  try {
    const result = await env.DB.prepare("SELECT value FROM config WHERE key = 'allowed_domains'").first();
    const allowedDomains = JSON.parse(result?.value || '[]');
    return allowedDomains.includes(origin) || allowedDomains.includes('*');
  } catch (e) {
    console.error(e);
    return false;
  }
}

// 校验API Key
function validateApiKey(request, env) {
  const authHeader = request.headers.get('Authorization');
  return authHeader && authHeader === `Bearer ${env.API_KEY}`;
}

// 哈希IP
async function hashIP(ip, salt) {
  const msgUint8 = new TextEncoder().encode(ip + salt);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

function normalizePagePath(input) {
  // 统一pathname：补齐前导 /；非根路径去尾 /
  if (!input) return '/';
  let p = String(input);
  try {
    p = new URL(p, 'http://error.local').pathname;
  } catch {
  }

  if (!p.startsWith('/')) p = `/${p}`;
  if (p !== '/') p = p.replace(/\/+$/, '');
  return p || '/';
}

function isPostPagePath(pagePath) {
  return typeof pagePath === 'string' && (/^\/post\/[A-Za-z0-9_-]+$/.test(pagePath) || /^\/posts\/[A-Za-z0-9_-]+$/.test(pagePath));
}

// --- 路由处理 ---

// 1、处理访问记录(/log)
async function handleLog(request, env) {
  // 校验白名单
  if (!(await validateOrigin(request, env))) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { 
        status: 403, 
        // 出错也返回 CORS
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });
  }

  try {
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const userAgent = request.headers.get('User-Agent') || '';
    const referer = request.headers.get('Referer') || '';
    const country = request.headers.get('CF-IPCountry') || '';
    // 客户端建议传window.location.pathname；服务端会做normalize
    const rawPath = new URL(request.url).searchParams.get('path') || '/';
    const pagePath = normalizePagePath(rawPath);

    const hashedIP = await hashIP(ip, env.SALT);

    const now = Date.now();

    await env.DB.prepare(
      'INSERT INTO visits (visit_time, page_path, ip_hash, user_agent, referer, country) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(now, pagePath, hashedIP, userAgent.substring(0, 1000), referer.substring(0, 500), country).run();

    const uniqueInsert = await env.DB.prepare(
      'INSERT OR IGNORE INTO unique_visitors (ip_hash, first_seen) VALUES (?, ?)'
    ).bind(hashedIP, now).run();

    const uniqueInc = uniqueInsert?.meta?.changes ? 1 : 0;
    await env.DB.prepare(
      'UPDATE global_stats SET total_visits = total_visits + 1, total_unique_visitors = total_unique_visitors + ?, last_updated = ? WHERE id = 1'
    ).bind(uniqueInc, now).run();

    if (isPostPagePath(pagePath)) {
      await env.DB.prepare(
        `INSERT INTO page_stats (page_path, total_visits, last_updated)
         VALUES (?, 1, ?)
         ON CONFLICT(page_path) DO UPDATE SET
           total_visits = total_visits + 1,
           last_updated = excluded.last_updated`
      ).bind(pagePath, now).run();
    }

    // 返回1x1透明GIF
    const gifBase64 = 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
    return new Response(Uint8Array.from(atob(gifBase64), c => c.charCodeAt(0)), {
      headers: { ...corsHeaders, 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

// 2、文章页统计查询(/page-stats)
async function handlePageStats(request, env) {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  if (!(await validateOrigin(request, env))) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    const { searchParams } = new URL(request.url);
    const rawPath = searchParams.get('path') || '';
    const pagePath = normalizePagePath(rawPath);

    if (!isPostPagePath(pagePath)) {
      return new Response(JSON.stringify({ error: 'Invalid path' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const pageResult = await env.DB.prepare(
      'SELECT page_path, total_visits, last_updated FROM page_stats WHERE page_path = ?'
    ).bind(pagePath).first();

    const siteResult = await env.DB.prepare(
      'SELECT total_visits, total_unique_visitors, last_updated FROM global_stats WHERE id = 1'
    ).first();

    return new Response(
      JSON.stringify({
        path: pagePath,
        articleTotal: pageResult?.total_visits || 0,
        articleLastUpdated: pageResult?.last_updated || null,
        siteTotal: siteResult?.total_visits || 0,
        siteUnique: siteResult?.total_unique_visitors || 0,
        siteLastUpdated: siteResult?.last_updated || null
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// 3、全站累计（/total，带缓存）
async function handleTotal(request, env, ctx) {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  if (!(await validateOrigin(request, env))) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // 60s缓存
  const ttlSeconds = 60;
  const cacheKey = new Request(new URL('/total', request.url).toString(), request);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const siteResult = await env.DB.prepare(
      'SELECT total_visits, total_unique_visitors, last_updated FROM global_stats WHERE id = 1'
    ).first();

    const response = new Response(
      JSON.stringify({
        siteTotal: siteResult?.total_visits || 0,
        siteUnique: siteResult?.total_unique_visitors || 0,
        siteLastUpdated: siteResult?.last_updated || null
      }),
      {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${ttlSeconds}`
        }
      }
    );

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// 4、实时统计（/stats，基于visits）
async function handleStats(request, env) {
  // 校验 API Key
  if (!validateApiKey(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') || 'today';
    const pagePath = searchParams.get('path') ? normalizePagePath(searchParams.get('path')) : undefined;
    let stats;

    if (period === 'all') {
      const result = pagePath
        ? await env.DB.prepare(
            `SELECT 
              COUNT(*) as total_visits,
              COUNT(DISTINCT ip_hash) as unique_visitors
             FROM visits
             WHERE page_path = ?`
          ).bind(pagePath).first()
        : await env.DB.prepare(`
            SELECT 
              COUNT(*) as total_visits,
              COUNT(DISTINCT ip_hash) as unique_visitors
            FROM visits
          `).first();
      
      stats = { 
        total: result?.total_visits || 0, 
        unique: result?.unique_visitors || 0,
        ...(pagePath ? { path: pagePath, period: 'all' } : {})
      };
    } else {
      const startOfDay = new Date().setHours(0, 0, 0, 0);
      const result = pagePath
        ? await env.DB.prepare(
            `SELECT 
              COUNT(*) as total_visits,
              COUNT(DISTINCT ip_hash) as unique_visitors
             FROM visits 
             WHERE visit_time > ? AND page_path = ?`
          ).bind(startOfDay, pagePath).first()
        : await env.DB.prepare(`
            SELECT 
              COUNT(*) as total_visits,
              COUNT(DISTINCT ip_hash) as unique_visitors
            FROM visits 
            WHERE visit_time > ?
          `).bind(startOfDay).first();
      
      stats = { 
        total: result?.total_visits || 0, 
        unique: result?.unique_visitors || 0, 
        period: 'today',
        ...(pagePath ? { path: pagePath } : {})
      };
    }

    return new Response(JSON.stringify(stats), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

async function cleanupOldData(env) {
  // 仅清理visits
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const cutoffTime = Date.now() - ninetyDaysMs;
  await env.DB.prepare('DELETE FROM visits WHERE visit_time < ?').bind(cutoffTime).run();
}
