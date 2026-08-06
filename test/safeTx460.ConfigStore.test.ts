import fs from "fs";
import path from "path";
import { Client } from "../src/contracts/acrossConfigStore";
import { AcrossConfigStoreClient } from "../src/clients";
import { parseAndReturnRateModelFromString } from "../src/lpFeeCalculator/rateModel";
import { calculateRealizedLpFeePct } from "../src/lpFeeCalculator";
import { TokenConfig } from "../src/interfaces";
import { toBN, toWei } from "../src/utils";
import { createSpyLogger, expect } from "./utils";

// Fixtures extracted from Safe multisig tx nonce 460 on
// 0xB524735356985D2f267FA010D681f061DfF03715 (safeTxHash 0xf2aa084c…7ba3):
// a MultiSend of three AcrossConfigStore.updateTokenConfig(address,string) calls.
// "onchain_*" are the current values returned by l1TokenConfig(address) at
// ConfigStore 0x3B03509645713718B78951126E0A6dE6f10043f5.
const FIXTURES = path.join(__dirname, "fixtures", "safe-tx-460");
const TOKENS = [
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
];

const read = (f: string) => fs.readFileSync(path.join(FIXTURES, f), "utf8");

// validateTokenConfigUpdate is an instance method that touches no client state,
// so a bare instance is enough to exercise the real validation path.
const configStoreClient = new AcrossConfigStoreClient(
  createSpyLogger().spyLogger,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  {} as any,
  { from: 0, maxLookBack: 0 },
  0
);

const asEvent = (l1Token: string, value: string): TokenConfig =>
  ({
    key: l1Token,
    value,
    blockNumber: 1,
    txnIndex: 0,
    logIndex: 0,
    txnRef: "0xsafeTx460",
  }) as TokenConfig;

describe("Safe tx 460 — proposed ConfigStore token configs", () => {
  TOKENS.forEach(({ symbol, address }) => {
    describe(symbol, () => {
      const proposed = read(`proposed_${symbol}.json`);

      it("is well-formed JSON", () => {
        expect(() => JSON.parse(proposed)).to.not.throw();
      });

      it("passes AcrossConfigStoreClient.validateTokenConfigUpdate", () => {
        expect(() => configStoreClient.validateTokenConfigUpdate(asEvent(address, proposed))).to.not.throw();
        const { rateModel, routeRateModel, spokeTargetBalances } = configStoreClient.validateTokenConfigUpdate(
          asEvent(address, proposed)
        );
        // rateModel === undefined means the client silently drops the whole update.
        expect(rateModel).to.not.equal(undefined);
        expect(Object.keys(routeRateModel).length).to.be.greaterThan(0);
        expect(Object.keys(spokeTargetBalances ?? {}).length).to.be.greaterThan(0);
      });

      it("passes Client.parseL1TokenConfig (superstruct)", () => {
        expect(() => Client.parseL1TokenConfig(proposed)).to.not.throw();
      });

      it("every rate model parses via parseAndReturnRateModelFromString", () => {
        const { rateModel, routeRateModel } = configStoreClient.validateTokenConfigUpdate(asEvent(address, proposed));
        expect(() => parseAndReturnRateModelFromString(rateModel as string)).to.not.throw();
        Object.entries(routeRateModel).forEach(([route, model]) => {
          expect(() => parseAndReturnRateModelFromString(model), `route ${route}`).to.not.throw();
        });
      });

      it("every rate model satisfies isValidRateModel (0 < UBar < 1e18)", () => {
        const parsed = JSON.parse(proposed);
        const models = [parsed.rateModel, ...Object.values(parsed.routeRateModel ?? {})];
        models.forEach((m) => {
          const ubar = toBN((m as { UBar: string }).UBar);
          expect(ubar.gt(0) && ubar.lt(toWei("1")), `UBar ${JSON.stringify(m)}`).to.be.true;
        });
      });

      it("every rate model produces a computable LP fee at 0%/50%/100% utilisation", () => {
        const parsed = JSON.parse(proposed);
        const models = [parsed.rateModel, ...Object.values(parsed.routeRateModel ?? {})];
        models.forEach((m) => {
          [toBN(0), toWei("0.5"), toWei("1")].forEach((util) => {
            expect(
              () => calculateRealizedLpFeePct(m as never, toBN(0), util),
              `${JSON.stringify(m)} @ ${util.toString()}`
            ).to.not.throw();
          });
        });
      });

      it("every spokeTargetBalance is a non-negative integer pair", () => {
        const { spokeTargetBalances } = configStoreClient.validateTokenConfigUpdate(asEvent(address, proposed));
        Object.entries(spokeTargetBalances ?? {}).forEach(([chainId, bal]) => {
          expect(bal.target.gte(0), `chain ${chainId} target`).to.be.true;
          expect(bal.threshold.gte(0), `chain ${chainId} threshold`).to.be.true;
        });
      });
    });
  });

  // The checks above only prove the client ACCEPTS the config. The checks below
  // compare accepted-old vs accepted-new to surface silent behavioural drift.
  describe("behavioural diff vs current on-chain config", () => {
    TOKENS.forEach(({ symbol, address }) => {
      it(`${symbol}: reports routes and spoke targets that change meaning`, () => {
        const oldCfg = configStoreClient.validateTokenConfigUpdate(asEvent(address, read(`onchain_${symbol}.json`)));
        const newCfg = configStoreClient.validateTokenConfigUpdate(asEvent(address, read(`proposed_${symbol}.json`)));

        const oldRoutes = new Set(Object.keys(oldCfg.routeRateModel));
        const newRoutes = new Set(Object.keys(newCfg.routeRateModel));
        const droppedRoutes = [...oldRoutes].filter((r) => !newRoutes.has(r));
        const changedRoutes = [...oldRoutes].filter(
          (r) => newRoutes.has(r) && oldCfg.routeRateModel[r] !== newCfg.routeRateModel[r]
        );

        const oldSpokes = new Set(Object.keys(oldCfg.spokeTargetBalances ?? {}));
        const newSpokes = new Set(Object.keys(newCfg.spokeTargetBalances ?? {}));
        const droppedSpokes = [...oldSpokes].filter((c) => !newSpokes.has(c));

        // A dropped route silently falls back to the token default rate model.
        const fallback = parseAndReturnRateModelFromString(newCfg.rateModel as string);
        const feeDelta = droppedRoutes
          .map((route) => {
            const before = parseAndReturnRateModelFromString(oldCfg.routeRateModel[route]);
            const util = toWei("0.5");
            const feeBefore = calculateRealizedLpFeePct(before, toBN(0), util);
            const feeAfter = calculateRealizedLpFeePct(fallback, toBN(0), util);
            return { route, feeBefore, feeAfter, changed: !feeBefore.eq(feeAfter) };
          })
          .filter((r) => r.changed);

        // eslint-disable-next-line no-console
        console.log(
          `\n  ${symbol}: routes ${oldRoutes.size} -> ${newRoutes.size} ` +
            `(dropped ${droppedRoutes.length}, changed ${changedRoutes.length}); ` +
            `spokeTargetBalances ${oldSpokes.size} -> ${newSpokes.size} (dropped ${droppedSpokes.length})\n` +
            `    dropped routes whose LP fee @50% util changes: ${feeDelta.length}\n` +
            feeDelta
              .slice(0, 8)
              .map(
                (d) =>
                  `      ${d.route}: ${d.feeBefore.toString()} -> ${d.feeAfter.toString()}` +
                  ` (${d.feeAfter.gt(d.feeBefore) ? "+" : "-"})`
              )
              .join("\n") +
            (droppedSpokes.length ? `\n    spoke targets reset to 0: ${droppedSpokes.join(", ")}` : "")
        );

        // Not an assertion of correctness — this test exists to print the diff.
        expect(newRoutes.size).to.be.greaterThan(0);
      });
    });
  });
});
