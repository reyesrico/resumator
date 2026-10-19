import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "resumator-test-library-"));
process.env.RESUMATOR_DATA_DIR = directory;
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
