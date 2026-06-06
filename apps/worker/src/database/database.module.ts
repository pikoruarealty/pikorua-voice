import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createDatabase } from "@pikorua/db";

@Global()
@Module({
  providers: [
    {
      provide: "DATABASE",
      useFactory: (config: ConfigService) => {
        const url = String(config.get("DATABASE_URL") ?? "");
        return createDatabase(url, { max: 5 });
      },
      inject: [ConfigService],
    },
  ],
  exports: ["DATABASE"],
})
export class DatabaseModule {}
