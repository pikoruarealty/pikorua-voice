import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";

export const REDIS_CLIENT = "REDIS_CLIENT";

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
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
