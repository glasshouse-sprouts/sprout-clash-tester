#!/usr/bin/env node
// `npm run clean` — remove TypeScript and Electron build output so the
// next `npm run build` starts from scratch.
//
// Why it exists: `tsc -b` trusts the `*.tsbuildinfo` files. A copy of the
// repository that has them but not the matching `dist/` folders builds
// nothing, and the CLI / MCP / desktop tests then fail with "Cannot find
// module …/dist/index.js". Removing both fixes that.
//
// Leaves engine/target alone (use `cargo clean` in engine/ for that).

import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packages = path.join(root, "packages");

/** Build output, per package, relative to the package folder. */
function targets(pkgDir) {
  const names = readdirSync(pkgDir);
  return [
    "dist",
    "out",
    ...names.filter((n) => n.startsWith("out-types-") || n.endsWith(".tsbuildinfo")),
  ].map((n) => path.join(pkgDir, n));
}

let removed = 0;
for (const pkg of readdirSync(packages, { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue;
  for (const target of targets(path.join(packages, pkg.name))) {
    try {
      rmSync(target, { recursive: true });
      console.log(`removed ${path.relative(root, target)}`);
      removed++;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}
console.log(removed === 0 ? "nothing to clean" : `${removed} item(s) removed`);
