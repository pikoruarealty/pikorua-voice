import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import { CallSlots } from "@pikorua/shared";

export const REDIS_CLIENT = "REDIS_CLIENT";
// Call-slot gate shared with the worker (null when Redis isn't configured, in
// which case calls are not capped).
export const CALL_SLOTS = "CALL_SLOTS";

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService): Redis | null => {
        const url = config.get<string>("REDIS_URL");
        if (!url) return null;
        const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 1 });
        client.on("error", (err) => {
          // Non-fatal — call state falls back to in-process Map
          console.warn("[Redis] connection error:", err.message);
        });
        return client;
      },
      inject: [ConfigService],
    },
    {
      provide: CALL_SLOTS,
      useFactory: (redis: Redis | null, config: ConfigService): CallSlots | null =>
        redis
          ? new CallSlots(
              redis,
              Number(config.get("MAX_CONCURRENT_CALLS") ?? 2),
              Number(config.get("OUTBOUND_MAX_CONCURRENT") ?? 1),
            )
          : null,
      inject: [REDIS_CLIENT, ConfigService],
    },
  ],
  exports: [REDIS_CLIENT, CALL_SLOTS],
})
export class RedisModule {}
