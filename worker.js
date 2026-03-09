// EMBY-PROXY-UI V18.0 (SaaS UI Optimized - Ultimate Fix + Emby Auth Patch)
// 终极修复：彻底解决 POST 导致 WAF/Emby 报错，拔除所有视频节流冗余代码，无损 URL 穿透
// 补丁集成：Emby 授权头双向兼容、登录 API 补头、轻量 403 重试、协议 Fallback
// 数据面板升级：支持 Cloudflare Analytics 聚合、时间锥、以及全场景“资源类别”徽章解析

// ============================================================================
// 0. 全局配置与状态 (GLOBAL CONFIG & STATE)
// ============================================================================
const Config = {
  Defaults: {
    JwtExpiry: 60 * 60 * 24 * 30,  
    LoginLockDuration: 900,         
    MaxLoginAttempts: 5,            
    CacheTTL: 60000,                
    CryptoKeyCacheTTL: 86400,       
    CryptoKeyCacheMax: 100,         
    NodeCacheMax: 5000,             
    NodesReadConcurrency: 12,       
    CleanupBudgetMs: 1,             
    CleanupChunkSize: 64,           
    AssetHash: "v18.0",           
    Version: "18.0"                 
  }
};

const GLOBALS = {
  NodeCache: new Map(),
  ConfigCache: null,
  CryptoKeyCache: new Map(),
  NodesListCache: null,
  CleanupState: { phase: 0 },
  NodesIndexCache: null,
  LogQueue: [],
  LogDedupe: new Map(),
  RateLimitCache: new Map(),
  LogFlushPending: false,
  LogLastFlushAt: 0,
  Regex: {
    StaticExt: /\.(?:jpg|jpeg|gif|png|svg|ico|webp|js|css|woff2?|ttf|otf|map|webmanifest|json)$/i,
    SubtitleExt: /\.(?:srt|ass|vtt|sub)$/i,
    EmbyImages: /(?:\/Images\/|\/Icons\/|\/Branding\/|\/emby\/covers\/)/i,
    ManifestExt: /\.(?:m3u8|mpd)$/i,
    SegmentExt: /\.(?:ts|m4s)$/i,
    Streaming: /\.(?:mp4|m4v|m4a|ogv|webm|mkv|mov|avi|wmv|flv)$/i
  },
  SecurityHeaders: {
    "Referrer-Policy": "origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=15552000; preload",
    "X-Frame-Options": "SAMEORIGIN",
    "X-Content-Type-Options": "nosniff",
    "X-XSS-Protection": "1; mode=block"
  },
  DropRequestHeaders: new Set([
    "host", "x-real-ip", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded",
    "connection", "upgrade", "transfer-encoding", "te", "keep-alive",
    "proxy-authorization", "proxy-authenticate", "trailer", "expect"
  ]),
  DropResponseHeaders: new Set([
    "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "access-control-allow-credentials",
    "x-frame-options", "strict-transport-security", "x-content-type-options", "x-xss-protection", "referrer-policy",
    "x-powered-by", "server" 
  ])
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Emby-Authorization, X-Emby-Token, X-Emby-Client, X-Emby-Device-Id, X-Emby-Device-Name, X-Emby-Client-Version"
};

function mergeVaryHeader(headers, value) {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", value);
    return;
  }
  const parts = current.split(",").map(v => v.trim()).filter(Boolean);
  if (!parts.includes(value)) parts.push(value);
  headers.set("Vary", parts.join(", "));
}

function applySecurityHeaders(headers) {
  Object.entries(GLOBALS.SecurityHeaders).forEach(([k, v]) => headers.set(k, v));
  return headers;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function toGraphQLString(value) {
  return JSON.stringify(String(value ?? ""));
}

function toGraphQLStringArray(values) {
  return JSON.stringify((Array.isArray(values) ? values : []).map(value => String(value ?? "")));
}

function getCorsHeadersForResponse(env, request, originOverride = null) {
  const reqOrigin = request.headers.get("Origin");
  const reqHeaders = request.headers.get("Access-Control-Request-Headers") || corsHeaders["Access-Control-Allow-Headers"];
  const allowOrigin = originOverride || reqOrigin || corsHeaders["Access-Control-Allow-Origin"];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": corsHeaders["Access-Control-Allow-Methods"],
    "Access-Control-Allow-Headers": reqHeaders,
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, X-Emby-Auth-Token",
    "Access-Control-Max-Age": "86400"
  };
}

function safeDecodeSegment(segment = "") {
  if (!segment) return "";
  try { return decodeURIComponent(segment); } catch { return segment; }
}

function sanitizeProxyPath(path) {
  let raw = typeof path === "string" ? path : "/";
  if (!raw) return "/";
  if (!raw.startsWith("/")) raw = "/" + raw;
  raw = raw.replace(/^\/+/, "/");
  return raw;
}

function buildProxyPrefix(name, key) {
  const encodedName = encodeURIComponent(String(name || ""));
  if (!key) return "/" + encodedName;
  return "/" + encodedName + "/" + encodeURIComponent(String(key));
}

const DEFAULT_WANGPAN_DIRECT_TERMS = [
  "115.com", "anxia.com", "jianguoyun", "aliyundrive", "alipan", "aliyundrive.net", "alicloudccp", "myqcloud", "aliyuncs",
  "189.cn", "ctyun.cn", "baidu", "baidupcs", "123pan", "qiniudn", "qbox.me", "myhuaweicloud", "139.com",
  "quark", "yun.uc.cn", "r2.cloudflarestorage", "volces.com", "tos-s3"
];
const DEFAULT_WANGPAN_DIRECT_TEXT = DEFAULT_WANGPAN_DIRECT_TERMS.join(",");

function escapeRegexLiteral(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseKeywordTerms(raw = "") {
  return String(raw || "")
    .split(/[\n\r,，;；|]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function buildKeywordFuzzyRegex(raw = "", fallbackTerms = []) {
  const baseTerms = parseKeywordTerms(raw);
  const fallbackList = Array.isArray(fallbackTerms) ? fallbackTerms : parseKeywordTerms(String(fallbackTerms || ""));
  const mergedTerms = baseTerms.length ? baseTerms : fallbackList;
  if (!mergedTerms.length) return null;
  try {
    return new RegExp(mergedTerms.map(escapeRegexLiteral).join("|"), "i");
  } catch {
    return null;
  }
}

function getWangpanDirectText(raw = "") {
  const terms = parseKeywordTerms(raw);
  return (terms.length ? terms : DEFAULT_WANGPAN_DIRECT_TERMS).join(",");
}

function shouldDirectByWangpan(targetUrl, customKeywords = "") {
  let haystack = "";
  try {
    const url = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl));
    haystack = `${url.hostname} ${url.href}`;
  } catch {
    haystack = String(targetUrl || "");
  }
  const matchRegex = buildKeywordFuzzyRegex(customKeywords, DEFAULT_WANGPAN_DIRECT_TERMS);
  return !!matchRegex && matchRegex.test(haystack);
}

function normalizeNodeNameList(input) {
  const rawList = Array.isArray(input)
    ? input
    : String(input || "").split(/[\\r\\n,，;；|]+/);
  const seen = new Set();
  const result = [];
  for (const item of rawList) {
    const value = String(item || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function isNodeDirectSourceEnabled(node, currentConfig = null) {
  const configuredDirectNodes = normalizeNodeNameList(currentConfig?.sourceDirectNodes ?? currentConfig?.directSourceNodes ?? currentConfig?.nodeDirectList ?? []);
  const nodeName = String(node?.name || "").trim();
  if (nodeName && configuredDirectNodes.some(item => item.toLowerCase() === nodeName.toLowerCase())) return true;
  const proxyMode = String(node?.proxyMode || node?.mode || "").trim().toLowerCase();
  if (["direct", "source-direct", "origin-direct", "node-direct"].includes(proxyMode)) return true;
  if (node?.direct === true || node?.sourceDirect === true || node?.directSource === true || node?.direct2xx === true) return true;
  const explicitText = `${node?.tag || ""} ${node?.remark || ""}`;
  return /(?:^|[\s\[(【])(?:直连|source-direct|origin-direct|node-direct)(?:$|[\s\])】])/i.test(explicitText);
}

function resolveRedirectTarget(location, baseUrl) {
  if (!location) return null;
  try {
    return new URL(location, baseUrl instanceof URL ? baseUrl : String(baseUrl || ""));
  } catch {
    return null;
  }
}

function normalizeRedirectMethod(status, method = "GET") {
  const upperMethod = String(method || "GET").toUpperCase();
  if (status === 303 && upperMethod !== "GET" && upperMethod !== "HEAD") return "GET";
  if ((status === 301 || status === 302) && upperMethod === "POST") return "GET";
  return upperMethod;
}

const CF_DASH_CACHE_VERSION = 4;

function makeCfDashCacheKey(zoneId, dateKey = "") {
  const safeZoneId = encodeURIComponent(String(zoneId || "default").trim() || "default");
  const safeDateKey = encodeURIComponent(String(dateKey || "current").trim() || "current");
  return `sys:cf_dash_cache:${safeZoneId}:${safeDateKey}`;
}

function getVideoRequestWhereClause(column = "request_path") {
  return `(${column} LIKE '%/stream%' OR ${column} LIKE '%/master.m3u8%' OR ${column} LIKE '%/videos/%/original%' OR ${column} LIKE '%/videos/%/download%' OR ${column} LIKE '%/videos/%/file%' OR ${column} LIKE '%/items/%/download%' OR ${column} LIKE '%Static=true%' OR ${column} LIKE '%Download=true%')`;
}

function parseHostnameCandidate(rawHostname) {
  const host = String(rawHostname || "").trim().toLowerCase();
  if (!host) return null;
  const wildcard = host.includes("*");
  const cleaned = host.replace(/^\*\./, "").replace(/^\*+/, "").replace(/\*+$/g, "").replace(/^\.+|\.+$/g, "");
  if (!cleaned) return null;
  return { hostname: cleaned, wildcard };
}

function extractRouteHostnameInfo(pattern) {
  const rawPattern = String(pattern || "").trim();
  if (!rawPattern) return null;
  const slashIndex = rawPattern.indexOf("/");
  const rawHost = slashIndex === -1 ? rawPattern : rawPattern.slice(0, slashIndex);
  const path = slashIndex === -1 ? "" : rawPattern.slice(slashIndex);
  const parsed = parseHostnameCandidate(rawHost);
  if (!parsed) return null;
  return { ...parsed, path, pattern: rawPattern };
}

function scoreHostnameCandidate(hostname, options = {}) {
  const path = String(options.path || "");
  let score = 0;
  if (!options.wildcard) score += 100;
  if (hostname.includes(".workers.dev")) score -= 20;
  if (path === "/" || path === "/*") score += 20;
  else if (path.endsWith("*")) score += 10;
  else if (path) score += 4;
  score += hostname.split(".").length * 4;
  score -= Math.min(path.length, 30);
  return score;
}

async function fetchCloudflareApiJson(url, apiToken) {
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" }
  });
  if (!res.ok) throw new Error(`cf_api_http_${res.status}`);
  const payload = await res.json();
  if (payload?.success === false) {
    const msg = Array.isArray(payload?.errors) ? payload.errors.map(item => item?.message).filter(Boolean).join("; ") : "";
    throw new Error(msg || "cf_api_error");
  }
  return payload;
}

async function fetchCloudflareGraphQL(apiToken, query, variables) {
  const body = variables && typeof variables === "object"
    ? { query, variables }
    : { query };
  const cfRes = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!cfRes.ok) throw new Error(`cf_graphql_http_${cfRes.status}`);
  const cfData = await cfRes.json();
  if (Array.isArray(cfData?.errors) && cfData.errors.length) {
    throw new Error(cfData.errors.map(item => item?.message).filter(Boolean).join("; ") || "cf_graphql_error");
  }
  return cfData;
}

async function fetchCloudflareGraphQLZone(zoneId, apiToken, query, variables) {
  const cfData = await fetchCloudflareGraphQL(apiToken, query, variables);
  return cfData?.data?.viewer?.zones?.[0] || null;
}

async function fetchCloudflareGraphQLAccount(accountId, apiToken, query, variables) {
  const cfData = await fetchCloudflareGraphQL(apiToken, query, variables);
  return cfData?.data?.viewer?.accounts?.[0] || null;
}

async function fetchCloudflareZoneDetails(zoneId, apiToken) {
  if (!zoneId || !apiToken) return null;
  const payload = await fetchCloudflareApiJson(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(String(zoneId).trim())}`, apiToken);
  return payload?.result || null;
}

async function resolveCloudflareWorkerServices({ cfAccountId, cfZoneId, cfApiToken }) {
  const serviceNames = new Set();
  const pushName = (rawName) => {
    const name = String(rawName || "").trim();
    if (!name) return;
    serviceNames.add(name);
  };

  if (cfAccountId && cfZoneId) {
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(String(cfAccountId).trim())}/workers/domains?zone_id=${encodeURIComponent(String(cfZoneId).trim())}`;
      const payload = await fetchCloudflareApiJson(url, cfApiToken);
      for (const item of payload?.result || []) {
        pushName(item?.service || item?.script || item?.name);
      }
    } catch (e) {
      console.log("CF Workers domains service lookup failed", e);
    }
  }

  if (cfZoneId) {
    try {
      let page = 1;
      let totalPages = 1;
      do {
        const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(String(cfZoneId).trim())}/workers/routes?page=${page}&per_page=100`;
        const payload = await fetchCloudflareApiJson(url, cfApiToken);
        totalPages = Number(payload?.result_info?.total_pages || payload?.result_info?.totalPages || 1);
        for (const item of payload?.result || []) {
          pushName(item?.script || item?.service);
        }
        page += 1;
      } while (page <= totalPages && page <= 5);
    } catch (e) {
      console.log("CF Workers routes service lookup failed", e);
    }
  }

  return [...serviceNames];
}

async function fetchCloudflareWorkerUsageMetrics({ cfAccountId, cfZoneId, cfApiToken, startIso, endIso }) {
  if (!cfAccountId || !cfApiToken) return null;
  const serviceNames = await resolveCloudflareWorkerServices({ cfAccountId, cfZoneId, cfApiToken });
  if (!serviceNames.length) return null;

  const query = `
  query {
    viewer {
      accounts(filter: { accountTag: ${toGraphQLString(cfAccountId)} }) {
        workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: ${toGraphQLString(startIso)}, datetime_leq: ${toGraphQLString(endIso)}, scriptName_in: ${toGraphQLStringArray(serviceNames)} }) {
          dimensions { datetime scriptName status }
          sum { requests }
        }
      }
    }
  }`;

  const accountData = await fetchCloudflareGraphQLAccount(cfAccountId, cfApiToken, query);
  const records = Array.isArray(accountData?.workersInvocationsAdaptive) ? accountData.workersInvocationsAdaptive : [];
  const hourlySeries = Array.from({ length: 24 }, (_, hour) => ({ label: String(hour).padStart(2, "0") + ":00", total: 0 }));

  let totalRequests = 0;
  for (const item of records) {
    const req = Number(item?.sum?.requests) || 0;
    totalRequests += req;

    const dtRaw = item?.dimensions?.datetime;
    if (!dtRaw) continue;
    const dt = new Date(dtRaw);
    if (Number.isNaN(dt.getTime())) continue;
    const hour = (dt.getUTCHours() + 8) % 24;
    if (hourlySeries[hour]) hourlySeries[hour].total += req;
  }

  return { totalRequests, hourlySeries, serviceNames };
}

async function resolveCloudflareBoundHostname({ cfAccountId, cfZoneId, cfApiToken, zoneNameFallback = "" }) {
  const candidates = [];
  const pushCandidate = (rawHostname, options = {}) => {
    const parsed = parseHostnameCandidate(rawHostname);
    if (!parsed) return;
    const wildcard = options.wildcard === true || parsed.wildcard === true;
    candidates.push({
      hostname: parsed.hostname,
      path: String(options.path || ""),
      wildcard,
      score: scoreHostnameCandidate(parsed.hostname, { wildcard, path: options.path || "" })
    });
  };

  if (cfAccountId && cfZoneId) {
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(String(cfAccountId).trim())}/workers/domains?zone_id=${encodeURIComponent(String(cfZoneId).trim())}`;
      const payload = await fetchCloudflareApiJson(url, cfApiToken);
      for (const item of payload?.result || []) {
        pushCandidate(item?.hostname);
      }
    } catch (e) {
      console.log("CF Workers domains lookup failed, will try routes", e);
    }
  }

  if (!candidates.length && cfZoneId) {
    try {
      let page = 1;
      let totalPages = 1;
      do {
        const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(String(cfZoneId).trim())}/workers/routes?page=${page}&per_page=100`;
        const payload = await fetchCloudflareApiJson(url, cfApiToken);
        totalPages = Number(payload?.result_info?.total_pages || payload?.result_info?.totalPages || 1);
        for (const item of payload?.result || []) {
          const info = extractRouteHostnameInfo(item?.pattern);
          if (!info) continue;
          pushCandidate(info.hostname, { wildcard: info.wildcard, path: info.path });
        }
        page += 1;
      } while (page <= totalPages && page <= 5);
    } catch (e) {
      console.log("CF Workers routes lookup failed", e);
    }
  }

  if (candidates.length) {
    candidates.sort((a, b) => (b.score - a.score) || (a.hostname.length - b.hostname.length) || a.hostname.localeCompare(b.hostname));
    return candidates[0].hostname;
  }

  return zoneNameFallback || "未知域名 (请配置 CF 联动)";
}

function sanitizeRuntimeConfig(input = {}) {
  const config = input && typeof input === "object" ? { ...input } : {};
  const trimFields = ["tgBotToken", "tgChatId", "cfAccountId", "cfZoneId", "cfApiToken", "corsOrigins", "geoAllowlist", "geoBlocklist", "ipBlacklist", "wangpandirect"];
  for (const key of trimFields) {
    if (config[key] === undefined || config[key] === null) continue;
    config[key] = String(config[key]).trim();
  }
  if (Array.isArray(config.sourceDirectNodes)) config.sourceDirectNodes = normalizeNodeNameList(config.sourceDirectNodes);
  return config;
}

function classifyCloudflareAnalyticsError(message, options = {}) {
  const raw = String(message || "").trim();
  const lower = raw.toLowerCase();
  const zoneId = String(options.zoneId || "").trim();
  const result = {
    status: "CF 查询失败",
    hint: "Cloudflare 查询失败，请检查 Zone ID、API 令牌与资源范围",
    detail: raw || (zoneId ? `当前查询的 Zone ID: ${zoneId}` : "")
  };
  if (!raw) return result;
  if (lower.includes("unknown field") || lower.includes("unknown enum") || lower.includes("error parsing args")) {
    return {
      status: "Schema 不兼容",
      hint: "当前账号可用的 GraphQL schema 与脚本查询字段不一致",
      detail: raw
    };
  }
  if (lower.includes("cf_graphql_http_429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return {
      status: "请求过于频繁",
      hint: "Cloudflare GraphQL 已限流，请稍后再试",
      detail: raw
    };
  }
  if (lower.includes("invalid token") || lower.includes("authentication") || lower.includes("cf_graphql_http_401")) {
    return {
      status: "令牌无效",
      hint: "Cloudflare API 令牌无效，或未启用 GraphQL Analytics 访问",
      detail: raw
    };
  }
  if (lower.includes("not authorized") || lower.includes("permission") || lower.includes("forbidden") || lower.includes("unauthorized") || lower.includes("cf_graphql_http_403")) {
    return {
      status: "权限或范围不匹配",
      hint: "令牌权限不足，或 Account / Zone Resources 未覆盖当前查询",
      detail: raw + (zoneId ? ` | Zone ID: ${zoneId}` : "")
    };
  }
  if (lower.includes("zone") && (lower.includes("not found") || lower.includes("invalid") || lower.includes("unknown"))) {
    return {
      status: "Zone ID 无效",
      hint: "Zone ID 无效，或当前令牌无法访问这个 Zone",
      detail: raw + (zoneId ? ` | Zone ID: ${zoneId}` : "")
    };
  }
  if (lower.includes("cf_graphql_http_400")) {
    return {
      status: "请求参数无效",
      hint: "GraphQL 请求参数无效，请检查 Zone ID 与筛选条件",
      detail: raw + (zoneId ? ` | Zone ID: ${zoneId}` : "")
    };
  }
  return result;
}

async function getRuntimeConfig(env) {
  const kv = Auth.getKV(env);
  if (!kv) return {};
  const now = nowMs();
  if (GLOBALS.ConfigCache && GLOBALS.ConfigCache.exp > now && GLOBALS.ConfigCache.data) return GLOBALS.ConfigCache.data;
  let config = {};
  try { config = sanitizeRuntimeConfig(await kv.get(Database.CONFIG_KEY, { type: "json" }) || {}); } catch {}
  GLOBALS.ConfigCache = { data: config, exp: now + 60000 };
  return config;
}

function parseCookieHeader(cookieHeader) {
  const map = new Map();
  if (!cookieHeader || typeof cookieHeader !== "string") return map;
  for (const rawPart of cookieHeader.split(";")) {
    const part = rawPart.trim();
    if (!part) continue;
    const eqIndex = part.indexOf("=");
    const key = (eqIndex === -1 ? part : part.slice(0, eqIndex)).trim();
    const value = eqIndex === -1 ? "" : part.slice(eqIndex + 1).trim();
    if (!key) continue;
    map.set(key, value);
  }
  return map;
}

function serializeCookieMap(cookieMap) {
  const parts = [];
  for (const [key, value] of cookieMap.entries()) {
    parts.push(value === "" ? key : `${key}=${value}`);
  }
  return parts.join("; ");
}

function mergeAndSanitizeCookieHeaders(baseCookieHeader, extraCookieHeader, blockedCookieNames = ["auth_token"]) {
  const blocked = new Set(blockedCookieNames.map(name => String(name || "").trim().toLowerCase()).filter(Boolean));
  const merged = parseCookieHeader(baseCookieHeader);
  for (const key of [...merged.keys()]) {
    if (blocked.has(String(key).trim().toLowerCase())) merged.delete(key);
  }
  const extra = parseCookieHeader(extraCookieHeader);
  for (const [key, value] of extra.entries()) {
    if (blocked.has(String(key).trim().toLowerCase())) continue;
    merged.set(key, value);
  }
  const result = serializeCookieMap(merged);
  return result || null;
}

function jsonHeaders(extra = {}) {
  return { ...GLOBALS.SecurityHeaders, ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, max-age=0", ...extra };
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders(extraHeaders) });
}

function jsonError(code, message, status = 400, details = null, extraHeaders = {}) {
  const body = { ok: false, error: { code, message } };
  if (details !== null && details !== undefined) body.error.details = details;
  return jsonResponse(body, status, extraHeaders);
}

async function normalizeJsonApiResponse(response) {
  const headers = new Headers(response.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store, max-age=0");
  Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
  applySecurityHeaders(headers);
  if (response.ok) return new Response(response.body, { status: response.status, headers });
  let payload = null, fallbackText = "";
  try { payload = await response.clone().json(); } catch { fallbackText = await response.text().catch(() => ""); }
  const code = payload?.error?.code || (typeof payload?.error === "string" ? payload.error.toUpperCase() : `HTTP_${response.status}`);
  const message = payload?.error?.message || payload?.message || (typeof payload?.error === "string" ? payload.error : fallbackText || response.statusText || "request_failed");
  const details = payload?.error?.details ?? payload?.details ?? null;
  return jsonError(code, message, response.status || 500, details);
}

const nowMs = () => Date.now();

async function runWithConcurrency(items, limit, worker) {
  const results = [], executing = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => worker(item));
    results.push(p);
    if (limit <= items.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

// ============================================================================
// 1. 认证模块 (AUTH MODULE)
// ============================================================================
const Auth = {
  getKV(env) { return env.ENI_KV || env.KV || env.EMBY_KV || env.EMBY_PROXY; },
  async handleLogin(request, env) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const kv = this.getKV(env);
    
    const config = await getRuntimeConfig(env);
    const jwtDays = Math.max(1, parseInt(config.jwtExpiryDays) || 30);
    const expSeconds = jwtDays * 86400;
    
    const safeKVGet = async (key) => kv ? await kv.get(key).catch(e => null) : null;
    const safeKVPut = async (key, val, opts) => kv ? await kv.put(key, val, opts).catch(e => null) : null;
    const safeKVDelete = async (key) => kv ? await kv.delete(key).catch(e => null) : null;
    try {
      const failKey = `fail:${ip}`;
      const prev = await safeKVGet(failKey);
      const failCount = prev ? parseInt(prev) : 0;
      if (failCount >= Config.Defaults.MaxLoginAttempts) return jsonError("TOO_MANY_ATTEMPTS", "账户已锁定，请稍后再试", 429);
      let password = "";
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const body = await request.json();
        password = (body.password || "").trim();
      }
      if (!env.JWT_SECRET) return jsonError("SERVER_MISCONFIGURED", "JWT_SECRET 未配置", 503);
      if (!env.ADMIN_PASS) return jsonError("SERVER_MISCONFIGURED", "ADMIN_PASS 未配置", 503);
      if (password && password === env.ADMIN_PASS) {
        await safeKVDelete(failKey);
        const jwt = await this.generateJwt(env.JWT_SECRET, expSeconds);
        return jsonResponse({ ok: true, expiresIn: expSeconds }, 200, { "Set-Cookie": `auth_token=${jwt}; Path=/; Max-Age=${expSeconds}; HttpOnly; Secure; SameSite=Strict` });
      }
      await safeKVPut(failKey, (failCount + 1).toString(), { expirationTtl: Config.Defaults.LoginLockDuration });
      return jsonResponse({ ok: false, error: { code: "INVALID_PASSWORD", message: "密码错误" }, remain: Math.max(0, Config.Defaults.MaxLoginAttempts - (failCount + 1)) }, 401);
    } catch (e) {
      return jsonError("INVALID_REQUEST", "请求无效", 400, { reason: e.message });
    }
  },
  async verifyRequest(request, env) {
    try {
      const secret = env.JWT_SECRET;
      if (!secret) return false;
      const auth = request.headers.get("Authorization") || "";
      let token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token) {
        const match = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)auth_token=([^;]+)/);
        token = match ? match[1] : null;
      }
      if (!token) return false;
      return await this.verifyJwt(token, secret);
    } catch { return false; }
  },
  async generateJwt(secret, expiresIn) {
    const encHeader = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const encPayload = btoa(JSON.stringify({ sub: "admin", exp: Math.floor(Date.now() / 1000) + expiresIn })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const signature = await this.sign(secret, `${encHeader}.${encPayload}`);
    return `${encHeader}.${encPayload}.${signature}`;
  },
  async verifyJwt(token, secret) {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    if (parts[2] !== await this.sign(secret, `${parts[0]}.${parts[1]}`)) return false;
    try { return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))).exp > Math.floor(Date.now() / 1000); } catch { return false; }
  },
  async sign(secret, data) {
    const enc = new TextEncoder(), now = Date.now();
    let entry = GLOBALS.CryptoKeyCache.get(secret);
    if (!entry || entry.exp <= now) {
      const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      entry = { key, exp: now + Config.Defaults.CryptoKeyCacheTTL * 1000 };
      GLOBALS.CryptoKeyCache.set(secret, entry);
    }
    const signature = await crypto.subtle.sign("HMAC", entry.key, enc.encode(data));
    return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
};

// ============================================================================
// 2. 数据库与缓存模块 (DATABASE & CACHE MODULE)
// ============================================================================
const CacheManager = {
  async getNodesList(env, ctx) {
    if (GLOBALS.NodesListCache && GLOBALS.NodesListCache.exp > nowMs()) return GLOBALS.NodesListCache.data;
    const kv = Database.getKV(env);
    if (!kv) return [];
    let nodeNames = GLOBALS.NodesIndexCache?.exp > nowMs() ? GLOBALS.NodesIndexCache.data : null;
    if (!nodeNames) {
      try {
        nodeNames = await kv.get(Database.NODES_INDEX_KEY, { type: "json" });
        if (Array.isArray(nodeNames)) GLOBALS.NodesIndexCache = { data: nodeNames, exp: nowMs() + 60000 };
      } catch (e) {}
    }
    if (!nodeNames || !Array.isArray(nodeNames)) {
      try {
        const list = await kv.list({ prefix: "node:" });
        nodeNames = list.keys.map(k => k.name.replace("node:", ""));
        if (ctx && nodeNames.length > 0) ctx.waitUntil(kv.put(Database.NODES_INDEX_KEY, JSON.stringify(nodeNames)));
        GLOBALS.NodesIndexCache = { data: nodeNames, exp: nowMs() + 60000 };
      } catch (e) { return []; }
    }
    const nodes = await runWithConcurrency(nodeNames, Config.Defaults.NodesReadConcurrency, async (name) => {
      try {
        const cached = GLOBALS.NodeCache.get(name);
        let val = cached?.exp > nowMs() ? cached.data : null;
        if (!val) val = await kv.get(`${Database.PREFIX}${name}`, { type: "json" });
        if (!val) return null;
        const { data: normalized, changed } = Database.normalizeNode(name, val);
        if (changed && ctx) ctx.waitUntil(kv.put(`${Database.PREFIX}${name}`, JSON.stringify(normalized)));
        GLOBALS.NodeCache.set(name, { data: normalized, exp: nowMs() + Config.Defaults.CacheTTL });
        return { name, ...normalized };
      } catch { return null; }
    });
    const validNodes = nodes.filter(Boolean);
    GLOBALS.NodesListCache = { data: validNodes, exp: nowMs() + 60000 };
    return validNodes;
  },
  async invalidateList(ctx) { GLOBALS.NodesListCache = null; },
  maybeCleanup() {
    const budget = Config.Defaults.CleanupBudgetMs;
    const chunkSize = Config.Defaults.CleanupChunkSize;
    const state = GLOBALS.CleanupState;
    const now = nowMs();
    const start = now;
    const cleanMap = (map, shouldDelete) => {
      let count = 0;
      for (const [k, v] of map) {
        if (nowMs() - start >= budget) break;
        if (shouldDelete(v, now)) map.delete(k);
        if (++count >= chunkSize) break;
      }
    };
    if (state.phase === 0) {
      cleanMap(GLOBALS.NodeCache, v => v?.exp && v.exp < now);
      state.phase = 1;
    } else if (state.phase === 1) {
      cleanMap(GLOBALS.CryptoKeyCache, v => v?.exp && v.exp < now);
      state.phase = 2;
    } else if (state.phase === 2) {
      cleanMap(GLOBALS.RateLimitCache, v => !v || v.resetAt < now);
      state.phase = 3;
    } else {
      cleanMap(GLOBALS.LogDedupe, v => !v || (now - v) > 300000);
      state.phase = 0;
    }
  }
};

const Database = {
  PREFIX: "node:", CONFIG_KEY: "sys:theme", NODES_INDEX_KEY: "sys:nodes_index:v1",
  getKV(env) { return Auth.getKV(env); },
  getDB(env) { return env.DB || env.D1 || env.PROXY_LOGS; },
  
  async sendDailyTelegramReport(env) {
      const db = this.getDB(env);
      const kv = this.getKV(env);
      if (!db || !kv) throw new Error("Database or KV not configured");

      const config = await kv.get(this.CONFIG_KEY, { type: "json" }) || {};
      const tgBotToken = String(config.tgBotToken || "").trim();
      const tgChatId = String(config.tgChatId || "").trim();
      const cfAccountId = String(config.cfAccountId || "").trim();
      const cfZoneId = String(config.cfZoneId || "").trim();
      const cfApiToken = String(config.cfApiToken || "").trim();
      if (!tgBotToken || !tgChatId) throw new Error("请先完善 Telegram Bot Token 和 Chat ID 配置");

      const now = new Date();
      const utc8Ms = now.getTime() + 8 * 3600 * 1000;
      const d = new Date(utc8Ms);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const todayStr = `${mm}-${dd}`;
      const dateString = `${yyyy}-${mm}-${dd}`;

      const startOfDayTs = Date.UTC(yyyy, d.getUTCMonth(), d.getUTCDate()) - 8 * 3600 * 1000;
      const endOfDayTs = startOfDayTs + 86400000 - 1;
      const videoWhereClause = getVideoRequestWhereClause();

      let reqTotal = 0, playCount = 0, infoCount = 0, totalAccMs = 0;
      let cfTrafficStatus = "未找到今日缓存 (需打开面板刷新)";
      let domainName = cfZoneId ? "Cloudflare (读取自缓存)" : "未接入 CF (读取自缓存)";

      try {
          const cacheKey = makeCfDashCacheKey(cfZoneId, dateString);
          const cached = await kv.get(cacheKey, { type: "json" });
          if (cached && cached.ver === CF_DASH_CACHE_VERSION) {
              reqTotal = Number(cached.todayRequests) || 0;
              cfTrafficStatus = cached.todayTraffic || "0 B";
              if (cfTrafficStatus === "未配置") cfTrafficStatus = "缓存暂无流量数据";
              playCount = cached.playCount || 0;
              infoCount = cached.infoCount || 0;
              totalAccMs = cached.totalAccMs || 0;
          }
      } catch (e) {
          cfTrafficStatus = "读取面板缓存异常";
          console.log("Read CF cache failed", e);
      }

      let reqStr = reqTotal.toString();
      if (reqTotal > 1000) reqStr = (reqTotal / 1000).toFixed(2) + "k";

      let accSecs = Math.floor(totalAccMs / 1000);
      let accHrs = Math.floor(accSecs / 3600);
      let accMins = Math.floor((accSecs % 3600) / 60);
      let accRemSecs = accSecs % 60;
      let accStr = `${accHrs}小时${accMins}分钟${accRemSecs}秒`;

      const msgText = `📊 Cloudflare Zone 每日报表 (UTC+8)\n域名: ${domainName}\n\n📅 今天 (${todayStr})\n请求数: ${reqStr}\n视频流量 (CF 总计): ${cfTrafficStatus}\n请求: 播放请求 ${playCount} 次 | 获取播放信息 ${infoCount} 次\n\n🚀 共加速时长: ${accStr}\n#Cloudflare #Emby #日报`;
      const tgUrl = `https://api.telegram.org/bot${tgBotToken}/sendMessage`;
      const res = await fetch(tgUrl, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({ chat_id: tgChatId, text: msgText })
      });
      const tgData = await res.json();
      if (!tgData.ok) throw new Error(tgData.description || "Telegram API 返回错误");
      return true;
  },

  sanitizeHeaders(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    const out = {};
    for (const [rawKey, rawValue] of Object.entries(input)) {
      const key = String(rawKey || "").trim();
      if (!key) continue;
      if (GLOBALS.DropRequestHeaders.has(key.toLowerCase())) continue;
      out[key] = String(rawValue ?? "");
    }
    return out;
  },
  normalizeTargets(targetValue) {
    const parts = String(targetValue || "").split(",").map(v => v.trim()).filter(Boolean);
    if (!parts.length) return null;
    const normalized = [];
    for (const part of parts) {
      try {
        const url = new URL(part);
        if (!["http:", "https:"].includes(url.protocol)) return null;
        normalized.push(url.toString().replace(/\/$/, ""));
      } catch {
        return null;
      }
    }
    return normalized.length ? normalized.join(",") : null;
  },
  normalizeNode(nodeName, data) {
    const n = { ...data };
    let changed = false;
    if (!n.target) { n.target = ""; changed = true; }
    if (n.secret === undefined) { n.secret = ""; changed = true; }
    if (n.tag === undefined) { n.tag = ""; changed = true; }
    if (n.remark === undefined) { n.remark = ""; changed = true; }
    const normalizedHeaders = this.sanitizeHeaders(n.headers);
    if (JSON.stringify(normalizedHeaders) !== JSON.stringify(n.headers || {})) changed = true;
    n.headers = normalizedHeaders;
    delete n.videoThrottling;
    delete n.interceptMs;
    if (!n.schemaVersion) { n.schemaVersion = 2; changed = true; }
    if (!n.createdAt) { n.createdAt = new Date().toISOString(); changed = true; }
    if (!n.updatedAt) { n.updatedAt = n.createdAt; changed = true; }
    return { data: n, changed };
  },
  async getNode(nodeName, env, ctx) {
    nodeName = String(nodeName).toLowerCase();
    const kv = this.getKV(env); if (!kv) return null;
    const mem = GLOBALS.NodeCache.get(nodeName);
    if (mem && mem.exp > Date.now()) return mem.data;
    try {
      const nodeData = await kv.get(`${this.PREFIX}${nodeName}`, { type: "json" });
      if (!nodeData) return null;
      const { data: normalized, changed } = this.normalizeNode(nodeName, nodeData);
      if (changed && ctx) ctx.waitUntil(kv.put(`${this.PREFIX}${nodeName}`, JSON.stringify(normalized)));
      GLOBALS.NodeCache.set(nodeName, { data: normalized, exp: Date.now() + Config.Defaults.CacheTTL });
      return normalized;
    } catch { return null; }
  },
  async handleApi(request, env, ctx) {
    const kv = this.getKV(env);
    if (!kv) return new Response(JSON.stringify({ error: "kv_missing" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    let data; try { data = await request.json(); } catch { return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400, headers: { ...corsHeaders } }); }
    // 🌟 性能防御：仅清除单体缓存，严禁主动销毁 NodesListCache 导致全站并发重读
    const invalidate = (name) => { GLOBALS.NodeCache.delete(name); };
    
    switch (data.action) {
      case "getDashboardStats": {
        const config = sanitizeRuntimeConfig(await getRuntimeConfig(env));
        let todayRequests = 0, todayTraffic = "未配置", nodeCount = 0;
        let cfAnalyticsLoaded = false, requestsLoaded = false;
        let cfAnalyticsStatus = "", cfAnalyticsError = "", cfAnalyticsDetail = "";
        let requestSource = "pending", requestSourceText = "等待数据加载", trafficSourceText = "视频流量口径：CF Zone 总流量";
        let hourlySeries = Array.from({ length: 24 }, (_, hour) => ({ label: String(hour).padStart(2, "0") + ":00", total: 0 }));
        let playCount = 0, infoCount = 0, totalAccMs = 0;

        const nodes = await CacheManager.getNodesList(env, ctx);
        nodeCount = nodes.length || 0;

        const now = new Date();
        const utc8Ms = now.getTime() + 8 * 3600 * 1000;
        const d = new Date(utc8Ms);
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const dateString = `${yyyy}-${mm}-${dd}`;
        const startOfDayTs = Date.UTC(yyyy, d.getUTCMonth(), d.getUTCDate()) - 8 * 3600 * 1000;
        const endOfDayTs = startOfDayTs + 86400000 - 1;

        const cfZoneId = String(config.cfZoneId || "").trim();
        const cfApiToken = String(config.cfApiToken || "").trim();
        const cacheKey = makeCfDashCacheKey(cfZoneId, dateString);
        let cached = await kv.get(cacheKey, { type: "json" });

        if (cached && cached.ver === CF_DASH_CACHE_VERSION && (Date.now() - cached.ts < 3600000) && Array.isArray(cached.hourlySeries)) {
            todayRequests = Number(cached.todayRequests) || 0;
            todayTraffic = cached.todayTraffic || "0 B";
            hourlySeries = cached.hourlySeries;
            cfAnalyticsLoaded = !!cached.cfAnalyticsLoaded;
            requestsLoaded = true;
            requestSource = cached.requestSource || "zone_analytics";
            requestSourceText = cached.requestSourceText || "";
            trafficSourceText = cached.trafficSourceText || "";
            cfAnalyticsStatus = cached.cfAnalyticsStatus || "";
            cfAnalyticsError = cached.cfAnalyticsError || "";
            cfAnalyticsDetail = cached.cfAnalyticsDetail || "";
            playCount = cached.playCount || 0;
            infoCount = cached.infoCount || 0;
            totalAccMs = cached.totalAccMs || 0;
        } else {
            if (cfZoneId && cfApiToken) {
                const startIso = new Date(startOfDayTs).toISOString();
                const endIso = new Date(endOfDayTs).toISOString();
                const query = `
                query {
                  viewer {
                    zones(filter: { zoneTag: ${toGraphQLString(cfZoneId)} }) {
                      series: httpRequestsAdaptiveGroups(limit: 10000, filter: { datetime_geq: ${toGraphQLString(startIso)}, datetime_leq: ${toGraphQLString(endIso)} }) {
                        count
                        dimensions { datetimeHour }
                        sum { edgeResponseBytes }
                      }
                    }
                  }
                }`;
                try {
                    const zoneData = await fetchCloudflareGraphQLZone(cfZoneId, cfApiToken, query);
                    if (zoneData) {
                        let zoneTotalReq = 0, totalBytes = 0;
                        let zoneHourlySeries = Array.from({ length: 24 }, (_, hour) => ({ label: String(hour).padStart(2, "0") + ":00", total: 0 }));
                        const seriesData = Array.isArray(zoneData.series) ? [...zoneData.series].sort((a, b) => String(a?.dimensions?.datetimeHour || "").localeCompare(String(b?.dimensions?.datetimeHour || ""))) : [];
                        seriesData.forEach(item => {
                            const req = Number(item.count) || 0;
                            const byt = Number(item.sum?.edgeResponseBytes) || 0;
                            zoneTotalReq += req;
                            totalBytes += byt;
                            const dtRaw = item?.dimensions?.datetimeHour;
                            if (!dtRaw) return;
                            const dt = new Date(dtRaw);
                            if (!Number.isNaN(dt.getTime())) zoneHourlySeries[(dt.getUTCHours() + 8) % 24].total += req;
                        });

                        todayTraffic = formatBytes(totalBytes);
                        cfAnalyticsLoaded = true;
                        cfAnalyticsStatus = "Cloudflare 统计正常";
                        trafficSourceText = "视频流量当前对齐：CF Zone 总流量（edgeResponseBytes）";

                        let resolvedRequestSource = "zone_analytics";
                        try {
                            const workerUsage = await fetchCloudflareWorkerUsageMetrics({ cfAccountId: String(config.cfAccountId || "").trim(), cfZoneId, cfApiToken, startIso, endIso });
                            if (workerUsage && Number.isFinite(workerUsage.totalRequests)) {
                                todayRequests = workerUsage.totalRequests;
                                hourlySeries = workerUsage.hourlySeries;
                                requestsLoaded = true;
                                resolvedRequestSource = "workers_usage";
                                requestSource = "workers_usage";
                                requestSourceText = "今日请求量当前对齐：Cloudflare Workers Usage";
                                cfAnalyticsStatus = "Cloudflare 统计正常（请求数已对齐 Workers Usage）";
                                cfAnalyticsDetail = workerUsage.serviceNames?.length ? `已对齐脚本: ${workerUsage.serviceNames.join(", ")}` : cfAnalyticsDetail;
                            }
                        } catch (e) {
                            console.log("CF workers usage fetch failed", e);
                        }

                        if (!requestsLoaded) {
                            todayRequests = zoneTotalReq;
                            hourlySeries = zoneHourlySeries;
                            requestsLoaded = true;
                            requestSource = "zone_analytics";
                            requestSourceText = "今日请求量当前对齐：Cloudflare Zone Analytics";
                        }
                    } else {
                        cfAnalyticsStatus = "Zone 未命中";
                        cfAnalyticsError = "GraphQL 返回空；请检查 Zone ID 或权限";
                        todayTraffic = "CF 无统计数据";
                    }
                } catch (e) {
                    const cfDiag = classifyCloudflareAnalyticsError(e?.message || e, { zoneId: cfZoneId });
                    cfAnalyticsStatus = cfDiag.status;
                    cfAnalyticsError = cfDiag.hint;
                    cfAnalyticsDetail = cfDiag.detail;
                    todayTraffic = "CF 查询失败";
                }
            } else {
                cfAnalyticsStatus = "未配置 Cloudflare";
                cfAnalyticsError = "请在账号设置中填写并保存 Cloudflare Zone ID 与 API 令牌";
                requestSourceText = "今日请求量当前对齐：本地 D1 日志（兜底口径）";
                trafficSourceText = "视频流量当前对齐：未配置 Cloudflare，无法获取 CF Zone 总流量";
            }

            const db = this.getDB(env);
            if (db) {
                const videoWhereClause = getVideoRequestWhereClause();
                playCount = (await db.prepare(`SELECT COUNT(*) as c FROM proxy_logs WHERE timestamp >= ? AND timestamp <= ? AND ${videoWhereClause}`).bind(startOfDayTs, endOfDayTs).first())?.c || 0;
                infoCount = (await db.prepare(`SELECT COUNT(*) as c FROM proxy_logs WHERE timestamp >= ? AND timestamp <= ? AND request_path LIKE '%/PlaybackInfo%'`).bind(startOfDayTs, endOfDayTs).first())?.c || 0;
                totalAccMs = (await db.prepare(`SELECT SUM(response_time) as st FROM proxy_logs WHERE timestamp >= ? AND timestamp <= ? AND ${videoWhereClause}`).bind(startOfDayTs, endOfDayTs).first())?.st || 0;

                if (!requestsLoaded) {
                    todayRequests = (await db.prepare(`SELECT COUNT(*) as total FROM proxy_logs WHERE timestamp >= ? AND timestamp <= ?`).bind(startOfDayTs, endOfDayTs).first())?.total || 0;
                    const dbHourly = await db.prepare(`SELECT strftime('%H', datetime(timestamp / 1000 + 28800, 'unixepoch')) as hour, COUNT(*) as total FROM proxy_logs WHERE timestamp >= ? AND timestamp <= ? GROUP BY hour ORDER BY hour ASC`).bind(startOfDayTs, endOfDayTs).all();
                    for (const row of dbHourly?.results || []) {
                        const index = Number.parseInt(row.hour, 10);
                        if (!Number.isNaN(index) && hourlySeries[index]) hourlySeries[index].total += (Number(row.total) || 0);
                    }
                    requestsLoaded = true;
                    requestSource = "d1_logs";
                    requestSourceText = "今日请求量当前对齐：本地 D1 日志（兜底口径）";
                }
            }

            const cachePayload = JSON.stringify({
                ver: CF_DASH_CACHE_VERSION, ts: Date.now(),
                todayRequests, todayTraffic, hourlySeries,
                requestSource, requestSourceText, trafficSourceText,
                cfAnalyticsLoaded, cfAnalyticsStatus, cfAnalyticsError, cfAnalyticsDetail,
                playCount, infoCount, totalAccMs
            });
            if (ctx) ctx.waitUntil(kv.put(cacheKey, cachePayload));
            else await kv.put(cacheKey, cachePayload);
        }

        return new Response(JSON.stringify({ todayRequests, todayTraffic, nodeCount, hourlySeries, cfAnalyticsLoaded, cfAnalyticsStatus, cfAnalyticsError, cfAnalyticsDetail, requestSource, requestSourceText, trafficSourceText, playCount, infoCount, totalAccMs }), { headers: { ...corsHeaders } });      
      }
      case "loadConfig": return new Response(JSON.stringify({ config: await getRuntimeConfig(env) }), { headers: { ...corsHeaders } });
      case "saveConfig": 
        if (data.config) {
            const prevConfig = await getRuntimeConfig(env);
            const nextConfig = sanitizeRuntimeConfig(data.config);
            await kv.put(this.CONFIG_KEY, JSON.stringify(nextConfig));
            GLOBALS.ConfigCache = null;
            const now = new Date();
            const utc8Ms = now.getTime() + 8 * 3600 * 1000;
            const d = new Date(utc8Ms);
            const yyyy = d.getUTCFullYear();
            const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
            const dd = String(d.getUTCDate()).padStart(2, '0');
            const dateKey = `${yyyy}-${mm}-${dd}`;
            const staleKeys = new Set([
              "sys:cf_dash_cache",
              makeCfDashCacheKey(prevConfig?.cfZoneId),
              makeCfDashCacheKey(nextConfig?.cfZoneId),
              makeCfDashCacheKey(prevConfig?.cfZoneId, dateKey),
              makeCfDashCacheKey(nextConfig?.cfZoneId, dateKey)
            ]);
            const deleteTasks = [...staleKeys].filter(Boolean).map(key => kv.delete(key));
            if (deleteTasks.length) {
              if (ctx) ctx.waitUntil(Promise.all(deleteTasks));
              else await Promise.all(deleteTasks);
            }
        }
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders } });
      case "exportConfig": return new Response(JSON.stringify({ version: Config.Defaults.Version, exportTime: new Date().toISOString(), nodes: (await CacheManager.getNodesList(env, ctx)).filter(Boolean), config: await getRuntimeConfig(env) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      case "list": return new Response(JSON.stringify({ nodes: await CacheManager.getNodesList(env, ctx) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      
      case "save":
      case "import": {
        const nodesToSave = data.action === "save" ? [data] : data.nodes;
        const savedNodes = [];
        let index = await kv.get(this.NODES_INDEX_KEY, { type: "json" }) || [];
        
        for (const n of nodesToSave) {
          if (!n.name || !n.target) continue;
          const name = String(n.name).toLowerCase();
          const originalName = n.originalName ? String(n.originalName).toLowerCase() : null;
          
          let existingNode = {};
          if (originalName && originalName !== name) {
              existingNode = await kv.get(`${this.PREFIX}${originalName}`, { type: "json" }) || {};
              await kv.delete(`${this.PREFIX}${originalName}`);
              await invalidate(originalName);
              index = index.filter(x => x !== originalName);
          } else {
              existingNode = await kv.get(`${this.PREFIX}${name}`, { type: "json" }) || {};
          }
          
          let parsedHeaders = n.headers !== undefined ? n.headers : existingNode.headers;
          if (typeof parsedHeaders === "string") { try { parsedHeaders = JSON.parse(parsedHeaders); } catch { parsedHeaders = {}; } }
          const normalizedTargets = this.normalizeTargets(n.target || existingNode.target);
          if (!normalizedTargets) continue;
          const baseNode = {
            target: normalizedTargets,
            secret: n.secret !== undefined ? n.secret : (existingNode.secret || ""),
            tag: n.tag !== undefined ? n.tag : (existingNode.tag || ""),
            remark: n.remark !== undefined ? n.remark : (existingNode.remark || ""),
            headers: this.sanitizeHeaders(parsedHeaders),
            schemaVersion: 2,
            createdAt: existingNode.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          const val = this.normalizeNode(name, baseNode).data;
          await kv.put(`${this.PREFIX}${name}`, JSON.stringify(val));
          await invalidate(name);
          savedNodes.push({ name, ...val });
          index.push(name);
        }
        
        if (savedNodes.length > 0 && ctx) { 
          ctx.waitUntil((async () => { 
            index = [...new Set(index)]; 
            await kv.put(this.NODES_INDEX_KEY, JSON.stringify(index)); 
            GLOBALS.NodesIndexCache = { data: index, exp: nowMs() + 60000 }; 
          })()); 
        }
        if (data.action === "save" && savedNodes.length === 0) return jsonError("INVALID_TARGET", "目标源站必须是有效的 http/https URL");
        return new Response(JSON.stringify({ success: true, node: data.action === "save" ? savedNodes[0] : undefined, nodes: data.action === "import" ? savedNodes : undefined }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      
      case "importFull": {
        if (data.config) { await kv.put(this.CONFIG_KEY, JSON.stringify(data.config)); GLOBALS.ConfigCache = null; }
        if (data.nodes && Array.isArray(data.nodes)) {
            const savedNodes = [];
            for (const n of data.nodes) {
              if (!n.name || !n.target) continue;
              const name = String(n.name).toLowerCase(); 
              const existingNode = await kv.get(`${this.PREFIX}${name}`, { type: "json" }) || {};
              let parsedHeaders = n.headers !== undefined ? n.headers : existingNode.headers;
              if (typeof parsedHeaders === "string") { try { parsedHeaders = JSON.parse(parsedHeaders); } catch { parsedHeaders = {}; } }
              const normalizedTargets = this.normalizeTargets(n.target || existingNode.target);
              if (!normalizedTargets) continue;
              const val = this.normalizeNode(name, {
                target: normalizedTargets,
                secret: n.secret !== undefined ? n.secret : (existingNode.secret || ""),
                tag: n.tag !== undefined ? n.tag : (existingNode.tag || ""),
                remark: n.remark !== undefined ? n.remark : (existingNode.remark || ""),
                headers: this.sanitizeHeaders(parsedHeaders),
                schemaVersion: 2,
                createdAt: existingNode.createdAt || new Date().toISOString(),
                updatedAt: new Date().toISOString()
              }).data;
              await kv.put(`${this.PREFIX}${name}`, JSON.stringify(val));
              GLOBALS.NodeCache.delete(name);
              savedNodes.push(name);
            }
            if (savedNodes.length > 0 && ctx) {
              ctx.waitUntil((async () => {
                let index = await kv.get(this.NODES_INDEX_KEY, { type: "json" }) || [];
                index = [...new Set([...index, ...savedNodes])];
                await kv.put(this.NODES_INDEX_KEY, JSON.stringify(index));
                GLOBALS.NodesIndexCache = { data: index, exp: nowMs() + 60000 };
                await CacheManager.invalidateList(ctx);
              })());
            }
        }
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders } });
      }
      case "delete": {
        if (data.name) {
          const delName = String(data.name).toLowerCase(); await kv.delete(`${this.PREFIX}${delName}`); await invalidate(delName);
          if (ctx) ctx.waitUntil((async () => { let index = await kv.get(this.NODES_INDEX_KEY, { type: "json" }) || []; await kv.put(this.NODES_INDEX_KEY, JSON.stringify(index.filter(n => n !== delName))); })());
        }
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders } });
      }
      
      case "purgeCache": {
          const config = await kv.get(this.CONFIG_KEY, { type: "json" }) || {};
          if (!config.cfZoneId || !config.cfApiToken) return jsonError("CF_API_ERROR", "请在账号设置中完善 Zone ID 和 API 令牌");
          try {
              const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(String(config.cfZoneId).trim())}/purge_cache`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${config.cfApiToken}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ purge_everything: true })
              });
              if (res.ok) return jsonResponse({ success: true });
              return jsonError("PURGE_FAILED", "清理失败，请检查密钥权限");
          } catch(e) { return jsonError("PURGE_ERROR", e.message); }
      }
      
      case "testTelegram": {
          const { tgBotToken, tgChatId } = data;
          if (!tgBotToken || !tgChatId) return jsonError("MISSING_PARAMS", "请先填写 Bot Token 和 Chat ID");
          try {
              const tgUrl = `https://api.telegram.org/bot${tgBotToken}/sendMessage`;
              const msgText = "✅ Emby Proxy: Telegram 机器人测试通知成功！\n如果您能看到这条消息，说明您的通知配置完全正确。";
              const tgRes = await fetch(tgUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ chat_id: tgChatId, text: msgText })
              });
              const tgData = await tgRes.json();
              if (tgData.ok) return jsonResponse({ success: true });
              else return jsonError("TG_API_ERROR", tgData.description || "Telegram API 返回错误，请检查 Token/ChatID");
          } catch (e) {
              return jsonError("NETWORK_ERROR", e.message);
          }
      }

      case "sendDailyReport": {
          try {
              await this.sendDailyTelegramReport(env);
              return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders } });
          } catch (e) {
              return jsonError("REPORT_FAILED", e.message);
          }
      }

      case "pingNode": {
          const node = await this.getNode(data.name, env, ctx);
          if (!node || !node.target) return jsonError("NOT_FOUND", "节点不存在");
          // 取第一个目标源站进行真实回源探测
          const targets = String(node.target).split(",").map(i => i.trim()).filter(Boolean);
          const start = Date.now();
          try {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), parseInt(data.timeout || 5000));
              await fetch(targets[0], { method: 'HEAD', signal: controller.signal });
              clearTimeout(timeoutId);
              return jsonResponse({ ms: Date.now() - start });
          } catch (e) {
              return jsonResponse({ ms: 9999 });
          }
      }
      
      case "getLogs": {
        const db = this.getDB(env); if (!db) return new Response(JSON.stringify({ error: "D1 not configured" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const { page = 1, pageSize = 50, filters = {} } = data;
        const offset = (page - 1) * pageSize;
        let whereClause = [], params = [];
        
        if (filters.keyword) { 
            whereClause.push("(node_name LIKE ? OR request_path LIKE ? OR client_ip LIKE ? OR category LIKE ? OR CAST(status_code AS TEXT) LIKE ?)"); 
            params.push(`%${filters.keyword}%`, `%${filters.keyword}%`, `%${filters.keyword}%`, `%${filters.keyword}%`, `%${filters.keyword}%`); 
        }
        if (filters.category) { whereClause.push("category = ?"); params.push(filters.category); }
        if (filters.startDate) { whereClause.push("timestamp >= ?"); params.push(new Date(filters.startDate).getTime()); }
        if (filters.endDate) { whereClause.push("timestamp <= ?"); params.push(new Date(filters.endDate + "T23:59:59").getTime()); }
        
        const where = whereClause.length > 0 ? "WHERE " + whereClause.join(" AND ") : "";
        const total = (await db.prepare(`SELECT COUNT(*) as total FROM proxy_logs ${where}`).bind(...params).first())?.total || 0;
        const logsResult = await db.prepare(`SELECT * FROM proxy_logs ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`).bind(...params, pageSize, offset).all();
        return new Response(JSON.stringify({ logs: logsResult.results || [], total, page, pageSize, totalPages: Math.ceil(total / pageSize) }), { headers: { ...corsHeaders } });
      }
      case "clearLogs": {
        const db = this.getDB(env); if (!db) return new Response(JSON.stringify({ error: "D1 not configured" }), { status: 500, headers: { ...corsHeaders } });
        await db.prepare("DELETE FROM proxy_logs").run();
        return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders } });
      }
      case "initLogsDb": {
        const db = this.getDB(env); if (!db) return new Response(JSON.stringify({ error: "D1 not configured" }), { status: 500, headers: { ...corsHeaders } });
        await db.prepare(`CREATE TABLE IF NOT EXISTS proxy_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, node_name TEXT NOT NULL, request_path TEXT NOT NULL, request_method TEXT NOT NULL, status_code INTEGER NOT NULL, response_time INTEGER NOT NULL, client_ip TEXT NOT NULL, user_agent TEXT, referer TEXT, category TEXT DEFAULT 'api', created_at TEXT NOT NULL)`).run();
        try {
          await db.prepare(`ALTER TABLE proxy_logs ADD COLUMN category TEXT DEFAULT 'api'`).run();
        } catch (e) {
          const msg = String(e && e.message || e).toLowerCase();
          if (!msg.includes("duplicate column") && !msg.includes("already exists") && !msg.includes("duplicate") && !msg.includes("exists")) {
            throw e;
          }
        }
        await db.prepare(`CREATE INDEX IF NOT EXISTS idx_proxy_logs_timestamp ON proxy_logs (timestamp)`).run();
        await db.prepare(`CREATE INDEX IF NOT EXISTS idx_proxy_logs_client_ip ON proxy_logs (client_ip)`).run();
        await db.prepare(`CREATE INDEX IF NOT EXISTS idx_proxy_logs_node_time ON proxy_logs (node_name, timestamp)`).run();
        await db.prepare(`CREATE INDEX IF NOT EXISTS idx_proxy_logs_category ON proxy_logs (category)`).run();
        return new Response(JSON.stringify({ success: true, schemaVersion: 2, categoryEnabled: true }), { headers: { ...corsHeaders } });
      }
      default: return new Response("Invalid Action", { status: 400, headers: { ...corsHeaders } });
    }
  }
};

// ============================================================================
// 3. 代理模块 (PROXY MODULE - 核心缓冲防护与 CORS 重构)
// ============================================================================
const Proxy = {
  async handle(request, node, path, name, key, env, ctx, options = {}) {
    const startTime = Date.now();
    CacheManager.maybeCleanup();
    if (!node || !node.target) return new Response("Invalid Node", { status: 502, headers: applySecurityHeaders(new Headers()) });

    const currentConfig = await getRuntimeConfig(env);
    const requestUrl = options.requestUrl || new URL(request.url);
    const proxyPath = sanitizeProxyPath(path);
    const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
    const country = request.cf?.country || "UNKNOWN";

    const reqOrigin = request.headers.get("Origin");
    const allowedOrigins = String(currentConfig.corsOrigins || "").split(",").map(i => i.trim()).filter(Boolean);
    let finalOrigin = "*";
    if (allowedOrigins.length > 0) finalOrigin = reqOrigin && allowedOrigins.includes(reqOrigin) ? reqOrigin : allowedOrigins[0];
    else if (reqOrigin) finalOrigin = reqOrigin;
    const dynamicCors = getCorsHeadersForResponse(env, request, finalOrigin);

    if (request.method === "OPTIONS") {
      const headers = new Headers(dynamicCors);
      applySecurityHeaders(headers);
      if (finalOrigin !== "*") mergeVaryHeader(headers, "Origin");
      return new Response(null, { headers });
    }

    const ipBlacklist = String(currentConfig.ipBlacklist || "").split(",").map(i => i.trim()).filter(Boolean);
    if (ipBlacklist.includes(clientIp)) {
      const headers = new Headers({ "Access-Control-Allow-Origin": finalOrigin, "Cache-Control": "no-store" });
      applySecurityHeaders(headers);
      return new Response("Forbidden by IP Firewall", { status: 403, headers });
    }

    const geoAllow = String(currentConfig.geoAllowlist || "").split(",").map(i => i.trim().toUpperCase()).filter(Boolean);
    const geoBlock = String(currentConfig.geoBlocklist || "").split(",").map(i => i.trim().toUpperCase()).filter(Boolean);
    if ((geoAllow.length > 0 && !geoAllow.includes(country)) || (geoBlock.length > 0 && geoBlock.includes(country))) {
      const headers = new Headers({ "Access-Control-Allow-Origin": finalOrigin, "Cache-Control": "no-store" });
      applySecurityHeaders(headers);
      return new Response("Forbidden by Geo Firewall", { status: 403, headers });
    }

    const rangeHeader = request.headers.get("Range");
    const isHeadPrewarm = request.method === "GET" && !!rangeHeader && /^bytes=0-1\d{5,6}$/.test(rangeHeader);
    const isImage = GLOBALS.Regex.EmbyImages.test(proxyPath) || GLOBALS.Regex.StaticExt.test(proxyPath);
    const isSubtitle = GLOBALS.Regex.SubtitleExt.test(proxyPath);
    const isManifest = GLOBALS.Regex.ManifestExt.test(proxyPath);
    const isSegment = GLOBALS.Regex.SegmentExt.test(proxyPath);
    const isWsUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    const looksLikeVideoRoute = GLOBALS.Regex.Streaming.test(proxyPath) || /\/videos\/[^/]+\/(stream|original|download|file)/i.test(proxyPath) || /\/items\/[^/]+\/download/i.test(proxyPath) || requestUrl.searchParams.get("Static") === "true" || requestUrl.searchParams.get("Download") === "true";
    const isBigStream = looksLikeVideoRoute && !isManifest && !isSegment && !isHeadPrewarm;
    const isCacheableAsset = request.method === "GET" && !isWsUpgrade && (isImage || isSubtitle || isSegment || isHeadPrewarm);

    const rpmLimit = parseInt(currentConfig.rateLimitRpm) || 0;
    const shouldRateLimit = rpmLimit > 0 && !(isManifest || isSegment || isHeadPrewarm || isBigStream);
    if (shouldRateLimit) {
      let rlData = GLOBALS.RateLimitCache.get(clientIp);
      if (!rlData || startTime > rlData.resetAt) rlData = { count: 0, resetAt: startTime + 60000 };
      rlData.count += 1;
      GLOBALS.RateLimitCache.set(clientIp, rlData);
      if (rlData.count > rpmLimit) {
        const headers = new Headers({ "Access-Control-Allow-Origin": finalOrigin, "Cache-Control": "no-store" });
        applySecurityHeaders(headers);
        return new Response("Rate Limit Exceeded", { status: 429, headers });
      }
    }

    const enableH2 = currentConfig.enableH2 === true;
    const enableH3 = currentConfig.enableH3 === true;
    const peakDowngrade = currentConfig.peakDowngrade !== false;
    const protocolFallback = currentConfig.protocolFallback !== false; 
    const utc8Hour = (new Date().getUTCHours() + 8) % 24;
    const isPeakHour = utc8Hour >= 20 && utc8Hour < 24;
    const forceH1 = (peakDowngrade && isPeakHour) || (!enableH2 && !enableH3);

    const targetBases = String(node.target || "").split(",").map(item => item.trim()).filter(Boolean).map(item => {
      try { return new URL(item); } catch { return null; }
    }).filter(url => url && ["http:", "https:"].includes(url.protocol));
    if (!targetBases.length) {
      const headers = new Headers({ "Access-Control-Allow-Origin": finalOrigin, "Cache-Control": "no-store" });
      applySecurityHeaders(headers);
      return new Response("Invalid Node Target", { status: 502, headers });
    }

    const newHeaders = new Headers(request.headers);
    GLOBALS.DropRequestHeaders.forEach(h => newHeaders.delete(h));

    const adminCustomHeaders = new Set();
    let adminCustomCookie = null;
    if (node.headers && typeof node.headers === "object") {
      for (const [hKey, hVal] of Object.entries(node.headers)) {
        const lowerKey = String(hKey).toLowerCase();
        if (GLOBALS.DropRequestHeaders.has(lowerKey)) continue;
        adminCustomHeaders.add(lowerKey);
        if (lowerKey === "cookie") adminCustomCookie = String(hVal);
        else newHeaders.set(hKey, String(hVal));
      }
    }

    const mergedCookie = mergeAndSanitizeCookieHeaders(newHeaders.get("Cookie"), adminCustomCookie, ["auth_token"]);
    if (mergedCookie) newHeaders.set("Cookie", mergedCookie);
    else newHeaders.delete("Cookie");

    // ================== 核心补丁：Emby 授权头双向兼容 & 登录 API 补头 ==================
    let embyAuth = newHeaders.get("X-Emby-Authorization");
    let stdAuth = newHeaders.get("Authorization");

    if (embyAuth && !stdAuth) {
      newHeaders.set("Authorization", embyAuth);
    } else if (stdAuth && stdAuth.toLowerCase().startsWith("emby ") && !embyAuth) {
      newHeaders.set("X-Emby-Authorization", stdAuth);
    }

    if (request.method === "POST" && proxyPath.toLowerCase().includes("/users/authenticatebyname")) {
      const loginCompatAuth = 'Emby Client="Emby Proxy Patch", Device="Browser", DeviceId="proxy-login-patch", Version="1.0.0"';

      if (!newHeaders.has("X-Emby-Authorization") && !newHeaders.has("Authorization")) {
        newHeaders.set("X-Emby-Authorization", loginCompatAuth);
        newHeaders.set("Authorization", loginCompatAuth);
      } else if (newHeaders.has("X-Emby-Authorization") && !newHeaders.has("Authorization")) {
        newHeaders.set("Authorization", newHeaders.get("X-Emby-Authorization"));
      } else if (newHeaders.has("Authorization") && !newHeaders.has("X-Emby-Authorization")) {
        const authVal = newHeaders.get("Authorization") || "";
        if (authVal.toLowerCase().startsWith("emby ")) {
          newHeaders.set("X-Emby-Authorization", authVal);
        }
      }
    }
    // =====================================================================================

    newHeaders.set("X-Real-IP", clientIp);
    newHeaders.set("X-Forwarded-For", clientIp);
    newHeaders.set("X-Forwarded-Host", requestUrl.host);
    newHeaders.set("X-Forwarded-Proto", requestUrl.protocol.replace(":", ""));
    if (isWsUpgrade) {
      newHeaders.set("Upgrade", "websocket");
      newHeaders.set("Connection", "Upgrade");
    } else if (forceH1) {
      newHeaders.set("Connection", "keep-alive");
    }
    if ((isBigStream || isSegment || isManifest) && !adminCustomHeaders.has("referer")) newHeaders.delete("Referer");

    // ================== 核心分流机制：三车道完美路由 ==================
    // 1. 判定是否为带 Body 的非幂等请求 (POST/PUT/PATCH 等)
    const isNonIdempotent = request.method !== "GET" && request.method !== "HEAD";
    
    // 2. 终极内存优化：强制使用纯流式 request.body，斩断 ArrayBuffer OOM 根源
    const preparedBody = isNonIdempotent ? request.body : null;
    const preparedBodyMode = (isNonIdempotent && request.body) ? "stream" : "none";
    
    // 3. 剥夺重试权利：POST/PUT 只取 targetBases[0]，GET/HEAD/WS 保留完整容灾队列
    const retryTargets = isNonIdempotent ? targetBases.slice(0, 1) : targetBases;
    // ==================================================================
    const sourceSameOriginProxy = currentConfig.sourceSameOriginProxy !== false;
    const forceExternalProxy = currentConfig.forceExternalProxy !== false;
    const wangpanDirectKeywords = getWangpanDirectText(currentConfig.wangpandirect || "");
    const nodeDirectSource = isNodeDirectSourceEnabled(node, currentConfig);

    const buildFetchOptions = async (targetUrl, options = {}) => {
      const headers = new Headers(newHeaders);
      const finalTargetUrl = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl));
      const targetOrigin = finalTargetUrl.origin;
      const effectiveMethod = String(options.method || request.method || "GET").toUpperCase();
      const effectiveBodyMode = options.bodyMode || preparedBodyMode;
      const effectiveBody = options.body !== undefined ? options.body : preparedBody;
      const isRetry = options.isRetry === true;
      const isExternalRedirect = options.isExternalRedirect === true;

      if (headers.has("Origin") && !adminCustomHeaders.has("origin")) {
        headers.set("Origin", targetOrigin);
      }

      if (headers.has("Referer") && !adminCustomHeaders.has("referer")) {
        try {
          const originalReferer = new URL(headers.get("Referer"));
          if (originalReferer.origin !== targetOrigin) {
            const safeReferer = new URL(originalReferer.pathname + originalReferer.search, targetOrigin);
            headers.set("Referer", safeReferer.toString());
          }
        } catch {
          headers.set("Referer", targetOrigin + "/");
        }
      }

      if (isExternalRedirect) {
        headers.delete("Authorization");
        headers.delete("X-Emby-Authorization");
        if (!adminCustomHeaders.has("cookie")) headers.delete("Cookie");
        if (!adminCustomHeaders.has("origin")) headers.delete("Origin");
        if (!adminCustomHeaders.has("referer")) headers.delete("Referer");
      }

      if (isRetry && protocolFallback) {
        headers.delete("Authorization");
        headers.delete("X-Emby-Authorization");
        headers.set("Connection", "keep-alive");
      }

      if (effectiveMethod === "GET" || effectiveMethod === "HEAD") {
        headers.delete("Content-Length");
      }

      const fetchOptions = { method: effectiveMethod, headers, redirect: "manual", cf: { cacheEverything: false, cacheTtl: 0 } };
      if (effectiveMethod !== "GET" && effectiveMethod !== "HEAD") {
        if (effectiveBodyMode === "buffered" && effectiveBody !== null && effectiveBody !== undefined) fetchOptions.body = effectiveBody.slice(0);
        else if (effectiveBodyMode === "stream") fetchOptions.body = effectiveBody;
      }
      return fetchOptions;
    };

    const retryableStatuses = new Set([500, 502, 503, 504, 522, 523, 524, 525, 526, 530]); 
    
    const fetchUpstream = async (isRetry = false) => {
      let lastError = null;
      let lastResponse = null;
      let lastBase = retryTargets[0];
      let lastFinalUrl = new URL(proxyPath, lastBase);
      lastFinalUrl.search = requestUrl.search;
      
      for (let index = 0; index < retryTargets.length; index++) {
        const targetBase = retryTargets[index];
        const finalUrl = new URL(proxyPath, targetBase);
        finalUrl.search = requestUrl.search;
        lastBase = targetBase;
        lastFinalUrl = finalUrl;
        
        try {
          const fetchOptions = await buildFetchOptions(finalUrl, { isRetry });
          const response = await fetch(finalUrl.toString(), fetchOptions);
          
          // 🌟 第三车道 (WebSocket 特权通道)
          if (response.status === 101) {
            return { response, targetBase: lastBase, finalUrl: lastFinalUrl };
          }
          
          // 🌟 异常防御：403 降级重试拦截
          if (response.status === 403 && !isRetry && protocolFallback) {
            // 如果是 POST 流式 body，已经被消费过一次，绝不能二次 fetch，直接原样返回
            if (preparedBodyMode === "stream") {
              return { response, targetBase, finalUrl };
            }
            // 销毁无用响应体，防止 CF 内存泄漏
            try { response.body?.cancel?.(); } catch {}
            return await fetchUpstream(true); 
          }
          
          // 如果状态码正常，或是最后一个节点，直接返回
          if (!retryableStatuses.has(response.status) || index === retryTargets.length - 1) {
            return { response, targetBase, finalUrl };
          }
          
          // 🌟 内存防御：在进入下一次重试循环前，必须手动销毁被废弃的响应体
          if (lastResponse) {
            try { lastResponse.body?.cancel?.(); } catch {}
          }
          lastResponse = response;
        } catch (error) {
          lastError = error;
          if (index === retryTargets.length - 1) throw error;
        }
      }
      if (lastResponse) return { response: lastResponse, targetBase: lastBase, finalUrl: lastFinalUrl };
      throw lastError || new Error("upstream_fetch_failed");
    };

    let response;
    let finalUrl;
    let activeTargetBase;
    let proxiedExternalRedirect = false;
    let directRedirectUrl = null;
    let directRedirectStatus = null;

    try {
      const upstream = await fetchUpstream();
      response = upstream.response;
      activeTargetBase = upstream.targetBase;
      finalUrl = upstream.finalUrl;

      let redirectHop = 0;
      let redirectMethod = String(request.method || "GET").toUpperCase();
      let redirectBodyMode = preparedBodyMode;
      let redirectBody = preparedBody;
      while (response.status >= 300 && response.status < 400 && redirectHop < 8) {
        const location = response.headers.get("Location");
        const nextUrl = resolveRedirectTarget(location, finalUrl || activeTargetBase);
        if (!nextUrl) break;

        const isSameOriginRedirect = nextUrl.origin === activeTargetBase.origin;
        const mustDirect = isSameOriginRedirect
          ? !sourceSameOriginProxy
          : (!forceExternalProxy || shouldDirectByWangpan(nextUrl, wangpanDirectKeywords));

        if (mustDirect) {
          directRedirectUrl = nextUrl;
          break;
        }

        const nextMethod = normalizeRedirectMethod(response.status, redirectMethod);
        let nextBodyMode = redirectBodyMode;
        let nextBody = redirectBody;
        if (nextMethod === "GET" || nextMethod === "HEAD") {
          nextBodyMode = "none";
          nextBody = null;
        } else if (redirectBodyMode === "stream") {
          directRedirectUrl = nextUrl;
          break;
        }

        try { response.body?.cancel?.(); } catch {}

        const redirectFetchOptions = await buildFetchOptions(nextUrl, {
          method: nextMethod,
          bodyMode: nextBodyMode,
          body: nextBody,
          isExternalRedirect: !isSameOriginRedirect
        });
        response = await fetch(nextUrl.toString(), redirectFetchOptions);
        finalUrl = nextUrl;
        redirectMethod = nextMethod;
        redirectBodyMode = nextBodyMode;
        redirectBody = nextBody;
        if (!isSameOriginRedirect) proxiedExternalRedirect = true;
        redirectHop += 1;
      }

      if (!directRedirectUrl && nodeDirectSource && response.status >= 200 && response.status < 300 && (request.method === "GET" || request.method === "HEAD")) {
        directRedirectUrl = new URL(proxyPath, activeTargetBase);
        directRedirectUrl.search = requestUrl.search;
        directRedirectStatus = 307;
        try { response.body?.cancel?.(); } catch {}
      }

      const modifiedHeaders = new Headers(response.headers);

      if (GLOBALS.DropResponseHeaders) {
        GLOBALS.DropResponseHeaders.forEach(h => modifiedHeaders.delete(h));
      }

      modifiedHeaders.set("Access-Control-Allow-Origin", finalOrigin);

      if (dynamicCors && dynamicCors["Access-Control-Expose-Headers"]) {
        modifiedHeaders.set("Access-Control-Expose-Headers", dynamicCors["Access-Control-Expose-Headers"]);
      }

      if (dynamicCors && dynamicCors["Access-Control-Allow-Methods"]) {
        modifiedHeaders.set("Access-Control-Allow-Methods", dynamicCors["Access-Control-Allow-Methods"]);
      }

      const resReqHeaders = request.headers.get("Access-Control-Request-Headers");
      if (resReqHeaders) {
        modifiedHeaders.set("Access-Control-Allow-Headers", resReqHeaders);
        mergeVaryHeader(modifiedHeaders, "Access-Control-Request-Headers");
      } else if (dynamicCors && dynamicCors["Access-Control-Allow-Headers"]) {
        modifiedHeaders.set("Access-Control-Allow-Headers", dynamicCors["Access-Control-Allow-Headers"]);
      }

      if (finalOrigin !== "*") {
        mergeVaryHeader(modifiedHeaders, "Origin");
      }

      if (!enableH3 || forceH1) {
        modifiedHeaders.delete("Alt-Svc");
      }

      // 🌟 透传 Range 的同时，强行命令 CF 边缘节点缓存静态资源与高频探测
      if (isImage || isSubtitle || isManifest) {
        modifiedHeaders.set("Cache-Control", "public, max-age=86400");
      } else if (isHeadPrewarm) {
        // 对于播放器频繁的 HEAD 预热请求，给个 3 分钟的微型缓存，防止击穿源站
        modifiedHeaders.set("Cache-Control", "public, max-age=180");
      } else if (isBigStream || proxiedExternalRedirect) {
        modifiedHeaders.set("Cache-Control", "no-store");
      }

      if (directRedirectUrl) {
        modifiedHeaders.set("Location", directRedirectUrl.toString());
        modifiedHeaders.set("Cache-Control", "no-store");
      } else if (response.status >= 300 && response.status < 400) {
        const location = modifiedHeaders.get("Location");
        if (location) {
          const prefix = buildProxyPrefix(name, key);
          if (location.startsWith("/")) {
            modifiedHeaders.set("Location", prefix + location);
          } else {
            try {
              const locUrl = new URL(location);
              if (locUrl.origin === activeTargetBase.origin) {
                modifiedHeaders.set("Location", prefix + locUrl.pathname + locUrl.search + locUrl.hash);
              }
            } catch {}
          }
        }
      }

      applySecurityHeaders(modifiedHeaders);
      
      // 生成高精度的后端请求分类打标
      let reqCategory = "api";
      if (isSegment) reqCategory = "segment";
      else if (isHeadPrewarm) reqCategory = "prewarm";
      else if (isManifest) reqCategory = "manifest";
      else if (isBigStream) reqCategory = "stream";
      else if (isImage) reqCategory = "image";
      else if (isSubtitle) reqCategory = "subtitle";
      else if (isWsUpgrade) reqCategory = "websocket";

      Logger.record(env, ctx, {
        nodeName: name,
        requestPath: proxyPath,
        requestMethod: request.method,
        statusCode: response.status,
        responseTime: Date.now() - startTime,
        clientIp,
        userAgent: request.headers.get("User-Agent"),
        referer: request.headers.get("Referer"),
        category: reqCategory
      });

      const finalStatus = directRedirectStatus || response.status;
      const finalStatusText = directRedirectStatus ? "Temporary Redirect" : response.statusText;
      return new Response(directRedirectStatus ? null : response.body, {
        status: finalStatus,
        statusText: finalStatusText,
        headers: modifiedHeaders
      });

    } catch (err) {
      Logger.record(env, ctx, {
        nodeName: name,
        requestPath: proxyPath,
        requestMethod: request.method,
        statusCode: 502,
        responseTime: Date.now() - startTime,
        clientIp,
        category: "error"
      });

      const errHeaders = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": finalOrigin || "*",
        "Cache-Control": "no-store"
      });

      if (finalOrigin !== "*") mergeVaryHeader(errHeaders, "Origin");
      applySecurityHeaders(errHeaders);

      return new Response(
        JSON.stringify({ error: "Bad Gateway", code: 502, message: "All proxy attempts failed." }),
        { status: 502, headers: errHeaders }
      );
    }
  }
};

const Logger = {
  record(env, ctx, logData) {
    const db = Database.getDB(env);
    if (!db || !ctx) return;
    if (logData.requestMethod === "OPTIONS") return;

    const currentMs = nowMs();
    let dedupeWindow = 0;
    if (logData.requestMethod === "HEAD") dedupeWindow = 300000;
    else if (logData.category === "segment" || logData.category === "prewarm") dedupeWindow = 30000;

    if (dedupeWindow > 0) {
      const dedupKey = [logData.nodeName || "unknown", logData.requestMethod || "GET", logData.statusCode || 0, logData.requestPath || "/", logData.clientIp || "unknown"].join("|");
      const lastSeen = GLOBALS.LogDedupe.get(dedupKey);
      if (lastSeen && (currentMs - lastSeen) < dedupeWindow) return;
      GLOBALS.LogDedupe.set(dedupKey, currentMs);
      if (GLOBALS.LogDedupe.size > 10000) {
        for (const [key, ts] of GLOBALS.LogDedupe) {
          if ((currentMs - ts) > dedupeWindow) GLOBALS.LogDedupe.delete(key);
          if (GLOBALS.LogDedupe.size <= 5000) break;
        }
      }
    }

    GLOBALS.LogQueue.push({
      timestamp: currentMs,
      nodeName: logData.nodeName || "unknown",
      requestPath: logData.requestPath || "/",
      requestMethod: logData.requestMethod || "GET",
      statusCode: Number(logData.statusCode) || 0,
      responseTime: Number(logData.responseTime) || 0,
      clientIp: logData.clientIp || "unknown",
      userAgent: logData.userAgent || null,
      referer: logData.referer || null,
      category: logData.category || "api",
      createdAt: new Date().toISOString()
    });

    if (!GLOBALS.LogLastFlushAt) GLOBALS.LogLastFlushAt = currentMs;
    const configuredDelayMinutes = Number(GLOBALS.ConfigCache?.data?.logWriteDelayMinutes);
    const flushWindowMs = Math.max(0, Number.isFinite(configuredDelayMinutes) ? configuredDelayMinutes * 60000 : 60000);
    const shouldFlush = GLOBALS.LogQueue.length >= 100 || flushWindowMs === 0 || (currentMs - GLOBALS.LogLastFlushAt) >= flushWindowMs;
    if (shouldFlush && !GLOBALS.LogFlushPending) {
      GLOBALS.LogFlushPending = true;
      ctx.waitUntil(this.flush(env).finally(() => {
        GLOBALS.LogFlushPending = false;
        GLOBALS.LogLastFlushAt = nowMs();
      }));
    }
  },
  async flush(env) {
    const db = Database.getDB(env);
    if (!db || GLOBALS.LogQueue.length === 0) return;
    const batchLogs = GLOBALS.LogQueue.splice(0, GLOBALS.LogQueue.length);
    try {
      const statements = batchLogs.map(item => db.prepare(`INSERT INTO proxy_logs (timestamp, node_name, request_path, request_method, status_code, response_time, client_ip, user_agent, referer, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(item.timestamp, item.nodeName, item.requestPath, item.requestMethod, item.statusCode, item.responseTime, item.clientIp, item.userAgent, item.referer, item.category, item.createdAt));
      await db.batch(statements);
    } catch (e) {
      // 🌟 性能防御：D1 写入失败直接丢弃批次，严禁 unshift 导致队列内存堆积与时间轴错乱
      console.log("Log flush failed, dropping batch.", e);
    }
  }
};

// ============================================================================
// 5. 新版 SAAS UI (纯净版：彻底删除所有冗余设置)
// ============================================================================
const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Emby Proxy V18.0 - SaaS Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lucide@latest"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: { extend: { colors: { brand: { 50: '#eff6ff', 500: '#3b82f6', 600: '#2563eb' } } } }
    }
  </script>
  <style>
    .glass-card { background: rgba(255,255,255,0.9); backdrop-filter: blur(12px); border: 1px solid #e2e8f0; }
    .dark .glass-card { background: rgba(15,23,42,0.6); border: 1px solid rgba(255,255,255,0.08); }
    .view-section { display: none; }
    .view-section.active { display: block; animation: fadeIn 0.3s ease-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
    aside { transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
  </style>
</head>
<body class="bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 antialiased overflow-hidden flex h-[100dvh]">

  <div id="sidebar-backdrop" onclick="App.toggleSidebar()" class="fixed inset-0 bg-slate-950/60 z-20 hidden backdrop-blur-sm transition-opacity"></div>

  <aside id="sidebar" class="w-64 h-full border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col z-30 absolute md:relative -translate-x-full md:translate-x-0 shadow-2xl md:shadow-none pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
    <div class="h-16 flex items-center px-6 border-b border-slate-200 dark:border-slate-800">
      <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-indigo-600 flex items-center justify-center text-white font-bold text-lg">E</div>
      <h1 class="ml-3 font-semibold tracking-tight text-lg">Emby Proxy</h1>
    </div>
    <nav class="flex-1 overflow-y-auto py-4 px-3 space-y-1">
      <a href="#dashboard" class="nav-item flex items-center px-3 py-2.5 rounded-xl text-sm font-medium transition-colors text-slate-600 dark:text-slate-400 hover:text-slate-900 hover:bg-slate-100 dark:hover:text-white dark:hover:bg-slate-800/50"><i data-lucide="layout-dashboard" class="w-5 h-5 mr-3"></i> 仪表盘</a>
      <a href="#nodes" class="nav-item flex items-center px-3 py-2.5 rounded-xl text-sm font-medium transition-colors text-slate-600 dark:text-slate-400 hover:text-slate-900 hover:bg-slate-100 dark:hover:text-white dark:hover:bg-slate-800/50"><i data-lucide="server" class="w-5 h-5 mr-3"></i> 节点列表</a>
      <a href="#logs" class="nav-item flex items-center px-3 py-2.5 rounded-xl text-sm font-medium transition-colors text-slate-600 dark:text-slate-400 hover:text-slate-900 hover:bg-slate-100 dark:hover:text-white dark:hover:bg-slate-800/50"><i data-lucide="activity" class="w-5 h-5 mr-3"></i> 日志记录</a>
      <div class="my-4 border-t border-slate-200 dark:border-slate-800"></div>
      <a href="#settings" class="nav-item flex items-center px-3 py-2.5 rounded-xl text-sm font-medium transition-colors text-slate-600 dark:text-slate-400 hover:text-slate-900 hover:bg-slate-100 dark:hover:text-white dark:hover:bg-slate-800/50"><i data-lucide="settings" class="w-5 h-5 mr-3"></i> 全局设置</a>
    </nav>
  </aside>

  <main class="flex-1 flex flex-col h-full min-w-0 relative">
    <header class="flex items-center justify-between px-6 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 z-10 sticky top-0 h-[calc(4rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))]">
      <div class="flex items-center">
        <button onclick="App.toggleSidebar()" class="md:hidden mr-4 text-slate-500 hover:text-slate-900"><i data-lucide="menu" class="w-5 h-5"></i></button>
        <h2 id="page-title" class="text-lg font-semibold tracking-tight">加载中...</h2>
      </div>
      <div class="flex items-center space-x-4">
        <a href="https://github.com/axuitomo/CF-EMBY-PROXY-UI" target="_blank" class="text-slate-400 hover:text-slate-900 dark:hover:text-white transition"><i data-lucide="github" class="w-5 h-5"></i></a>
        <button onclick="App.toggleTheme()" class="text-slate-400 hover:text-brand-500 transition"><i data-lucide="sun" class="w-5 h-5 dark:hidden"></i><i data-lucide="moon" class="w-5 h-5 hidden dark:block"></i></button>
      </div>
    </header>

    <div id="content-area" class="flex-1 overflow-y-auto p-4 md:p-8 pb-[calc(1rem+env(safe-area-inset-bottom))] md:pb-[calc(2rem+env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
      
      <div id="view-dashboard" class="view-section w-full mx-auto space-y-6">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
           <div class="glass-card rounded-3xl p-6 shadow-sm border-l-4 border-blue-500 min-w-0 overflow-hidden relative"><p class="text-sm text-slate-500 truncate">今日请求量</p><h3 class="text-2xl md:text-3xl font-bold mt-2 break-all" id="dash-req-count">0</h3><p class="text-xs font-medium text-slate-500 mt-2 break-all" id="dash-req-hint">&nbsp;</p><p class="text-[11px] font-medium text-brand-600 dark:text-brand-400 mt-2 break-all bg-brand-50 dark:bg-brand-500/10 inline-block px-2.5 py-1 rounded-md" id="dash-emby-metrics">请求: 播放 0 次 | 信息 0 次 , 加速 0秒</p></div>
           <div class="glass-card rounded-3xl p-6 shadow-sm border-l-4 border-emerald-500 min-w-0 overflow-hidden"><p class="text-sm text-slate-500 truncate">视频流量 (CF Zone 总流量)</p><h3 class="text-2xl md:text-3xl font-bold mt-2 break-all" id="dash-traffic-count">0 B</h3><p class="text-xs font-medium text-slate-500 mt-2 break-all" id="dash-traffic-hint">&nbsp;</p><p class="text-[11px] text-slate-400 mt-1 break-all whitespace-pre-line" id="dash-traffic-detail">&nbsp;</p></div>
           <div class="glass-card rounded-3xl p-6 shadow-sm border-l-4 border-purple-500 min-w-0 overflow-hidden"><p class="text-sm text-slate-500 truncate">接入节点</p><h3 class="text-2xl md:text-3xl font-bold mt-2 break-all" id="dash-node-count">0</h3></div>
        </div>
        <div class="glass-card rounded-3xl p-6 shadow-sm flex flex-col">
           <h3 class="font-semibold text-lg mb-4">请求趋势</h3>
           <div class="relative w-full h-64 md:h-80 2xl:h-[40vh] min-h-[250px] 2xl:min-h-[450px]"><canvas id="trafficChart"></canvas></div>
           <p class="text-xs text-slate-500 mt-4">Y 轴（纵轴）代表：该小时内的“请求总次数”；X 轴（横轴）代表：当前天的“小时”时间刻度（UTC+8）。</p>
        </div>
      </div>

      <div id="view-nodes" class="view-section w-full mx-auto space-y-6">
        <div class="flex flex-col xl:flex-row justify-between items-center gap-4">
          <div class="flex items-center gap-2 w-full xl:w-auto">
            <button onclick="App.showNodeModal()" class="px-4 py-2 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 flex items-center transition whitespace-nowrap"><i data-lucide="plus" class="w-4 h-4 mr-2"></i> 新建节点</button>
            <input type="text" id="node-search" placeholder="搜索节点名称或标签..." class="px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 outline-none text-sm text-slate-900 dark:text-white w-full sm:w-64 transition" oninput="App.renderNodesGrid()">
          </div>
          <div class="flex flex-wrap gap-2 w-full xl:w-auto">
            <button onclick="document.getElementById('import-nodes-file').click()" class="flex-1 sm:flex-none px-4 py-2 bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-xl text-sm font-medium hover:bg-slate-300 dark:hover:bg-slate-700 transition flex items-center justify-center"><i data-lucide="upload" class="w-4 h-4 mr-2"></i> 导入配置</button>
            <button onclick="App.exportNodes()" class="flex-1 sm:flex-none px-4 py-2 bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-xl text-sm font-medium hover:bg-slate-300 dark:hover:bg-slate-700 transition flex items-center justify-center"><i data-lucide="download" class="w-4 h-4 mr-2"></i> 导出配置</button>
            <button onclick="App.forceHealthCheck(event)" class="w-full sm:w-auto px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm font-medium hover:bg-emerald-700 flex items-center justify-center transition"><i data-lucide="activity" class="w-4 h-4 mr-2"></i> 全局 Ping</button>
            <input type="file" id="import-nodes-file" class="hidden" accept=".json" onchange="App.importNodes(event)">
            <input type="file" id="import-full-file" class="hidden" accept=".json" onchange="App.importFull(event)">
          </div>
        </div>
        <div id="nodes-grid" class="grid gap-6 grid-cols-[repeat(auto-fill,minmax(340px,1fr))]"></div>
      </div>

      <div id="view-logs" class="view-section w-full mx-auto space-y-6">
        <div class="glass-card rounded-3xl p-6 shadow-sm flex flex-col min-h-[calc(100vh-120px)]">
          <div class="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 gap-4">
            <h3 class="font-semibold text-lg flex-shrink-0">日志记录</h3>
            <div class="flex flex-wrap items-center gap-2 w-full md:w-auto">
              <input type="text" id="log-search-input" placeholder="搜索节点、IP、路径或状态码(如200)..." class="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 outline-none text-sm text-slate-900 dark:text-white flex-1 md:w-56" onkeydown="if(event.key==='Enter') App.loadLogs(1)">
              <button onclick="App.loadLogs(1)" class="text-brand-500 text-sm px-2 hover:text-brand-600"><i data-lucide="search" class="w-4 h-4 inline"></i></button>
              
              <div class="w-px h-5 bg-slate-300 dark:bg-slate-700 mx-1 hidden md:block"></div>
              
              <button onclick="App.apiCall('initLogsDb').then(()=>alert('初始化完成'))" class="text-slate-500 text-sm hover:text-brand-500"><i data-lucide="database" class="w-4 h-4 inline mr-1"></i>初始化 DB</button>
              <button onclick="if(confirm('确定清空所有日志?')) App.apiCall('clearLogs').then(()=>App.loadLogs(1))" class="text-red-500 text-sm hover:text-red-600 ml-2"><i data-lucide="trash-2" class="w-4 h-4 inline mr-1"></i>清空日志</button>
              <button onclick="App.loadLogs()" class="text-brand-500 text-sm ml-2"><i data-lucide="refresh-cw" class="w-4 h-4 inline mr-1"></i>刷新</button>
            </div>
          </div>
          <div class="overflow-x-auto min-h-0 w-full mb-4">
            <table class="w-full text-left border-collapse table-fixed min-w-[900px]">
              <thead><tr class="text-sm text-slate-500 border-b border-slate-200 dark:border-slate-800"><th class="py-3 px-4 w-24 md:w-28">节点</th><th class="py-3 px-4 w-28 md:w-32">资源类别</th><th class="py-3 px-4 w-16 md:w-20">状态</th><th class="py-3 px-4 w-32">IP</th><th class="py-3 px-4">UA</th><th class="py-3 px-4 w-28">时间锥</th></tr></thead>
              <tbody id="logs-tbody" class="text-sm"></tbody>
            </table>
          </div>
          <div class="flex justify-between items-center mt-auto pt-6 border-t border-slate-200 dark:border-slate-800">
              <button onclick="App.changeLogPage(-1)" class="px-4 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition">上一页</button>
              <span id="log-page-info" class="text-sm font-mono text-slate-500">1 / 1</span>
              <button onclick="App.changeLogPage(1)" class="px-4 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition">下一页</button>
          </div>
        </div>
      </div>

      <div id="view-settings" class="view-section max-w-4xl mx-auto space-y-6">
        <div class="glass-card rounded-3xl p-6 flex flex-col md:flex-row gap-6">
           <div class="w-full md:w-48 flex flex-row md:flex-col gap-2 md:gap-0 md:space-y-1 border-b md:border-b-0 md:border-r border-slate-200 dark:border-slate-800 pb-4 md:pb-0 pr-0 md:pr-4 overflow-x-auto whitespace-nowrap">
              <button class="set-tab flex-shrink-0 text-left px-3 py-2 rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400 text-sm font-medium" onclick="App.switchSetTab(event, 'ui')">系统 UI</button>
              <button class="set-tab flex-shrink-0 text-left px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm font-medium" onclick="App.switchSetTab(event, 'proxy')">代理与网络</button>
              <button class="set-tab flex-shrink-0 text-left px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm font-medium" onclick="App.switchSetTab(event, 'security')">缓存与安全</button>
              <button class="set-tab flex-shrink-0 text-left px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm font-medium" onclick="App.switchSetTab(event, 'logs')">日志与监控</button>
              <button class="set-tab flex-shrink-0 text-left px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 text-sm font-medium" onclick="App.switchSetTab(event, 'account')">账号与备份</button>
           </div>
           <div class="flex-1" id="settings-forms">
              
              <div id="set-ui" class="block">
                <h3 class="font-bold mb-4 text-slate-900 dark:text-white">UI 外观偏好</h3>
                <p class="text-sm text-slate-500 mb-4">外观偏好直接保存在本地浏览器缓存中。点击右上角太阳/月亮图标即可切换深浅模式。</p>
              </div>
              
              <div id="set-proxy" class="hidden">
                <h3 class="font-bold mb-4 text-slate-900 dark:text-white">网络协议与优化</h3>
                <p class="text-sm text-slate-500 mb-4">默认强制所有数据在 H1.1 下流通以保持最佳的单线程连贯性（并自动注入长连接参数）。</p>
                <label class="flex items-center text-sm font-medium mb-2 cursor-pointer text-slate-900 dark:text-white"><input type="checkbox" id="cfg-enable-h2" class="mr-2 w-4 h-4 rounded"> 允许开启 HTTP/2 (不建议)</label>
                <p class="text-xs text-slate-500 mb-3 ml-6">适合少数明确支持多路复用的上游；部分视频源在分片、长连接或头部兼容性上反而更容易出现异常。</p>
                <label class="flex items-center text-sm font-medium mb-2 cursor-pointer text-slate-900 dark:text-white"><input type="checkbox" id="cfg-enable-h3" class="mr-2 w-4 h-4 rounded"> 允许开启 HTTP/3 QUIC (推荐良好网络开启)</label>
                <p class="text-xs text-slate-500 mb-3 ml-6">适合网络质量稳定、丢包率低的环境；弱网或运营商链路复杂时，实际稳定性未必优于 HTTP/1.1。</p>
                <label class="flex items-center text-sm font-medium mb-2 cursor-pointer text-slate-900 dark:text-white"><input type="checkbox" id="cfg-peak-downgrade" class="mr-2 w-4 h-4 rounded" checked> 晚高峰 (20:00 - 24:00) 自动降级为 HTTP/1.1 兜底</label>
                <p class="text-xs text-slate-500 mb-3 ml-6">高峰时段优先稳态传输，减少握手抖动、异常回源和多路复用放大的兼容性问题。</p>
                <label class="flex items-center text-sm font-medium mb-2 cursor-pointer text-slate-900 dark:text-white"><input type="checkbox" id="cfg-protocol-fallback" class="mr-2 w-4 h-4 rounded" checked> 开启协议回退与 403 重试 (剥离报错头重连，缓解视频报错)</label>
                <p class="text-xs text-slate-500 mb-4 ml-6">当上游返回 403 或握手异常时，自动剥离可疑报错头并切换到更稳的协议后重试一次。</p>

                <h3 class="font-bold mb-2 mt-6 text-slate-900 dark:text-white">跳转代理开关</h3>
                <label class="flex items-center text-sm font-medium mb-2 cursor-pointer text-slate-900 dark:text-white"><input type="checkbox" id="cfg-source-same-origin-proxy" class="mr-2 w-4 h-4 rounded" checked> 默认开启：源站和同源跳转代理</label>
                <p class="text-xs text-slate-500 mb-3">开启时既包含源站 2xx 的 Worker 透明拉流，也包含同源 30x 的继续代理跳转；仅当节点被显式标记为直连时，源站 2xx 才会改为直连源站。关闭后，同源 30x 直接下发 Location。</p>
                <label class="flex items-center text-sm font-medium mb-2 cursor-pointer text-slate-900 dark:text-white"><input type="checkbox" id="cfg-force-external-proxy" class="mr-2 w-4 h-4 rounded" checked> 默认开启：强制反代外部链接</label>
                <p class="text-xs text-slate-500 mb-3">开启后 Worker 会作为中继站拉流并透明转发；除国内网盘/对象存储外默认不缓存，命中 <code>wangpandirect</code> 列表走直连。关闭后外部链接直接下发直连。</p>
                <p class="text-xs text-slate-500 mb-2">默认已填入内置关键词；请使用英文逗号分隔自定义内容，例如 <code>baidu,alibaba</code>。</p>
                <label class="block text-sm text-slate-500 mb-1">wangpandirect 直连黑名单（关键词模糊匹配，英文逗号分隔）</label>
                <textarea id="cfg-wangpandirect" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-4 dark:text-white resize-y" rows="3" placeholder="例如: baidu,alibaba"></textarea>

                <h3 class="font-bold mb-2 mt-6 text-slate-900 dark:text-white">源站直连名单</h3>
                <p class="text-xs text-slate-500 mb-3">这里列出现有节点。勾选后，这些节点在“源站和同源跳转代理”开启时，源站 2xx 会直接下发到源站，不再由 Worker 中继；未勾选节点继续由 Worker 透明拉流。</p>
                <input type="text" id="cfg-direct-node-search" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-3 dark:text-white" placeholder="搜索节点名称、标签或备注..." oninput="App.renderSourceDirectNodesPicker()">
                <div id="cfg-source-direct-nodes-summary" class="text-xs text-slate-500 mb-2">已选 0 个节点</div>
                <div id="cfg-source-direct-nodes-list" class="max-h-64 overflow-y-auto rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/60 p-2 space-y-2 mb-4"></div>
                
                <h3 class="font-bold mb-2 mt-6 text-slate-900 dark:text-white">健康检查探测</h3>
                <label class="block text-sm text-slate-500 mb-1">Ping 超时时间 (毫秒)</label>
                <input type="number" id="cfg-ping-timeout" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-4 dark:text-white" value="5000">
                <button onclick="App.saveSettings('proxy')" class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-sm transition">保存代理网络</button>
              </div>

              <div id="set-security" class="hidden">
                <h3 class="font-bold mb-4 text-slate-900 dark:text-white">安全防火墙与缓存引擎</h3>
                <label class="block text-sm text-slate-500 mb-1">国家/地区白名单 (留空不限制，如: CN,HK)</label>
                <p class="text-xs text-slate-500 mb-2">仅允许这些国家/地区的访客源 IP 访问；识别依据是 Cloudflare 看到的用户公网 IP 所属地区，不是你的源站位置。</p>
                <input type="text" id="cfg-geo-allow" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-3 dark:text-white" placeholder="例如: CN,HK">
                
                <label class="block text-sm text-slate-500 mb-1">国家/地区黑名单 (屏蔽指定国家，如: US,SG)</label>
                <p class="text-xs text-slate-500 mb-2">按访客源 IP 所属国家/地区直接拦截，可用于屏蔽不希望访问的海外地区或异常流量来源。</p>
                <input type="text" id="cfg-geo-block" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-3 dark:text-white" placeholder="例如: US">
                
                <label class="block text-sm text-slate-500 mb-1">IP 黑名单 (逗号分隔)</label>
                <p class="text-xs text-slate-500 mb-2">这里屏蔽的是访问者的公网 IP；命中后会直接拒绝该用户/设备的请求，适合封禁恶意爬虫、攻击源或异常账号。</p>
                <textarea id="cfg-ip-black" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-3 dark:text-white resize-y" rows="2"></textarea>
                
                <label class="block text-sm text-slate-500 mb-1">全局单 IP 限速 (请求/分钟，0为不限制)</label>
                <p class="text-xs text-slate-500 mb-2">对单个访客源 IP 生效；超过阈值后可快速压制刷接口、扫库和异常爆发流量。</p>
                <input type="number" id="cfg-rate-limit" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-3 dark:text-white" placeholder="如: 600">
                
                <label class="block text-sm text-slate-500 mb-1">图片海报缓存时长 (天)</label>
                <p class="text-xs text-slate-500 mb-2">仅影响海报、封面等图片静态资源的边缘缓存时长，不影响视频主流量的回源策略。</p>
                <input type="number" id="cfg-cache-ttl" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-3 dark:text-white" value="30">
                
                <label class="block text-sm text-slate-500 mb-1">CORS 跨域白名单 (留空为 *，如 https://emby.com)</label>
                <p class="text-xs text-slate-500 mb-2">用于限制哪些网页前端可以在浏览器里跨域调用本 Worker API；它主要影响浏览器环境，不影响服务器到服务器的直连请求。</p>
                <input type="text" id="cfg-cors" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-4 dark:text-white">
                
                <button onclick="App.saveSettings('security')" class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-sm transition">保存安全防护</button>
              </div>
              
              <div id="set-logs" class="hidden">
                <h3 class="font-bold mb-4 text-slate-900 dark:text-white">监控与日志配置</h3>
                <label class="block text-sm text-slate-500 mb-1">日志保存天数 (超过将由系统自动清理)</label>
                <input type="number" id="cfg-log-days" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-4 dark:text-white" value="7">
                <label class="block text-sm text-slate-500 mb-1">日志写入延迟（分钟）</label>
                <input type="number" min="0" step="0.5" id="cfg-log-delay" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-2 dark:text-white" value="1">
                <p class="text-xs text-slate-500 mb-4">控制内存日志队列写入 D1 的延迟窗口；达到批量阈值时会提前写入。设为 0 表示尽快写入。</p>
                
                <h3 class="font-bold mb-4 mt-6 text-slate-900 dark:text-white border-t border-slate-200 dark:border-slate-800 pt-4">Telegram 每日报表与告警机器人</h3>
                
                <label class="block text-sm text-slate-500 mb-1">Telegram Bot Token</label>
                <input type="text" id="cfg-tg-token" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-3 dark:text-white" placeholder="如: 123456789:ABCdefGHIjklMNOpqrSTUvwxYZ">
                
                <label class="block text-sm text-slate-500 mb-1">Telegram Chat ID (接收人ID)</label>
                <input type="text" id="cfg-tg-chatid" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-4 dark:text-white" placeholder="如: 123456789">
                
                <div class="flex flex-wrap gap-2">
                    <button onclick="App.saveSettings('logs')" class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-sm transition">保存监控设置</button>
                    <button onclick="App.testTelegram()" class="px-4 py-2 border border-blue-200 text-blue-600 rounded-xl text-sm transition hover:bg-blue-50 dark:border-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/20 flex items-center justify-center"><i data-lucide="send" class="w-4 h-4 mr-1"></i> 发送测试通知</button>
                    <button onclick="App.sendDailyReport()" class="px-4 py-2 border border-emerald-200 text-emerald-600 rounded-xl text-sm transition hover:bg-emerald-50 dark:border-emerald-900/30 dark:text-emerald-400 dark:hover:bg-emerald-900/20 flex items-center justify-center"><i data-lucide="file-bar-chart" class="w-4 h-4 mr-1"></i> 手动发送日报</button>
                </div>
              </div>
              
              <div id="set-account" class="hidden">
                <h3 class="font-bold mb-4 text-slate-900 dark:text-white">系统账号与安全</h3>
                <label class="block text-sm text-slate-500 mb-1">免密登录有效天数 (管理员 JWT)</label>
                <input type="number" id="cfg-jwt-days" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-4 dark:text-white" value="30">
                
                <h3 class="font-bold mb-4 border-t border-slate-200 dark:border-slate-800 pt-4 text-slate-900 dark:text-white">Cloudflare 联动</h3>
                <label class="block text-sm text-slate-500 mb-1">Cloudflare 账号 ID</label>
                <input type="text" id="cfg-cf-account" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-3 dark:text-white">
                <label class="block text-sm text-slate-500 mb-1">Cloudflare Zone ID (区域ID，用于面板数据与清理缓存)</label>
                <input type="text" id="cfg-cf-zone" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-3 dark:text-white">
                <label class="block text-sm text-slate-500 mb-1">Cloudflare API 令牌</label>
                <input type="password" id="cfg-cf-token" class="w-full p-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none mb-3 dark:text-white">
                <div class="flex gap-2 mb-6">
                    <button onclick="App.saveSettings('account')" class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-sm transition">保存账号设置</button>
                    <button onclick="App.purgeCache()" class="px-4 py-2 border border-red-200 text-red-600 rounded-xl text-sm transition hover:bg-red-50 dark:border-red-900/30 dark:hover:bg-red-900/20">一键清理全站缓存 (Purge)</button>
                </div>

                <h3 class="font-bold mb-4 border-t border-slate-200 dark:border-slate-800 pt-4 text-slate-900 dark:text-white">备份与恢复 (全量 KV 数据)</h3>
                <p class="text-sm text-slate-500 mb-4">导出或导入系统内的所有节点以及全局设置数据（单文件）。</p>
                <div class="flex gap-4">
                  <button onclick="document.getElementById('import-full-file').click()" class="px-4 py-2 bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-xl text-sm transition font-medium"><i data-lucide="upload" class="w-4 h-4 inline mr-1"></i> 导入完整备份</button>
                  <button onclick="App.exportFull()" class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-xl text-sm transition font-medium"><i data-lucide="download" class="w-4 h-4 inline mr-1"></i> 导出完整备份</button>
                </div>
              </div>
              
           </div>
        </div>
      </div>

    </div>
  </main>

  <dialog id="node-modal" class="backdrop:bg-slate-950/60 bg-transparent w-11/12 md:w-full max-w-xl m-auto p-0">
    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-2xl">
      <h2 class="text-xl font-bold mb-4 text-slate-900 dark:text-white" id="node-modal-title">新建节点</h2>
     <form onsubmit="App.saveNode(event)" class="space-y-4 max-h-[calc(80vh-env(safe-area-inset-bottom)-env(safe-area-inset-top))] overflow-y-auto pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[max(0.5rem,env(safe-area-inset-right))]">
        <input type="hidden" id="form-original-name">
        <div><label class="block text-sm text-slate-500 mb-1">节点名称</label><input type="text" id="form-name" class="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 outline-none text-sm text-slate-900 dark:text-white" required></div>
        <div><label class="block text-sm text-slate-500 mb-1">目标源站 (Target)</label><input type="url" id="form-target" class="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none text-sm text-slate-900 dark:text-white" required></div>
        
        <div><label class="block text-sm text-slate-500 mb-1">访问鉴权 (Secret, 可留空)</label><input type="text" id="form-secret" class="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none text-sm text-slate-900 dark:text-white"></div>
        
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div><label class="block text-sm text-slate-500 mb-1">标签</label><input type="text" id="form-tag" class="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none text-sm text-slate-900 dark:text-white"></div>
          <div><label class="block text-sm text-slate-500 mb-1">备注</label><input type="text" id="form-remark" class="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none text-sm text-slate-900 dark:text-white"></div>
        </div>
        
        <div class="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-100 dark:border-slate-800">
          <label class="block text-sm font-medium mb-2 text-slate-900 dark:text-white">自定义请求头 (覆盖或新增)</label>
          <div id="headers-container" class="space-y-2 mb-3"></div>
          <button type="button" onclick="App.addHeaderRow()" class="text-xs font-medium text-brand-600 hover:text-brand-700 bg-brand-50 dark:bg-brand-500/10 dark:text-brand-400 px-3 py-1.5 rounded-lg transition">+ 添加请求头</button>
        </div>

        <div class="flex gap-3 mt-6 sticky bottom-0 bg-white dark:bg-slate-900 py-3 border-t border-slate-100 dark:border-slate-800 z-10 shadow-[0_-10px_15px_-3px_rgba(0,0,0,0.05)] dark:shadow-none">
           <button type="button" onclick="document.getElementById('node-modal').close()" class="flex-1 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-900 dark:text-white transition shadow-sm">取消</button>
           <button type="submit" class="flex-1 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition shadow-sm">保存</button>
        </div>
      </form>
    </div>
  </dialog>

  <script>
    const App = {
      nodes: [],
      settingsSourceDirectNodes: [],
      nodeHealth: {},
      logPage: 1,
      logTotalPages: 1,
      dashboardSeries: [],
      loginPromise: null,
      chart: null,

      safeCreateIcons(opts = {}) {
          if (typeof window.lucide !== 'undefined') {
              window.lucide.createIcons(opts);
          }
      },

      simpleHash(str) {
        const input = String(str || "");
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
          hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
        }
        return String(hash >>> 0).toString(36);
      },

      safeDomId(prefix, value) {
        const base = String(value || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "node";
        return prefix + "-" + base + "-" + this.simpleHash(value);
      },

      buildNodeLink(node) {
        const encodedName = encodeURIComponent(String(node.name || ""));
        const encodedSecret = node.secret ? "/" + encodeURIComponent(String(node.secret)) : "";
        return window.location.origin + "/" + encodedName + encodedSecret;
      },
      normalizeNodeNameList(value) {
        const rawList = Array.isArray(value) ? value : String(value || '').split(/[\\r\\n,，;；|]+/);
        const seen = new Set();
        const result = [];
        rawList.forEach(item => {
          const name = String(item || '').trim();
          if (!name) return;
          const key = name.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          result.push(name);
        });
        return result;
      },

      updateSourceDirectNodesSummary() {
        const summary = document.getElementById('cfg-source-direct-nodes-summary');
        if (!summary) return;
        const total = Array.isArray(this.nodes) ? this.nodes.length : 0;
        const selectedCount = this.normalizeNodeNameList(this.settingsSourceDirectNodes).length;
        summary.textContent = total ? ('已选 ' + selectedCount + ' / ' + total + ' 个节点作为源站直连') : ('已选 ' + selectedCount + ' 个节点');
      },

      renderSourceDirectNodesPicker(selectedNames) {
        if (selectedNames !== undefined) {
          this.settingsSourceDirectNodes = this.normalizeNodeNameList(selectedNames);
        } else {
          this.settingsSourceDirectNodes = this.normalizeNodeNameList(this.settingsSourceDirectNodes);
        }

        const container = document.getElementById('cfg-source-direct-nodes-list');
        if (!container) return;
        const keyword = String(document.getElementById('cfg-direct-node-search')?.value || '').trim().toLowerCase();
        const nodes = Array.isArray(this.nodes) ? this.nodes.slice() : [];
        const selectedSet = new Set(this.settingsSourceDirectNodes.map(name => String(name).toLowerCase()));
        const filteredNodes = nodes
          .filter(node => {
            if (!keyword) return true;
            const haystack = (String(node?.name || '') + ' ' + String(node?.tag || '') + ' ' + String(node?.remark || '')).toLowerCase();
            return haystack.includes(keyword);
          })
          .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-Hans-CN'));

        container.innerHTML = '';

        if (!nodes.length) {
          const empty = document.createElement('div');
          empty.className = 'text-sm text-slate-500 px-3 py-2';
          empty.textContent = '暂无可选节点';
          container.appendChild(empty);
          this.updateSourceDirectNodesSummary();
          return;
        }

        if (!filteredNodes.length) {
          const empty = document.createElement('div');
          empty.className = 'text-sm text-slate-500 px-3 py-2';
          empty.textContent = '没有匹配的节点';
          container.appendChild(empty);
          this.updateSourceDirectNodesSummary();
          return;
        }

        filteredNodes.forEach(node => {
          const wrapper = document.createElement('label');
          wrapper.className = 'flex items-start gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 px-3 py-2 cursor-pointer';

          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'mt-1 w-4 h-4 rounded';
          checkbox.checked = selectedSet.has(String(node?.name || '').toLowerCase());
          checkbox.onchange = () => {
            const set = new Set(this.normalizeNodeNameList(this.settingsSourceDirectNodes).map(name => String(name).toLowerCase()));
            const originalNames = new Map(this.normalizeNodeNameList(this.settingsSourceDirectNodes).map(name => [String(name).toLowerCase(), name]));
            const nodeName = String(node?.name || '').trim();
            const nodeKey = nodeName.toLowerCase();
            if (checkbox.checked) {
              set.add(nodeKey);
              originalNames.set(nodeKey, nodeName);
            } else {
              set.delete(nodeKey);
              originalNames.delete(nodeKey);
            }
            this.settingsSourceDirectNodes = Array.from(set).map(key => originalNames.get(key) || key);
            this.updateSourceDirectNodesSummary();
          };

          const content = document.createElement('div');
          content.className = 'min-w-0 flex-1';
          const title = document.createElement('div');
          title.className = 'text-sm font-medium text-slate-900 dark:text-white truncate';
          title.textContent = node?.name || '未命名节点';
          const meta = document.createElement('div');
          meta.className = 'text-xs text-slate-500 mt-1 break-all';
          const metaParts = [];
          if (node?.tag) metaParts.push('标签: ' + node.tag);
          if (node?.remark) metaParts.push('备注: ' + node.remark);
          meta.textContent = metaParts.length ? metaParts.join('  ·  ') : '无标签 / 备注';
          content.appendChild(title);
          content.appendChild(meta);

          wrapper.appendChild(checkbox);
          wrapper.appendChild(content);
          container.appendChild(wrapper);
        });

        this.updateSourceDirectNodesSummary();
      },

      validateTargets(targetValue) {
        const targets = String(targetValue || "").split(",").map(function (item) { return item.trim(); }).filter(Boolean);
        if (!targets.length) return false;
        return targets.every(function (item) {
          try {
            const url = new URL(item);
            return url.protocol === "http:" || url.protocol === "https:";
          } catch {
            return false;
          }
        });
      },

      async promptLogin() {
        if (this.loginPromise) return this.loginPromise;
        this.loginPromise = (async () => {
          const pass = window.prompt("请输入管理员密码:");
          if (!pass) throw new Error("LOGIN_CANCELLED");
          const res = await fetch("/api/auth/login", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: pass })
          });
          const data = await res.json().catch(function () { return {}; });
          if (!res.ok || (!data.ok && !data.token)) throw new Error((data.error && data.error.message) || "登录失败");
          return true;
        })();
        try { return await this.loginPromise; } finally { this.loginPromise = null; }
      },
      
      init() {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'light') { document.documentElement.classList.remove('dark'); }
        else if (savedTheme === 'dark') { document.documentElement.classList.add('dark'); }
        else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) { document.documentElement.classList.add('dark'); }
        
        this.safeCreateIcons();
        window.onhashchange = () => this.route();
        this.route();
        
        // Time Cone Sync: 每 60 秒异步刷新一次相对时间
        setInterval(() => this.updateTimeCones(), 60000);
      },

      toggleTheme() {
        const html = document.documentElement;
        html.classList.toggle('dark');
        localStorage.setItem('theme', html.classList.contains('dark') ? 'dark' : 'light');
      },
      
      async apiCall(action, payload={}) {
          const requestInit = {
              method: 'POST',
              credentials: 'same-origin',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({action, ...payload})
          };
          let res = await fetch('/admin', requestInit);
          if (res.status === 401) {
              await this.promptLogin();
              res = await fetch('/admin', requestInit);
          }
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error?.message || ('HTTP ' + res.status));
          return data;
      },

      toggleSidebar() {
        const sb = document.getElementById('sidebar');
        const bd = document.getElementById('sidebar-backdrop');
        sb.classList.toggle('-translate-x-full');
        if(sb.classList.contains('-translate-x-full')) bd.classList.add('hidden');
        else bd.classList.remove('hidden');
      },
      
      route() {
        const hash = window.location.hash || '#dashboard';
        document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.nav-item').forEach(el => { el.classList.remove('bg-brand-50', 'text-brand-600', 'dark:bg-brand-500/10', 'dark:text-brand-400'); });

        const view = document.getElementById('view-' + hash.replace('#',''));
        if (view) view.classList.add('active');

        const activeNav = document.querySelector('a[href="' + hash + '"]');
        if (activeNav) activeNav.classList.add('bg-brand-50', 'text-brand-600', 'dark:bg-brand-500/10', 'dark:text-brand-400');

        const titles = {'#dashboard':'仪表盘', '#nodes':'节点列表', '#logs':'日志记录', '#settings':'全局设置'};
        document.getElementById('page-title').textContent = titles[hash] || 'Emby Proxy';

        // 移动端体验优化：切换菜单后自动收起侧边栏
        const sb = document.getElementById('sidebar');
        if (sb && !sb.classList.contains('-translate-x-full') && window.innerWidth < 768) {
            this.toggleSidebar();
        }

        if (hash === '#dashboard') this.loadDashboard();
        if (hash === '#nodes') this.loadNodes();
        if (hash === '#logs') this.loadLogs(1);
        if (hash === '#settings') this.loadSettings();
      },

      switchSetTab(event, id) {
        document.querySelectorAll('.set-tab').forEach(el => {
          el.classList.remove('bg-brand-50', 'text-brand-600', 'dark:bg-brand-500/10', 'dark:text-brand-400');
          el.classList.add('text-slate-500');
        });
        if (event && event.currentTarget) event.currentTarget.classList.add('bg-brand-50', 'text-brand-600', 'dark:bg-brand-500/10', 'dark:text-brand-400');
        document.querySelectorAll('#settings-forms > div').forEach(el => el.classList.add('hidden'));
        document.getElementById('set-' + id).classList.remove('hidden');
      },

      async loadDashboard() {
         try {
             const data = await this.apiCall('getDashboardStats');
             document.getElementById('dash-req-count').textContent = data.todayRequests || 0;
             document.getElementById('dash-traffic-count').textContent = data.todayTraffic || '0 B';
             document.getElementById('dash-node-count').textContent = data.nodeCount || 0;
             const reqHint = document.getElementById('dash-req-hint');
             if (reqHint) {
               const hint = data.requestSourceText || '今日请求量口径：未知';
               reqHint.textContent = hint || ' ';
               reqHint.title = [data.requestSourceText || '', data.cfAnalyticsDetail || ''].filter(Boolean).join(' | ');
             }
             const reqCount = document.getElementById('dash-req-count');
             if (reqCount) reqCount.title = [data.requestSourceText || '', data.cfAnalyticsDetail || ''].filter(Boolean).join(' | ');
             
             const embyMetrics = document.getElementById('dash-emby-metrics');
             if (embyMetrics) {
                 let accSecs = Math.floor((data.totalAccMs || 0) / 1000);
                 let accHrs = Math.floor(accSecs / 3600);
                 let accMins = Math.floor((accSecs % 3600) / 60);
                 let accRemSecs = accSecs % 60;
                 embyMetrics.textContent = '请求: 播放请求 ' + (data.playCount || 0) + ' 次 | 获取播放信息 ' + (data.infoCount || 0) + ' 次 ，共加速时长: ' + accHrs + '小时' + accMins + '分钟' + accRemSecs + '秒';
             }

             const trafficHint = document.getElementById('dash-traffic-hint');
             if (trafficHint) {
               const hint = data.trafficSourceText || data.cfAnalyticsStatus || data.cfAnalyticsError || '';
               trafficHint.textContent = hint || ' ';
               trafficHint.title = [data.trafficSourceText || '', data.cfAnalyticsStatus || '', data.cfAnalyticsError || '', data.cfAnalyticsDetail || ''].filter(Boolean).join(' | ');
             }
             const trafficDetail = document.getElementById('dash-traffic-detail');
             if (trafficDetail) {
               const detailLines = [data.cfAnalyticsStatus, data.cfAnalyticsError, data.cfAnalyticsDetail].filter(Boolean);
               trafficDetail.textContent = detailLines.length ? detailLines.join('\\n') : ' ';
             }
             const trafficCount = document.getElementById('dash-traffic-count');
             if (trafficCount) trafficCount.title = [data.trafficSourceText || '', data.cfAnalyticsStatus || '', data.cfAnalyticsError || '', data.cfAnalyticsDetail || ''].filter(Boolean).join(' | ');
             this.dashboardSeries = Array.isArray(data.hourlySeries) ? data.hourlySeries : [];
             this.renderChart();
         } catch(e) {
             const reqHint = document.getElementById('dash-req-hint');
             if (reqHint) reqHint.textContent = '加载仪表盘失败';
             const trafficHint = document.getElementById('dash-traffic-hint');
             if (trafficHint) trafficHint.textContent = '加载仪表盘失败';
             const trafficDetail = document.getElementById('dash-traffic-detail');
             if (trafficDetail) trafficDetail.textContent = e?.message || '未知错误';
         }
      },

      renderChart() {
        const ctx = document.getElementById('trafficChart');
        if (!ctx) return;
        if (this.chart) this.chart.destroy();
        const fallbackSeries = Array.from({ length: 24 }, (_, hour) => ({ label: String(hour).padStart(2, '0') + ':00', total: 0 }));
        const series = this.dashboardSeries.length ? this.dashboardSeries : fallbackSeries;
        this.chart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: series.map(item => item.label),
            datasets: [{ label: '请求趋势', data: series.map(item => item.total), borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)', fill: true, tension: 0.35 }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              y: { min: 0, suggestedMax: 10, ticks: { precision: 0 }, title: { display: true, text: '请求总次数' } },
              x: { title: { display: true, text: '小时（UTC+8）' } }
            }
          }
        });
      },

      async loadSettings() {
          const [configRes, nodesRes] = await Promise.all([
              this.apiCall('loadConfig'),
              this.apiCall('list').catch(() => ({ nodes: this.nodes || [] }))
          ]);
          const cfg = configRes.config || { enableH2: false, enableH3: false, peakDowngrade: true, protocolFallback: true, sourceSameOriginProxy: true, forceExternalProxy: true };
          if (Array.isArray(nodesRes.nodes)) this.nodes = nodesRes.nodes;
          
          document.getElementById('cfg-enable-h2').checked = !!cfg.enableH2;
          document.getElementById('cfg-enable-h3').checked = !!cfg.enableH3;
          document.getElementById('cfg-peak-downgrade').checked = cfg.peakDowngrade !== false; 
          document.getElementById('cfg-protocol-fallback').checked = cfg.protocolFallback !== false; 
          document.getElementById('cfg-source-same-origin-proxy').checked = cfg.sourceSameOriginProxy !== false;
          document.getElementById('cfg-force-external-proxy').checked = cfg.forceExternalProxy !== false;
          document.getElementById('cfg-wangpandirect').value = cfg.wangpandirect || '${DEFAULT_WANGPAN_DIRECT_TEXT}';
          document.getElementById('cfg-direct-node-search').value = '';
          this.settingsSourceDirectNodes = this.normalizeNodeNameList(cfg.sourceDirectNodes || cfg.directSourceNodes || cfg.nodeDirectList || []);
          this.renderSourceDirectNodesPicker(this.settingsSourceDirectNodes);
          document.getElementById('cfg-ping-timeout').value = cfg.pingTimeout || 5000;
          
          document.getElementById('cfg-geo-allow').value = cfg.geoAllowlist || '';
          document.getElementById('cfg-geo-block').value = cfg.geoBlocklist || '';
          document.getElementById('cfg-ip-black').value = cfg.ipBlacklist || '';
          document.getElementById('cfg-rate-limit').value = cfg.rateLimitRpm || '';
          document.getElementById('cfg-cache-ttl').value = cfg.cacheTtlImages || 30;
          document.getElementById('cfg-cors').value = cfg.corsOrigins || '';
          
          document.getElementById('cfg-log-days').value = cfg.logRetentionDays || 7;
          document.getElementById('cfg-log-delay').value = Number.isFinite(Number(cfg.logWriteDelayMinutes)) ? Number(cfg.logWriteDelayMinutes) : 1;
          document.getElementById('cfg-tg-token').value = cfg.tgBotToken || '';
          document.getElementById('cfg-tg-chatid').value = cfg.tgChatId || '';
          
          document.getElementById('cfg-jwt-days').value = cfg.jwtExpiryDays || 30;
          document.getElementById('cfg-cf-account').value = cfg.cfAccountId || '';
          document.getElementById('cfg-cf-zone').value = cfg.cfZoneId || '';
          document.getElementById('cfg-cf-token').value = cfg.cfApiToken || '';
      },

      async saveSettings(section) {
          const res = await this.apiCall('loadConfig');
          let newConfig = res.config || {};
          
          if(section === 'proxy') {
              newConfig.enableH2 = document.getElementById('cfg-enable-h2').checked;
              newConfig.enableH3 = document.getElementById('cfg-enable-h3').checked;
              newConfig.peakDowngrade = document.getElementById('cfg-peak-downgrade').checked;
              newConfig.protocolFallback = document.getElementById('cfg-protocol-fallback').checked;
              newConfig.sourceSameOriginProxy = document.getElementById('cfg-source-same-origin-proxy').checked;
              newConfig.forceExternalProxy = document.getElementById('cfg-force-external-proxy').checked;
              newConfig.wangpandirect = document.getElementById('cfg-wangpandirect').value.trim();
              newConfig.sourceDirectNodes = this.normalizeNodeNameList(this.settingsSourceDirectNodes);
              newConfig.pingTimeout = parseInt(document.getElementById('cfg-ping-timeout').value) || 5000;
          } else if(section === 'security') {
              newConfig.geoAllowlist = document.getElementById('cfg-geo-allow').value;
              newConfig.geoBlocklist = document.getElementById('cfg-geo-block').value;
              newConfig.ipBlacklist = document.getElementById('cfg-ip-black').value;
              newConfig.rateLimitRpm = parseInt(document.getElementById('cfg-rate-limit').value) || 0;
              newConfig.cacheTtlImages = parseInt(document.getElementById('cfg-cache-ttl').value) || 30;
              newConfig.corsOrigins = document.getElementById('cfg-cors').value;
          } else if(section === 'logs') {
              newConfig.logRetentionDays = parseInt(document.getElementById('cfg-log-days').value) || 7;
              const logDelayMinutes = parseFloat(document.getElementById('cfg-log-delay').value);
              newConfig.logWriteDelayMinutes = Number.isFinite(logDelayMinutes) ? Math.max(0, logDelayMinutes) : 1;
              newConfig.tgBotToken = document.getElementById('cfg-tg-token').value.trim();
              newConfig.tgChatId = document.getElementById('cfg-tg-chatid').value.trim();
          } else if(section === 'account') {
              newConfig.jwtExpiryDays = parseInt(document.getElementById('cfg-jwt-days').value) || 30;
              newConfig.cfAccountId = document.getElementById('cfg-cf-account').value.trim();
              newConfig.cfZoneId = document.getElementById('cfg-cf-zone').value.trim();
              newConfig.cfApiToken = document.getElementById('cfg-cf-token').value.trim();
          }
          
          await this.apiCall('saveConfig', { config: newConfig });
          alert("设置已保存，立即生效");
      },
      
      async testTelegram() {
          const botToken = document.getElementById('cfg-tg-token').value.trim();
          const chatId = document.getElementById('cfg-tg-chatid').value.trim();
          
          if (!botToken || !chatId) {
              alert("请先填写完整的 Telegram Bot Token 和 Chat ID！");
              return;
          }
          
          const res = await this.apiCall('testTelegram', { tgBotToken: botToken, tgChatId: chatId });
          if (res.success) {
              alert("测试通知已发送！请查看您的 Telegram 客户端。");
          } else {
              alert("发送失败: " + (res.error?.message || "未知网络错误"));
          }
      },
      
      async sendDailyReport() {
          try {
              const res = await this.apiCall('sendDailyReport');
              if (res.success) {
                  alert("日报已成功生成并发送到 Telegram！");
              } else {
                  alert("发送失败: " + (res.error?.message || "未知网络错误"));
              }
          } catch(e) {
              alert("发送失败: " + e.message);
          }
      },

      async purgeCache() {
          const res = await this.apiCall('purgeCache');
          if (res.success) alert("边缘缓存已成功清空！");
          else alert("清空失败: " + (res.error?.message || "请检查 Zone ID 和 Token"));
      },

      async loadNodes() {
          const res = await this.apiCall('list');
          if(res.nodes) { this.nodes = res.nodes; this.renderNodesGrid(); }
      },

      async forceHealthCheck(event) {
          const btn = event.currentTarget;
          const originalHtml = btn.innerHTML;
          btn.innerHTML = \`<i data-lucide="loader" class="w-4 h-4 mr-2 animate-spin"></i> 探测中...\`;
          this.safeCreateIcons({root: btn.parentElement});
          await this.checkAllNodesHealth();
          btn.innerHTML = originalHtml;
          this.safeCreateIcons({root: btn.parentElement});
      },

      async checkSingleNodeHealth(name, btnEl) {
          const originalHtml = btnEl.innerHTML;
          // 修复：使用单引号，防止截断外部的 UI_HTML 模板字符串
          btnEl.innerHTML = '<i data-lucide="loader" class="w-4 h-4 animate-spin"></i>';
          this.safeCreateIcons({root: btnEl.parentElement});
          
          try {
             // 🌟 走 Worker API 测算真实的 CF 边缘到源站延迟
             const timeout = parseInt(document.getElementById('cfg-ping-timeout')?.value) || 5000;
             const res = await this.apiCall('pingNode', { name, timeout });
             this.updateNodeCardStatus(name, res.ms || 9999);
          } catch(e) {
             this.updateNodeCardStatus(name, 9999);
          }
          
          btnEl.innerHTML = originalHtml;
          this.safeCreateIcons({root: btnEl.parentElement});
      },

      async checkAllNodesHealth() {
          const timeout = parseInt(document.getElementById('cfg-ping-timeout')?.value) || 5000;
          for(let n of this.nodes) {
             try {
                const res = await this.apiCall('pingNode', { name: n.name, timeout });
                this.updateNodeCardStatus(n.name, res.ms || 9999);
             } catch(e) {
                this.updateNodeCardStatus(n.name, 9999);
             }
          }
      },
      
      updateNodeCardStatus(name, ms) {
          const dot = document.getElementById(this.safeDomId('dot', name));
          const title = document.getElementById(this.safeDomId('title', name));
          const txt = document.getElementById(this.safeDomId('lat', name));
          if (!dot || !title || !txt) return;
          let color = '#ffffff';
          if (ms <= 150) color = '#2ECC71';
          else if (ms <= 200) color = '#F1C40F';
          else if (ms <= 300) color = '#E67E22';
          else color = '#E74C3C';

          dot.style.backgroundColor = color;
          dot.style.boxShadow = '0 0 8px ' + color;
          txt.textContent = ms > 5000 ? 'Timeout' : (ms + ' ms');
          if (ms > 300) this.nodeHealth[name] = (this.nodeHealth[name] || 0) + 1;
          else this.nodeHealth[name] = 0;
          if (this.nodeHealth[name] > 3) title.classList.add('text-red-500');
          else title.classList.remove('text-red-500');
      },

      renderNodesGrid() {
        const keyword = document.getElementById('node-search')?.value.toLowerCase() || '';
        const filteredNodes = this.nodes.filter(n => n.name.toLowerCase().includes(keyword) || (n.tag && n.tag.toLowerCase().includes(keyword)));
        const grid = document.getElementById('nodes-grid');
        grid.innerHTML = '';

        if (!filteredNodes.length) {
          const empty = document.createElement('div');
          empty.className = 'col-span-full py-12 text-center text-slate-500';
          empty.textContent = '暂无匹配节点';
          grid.appendChild(empty);
          return;
        }

        const fragment = document.createDocumentFragment();
        filteredNodes.forEach(n => {
          const link = this.buildNodeLink(n);
          const dotId = this.safeDomId('dot', n.name);
          const titleId = this.safeDomId('title', n.name);
          const latId = this.safeDomId('lat', n.name);
          const linkId = this.safeDomId('link', n.name);

          const card = document.createElement('div');
          card.className = 'glass-card p-6 rounded-3xl flex flex-col justify-between';

          const top = document.createElement('div');
          const headerRow = document.createElement('div');
          headerRow.className = 'flex items-center mb-1 w-full';
          const dot = document.createElement('span');
          dot.id = dotId;
          dot.className = 'w-3 h-3 rounded-full mr-3 bg-white transition-colors duration-500 flex-shrink-0';
          const title = document.createElement('h3');
          title.id = titleId;
          title.className = 'font-semibold text-lg transition-colors flex-1 min-w-0 truncate';
          title.textContent = n.name;
          headerRow.appendChild(dot);
          headerRow.appendChild(title);

          const metaRow = document.createElement('div');
          metaRow.className = 'text-xs text-slate-400 mb-2 flex justify-between tracking-wider';
          const pingLabel = document.createElement('span');
          pingLabel.textContent = 'Ping: ';
          const pingValue = document.createElement('span');
          pingValue.id = latId;
          pingValue.textContent = '--';
          pingLabel.appendChild(pingValue);
          const shield = document.createElement('span');
          shield.className = 'truncate ml-2 text-right';
          const shieldIcon = document.createElement('i');
          shieldIcon.setAttribute('data-lucide', 'shield');
          shieldIcon.className = 'w-3 h-3 inline';
          shield.appendChild(shieldIcon);
          shield.appendChild(document.createTextNode(' ' + (n.secret ? '已防护' : '未防护')));
          metaRow.appendChild(pingLabel);
          metaRow.appendChild(shield);

          const detailWrap = document.createElement('div');
          detailWrap.className = 'text-xs text-slate-500 dark:text-slate-400 mb-3 space-y-1';
          const tagRow = document.createElement('div');
          tagRow.className = 'flex items-center min-w-0';
          const tagIcon = document.createElement('i');
          tagIcon.setAttribute('data-lucide', 'tag');
          tagIcon.className = 'w-3 h-3 mr-1.5 flex-shrink-0 text-brand-500';
          const tagText = document.createElement('span');
          tagText.className = 'truncate flex-1 min-w-0';
          tagText.textContent = n.tag || '无标签';
          tagRow.appendChild(tagIcon);
          tagRow.appendChild(tagText);
          const remarkRow = document.createElement('div');
          remarkRow.className = 'flex items-center min-w-0';
          const remarkIcon = document.createElement('i');
          remarkIcon.setAttribute('data-lucide', 'file-text');
          remarkIcon.className = 'w-3 h-3 mr-1.5 flex-shrink-0 text-purple-500';
          const remarkText = document.createElement('span');
          remarkText.className = 'truncate flex-1 min-w-0';
          remarkText.textContent = n.remark || '无备注';
          remarkRow.appendChild(remarkIcon);
          remarkRow.appendChild(remarkText);
          detailWrap.appendChild(tagRow);
          detailWrap.appendChild(remarkRow);

          top.appendChild(headerRow);
          top.appendChild(metaRow);
          top.appendChild(detailWrap);

          const bottom = document.createElement('div');
          const linkWrap = document.createElement('div');
          linkWrap.className = 'flex items-center bg-slate-100 dark:bg-slate-800 p-2 rounded-xl mb-4 border border-slate-200 dark:border-slate-700';
          const linkInput = document.createElement('input');
          linkInput.type = 'password';
          linkInput.id = linkId;
          linkInput.readOnly = true;
          linkInput.value = link;
          linkInput.className = 'bg-transparent border-none flex-1 min-w-0 text-xs outline-none text-slate-600 dark:text-slate-300';
          const toggleBtn = document.createElement('button');
          toggleBtn.type = 'button';
          toggleBtn.className = 'text-slate-400 hover:text-brand-500 ml-2';
          const toggleIcon = document.createElement('i');
          toggleIcon.setAttribute('data-lucide', 'eye');
          toggleIcon.className = 'w-4 h-4';
          toggleBtn.appendChild(toggleIcon);
          toggleBtn.addEventListener('click', () => {
            linkInput.type = linkInput.type === 'password' ? 'text' : 'password';
          });
          linkWrap.appendChild(linkInput);
          linkWrap.appendChild(toggleBtn);

          const actions = document.createElement('div');
          actions.className = 'flex gap-2';

          const pingBtn = document.createElement('button');
          pingBtn.type = 'button';
          pingBtn.className = 'px-3 border border-emerald-200 dark:border-emerald-800/50 text-emerald-600 dark:text-emerald-400 rounded-xl hover:bg-emerald-50 dark:hover:bg-emerald-900/30 transition flex items-center justify-center flex-shrink-0';
          pingBtn.title = '独立节点测速';
          const pingIconBtn = document.createElement('i');
          pingIconBtn.setAttribute('data-lucide', 'activity');
          pingIconBtn.className = 'w-4 h-4';
          pingBtn.appendChild(pingIconBtn);
          pingBtn.addEventListener('click', (event) => this.checkSingleNodeHealth(n.name, event.currentTarget));

          const copyBtn = document.createElement('button');
          copyBtn.type = 'button';
          copyBtn.className = 'flex-1 py-2 text-sm font-medium border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition';
          copyBtn.textContent = '复制';
          copyBtn.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(link);
              alert('链接已复制到剪贴板');
            } catch {
              alert('复制失败，请手动复制');
            }
          });

          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'flex-1 py-2 text-sm font-medium bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400 rounded-xl hover:bg-brand-100 dark:hover:bg-brand-500/20 transition';
          editBtn.textContent = '编辑';
          editBtn.addEventListener('click', () => this.showNodeModal(n.name));

          const deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'px-3 border border-red-100 dark:border-red-900/30 text-red-500 rounded-xl hover:bg-red-50 dark:hover:bg-red-900/20 transition flex items-center justify-center flex-shrink-0';
          const deleteIcon = document.createElement('i');
          deleteIcon.setAttribute('data-lucide', 'trash-2');
          deleteIcon.className = 'w-4 h-4';
          deleteBtn.appendChild(deleteIcon);
          deleteBtn.addEventListener('click', () => {
            if (confirm('删除节点?')) this.deleteNode(n.name);
          });

          actions.appendChild(pingBtn);
          actions.appendChild(copyBtn);
          actions.appendChild(editBtn);
          actions.appendChild(deleteBtn);

          bottom.appendChild(linkWrap);
          bottom.appendChild(actions);

          card.appendChild(top);
          card.appendChild(bottom);
          fragment.appendChild(card);
        });

        grid.appendChild(fragment);
        this.safeCreateIcons({root: grid});
      },

      addHeaderRow(key = '', val = '') {
          const div = document.createElement('div');
          div.className = 'flex gap-2 items-center';

          const keyInput = document.createElement('input');
          keyInput.type = 'text';
          keyInput.placeholder = 'Name (e.g. User-Agent)';
          keyInput.value = key;
          keyInput.className = 'header-key flex-1 min-w-0 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 outline-none text-sm font-mono text-slate-900 dark:text-white';

          const valInput = document.createElement('input');
          valInput.type = 'text';
          valInput.placeholder = 'Value';
          valInput.value = val;
          valInput.className = 'header-val flex-1 min-w-0 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 outline-none text-sm font-mono text-slate-900 dark:text-white';

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'text-red-500 p-1.5 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition';
          const removeIcon = document.createElement('i');
          removeIcon.setAttribute('data-lucide', 'x');
          removeIcon.className = 'w-4 h-4';
          removeBtn.appendChild(removeIcon);
          removeBtn.addEventListener('click', () => div.remove());

          div.appendChild(keyInput);
          div.appendChild(valInput);
          div.appendChild(removeBtn);
          document.getElementById('headers-container').appendChild(div);
          this.safeCreateIcons({root: div});
      },

      showNodeModal(name='') {
        document.getElementById('node-modal-title').textContent = name ? '编辑节点' : '新建节点';
        const form = document.querySelector('#node-modal form'); form.reset();
        document.getElementById('headers-container').innerHTML = ''; 
        
        if(name) {
            const n = this.nodes.find(x => String(x.name) === String(name));
            if(n) {
                document.getElementById('form-original-name').value = n.name; 
                document.getElementById('form-name').value = n.name;
                document.getElementById('form-name').readOnly = false; 
                document.getElementById('form-target').value = n.target;
                document.getElementById('form-secret').value = n.secret || ''; 
                document.getElementById('form-tag').value = n.tag || '';
                document.getElementById('form-remark').value = n.remark || ''; 
                
                if (n.headers && typeof n.headers === 'object') {
                    for (const [k, v] of Object.entries(n.headers)) {
                        this.addHeaderRow(k, v);
                    }
                }
            }
        } else {
            document.getElementById('form-original-name').value = '';
            this.addHeaderRow(); 
        }
        document.getElementById('node-modal').showModal();
      },
      
      async saveNode(e) {
          e.preventDefault();
          let headersObj = {};
          const hKeys = document.querySelectorAll('.header-key');
          const hVals = document.querySelectorAll('.header-val');
          for(let i = 0; i < hKeys.length; i++) {
              const k = hKeys[i].value.trim();
              const v = hVals[i].value.trim();
              if(k) headersObj[k] = v;
          }
          
          const payload = {
              originalName: document.getElementById('form-original-name').value,
              name: document.getElementById('form-name').value.trim(),
              target: document.getElementById('form-target').value.trim(),
              secret: document.getElementById('form-secret').value.trim(),
              tag: document.getElementById('form-tag').value.trim(),
              remark: document.getElementById('form-remark').value.trim(),
              headers: headersObj
          };

          if (!this.validateTargets(payload.target)) {
              alert('目标源站必须是有效的 http/https URL，多个源站请用英文逗号分隔');
              return;
          }

          await this.apiCall('save', payload);
          document.getElementById('node-modal').close();
          this.loadNodes();
      },
      
      async deleteNode(name) {
          await this.apiCall('delete', {name});
          this.loadNodes();
      },
      
      formatRelativeTime(ts) {
          const diff = Math.floor((Date.now() - ts) / 60000);
          if (diff <= 0) return '刚刚';
          if (diff < 60) return diff + ' 分钟前';
          if (diff < 1440) return Math.floor(diff / 60) + ' 小时前';
          return Math.floor(diff / 1440) + ' 天前';
      },

      formatUtc8ExactTime(ts) {
          const time = Number(ts);
          if (!time) return '-';
          const date = new Date(time + 8 * 3600 * 1000);
          if (Number.isNaN(date.getTime())) return '-';
          const yyyy = date.getUTCFullYear();
          const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(date.getUTCDate()).padStart(2, '0');
          const hh = String(date.getUTCHours()).padStart(2, '0');
          const mi = String(date.getUTCMinutes()).padStart(2, '0');
          return 'UTC+8 ' + yyyy + '-' + mm + '-' + dd + ' ' + hh + ':' + mi;
      },
      
      updateTimeCones() {
          document.querySelectorAll('.log-time-cell').forEach(cell => {
              const ts = parseInt(cell.dataset.timestamp);
              if (ts) {
                cell.textContent = this.formatRelativeTime(ts);
                const exactTime = this.formatUtc8ExactTime(ts);
                cell.title = exactTime;
                cell.setAttribute('aria-label', exactTime);
              }
          });
      },

      formatResourceCategory(path, category) {
          const p = String(path || "").toLowerCase();
          if (category === 'error') return '<span class="text-red-500 bg-red-50 dark:bg-red-500/10 px-2 py-1.5 rounded-lg font-medium">请求报错</span>';
          if (category === 'segment' || p.includes('.ts') || p.includes('.m4s')) return '<span class="text-blue-600 bg-blue-50 dark:text-blue-400 dark:bg-blue-500/10 px-2 py-1.5 rounded-lg font-medium">视频流分片</span>';
          if (category === 'manifest' || p.includes('.m3u8') || p.includes('.mpd')) return '<span class="text-purple-600 bg-purple-50 dark:text-purple-400 dark:bg-purple-500/10 px-2 py-1.5 rounded-lg font-medium">播放列表</span>';
          if (category === 'stream' || p.includes('.mp4') || p.includes('.mkv') || p.includes('/stream') || p.includes('download=true')) return '<span class="text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-500/10 px-2 py-1.5 rounded-lg font-medium">视频数据</span>';
          if (category === 'image' || p.includes('/images/') || p.includes('/emby/covers/') || p.includes('.jpg') || p.includes('.png')) return '<span class="text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-500/10 px-2 py-1.5 rounded-lg font-medium">图片海报</span>';
          if (category === 'subtitle' || p.includes('.srt') || p.includes('.vtt') || p.includes('.ass')) return '<span class="text-indigo-600 bg-indigo-50 dark:text-indigo-400 dark:bg-indigo-500/10 px-2 py-1.5 rounded-lg font-medium">字幕文件</span>';
          if (category === 'prewarm') return '<span class="text-cyan-600 bg-cyan-50 dark:text-cyan-400 dark:bg-cyan-500/10 px-2 py-1.5 rounded-lg font-medium">连接预热</span>';
          if (category === 'websocket' || p.includes('websocket')) return '<span class="text-rose-600 bg-rose-50 dark:text-rose-400 dark:bg-rose-500/10 px-2 py-1.5 rounded-lg font-medium">长连接通讯</span>';
          
          if (p.includes('/sessions/playing')) return '<span class="text-slate-600 bg-slate-100 dark:text-slate-300 dark:bg-slate-800 px-2 py-1.5 rounded-lg font-medium">播放状态同步</span>';
          if (p.includes('/playbackinfo')) return '<span class="text-slate-600 bg-slate-100 dark:text-slate-300 dark:bg-slate-800 px-2 py-1.5 rounded-lg font-medium">播放信息获取</span>';
          if (p.includes('/users/authenticate')) return '<span class="text-pink-600 bg-pink-50 dark:text-pink-400 dark:bg-pink-500/10 px-2 py-1.5 rounded-lg font-medium">用户认证</span>';
          if (p.includes('/items/') || p.includes('/shows/') || p.includes('/movies/') || p.includes('/users/')) return '<span class="text-slate-600 bg-slate-100 dark:text-slate-300 dark:bg-slate-800 px-2 py-1.5 rounded-lg font-medium">媒体元数据</span>';
          
          return '<span class="text-slate-500 bg-slate-50 dark:text-slate-400 dark:bg-slate-800/50 px-2 py-1.5 rounded-lg font-medium">常规 API</span>';
      },

      async loadLogs(page = this.logPage) {
          const keyword = document.getElementById('log-search-input')?.value || '';
          const res = await this.apiCall('getLogs', {page: page, pageSize: 50, filters: { keyword }});
          if (res.logs) {
              this.logPage = res.page;
              this.logTotalPages = res.totalPages || 1;
              document.getElementById('log-page-info').textContent = this.logPage + ' / ' + this.logTotalPages;

              const tbody = document.getElementById('logs-tbody');
              tbody.innerHTML = '';
              if (!res.logs.length) {
                  const row = document.createElement('tr');
                  const cell = document.createElement('td');
                  cell.colSpan = 6;
                  cell.className = 'py-6 text-center text-slate-500';
                  cell.textContent = '暂无匹配日志记录';
                  row.appendChild(cell);
                  tbody.appendChild(row);
                  return;
              }

              res.logs.forEach(l => {
                  const row = document.createElement('tr');
                  row.className = 'border-b border-slate-100 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition';

                  const nodeCell = document.createElement('td');
                  nodeCell.className = 'py-3 px-4 font-medium truncate';
                  nodeCell.title = l.node_name;
                  nodeCell.textContent = l.node_name;

                  const pathCell = document.createElement('td');
                  pathCell.className = 'py-3 px-4 text-xs cursor-pointer truncate';
                  pathCell.title = l.request_path;
                  pathCell.innerHTML = this.formatResourceCategory(l.request_path, l.category);

                  const statusCell = document.createElement('td');
                  statusCell.className = 'py-3 px-4 font-bold truncate ' + (l.status_code >= 400 ? 'text-red-500' : 'text-emerald-500');
                  statusCell.textContent = String(l.status_code);

                  const ipCell = document.createElement('td');
                  ipCell.className = 'py-3 px-4 font-mono text-xs truncate';
                  ipCell.title = l.client_ip;
                  ipCell.textContent = l.client_ip;

                  const uaCell = document.createElement('td');
                  uaCell.className = 'py-3 px-4 text-xs text-slate-400 truncate';
                  uaCell.title = l.user_agent || '-';
                  uaCell.textContent = l.user_agent || '-';
                  
                  // Time Cone Cell
                  const timeCell = document.createElement('td');
                  timeCell.className = 'py-3 px-4 text-xs font-mono text-slate-500 truncate log-time-cell';
                  timeCell.dataset.timestamp = l.timestamp;
                  timeCell.textContent = this.formatRelativeTime(l.timestamp);
                  const exactTime = this.formatUtc8ExactTime(l.timestamp);
                  timeCell.title = exactTime;
                  timeCell.setAttribute('aria-label', exactTime);
                  timeCell.tabIndex = 0;

                  row.appendChild(nodeCell);
                  row.appendChild(pathCell);
                  row.appendChild(statusCell);
                  row.appendChild(ipCell);
                  row.appendChild(uaCell);
                  row.appendChild(timeCell);
                  tbody.appendChild(row);
              });
          }
      },

      changeLogPage(delta) {
          const newPage = this.logPage + delta;
          if(newPage >= 1 && newPage <= this.logTotalPages) {
              this.loadLogs(newPage);
          }
      },

      downloadJson(data, filename) {
          const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          a.click();
          URL.revokeObjectURL(url);
      },

      async exportNodes() {
          this.downloadJson(this.nodes, \`emby_nodes_\${new Date().getTime()}.json\`);
      },

      async importNodes(event) {
          const file = event.target.files[0];
          if(!file) return;
          const reader = new FileReader();
          reader.onload = async (e) => {
              try {
                  const data = JSON.parse(e.target.result);
                  const nodes = Array.isArray(data) ? data : (data.nodes || []);
                  if(!nodes.length) return alert('未找到有效的节点数据');
                  await this.apiCall('import', {nodes});
                  alert('节点导入成功');
                  this.loadNodes();
              } catch(err) { alert('文件解析失败'); }
          };
          reader.readAsText(file);
          event.target.value = '';
      },

      async exportFull() {
          const res = await this.apiCall('exportConfig');
          if(res) this.downloadJson(res, \`emby_proxy_full_backup_\${new Date().getTime()}.json\`);
      },

      async importFull(event) {
          const file = event.target.files[0];
          if(!file) return;
          const reader = new FileReader();
          reader.onload = async (e) => {
              try {
                  const data = JSON.parse(e.target.result);
                  if(!data.config && !data.nodes) return alert('无效的备份文件');
                  await this.apiCall('importFull', {config: data.config, nodes: data.nodes});
                  alert('完整数据导入成功，请刷新页面');
                  location.reload();
              } catch(err) { alert('文件解析失败'); }
          };
          reader.readAsText(file);
          event.target.value = '';
      }
    };
    
    document.addEventListener('DOMContentLoaded', async () => {
        try {
            await App.apiCall('loadConfig');
        } catch (e) {
            const message = e?.message || '未知错误';
            if (message !== 'LOGIN_CANCELLED') alert('身份验证失败或网络异常: ' + message);
            return;
        }
        
        try {
            App.init();
        } catch (e) {
            console.error("UI 初始化错误:", e);
        }
    });
  </script>
</body>
</html>`;

function renderLandingPage() {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Emby Proxy V18.0</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-950 flex items-center justify-center min-h-screen text-center"><div class="p-8 max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl"><div class="w-16 h-16 mx-auto bg-brand-500/20 rounded-2xl flex items-center justify-center text-blue-500 mb-6"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg></div><h1 class="text-3xl font-bold text-white mb-2">Emby Proxy V18.0</h1><p class="text-slate-400 mb-8">高性能媒体代理与分流中心</p><a href="/admin" class="block w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-medium transition">进入管理控制台</a></div></body></html>`;
  const headers = new Headers({ 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' });
  applySecurityHeaders(headers);
  headers.set('X-Frame-Options', 'DENY');
  return new Response(html, { headers });
}

export default {
  async fetch(request, env, ctx) {
    const dynamicCors = getCorsHeadersForResponse(env, request);
    const requestUrl = new URL(request.url);
    let segments;
    try { segments = requestUrl.pathname.split('/').filter(Boolean); }
    catch {
      const headers = new Headers(dynamicCors);
      applySecurityHeaders(headers);
      return new Response('Bad Request', { status: 400, headers });
    }

    const rootRaw = segments[0] || '';
    const root = safeDecodeSegment(rootRaw).toLowerCase();

    if (request.method === 'GET' && requestUrl.pathname === '/') return renderLandingPage();

    if (root === 'admin' && request.method === 'GET' && requestUrl.pathname.toLowerCase() === '/admin') {
      const headers = new Headers({ 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' });
      applySecurityHeaders(headers);
      return new Response(UI_HTML, { headers });
    }

    if (request.method === 'OPTIONS' && (requestUrl.pathname.toLowerCase().startsWith('/admin') || requestUrl.pathname.toLowerCase().startsWith('/api'))) {
      const headers = new Headers(dynamicCors);
      applySecurityHeaders(headers);
      if (headers.get('Access-Control-Allow-Origin') !== '*') mergeVaryHeader(headers, 'Origin');
      return new Response(null, { headers });
    }

    if (root === 'api' && segments[1] === 'auth' && segments[2] === 'login' && request.method === 'POST') return Auth.handleLogin(request, env);

    if (root === 'admin' && request.method === 'POST') {
      if (!(await Auth.verifyRequest(request, env))) return jsonError('UNAUTHORIZED', '未授权', 401);
      try {
        return await normalizeJsonApiResponse(await Database.handleApi(request, env, ctx));
      } catch (e) {
        return jsonError('INTERNAL_ERROR', 'Server Error', 500, { reason: e?.message || 'unknown_error' });
      }
    }

    if (root) {
      const nodeData = await Database.getNode(root, env, ctx);
      if (nodeData) {
        const secret = nodeData.secret;
        let valid = true;
        let prefixLen = 0;

        if (secret) {
          const secretRaw = segments[1] || '';
          if (safeDecodeSegment(secretRaw) === secret) prefixLen = 1 + rootRaw.length + 1 + secretRaw.length;
          else valid = false;
        } else {
          prefixLen = 1 + rootRaw.length;
        }

        if (valid) {
          let remaining = requestUrl.pathname.substring(prefixLen);
          if (remaining === '' && !requestUrl.pathname.endsWith('/')) {
            const redirectUrl = new URL(request.url);
            redirectUrl.pathname = redirectUrl.pathname + '/';
            const headers = new Headers({ 'Location': redirectUrl.toString(), 'Cache-Control': 'no-store' });
            applySecurityHeaders(headers);
            return new Response(null, { status: 301, headers });
          }
          if (remaining === '') remaining = '/';
          remaining = sanitizeProxyPath(remaining);
          return Proxy.handle(request, nodeData, remaining, root, secret, env, ctx, { requestUrl, corsHeaders: dynamicCors });
        }
      }
    }

    const headers = new Headers(dynamicCors);
    applySecurityHeaders(headers);
    if (headers.get('Access-Control-Allow-Origin') !== '*') mergeVaryHeader(headers, 'Origin');
    return new Response('Not Found', { status: 404, headers });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const db = Database.getDB(env);
      const kv = Database.getKV(env);
      if (!kv) return;
      
      try {
        const config = await kv.get(Database.CONFIG_KEY, { type: "json" }) || {};
        
        if (db) {
          try {
            const retentionDays = config.logRetentionDays || 7; 
            const expireTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
            await db.prepare("DELETE FROM proxy_logs WHERE timestamp < ?").bind(expireTime).run();
          } catch (dbErr) {
            console.error("Scheduled DB Cleanup Error: ", dbErr);
          }
        }
        
        const { tgBotToken, tgChatId } = config;
        if (tgBotToken && tgChatId) {
            await Database.sendDailyTelegramReport(env);
        }
      } catch (err) {
          console.error("Scheduled Task Error: ", err);
      }
    })());
  }
};
