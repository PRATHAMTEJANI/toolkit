import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getAbuseKey, rateLimit } from "@/lib/server/rate-limit";
import { getConversionQueue } from "@/lib/server/queue";
import { getSupabase } from "@/lib/server/supabase";
import { logger } from "@/lib/server/logger";
import { env } from "@/lib/server/env";
import { isSupportedConversion } from "@/lib/conversion-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ visitorId: z.string().uuid(), sessionId: z.string().uuid(), tool: z.string().min(2).max(80), sourceObjectPaths: z.array(z.string().min(1).max(240)).min(1).max(20), targetFormat: z.string().regex(/^[a-z0-9]{2,8}$/i), options: z.record(z.string(), z.unknown()).default({}), captchaToken: z.string().max(4096).optional() });

export async function POST(request: Request) {
  const limit = await rateLimit(`${await getAbuseKey(request)}:conversion`, 20, 60);
  if (!limit.allowed) return NextResponse.json({ error: "Conversion request limit reached." }, { status: 429, headers: { "Retry-After": String(limit.resetSeconds) } });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid conversion request." }, { status: 400 });
  const input = parsed.data;
  if (input.tool !== "Merge PDF" && input.sourceObjectPaths.length > 1) return NextResponse.json({ error: "This tool processes one file at a time. Select one file or choose Merge PDF." }, { status: 422 });
  if (env.TURNSTILE_SECRET_KEY) {
    if (!input.captchaToken) return NextResponse.json({ error: "Complete the abuse prevention check before converting." }, { status: 400 });
    const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: input.captchaToken });
    const captcha = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, cache: "no-store" }).then((response) => response.json() as Promise<{ success?: boolean }>).catch(() => ({ success: false }));
    if (!captcha.success) return NextResponse.json({ error: "Abuse prevention check expired. Please verify again." }, { status: 403 });
  }
  const targetFormat = input.targetFormat.toLowerCase();
  if (!isSupportedConversion(input.tool, targetFormat)) return NextResponse.json({ error: "That tool or output format is not supported by the current processing worker." }, { status: 422 });
  let supabase: ReturnType<typeof getSupabase> | undefined;
  let jobId: string | undefined;
  try {
    supabase = getSupabase();
    const { data: files, error: filesError } = await supabase.from("conversion_files").select("object_path,content_type,size_bytes").eq("session_id", input.sessionId).eq("visitor_id", input.visitorId).eq("file_role", "original").is("deleted_at", null).in("object_path", input.sourceObjectPaths);
    if (filesError) throw filesError;
    if (!files || files.length !== input.sourceObjectPaths.length) return NextResponse.json({ error: "One or more files are unavailable for this anonymous session." }, { status: 403 });
    const sourceBytes = files.reduce((sum, file) => sum + Number(file.size_bytes), 0);
    if (!Number.isFinite(sourceBytes) || sourceBytes > env.MAX_UPLOAD_BYTES) return NextResponse.json({ error: `The combined source files exceed the ${Math.round(env.MAX_UPLOAD_BYTES / (1024 * 1024))} MB processing limit.` }, { status: 413 });
    jobId = randomUUID();
    const sourceFormat = files[0].object_path.split(".").at(-1)?.toLowerCase() ?? "unknown";
    const resultPath = `${input.visitorId}/${input.sessionId}/${jobId}.${targetFormat}`;
    const { error: insertError } = await supabase.from("conversion_jobs").insert({
      id: jobId, visitor_id: input.visitorId, session_id: input.sessionId, tool: input.tool,
      source_path: files[0].object_path, source_paths: input.sourceObjectPaths, options: input.options, result_path: resultPath, source_format: sourceFormat,
      target_format: targetFormat, status: "queued", progress: 0,
    });
    if (insertError) throw insertError;
    const { error: analyticsError } = await supabase.rpc("record_anonymous_analytics", {
      p_event: { sessionId: input.sessionId, visitorId: input.visitorId, eventType: "conversion_started", toolUsed: input.tool, format: targetFormat },
      p_browser: null, p_browser_version: null, p_operating_system: null, p_device_type: null,
      p_screen_resolution: null, p_language: null, p_timezone: null, p_country: null, p_city: null,
      p_referrer: null, p_utm_source: null, p_utm_medium: null, p_utm_campaign: null,
    });
    if (analyticsError) logger.warn({ jobId, error: analyticsError }, "conversion queued but start analytics could not be recorded");
    await getConversionQueue().add("convert", {
      jobId, visitorId: input.visitorId, sessionId: input.sessionId, tool: input.tool,
      sourcePaths: input.sourceObjectPaths, resultPath, targetFormat, options: input.options,
    }, { jobId });
    return NextResponse.json({ jobId, status: "queued", poll: `/api/conversions/${jobId}` }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (supabase && jobId) {
      const { error: stateError } = await supabase.from("conversion_jobs").update({ status: "failed", error_code: "QUEUE_UNAVAILABLE", error_message: "The processing queue could not accept this job.", finished_at: new Date().toISOString() }).eq("id", jobId).eq("status", "queued");
      if (stateError) logger.error({ jobId, error: stateError }, "could not mark unqueued conversion as failed");
    }
    logger.error({ error }, "conversion enqueue failed");
    return NextResponse.json({ error: "Conversion queue is temporarily unavailable. Check Redis and worker configuration." }, { status: 503 });
  }
}
