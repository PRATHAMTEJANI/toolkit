import "server-only";
import { Queue } from "bullmq";
import { getRedis } from "@/lib/server/redis";

export const CONVERSION_QUEUE = "converthub-conversions";
let queue: Queue | undefined;
export function getConversionQueue() {
  queue ??= new Queue(CONVERSION_QUEUE, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1500 },
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 10000 },
    },
  });
  return queue;
}
