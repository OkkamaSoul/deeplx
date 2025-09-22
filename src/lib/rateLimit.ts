/**
 * Lightweight Token Bucket Rate Limiter for Cloudflare Worker
 * Optimized for minimal CPU usage
 */

interface Env {
  RATE_LIMIT_KV: KVNamespace;
  PROXY_URLS?: string;
}

interface RateLimitEntry {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

const DEFAULT_TOKENS_PER_MINUTE = 60; // лимит запросов на IP в минуту
const REFILL_RATE = DEFAULT_TOKENS_PER_MINUTE / 60; // токены в секунду
const CACHE_TTL = 15000; // 15 секунд для in-memory кэша

const rateCache = new Map<
  string,
  { tokens: number; lastRefill: number; lastUpdate: number }
>();

/**
 * Получить клиентский IP
 */
export function getClientIP(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * Проверка лимита по IP (token bucket)
 */
async function checkRateLimit(clientIP: string, env: Env): Promise<boolean> {
  const key = `rate:${clientIP}`;
  const now = Date.now();
  let tokens = DEFAULT_TOKENS_PER_MINUTE;
  let lastRefill = now;

  const cached = rateCache.get(key);
  if (cached && now - cached.lastUpdate < CACHE_TTL) {
    const timePassed = (now - cached.lastRefill) / 1000;
    tokens = Math.min(DEFAULT_TOKENS_PER_MINUTE, cached.tokens + timePassed * REFILL_RATE);
    lastRefill = cached.lastRefill;
  } else {
    // KV fallback, но без await
    env.RATE_LIMIT_KV.get(key, "json").then((existing: RateLimitEntry | null) => {
      if (existing) {
        const timePassed = (now - existing.lastRefill) / 1000;
        const kvTokens = Math.min(DEFAULT_TOKENS_PER_MINUTE, existing.tokens + timePassed * REFILL_RATE);
        rateCache.set(key, { tokens: kvTokens, lastRefill: existing.lastRefill, lastUpdate: now });
      }
    }).catch(() => {});
  }

  if (tokens < 1) {
    rateCache.set(key, { tokens, lastRefill: now, lastUpdate: now });
    // async KV update
    env.RATE_LIMIT_KV.put(key, JSON.stringify({ tokens, lastRefill: now }), { expirationTtl: 3600 }).catch(() => {});
    return false;
  }

  // consume token
  tokens -= 1;
  rateCache.set(key, { tokens, lastRefill: now, lastUpdate: now });
  env.RATE_LIMIT_KV.put(key, JSON.stringify({ tokens, lastRefill: now }), { expirationTtl: 3600 }).catch(() => {});
  return true;
}

/**
 * Проверка комбинированного лимита (клиент + прокси)
 */
export async function checkCombinedRateLimit(
  clientIP: string,
  proxyUrl: string | null,
  env: Env
): Promise<RateLimitResult> {
  const allowed = await checkRateLimit(clientIP, env);
  if (!allowed) return { allowed: false, reason: "Client rate limit exceeded" };

  // Простая проверка прокси лимита (по желанию)
  if (proxyUrl) {
    const proxyAllowed = await checkRateLimit(proxyUrl, env);
    if (!proxyAllowed) return { allowed: false, reason: "Proxy rate limit exceeded" };
  }

  return { allowed: true };
}
