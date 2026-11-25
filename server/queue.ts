import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
export const fulfillmentQueue = new Queue('topup-fulfillment', { connection });
export const expirationQueue = new Queue('order-expiration', { connection });
