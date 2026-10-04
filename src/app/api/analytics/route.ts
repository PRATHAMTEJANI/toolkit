import { NextResponse } from "next/server";
import { z } from "zod";
import type { ClientAnalytics } from "@/lib/analytics-types";
import { env, hasSupabase } from "@/lib/server/env";
import { getAbuseKey, rateLimit } from "@/lib/server/rate-limit";
import { logger } from "@/lib/server/logger";
import { getSupabase } from "@/lib/server/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const id = z.string().uuid();
const schema = z.object({
  visitorId: id, sessionId: id,
  eventType: z.enum(["page_view", "tool_used", "upload", "download", "conversion_started", "conversion_succeeded", "conversion_failed", "session_end"]),
  browser: z.string().max(80).optional(), browserVersion: z.string().max(32).optional(), operatingSystem: z.string().max(80).optional(),
  deviceType: z.enum(["mobile", "tablet", "desktop"]).optional(), screenResolution: z.string().regex(/^\d{1,5}x\d{1,5}$/).optional(),
  language: z.string().max(32).optional(), timezone: z.string().max(80).optional(), referrer: z.string().max(240).optional(),
  utmSource: z.string().max(100).optional(), utmMedium: z.string().max(100).optional(), utmCampaign: z.string().max(120).optional(),
  toolUsed: z.string().max(80).optional(), format: z.string().max(24).optional(), durationSeconds: z.number().int().min(0).max(60 * 60 * 24).optional(),
  processingTimeMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(), errorCode: z.string().max(80).optional(),
}) satisfies z.ZodType<ClientAnalytics>;

function browserFromAgent(agent: string) {
  const cases: Array<[RegExp, string]> = [[/Edg\//, "Edge"], [/OPR\//, "Opera"], [/Firefox\//, "Firefox"], [/Chrome\//, "Chrome"], [/Version\/.+Safari/, "Safari"]];
  const match = cases.find(([pattern]) => pattern.test(agent));
  if (!match) return { browser: "Other", version: "unknown" };
  const versionPattern: Record<string, RegExp> = { Edge: /Edg\/(\d+(?:\.\d+)*)/, Opera: /OPR\/(\d+(?:\.\d+)*)/, Firefox: /Firefox\/(\d+(?:\.\d+)*)/, Chrome: /Chrome\/(\d+(?:\.\d+)*)/, Safari: /Version\/(\d+(?:\.\d+)*)/ };
  const version = agent.match(versionPattern[match[1]])?.[1] ?? "unknown";
  return { browser: match[1], version };
}

export async function POST(request: Request) {
  const limit = await rateLimit(`${await getAbuseKey(request)}:analytics`, 120, 60);
  if (!limit.allowed) return NextResponse.json({ error: "Too many analytics events." }, { status: 429, headers: { "Retry-After": String(limit.resetSeconds) } });
  if (!hasSupabase) return NextResponse.json({ accepted: true, persistence: "disabled" });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid analytics payload." }, { status: 400 });
  const event = parsed.data;
  try {
    const userAgent = request.headers.get("user-agent") ?? "";
    const browser = browserFromAgent(userAgent);
    const geo = env.TRUST_PROXY_GEO_HEADERS === "true";
    const geoCountry = geo ? request.headers.get("x-vercel-ip-country")?.slice(0, 2) ?? null : null;
    const geoCity = geo ? request.headers.get("x-vercel-ip-city")?.slice(0, 100) ?? null : null;
    const { error } = await getSupabase().rpc("record_anonymous_analytics", {
      p_event: event,
      p_browser: event.browser ?? browser.browser,
      p_browser_version: event.browserVersion ?? browser.version,
      p_operating_system: event.operatingSystem ?? "Unknown",
      p_device_type: event.deviceType ?? "desktop",
      p_screen_resolution: event.screenResolution ?? null,
      p_language: event.language ?? null,
      p_timezone: event.timezone ?? null,
      p_country: geoCountry,
      p_city: geoCity,
      p_referrer: event.referrer ?? null,
      p_utm_source: event.utmSource ?? null,
      p_utm_medium: event.utmMedium ?? null,
      p_utm_campaign: event.utmCampaign ?? null,
    });
    if (error?.message.includes("Session does not match visitor")) return NextResponse.json({ error: "Session does not match visitor." }, { status: 403 });
    if (error) throw error;
    return NextResponse.json({ accepted: true });
  } catch (error) {
    logger.error({ error }, "anonymous analytics persistence failed");
    return NextResponse.json({ error: "Analytics service temporarily unavailable." }, { status: 503 });
  }
}
