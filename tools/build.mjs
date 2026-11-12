// npm run build — copies what a host page embeds into dist/.
// The demo folder is for standalone play only and is left out.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const shipped = ["ais6-bridge.js", "app.manifest.json", "kit.css", "shared", "take", "tune"];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const path of shipped) cpSync(join(root, path), join(dist, path), { recursive: true });
console.log(`built dist/ (${shipped.join(", ")})`);
