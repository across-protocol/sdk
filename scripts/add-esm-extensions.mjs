#!/usr/bin/env node
/**
 * Post-process dist/esm/**\/*.js so every relative import/export specifier ends
 * in `.js` (or `/index.js` for directories). `tsc --module es2015` emits the
 * specifiers as written in source — extension-less — which Node's strict ESM
 * resolver rejects when `dist/esm/package.json` declares `"type":"module"`.
 *
 * We rewrite the dist instead of the source so contributors keep writing
 * idiomatic TS imports.
 *
 * Handles:
 *   import x from "./y"
 *   import x from "./y"        →  "./y.js"  or  "./y/index.js"
 *   export * from "./y"
 *   export { x } from "./y"
 *   import("./y")              dynamic
 *   import "./y"               side-effect
 *
 * Skips:
 *   bare specifiers ("lodash", "@scope/pkg")
 *   already-extensioned paths (".js", ".mjs", ".cjs", ".json", ".node")
 *   data: / node: schemes
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const DIST = join(ROOT, "dist", "esm");

const SPECIFIER_RE =
  /(\b(?:import|export)\s*(?:[\w*${},\s]*\s+from\s*)?|\bimport\s*\()\s*(['"])(\.\.?(?:\/[^'"]*)?)\2/g;

const SKIP_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".node",
  ".wasm",
]);

function hasKnownExtension(spec) {
  const dot = spec.lastIndexOf(".");
  if (dot === -1) return false;
  const slash = spec.lastIndexOf("/");
  if (dot < slash) return false; // dot is in a path segment, not an extension
  return SKIP_EXTENSIONS.has(spec.slice(dot));
}

function resolveSpec(fileDir, spec) {
  const abs = resolve(fileDir, spec);
  if (existsSync(abs + ".js")) return spec + ".js";
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    if (existsSync(join(abs, "index.js"))) return spec + "/index.js";
  }
  // Not found locally — leave untouched. Could be a runtime-only path, a
  // generated file the script can't see, or a bug we'd rather surface than
  // silently rewrite.
  return null;
}

async function processFile(file) {
  const original = await readFile(file, "utf8");
  const fileDir = dirname(file);
  let unresolved = [];

  const rewritten = original.replace(SPECIFIER_RE, (match, prefix, quote, spec) => {
    if (hasKnownExtension(spec)) return match;
    const resolved = resolveSpec(fileDir, spec);
    if (!resolved) {
      unresolved.push(spec);
      return match;
    }
    return `${prefix}${quote}${resolved}${quote}`;
  });

  if (rewritten !== original) {
    await writeFile(file, rewritten);
  }
  return { changed: rewritten !== original, unresolved };
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith(".js")) yield full;
  }
}

async function main() {
  if (!existsSync(DIST)) {
    console.error(`dist/esm not found at ${DIST} — run tsc first`);
    process.exit(1);
  }

  const files = [];
  for await (const file of walk(DIST)) files.push(file);
  let changedCount = 0;
  const allUnresolved = new Map();

  for (const file of files) {
    const { changed, unresolved } = await processFile(file);
    if (changed) changedCount++;
    for (const spec of unresolved) {
      const list = allUnresolved.get(file) ?? [];
      list.push(spec);
      allUnresolved.set(file, list);
    }
  }

  console.log(
    `add-esm-extensions: rewrote ${changedCount} / ${files.length} files`,
  );

  if (allUnresolved.size > 0) {
    console.error(
      `\nadd-esm-extensions: ${allUnresolved.size} file(s) have relative imports the script could not resolve:`,
    );
    for (const [file, specs] of allUnresolved) {
      console.error(`  ${file.slice(ROOT.length + 1)}`);
      for (const spec of specs) console.error(`    - ${spec}`);
    }
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
