import { NextResponse } from "next/server";
import { z } from "zod";
import { getAbuseKey, rateLimit } from "@/lib/server/rate-limit";
import { getSupabase } from "@/lib/server/supabase";
import { logger } from "@/lib/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.object({ visitorId: z.string().uuid(), sessionId: z.string().uuid(), objectPath: z.string().min(1).max(240), fileName: z.string().min(1).max(180), contentType: z.string().min(1).max(120), sizeBytes: z.number().int().positive() });

export async function POST(request: Request) {
  const limit = await rateLimit(`${await getAbuseKey(request)}:upload-complete`, 30, 60);
  if (!limit.allowed) return NextResponse.json({ error: "Too many upload requests." }, { status: 429 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid upload confirmation." }, { status: 400 });
  const input = parsed.data;
  const expectedPrefix = `${input.visitorId}/${input.sessionId}/`;
  if (!input.objectPath.startsWith(expectedPrefix) || input.objectPath.includes("..") || input.objectPath.includes("\\")) return NextResponse.json({ error: "Upload path is invalid." }, { status: 400 });
  const parts = input.objectPath.split("/");
  if (parts.length !== 3 || !/^[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i.test(parts[2])) return NextResponse.json({ error: "Upload path is invalid." }, { status: 400 });
  try {
    const supabase = getSupabase();
    const { data: objects, error: storageError } = await supabase.storage.from("originals").list(`${input.visitorId}/${input.sessionId}`, { search: parts[2], limit: 1 });
    if (storageError) throw storageError;
    const stored = objects?.find((object) => object.name === parts[2]);
    if (!stored || Number(stored.metadata?.size ?? 0) !== input.sizeBytes) return NextResponse.json({ error: "Uploaded file could not be verified." }, { status: 422 });
    const { data: session, error: sessionLookupError } = await supabase.from("analytics_sessions").select("session_id,visitor_id").eq("session_id", input.sessionId).maybeSingle();
    if (sessionLookupError) throw sessionLookupError;
    if (session && session.visitor_id !== input.visitorId) return NextResponse.json({ error: "Session does not match visitor." }, { status: 403 });
    if (!session) {
      const { error: sessionError } = await supabase.from("analytics_sessions").upsert({ session_id: input.sessionId, visitor_id: input.visitorId }, { onConflict: "session_id", ignoreDuplicates: true });
      if (sessionError) throw sessionError;
    }
    const { error } = await supabase.from("conversion_files").upsert({
      session_id: input.sessionId, visitor_id: input.visitorId, object_path: input.objectPath,
      file_name: input.fileName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180),
      content_type: input.contentType, size_bytes: input.sizeBytes, file_role: "original",
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: "object_path" });
    if (error) throw error;
    return NextResponse.json({ uploaded: true });
  } catch (error) {
    logger.error({ error }, "upload confirmation failed");
    return NextResponse.json({ error: "Could not confirm the uploaded file." }, { status: 503 });
  }
}
