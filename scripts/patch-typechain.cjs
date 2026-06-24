const fs = require("fs");
const path = require("path");

const TYPECHAIN_DIR = path.join(__dirname, "../src/utils/abi/typechain");

/**
 * Typechain occasionally emits unused type imports (e.g. struct types in factories).
 * Generated bindings are not hand-maintained, so suppress TS unused checks for them.
 */
function patchFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  if (content.includes("@ts-nocheck")) {
    return false;
  }

  const patched = content.replace(/(\/\* eslint-disable \*\/\n)/, `$1// @ts-nocheck\n`);
  if (patched === content) {
    return false;
  }

  fs.writeFileSync(filePath, patched);
  return true;
}

function walk(dir) {
  let patchedCount = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      patchedCount += walk(full);
    } else if (name.endsWith(".ts") && patchFile(full)) {
      patchedCount++;
    }
  }
  return patchedCount;
}

const patchedCount = walk(TYPECHAIN_DIR);
console.log(`Patched ${patchedCount} typechain files with @ts-nocheck`);
