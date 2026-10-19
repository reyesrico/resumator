import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { accessGate } from "../server/access";

const username = "studio-owner";
const password = "synthetic-test-password-only";
function protectedApp(publicDeployment = true) {
  const app = express();
  if (publicDeployment) app.set("trust proxy", 1);
  app.use(...accessGate(username, password, publicDeployment));
  app.get("/private", (_req, res) => { res.send("private content"); });
  return app;
}

describe("personal studio access", () => {
  it("fails closed if a public deployment has missing or weak credentials", () => {
    expect(() => accessGate(undefined, undefined, true)).toThrow("APP_ACCESS");
    expect(() => accessGate(username, "short", true)).toThrow("APP_ACCESS");
    expect(() => accessGate("invalid:user", password, true)).toThrow("APP_ACCESS");
    expect(accessGate(undefined, undefined, false)).toEqual([]);
  });
  it("requires authentication before serving private content", async () => {
    const app = protectedApp();
    const response = await request(app).get("/private").set("X-Forwarded-Proto", "https").expect(401);
    expect(response.headers["www-authenticate"]).toContain("Basic");
    expect(response.text).not.toContain("private content");
    await request(app).get("/private").set("X-Forwarded-Proto", "https").auth(username, password).expect(200, "private content");
  });
  it("rejects incorrect, malformed, and oversized credentials", async () => {
    const app = protectedApp();
    for (const authorization of ["Bearer unsupported", "Basic !!!", `Basic ${"A".repeat(5000)}`]) {
      await request(app).get("/private").set("X-Forwarded-Proto", "https").set("Authorization", authorization).expect(401);
    }
    await request(app).get("/private").set("X-Forwarded-Proto", "https").auth(username, "wrong-password").expect(401);
  });
  it("rejects plaintext public access even with valid credentials", async () => {
    await request(protectedApp()).get("/private").auth(username, password).expect(403);
  });
  it("permits explicitly configured local protection without TLS termination", async () => {
    await request(protectedApp(false)).get("/private").auth(username, password).expect(200);
  });
});
