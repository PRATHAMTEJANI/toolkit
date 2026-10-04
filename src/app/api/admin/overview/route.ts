import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/server/admin";
import { getConversionQueue } from "@/lib/server/queue";
import { getRedis } from "@/lib/server/redis";
import { getSupabase } from "@/lib/server/supabase";
import { logger } from "@/lib/server/logger";
import { getAbuseKey, rateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limit = await rateLimit(`${await getAbuseKey(request)}:admin`, 20, 60);
  if (!limit.allowed) return NextResponse.json({ error: "Too many dashboard requests." }, { status: 429, headers: { "Retry-After": String(limit.resetSeconds) } });
  if (!isAdminRequest(request)) return NextResponse.json({ error: "Dashboard access is not configured or the dashboard token is invalid." }, { status: 401 });
  try {
    const supabase = getSupabase();
    const { data: overview, error: overviewError } = await supabase.rpc("get_admin_analytics_overview");
    if (overviewError) throw overviewError;
    let queueStatus: { status: string; redis: string; waiting: number; active: number; delayed: number; failed: number; completed: number; paused: number; workers: number };
    try {
      const queue = getConversionQueue();
      const [counts, redisStatus, paused, workers] = await Promise.all([queue.getJobCounts("waiting", "active", "delayed", "failed", "completed"), getRedis().ping(), queue.isPaused(), queue.getWorkersCount()]);
      queueStatus = { status: "connected", redis: redisStatus, waiting: counts.waiting ?? 0, active: counts.active ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0, completed: counts.completed ?? 0, paused: paused ? 1 : 0, workers };
    } catch (queueError) {
      logger.warn({ error: queueError }, "admin dashboard could not read the processing queue");
      queueStatus = { status: "disconnected", redis: "ERROR", waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, paused: 0, workers: 0 };
    }
    return NextResponse.json({
      ...overview,
      queue: queueStatus,
      generatedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error({ error }, "admin dashboard aggregation failed");
    return NextResponse.json({ error: "Dashboard data is unavailable. Verify the Supabase schema and Redis connection." }, { status: 503 });
  }
}
