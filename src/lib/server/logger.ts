import "server-only";
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: ["req.headers.authorization", "*.token", "*.signedUrl", "*.url"], censor: "[REDACTED]" },
  base: { service: "converthub-ai" },
});
