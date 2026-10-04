import { NextResponse } from "next/server";
import { z } from "zod";
import { getConversionQueue } from "@/lib/server/queue";
import { getSupabase } from "@/lib/server/supabase";
import { getRedis } from "@/lib/server/redis";
import { logger } from "@/lib/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ visitorId: z.string().uuid(), sessionId: z.string().uuid() });

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Valid visitor and session IDs are required." }, { status: 400 });
  try {
    const supabase = getSupabase();
    const { data: job, error } = await supabase.from("conversion_jobs").select("id,status").eq("id", jobId).eq("visitor_id", parsed.data.visitorId).eq("session_id", parsed.data.sessionId).maybeSingle();
    if (error) throw error;
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
    if (!["queued", "active"].includes(job.status)) return NextResponse.json({ error: "This job can no longer be cancelled." }, { status: 409 });
    const queuedJob = await getConversionQueue().getJob(jobId);
    const state = await queuedJob?.getState();
    if (state === "active") {
      const subscribers = await getRedis().publish("converthub:cancel", jobId);
      if (subscribers < 1) return NextResponse.json({ error: "No worker is available to receive the cancellation." }, { status: 503 });
    }
    else if (queuedJob) await queuedJob.remove();
    const { data: cancelled, error: cancelError } = await supabase.from("conversion_jobs").update({ status: "cancelled", finished_at: new Date().toISOString(), error_code: null, error_message: null }).eq("id", jobId).eq("visitor_id", parsed.data.visitorId).in("status", ["queued", "active"]).select("id").maybeSingle();
    if (cancelError) throw cancelError;
    if (!cancelled) {
      const { data: latest, error: latestError } = await supabase.from("conversion_jobs").select("status").eq("id", jobId).eq("visitor_id", parsed.data.visitorId).maybeSingle();
      if (latestError) throw latestError;
      if (latest?.status === "cancelled") return NextResponse.json({ cancelled: true });
      return NextResponse.json({ error: "This job finished before the cancellation arrived." }, { status: 409 });
    }
    const { error: eventError } = await supabase.from("analytics_events").insert({ session_id: parsed.data.sessionId, visitor_id: parsed.data.visitorId, event_type: "conversion_cancelled" });
    if (eventError) logger.warn({ jobId, error: eventError }, "conversion cancelled but analytics event was not recorded");
    return NextResponse.json({ cancelled: true });
  } catch (error) {
    logger.error({ jobId, error }, "conversion cancellation failed");
    return NextResponse.json({ error: "Could not cancel the conversion." }, { status: 503 });
  }
}
