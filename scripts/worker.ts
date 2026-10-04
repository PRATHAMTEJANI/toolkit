import { Worker } from "bullmq";
import { CONVERSION_QUEUE, getConversionQueue } from "@/lib/server/queue";
import { getRedis } from "@/lib/server/redis";
import { logger } from "@/lib/server/logger";
import { processConversion } from "@/lib/worker/processor";

const worker = new Worker(CONVERSION_QUEUE, processConversion, {
  connection: getRedis(),
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 3),
  limiter: { max: Number(process.env.WORKER_RATE_MAX ?? 40), duration: Number(process.env.WORKER_RATE_DURATION_MS ?? 1000) },
});
const cancellationBus = getRedis().duplicate();

worker.on("ready", () => logger.info({ concurrency: worker.opts.concurrency }, "conversion worker ready"));
worker.on("completed", (job) => logger.info({ jobId: job.id }, "conversion job completed"));
worker.on("failed", (job, error) => logger.error({ jobId: job?.id, error: error.message }, "conversion job failed"));
worker.on("error", (error) => logger.error({ error }, "worker error"));

await worker.waitUntilReady();
await cancellationBus.subscribe("converthub:cancel");
cancellationBus.on("message", (_channel, jobId) => { worker.cancelJob(jobId, "Cancelled by visitor"); });
await getConversionQueue().upsertJobScheduler("cleanup-expired-files", { every: 15 * 60 * 1000 }, { name: "cleanup", data: {} });
logger.info("scheduled expired storage cleanup every 15 minutes");

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down worker");
  await worker.close();
  await cancellationBus.quit();
  await getRedis().quit();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
