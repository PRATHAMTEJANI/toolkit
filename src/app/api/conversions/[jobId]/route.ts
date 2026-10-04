import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/lib/server/supabase";
import { logger } from "@/lib/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ visitorId: z.string().uuid(), sessionId: z.string().uuid() });

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Valid visitorId and sessionId are required." }, { status: 400 });
  try {
    const { data: job, error } = await getSupabase().from("conversion_jobs").select("id,tool,target_format,status,progress,processing_time_ms,error_code,error_message,created_at,finished_at,result_path").eq("id", jobId).eq("visitor_id", parsed.data.visitorId).eq("session_id", parsed.data.sessionId).maybeSingle();
    if (error) throw error;
    if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
    let downloadUrl: string | undefined;
    if (job.status === "completed" && job.result_path) {
      const signed = await getSupabase().storage.from("converted").createSignedUrl(job.result_path, 600, { download: true });
      if (!signed.error) downloadUrl = signed.data.signedUrl;
    }
    return NextResponse.json({ ...job, downloadUrl }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error({ error }, "conversion status lookup failed");
    return NextResponse.json({ error: "Could not read conversion status." }, { status: 503 });
  }
}
