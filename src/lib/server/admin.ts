import "server-only";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/server/env";

export function isAdminRequest(request: Request) {
  const expected = env.ADMIN_DASHBOARD_TOKEN;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !provided) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}
