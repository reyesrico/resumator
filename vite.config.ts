import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  optimizeDeps: { exclude: ["mupdf"] },
  plugins: [react(), {
    name: "distribute-license-and-source",
    generateBundle() {
      this.emitFile({type:"asset",fileName:"AGPL-3.0.txt",source:readFileSync("node_modules/mupdf/LICENSE","utf8")});
      this.emitFile({type:"asset",fileName:"SOURCE.txt",source:`Resumator source: https://github.com/reyesrico/resumator/tree/${process.env.GITHUB_SHA??"main"}\nMuPDF.js 1.28.1 source and licensing: https://github.com/ArtifexSoftware/mupdf.js\nThis application is distributed under AGPL-3.0-or-later. See AGPL-3.0.txt.\n`});
    },
  }],
});
