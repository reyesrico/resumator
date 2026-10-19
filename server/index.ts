import "dotenv/config";
import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./app.js";

const app = createApp();
const dist = resolve("dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(resolve(dist, "index.html")));
}
const port = Number(process.env.PORT || 3001);
const host = process.env.RESUMATOR_PUBLIC === "true" ? "0.0.0.0" : "127.0.0.1";
app.listen(port, host, () => {
  console.log(`Resumator listening on ${host}:${port}`);
});
