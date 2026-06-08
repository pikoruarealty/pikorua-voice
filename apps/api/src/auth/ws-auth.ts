import type { IncomingMessage } from "http";
import type { ConfigService } from "@nestjs/config";
import type { WebSocket } from "ws";

export function isWebSocketAuthorized(config: ConfigService, request?: IncomingMessage): boolean {
  const token = config.get<string>("API_AUTH_TOKEN");
  const nodeEnv = config.get<string>("NODE_ENV") ?? "development";
  if (!token && nodeEnv !== "production") {
    return true;
  }

  return readToken(request) === token;
}

export function closeUnauthorized(client: WebSocket) {
  client.close(1008, "Missing or invalid API credentials");
}

function readToken(request?: IncomingMessage): string | undefined {
  const authorization = request?.headers.authorization;
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim();
  }

  const apiKey = request?.headers["x-api-key"];
  if (Array.isArray(apiKey)) {
    return apiKey[0];
  }
  if (typeof apiKey === "string") {
    return apiKey;
  }

  if (request?.url) {
    const url = new URL(request.url, "http://localhost");
    return url.searchParams.get("token") ?? undefined;
  }

  return undefined;
}
