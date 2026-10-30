import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";

// Operator pages: the browser demo (/), its session endpoint (which hands out the
// API token the demo's WebSocket needs), and the status dashboard. They sit behind
// one password — HTTP Basic, any username, DASHBOARD_PASSWORD — so the browser
// shows its own login box. Without this, anyone who opened the public URL got the
// API token. Everything else (Exotel stream + webhooks, CRM, /api/health) is untouched.
export function isOperatorPage(path: string): boolean {
  return (
    path === "/" || path === "/status" || path.startsWith("/api/status") || path.startsWith("/api/demo")
  );
}

export function operatorPagesGuard(password: string, production: boolean) {
  const expected = Buffer.from(password);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isOperatorPage(req.path)) return next();
    if (!password) {
      if (!production) return next(); // local dev: open
      res.status(503).send("Operator pages are disabled: set DASHBOARD_PASSWORD in .env.");
      return;
    }
    const [scheme, encoded] = String(req.headers.authorization ?? "").split(" ");
    const given =
      scheme?.toLowerCase() === "basic"
        ? Buffer.from(encoded ?? "", "base64").toString("utf8").split(":").slice(1).join(":")
        : "";
    const actual = Buffer.from(given);
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return next();
    res.setHeader("WWW-Authenticate", 'Basic realm="Pikorua Voice", charset="UTF-8"');
    res.status(401).send("Login required.");
  };
}
