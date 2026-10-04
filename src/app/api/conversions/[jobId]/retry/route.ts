import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getConversionQueue } from "@/lib/server/queue";
import { getSupabase } from "@/lib/server/supabase";
import { getAbuseKey, rateLimit } from "@/lib/server/rate-limit";
import { logger } from "@/lib/server/logger";
import { env } from "@/lib/server/env";
import { isSupportedConversion } from "@/lib/conversion-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ visitorId: z.string().uuid(), sessionId: z.string().uuid() });

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const limit = await rateLimit(`${await getAbuseKey(request)}:conversion-retry`, 6, 60);
  if (!limit.allowed) return NextResponse.json({ error: "Retry limit reached." }, { status: 429 });
  const { jobId: originalId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(originalId)) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Valid visitor and session IDs are required." }, { status: 400 });
  let supabase: ReturnType<typeof getSupabase> | undefined;
  let retryId: string | undefined;
  try {
    supabase = getSupabase();
    const { data: original, error } = await supabase.from("conversion_jobs").select("id,visitor_id,session_id,tool,source_path,source_paths,target_format,options,status").eq("id", originalId).eq("visitor_id", parsed.data.visitorId).eq("session_id", parsed.data.sessionId).maybeSingle();
    if (error) throw error;
    if (!original) return NextResponse.json({ error: "Job not found." }, { status: 404 });
    if (!["failed", "cancelled"].includes(original.status)) return NextResponse.json({ error: "Only failed or cancelled jobs can be retried." }, { status: 409 });
    if (!isSupportedConversion(original.tool, original.target_format)) return NextResponse.json({ error: "This saved job uses an unsupported tool or output format and cannot be retried." }, { status: 422 });
    const sources = original.source_paths?.length ? original.source_paths : [original.source_path];
    if (original.tool !== "Merge PDF" && sources.length > 1) return NextResponse.json({ error: "This saved job contains multiple files for a single-file tool and cannot be retried." }, { status: 422 });
    const { data: files, error: filesError } = await supabase.from("conversion_files").select("object_path,size_bytes").eq("visitor_id", original.visitor_id).eq("session_id", original.session_id).in("object_path", sources).is("deleted_at", null);
    if (filesError) throw filesError;
    if (!files || files.length !== sources.length) return NextResponse.json({ error: "The original file has expired. Upload it again to retry." }, { status: 410 });
    const sourceBytes = files.reduce((sum, file) => sum + Number(file.size_bytes), 0);
    if (!Number.isFinite(sourceBytes) || sourceBytes > env.MAX_UPLOAD_BYTES) return NextResponse.json({ error: `The combined source files exceed the ${Math.round(env.MAX_UPLOAD_BYTES / (1024 * 1024))} MB processing limit.` }, { status: 413 });
    retryId = randomUUID();
    const resultPath = `${original.visitor_id}/${original.session_id}/${retryId}.${original.target_format}`;
    const { error: insertError } = await supabase.from("conversion_jobs").insert({ id: retryId, visitor_id: original.visitor_id, session_id: original.session_id, tool: original.tool, source_path: sources[0], source_paths: sources, options: original.options ?? {}, result_path: resultPath, target_format: original.target_format, status: "queued", progress: 0 });
    if (insertError) throw insertError;
    await getConversionQueue().add("convert", { jobId: retryId, visitorId: original.visitor_id, sessionId: original.session_id, tool: original.tool, sourcePaths: sources, resultPath, targetFormat: original.target_format, options: original.options ?? {} }, { jobId: retryId });
    return NextResponse.json({ jobId: retryId, status: "queued", poll: `/api/conversions/${retryId}` }, { status: 202 });
  } catch (error) {
    if (supabase && retryId) {
      const { error: stateError } = await supabase.from("conversion_jobs").update({ status: "failed", error_code: "QUEUE_UNAVAILABLE", error_message: "The processing queue could not accept this retry.", finished_at: new Date().toISOString() }).eq("id", retryId).eq("status", "queued");
      if (stateError) logger.error({ jobId: retryId, error: stateError }, "could not mark unqueued retry as failed");
    }
    logger.error({ originalId, error }, "conversion retry failed");
    return NextResponse.json({ error: "Could not retry this conversion." }, { status: 503 });
  }
}
