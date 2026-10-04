import "server-only";
import { z } from "zod";

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  REDIS_URL: z.string().url().optional(),
  ADMIN_DASHBOARD_TOKEN: z.string().min(24).optional(),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  RESULT_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  TEMP_FILE_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
  TRUST_PROXY_GEO_HEADERS: z.enum(["true", "false"]).default("false"),
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  TURNSTILE_SECRET_KEY: z.string().optional(),
});

export const env = envSchema.parse(process.env);
export const hasSupabase = Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
