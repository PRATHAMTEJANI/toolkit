import "server-only";
import IORedis from "ioredis";
import { env } from "@/lib/server/env";

let connection: IORedis | undefined;
export function getRedis() {
  if (!env.REDIS_URL) throw new Error("REDIS_URL is not configured.");
  connection ??= new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: true });
  return connection;
}
