import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { timingSafeEqual } from "crypto";
import { IS_PUBLIC_ROUTE } from "./public.decorator";

// Constant-time string compare so token validation doesn't leak the secret
// length/prefix via early-exit timing of `===`. Returns false on any mismatch.
function safeTokenEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

@Injectable()
export class ApiAuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const token = this.config.get<string>("API_AUTH_TOKEN");
    const nodeEnv = this.config.get<string>("NODE_ENV") ?? "development";
    if (!token && nodeEnv !== "production") {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = this.readToken(request);
    if (token && safeTokenEqual(provided, token)) {
      return true;
    }

    throw new UnauthorizedException("Missing or invalid API credentials");
  }

  private readToken(request: Request): string | undefined {
    const authorization = request.headers.authorization;
    if (authorization?.toLowerCase().startsWith("bearer ")) {
      return authorization.slice("bearer ".length).trim();
    }

    const apiKey = request.headers["x-api-key"];
    if (Array.isArray(apiKey)) {
      return apiKey[0];
    }
    return apiKey;
  }
}
