import "server-only";
import { getRedis } from "@/lib/server/redis";
import { logger } from "@/lib/server/logger";

const memory = new Map<string, { count: number; expiresAt: number }>();
let redisUnavailableLogged = false;
let redisUnavailableUntil = 0;

function memoryRateLimit(key: string, limit: number, windowSeconds: number) {
  const now = Date.now();
  const current = memory.get(key);
  const bucket = !current || current.expiresAt <= now ? { count: 0, expiresAt: now + windowSeconds * 1000 } : current;
  bucket.count += 1;
  memory.set(key, bucket);
  if (memory.size > 10_000) {
    for (const [storedKey, value] of memory) if (value.expiresAt <= now) memory.delete(storedKey);
  }
  return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), resetSeconds: Math.max(0, Math.ceil((bucket.expiresAt - now) / 1000)) };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Redis rate limiter timed out.")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Use atomic Redis counters when ready; fall back locally if Redis is unavailable. */
export async function rateLimit(key: string, limit: number, windowSeconds: number) {
  if (process.env.REDIS_URL && Date.now() >= redisUnavailableUntil) {
    try {
      const redis = getRedis();
      if (redis.status === "wait") void redis.connect().catch(() => {});
      if (redis.status !== "ready") throw new Error("Redis is not ready for rate limiting.");
      const result = await withTimeout(redis.eval(
        "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return {count, redis.call('TTL', KEYS[1])}",
        1, key, windowSeconds,
      ) as Promise<[number, number]>, 1200);
      redisUnavailableLogged = false;
      redisUnavailableUntil = 0;
      const [count, ttl] = result.map(Number);
      return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetSeconds: Math.max(0, ttl) };
    } catch {
      redisUnavailableUntil = Date.now() + 5000;
      if (!redisUnavailableLogged) {
        logger.warn("Redis unavailable; using process-local rate limits until it reconnects");
        redisUnavailableLogged = true;
      }
    }
  }
  return memoryRateLimit(key, limit, windowSeconds);
}

/** Do not persist client IPs. Hash a transient network hint into a short-lived abuse key. */
export async function getAbuseKey(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || "unknown";
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  const digest = Array.from(new Uint8Array(bytes)).slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ratelimit:${digest}`;
}
