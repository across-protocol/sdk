import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { expect } from "./utils";

// scripts/lazify-cjs-index.cjs rewrites the emitted CJS barrel so that requiring the
// package root does not eagerly load all 17 namespaces. It runs as part of `build:cjs`
// and its output is the published entry point, so a silent failure ships a broken or
// needlessly heavy package root. These tests drive the real script over synthetic tsc
// emits and assert both halves of the contract: the laziness it exists to add, and the
// property semantics of the eager emit it replaces.
const SCRIPT = path.join(__dirname, "..", "scripts", "lazify-cjs-index.cjs");
const NAMESPACES = ["alpha", "beta", "gamma"];

const EAGER_INDEX = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
${NAMESPACES.map((name) => `exports.${name} = tslib_1.__importStar(require("./${name}"));`).join("\n")}
`;

type Fixture = { root: string; indexPath: string };

// Fixtures live under test/ rather than os.tmpdir() so that the `require("tslib")` in the
// emitted barrel resolves against the repo's node_modules, as it does in a real build.
let fixtureCount = 0;

function createFixture(indexSource: string = EAGER_INDEX): Fixture {
  const root = path.join(__dirname, `.tmp-lazify-${process.pid}-${fixtureCount++}`);
  const srcDir = path.join(root, "dist", "cjs", "src");
  fs.mkdirSync(srcDir, { recursive: true });

  for (const name of NAMESPACES) {
    fs.mkdirSync(path.join(srcDir, name), { recursive: true });
    // Record the load so a test can assert exactly which namespaces were pulled in.
    fs.writeFileSync(
      path.join(srcDir, name, "index.js"),
      `(globalThis.__lazyLoads ||= []).push("${name}");\nexports.name = "${name}";\n`
    );
  }

  fs.writeFileSync(path.join(srcDir, "index.js"), indexSource);
  return { root, indexPath: path.join(srcDir, "index.js") };
}

function lazify({ root }: Fixture): { status: number; stdout: string; stderr: string } {
  // Capture stderr rather than letting the drift cases inherit it and litter test output.
  const options = { cwd: root, encoding: "utf8" as const, stdio: ["ignore", "pipe", "pipe"] as const };
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [SCRIPT], options), stderr: "" };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
  }
}

// Each fixture has its own path, so requiring one never hits another's module cache.
function requireRoot({ indexPath }: Fixture): Record<string, { name: string }> {
  (globalThis as Record<string, unknown>).__lazyLoads = [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(indexPath);
}

function namespacesLoaded(): string[] {
  return ((globalThis as Record<string, unknown>).__lazyLoads as string[]) ?? [];
}

describe("lazify-cjs-index", () => {
  after(() => {
    for (const entry of fs.readdirSync(__dirname)) {
      if (entry.startsWith(".tmp-lazify-")) {
        fs.rmSync(path.join(__dirname, entry), { recursive: true, force: true });
      }
    }
  });

  describe("laziness", () => {
    it("requiring the package root loads no namespace", () => {
      const fixture = createFixture();
      expect(lazify(fixture).status).to.equal(0);

      const root = requireRoot(fixture);

      expect(namespacesLoaded()).to.deep.equal([]);
      expect(Object.keys(root).sort()).to.deep.equal([...NAMESPACES].sort());
    });

    it("reading a namespace loads that namespace only, and only once", () => {
      const fixture = createFixture();
      lazify(fixture);
      const root = requireRoot(fixture);

      expect(root.beta.name).to.equal("beta");
      expect(namespacesLoaded()).to.deep.equal(["beta"]);

      expect(root.beta).to.equal(root.beta);
      expect(namespacesLoaded()).to.deep.equal(["beta"]);
    });

    it("spreading the root resolves every namespace", () => {
      const fixture = createFixture();
      lazify(fixture);
      const root = requireRoot(fixture);

      expect(Object.keys({ ...root }).sort()).to.deep.equal([...NAMESPACES].sort());
      expect(namespacesLoaded().sort()).to.deep.equal([...NAMESPACES].sort());
    });
  });

  // tsc emits `exports.alpha = ...`, a plain writable/enumerable/configurable data
  // property. Consumers can monkey-patch it, and it survives Object.freeze() readable.
  // The lazy accessor has to preserve all of that.
  describe("property semantics of the eager emit", () => {
    it("leaves behind the writable data property tsc would have emitted", () => {
      const fixture = createFixture();
      lazify(fixture);
      const root = requireRoot(fixture);

      void root.alpha;

      expect(Object.getOwnPropertyDescriptor(root, "alpha")).to.deep.include({
        writable: true,
        enumerable: true,
        configurable: true,
      });
    });

    it("allows a namespace to be replaced after the first read", () => {
      const fixture = createFixture();
      lazify(fixture);
      const root = requireRoot(fixture);

      expect(root.alpha.name).to.equal("alpha");
      root.alpha = { name: "mock" };

      expect(root.alpha.name).to.equal("mock");
    });

    it("allows a namespace to be replaced before the first read, without loading it", () => {
      const fixture = createFixture();
      lazify(fixture);
      const root = requireRoot(fixture);

      root.alpha = { name: "mock" };

      expect(root.alpha.name).to.equal("mock");
      expect(namespacesLoaded()).to.deep.equal([]);
    });

    it("keeps namespaces readable after the root is sealed", () => {
      const fixture = createFixture();
      lazify(fixture);
      const root = requireRoot(fixture);

      Object.seal(root);

      expect(root.gamma.name).to.equal("gamma");
      expect(root.gamma).to.equal(root.gamma);
    });

    it("keeps namespaces readable after the root is frozen", () => {
      const fixture = createFixture();
      lazify(fixture);
      const root = requireRoot(fixture);

      Object.freeze(root);

      expect(root.gamma.name).to.equal("gamma");
      expect(root.gamma).to.equal(root.gamma);
    });

    it("honours the integrity guarantee of a frozen root", () => {
      const fixture = createFixture();
      lazify(fixture);
      const root = requireRoot(fixture);

      Object.freeze(root);
      root.alpha = { name: "mock" };

      expect(root.alpha.name).to.equal("alpha");
    });
  });

  describe("rewrite safety", () => {
    it("preserves exports that are not namespace re-exports", () => {
      const fixture = createFixture(`${EAGER_INDEX}exports.SDK_VERSION = "1.2.3";
Object.defineProperty(exports, "answer", { enumerable: true, get: function () { return 42; } });
`);
      expect(lazify(fixture).status).to.equal(0);

      const root = requireRoot(fixture) as unknown as { SDK_VERSION: string; answer: number };

      expect(root.SDK_VERSION).to.equal("1.2.3");
      expect(root.answer).to.equal(42);
      expect(namespacesLoaded()).to.deep.equal([]);
    });

    it("drops the source map reference and file, which no longer line up", () => {
      const fixture = createFixture(`${EAGER_INDEX}//# sourceMappingURL=index.js.map\n`);
      fs.writeFileSync(`${fixture.indexPath}.map`, "{}");

      expect(lazify(fixture).status).to.equal(0);

      expect(fs.readFileSync(fixture.indexPath, "utf8")).to.not.include("sourceMappingURL");
      expect(fs.existsSync(`${fixture.indexPath}.map`)).to.equal(false);
    });

    it("is idempotent", () => {
      const fixture = createFixture();
      lazify(fixture);
      const once = fs.readFileSync(fixture.indexPath, "utf8");

      const second = lazify(fixture);

      expect(second.stdout).to.include("already lazified");
      expect(fs.readFileSync(fixture.indexPath, "utf8")).to.equal(once);
    });
  });

  // The script only helps if it keeps matching tsc's output. Both guards below exist so
  // that an emit-shape change fails the build instead of silently shipping an eager
  // barrel (a memory regression) or a barrel missing exports (a runtime break).
  describe("emit-shape drift", () => {
    it("fails when no namespace re-export matches", () => {
      const fixture = createFixture(`"use strict";
const tslib_1 = require("tslib");
exports.alpha = tslib_1.__importStar(require, "./alpha");
`);

      const result = lazify(fixture);

      expect(result.status).to.equal(1);
      expect(result.stderr).to.include("no eager namespace re-exports found");
    });

    it("fails when only some namespace re-exports match", () => {
      const fixture = createFixture(`"use strict";
const tslib_1 = require("tslib");
exports.alpha = tslib_1.__importStar(require("./alpha"));
exports.beta = tslib_1.__importStar(require("./beta"), { with: {} });
`);

      const result = lazify(fixture);

      expect(result.status).to.equal(1);
      expect(result.stderr).to.include("survived the rewrite");
      expect(result.stderr).to.include("exports.beta");
    });

    it("fails when the tslib require used to anchor the helper is missing", () => {
      const fixture = createFixture(`"use strict";
const tslib = require("tslib");
exports.alpha = tslib_1.__importStar(require("./alpha"));
`);

      const result = lazify(fixture);

      expect(result.status).to.equal(1);
      expect(result.stderr).to.include("anchor the lazy helper");
    });
  });
});
