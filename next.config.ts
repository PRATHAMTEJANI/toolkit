import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["bullmq", "ioredis", "@supabase/supabase-js", "sharp", "pdf-lib", "file-type"],
};
export default nextConfig;
