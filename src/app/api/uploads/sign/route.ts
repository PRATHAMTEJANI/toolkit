import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/server/env";
import { getAbuseKey, rateLimit } from "@/lib/server/rate-limit";
import { getSupabase } from "@/lib/server/supabase";
import { logger } from "@/lib/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  visitorId: z.string().uuid(), sessionId: z.string().uuid(), fileName: z.string().min(1).max(180),
  contentType: z.string().min(1).max(120), sizeBytes: z.number().int().positive().max(env.MAX_UPLOAD_BYTES),
});
const extensions: Record<string, string> = {
  "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "image/heic": "heic", "image/heif": "heif",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/aac": "aac", "audio/ogg": "ogg",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/msword": "doc", "application/vnd.ms-excel": "xls", "application/vnd.ms-powerpoint": "ppt",
};

export async function POST(request: Request) {
  const abuseKey = await getAbuseKey(request);
  const limit = await rateLimit(`${abuseKey}:upload-sign`, 20, 60);
  if (!limit.allowed) return NextResponse.json({ error: "Upload limit reached. Please wait a moment." }, { status: 429, headers: { "Retry-After": String(limit.resetSeconds) } });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid file details or file exceeds the 100 MB limit." }, { status: 400 });
  const input = parsed.data;
  const extension = extensions[input.contentType.toLowerCase()];
  if (!extension) return NextResponse.json({ error: "This file type is not supported for secure upload." }, { status: 415 });
  const uploadId = randomUUID();
  const objectPath = `${input.visitorId}/${input.sessionId}/${uploadId}.${extension}`;
  try {
    const supabase = getSupabase();
    const { error: sessionError } = await supabase.from("analytics_sessions").upsert({ session_id: input.sessionId, visitor_id: input.visitorId }, { onConflict: "session_id", ignoreDuplicates: true });
    if (sessionError) throw sessionError;
    const { data: session, error: sessionLookupError } = await supabase.from("analytics_sessions").select("visitor_id").eq("session_id", input.sessionId).maybeSingle();
    if (sessionLookupError) throw sessionLookupError;
    if (session?.visitor_id !== input.visitorId) return NextResponse.json({ error: "Session does not match visitor." }, { status: 403 });
    const safeName = input.fileName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180);
    const { error: fileRecordError } = await supabase.from("conversion_files").insert({
      session_id: input.sessionId, visitor_id: input.visitorId, object_path: objectPath, file_name: safeName,
      content_type: input.contentType, size_bytes: input.sizeBytes, file_role: "original",
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    });
    if (fileRecordError) throw fileRecordError;
    const { data, error } = await supabase.storage.from("originals").createSignedUploadUrl(objectPath, { upsert: false });
    if (error) throw error;
    return NextResponse.json({ bucket: "originals", objectPath, token: data.token, uploadId, expiresIn: 7200, maxBytes: env.MAX_UPLOAD_BYTES }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error({ error }, "unable to create signed upload");
    const details = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; status?: unknown } : {};
    const code = typeof details.code === "string" ? details.code : "";
    const message = typeof details.message === "string" ? details.message : "";
    const status = typeof details.status === "number" ? details.status : undefined;
    const setupError = code === "42P01" || code === "PGRST205"
      ? "Upload database setup is incomplete. Apply the Supabase migrations, then restart the app."
      : /bucket not found/i.test(message)
        ? "The originals storage bucket is missing. Apply the Supabase storage migration."
        : status === 401 || status === 403
          ? "Supabase rejected the server credentials. Check SUPABASE_SERVICE_ROLE_KEY in .env.local and restart the app."
          : !env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY
            ? "Supabase server credentials are missing. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local, then restart the app."
            : "Could not reach Supabase to prepare the upload. Check the project URL, keys, network, and database migrations.";
    return NextResponse.json({ error: setupError }, { status: 503 });
  }
}
