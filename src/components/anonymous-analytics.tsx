"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import type { ClientAnalytics } from "@/lib/analytics-types";

const VISITOR_KEY = "ch_visitor_id";
const SESSION_KEY = "ch_session_id";
const START_KEY = "ch_session_started_at";
let memoryVisitorId: string | undefined;
let memorySessionId: string | undefined;
let memorySessionStartedAt: number | undefined;

function uuid() { return crypto.randomUUID(); }
function isUuid(value: string | null): value is string { return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)); }

export function getAnonymousIds() {
  try {
    let visitorId = localStorage.getItem(VISITOR_KEY);
    if (!isUuid(visitorId)) { visitorId = memoryVisitorId ?? uuid(); localStorage.setItem(VISITOR_KEY, visitorId); }
    memoryVisitorId = visitorId;
    let sessionId = sessionStorage.getItem(SESSION_KEY);
    if (!isUuid(sessionId)) {
      sessionId = memorySessionId ?? uuid();
      const startedAt = memorySessionStartedAt ?? Date.now();
      sessionStorage.setItem(SESSION_KEY, sessionId);
      sessionStorage.setItem(START_KEY, String(startedAt));
    }
    memorySessionId = sessionId;
    return { visitorId, sessionId };
  } catch {
    memoryVisitorId ??= uuid();
    memorySessionId ??= uuid();
    memorySessionStartedAt ??= Date.now();
    return { visitorId: memoryVisitorId, sessionId: memorySessionId };
  }
}

function getClientDetails(): Pick<ClientAnalytics, "browser" | "browserVersion" | "operatingSystem" | "deviceType" | "screenResolution" | "language" | "timezone" | "referrer" | "utmSource" | "utmMedium" | "utmCampaign"> {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "Other";
  const versionPattern: Record<string, RegExp> = { Edge: /Edg\/(\d+(?:\.\d+)*)/, Firefox: /Firefox\/(\d+(?:\.\d+)*)/, Chrome: /Chrome\/(\d+(?:\.\d+)*)/, Safari: /Version\/(\d+(?:\.\d+)*)/ };
  const browserVersion = agent.match(versionPattern[browser] ?? /(?:)/)?.[1] ?? "unknown";
  const operatingSystem = /Windows NT/.test(agent) ? "Windows" : /Mac OS X/.test(agent) ? "macOS" : /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Linux/.test(agent) ? "Linux" : "Other";
  const deviceType = /iPad|Tablet/i.test(agent) ? "tablet" : /Mobi|iPhone|Android/i.test(agent) ? "mobile" : "desktop";
  const query = new URLSearchParams(location.search);
  return {
    browser, browserVersion, operatingSystem, deviceType,
    screenResolution: `${screen.width}x${screen.height}`, language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    referrer: document.referrer ? (() => { try { return new URL(document.referrer).origin; } catch { return ""; } })() : "",
    utmSource: query.get("utm_source") ?? undefined, utmMedium: query.get("utm_medium") ?? undefined, utmCampaign: query.get("utm_campaign") ?? undefined,
  };
}

export function emitAnalytics(eventType: ClientAnalytics["eventType"], details: Partial<ClientAnalytics> = {}) {
  if (typeof window === "undefined") return;
  try {
    const ids = getAnonymousIds();
    const startedAt = Number(sessionStorage.getItem(START_KEY) ?? Date.now());
    const payload: ClientAnalytics = { ...getClientDetails(), ...ids, eventType, durationSeconds: Math.floor((Date.now() - startedAt) / 1000), ...details };
    void fetch("/api/analytics", { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", keepalive: true, body: JSON.stringify(payload) }).catch(() => {});
  } catch { /* Analytics must never block the user's file task. */ }
}

export function AnonymousAnalytics() {
  const pathname = usePathname();
  useEffect(() => {
    emitAnalytics("page_view");
    const finish = () => emitAnalytics("session_end");
    window.addEventListener("pagehide", finish);
    return () => window.removeEventListener("pagehide", finish);
  }, [pathname]);
  return null;
}
