import config from "../config/index.js";

// BullMQ connection options, derived once from config.redis. We pass a plain
// options object (not a shared ioredis instance) so BullMQ owns the client
// lifecycle and applies the settings a blocking Worker connection requires
// (e.g. maxRetriesPerRequest: null) itself. Both the producer (API) and the
// Worker import this.
export const connection = config.redis.connection;
