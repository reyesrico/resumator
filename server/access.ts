import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import rateLimit from "express-rate-limit";

export function accessGate(username: string | undefined, password: string | undefined, publicDeployment: boolean): RequestHandler[] {
  if (!username && !password && !publicDeployment) return [];
  if (!username || !/^[a-zA-Z0-9._-]{1,64}$/.test(username) || !password || password.length < 20) {
    throw new Error("Set APP_ACCESS_USERNAME and APP_ACCESS_PASSWORD (at least 20 characters) before enabling remote access.");
  }
  const expected = createHash("sha256").update(`${username}:${password}`).digest();
  return [
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true,
      standardHeaders: "draft-7", legacyHeaders: false,
      message: "Too many failed sign-in attempts. Wait 15 minutes and try again." }),
    (req, res, next) => {
      if (publicDeployment && !req.secure) {
        res.status(403).type("text").send("HTTPS is required to use this private studio.");
        return;
      }
      const authorization = req.get("authorization");
      if (authorization && /^Basic [a-zA-Z0-9+/]+={0,2}$/i.test(authorization) && authorization.length <= 4096) {
        const credentials = Buffer.from(authorization.slice(6), "base64");
        const received = createHash("sha256").update(credentials).digest();
        if (timingSafeEqual(expected, received)) { next(); return; }
      }
      res.setHeader("WWW-Authenticate", 'Basic realm="Resumator private studio", charset="UTF-8"');
      res.setHeader("Cache-Control", "no-store");
      res.status(401).type("text").send("Sign in with the studio credentials configured by its owner.");
    },
  ];
}
