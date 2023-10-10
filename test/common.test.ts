import assert from "assert";
import { SpokePool, SpokePool__factory } from "@across-protocol/contracts-v2";
import dotenv from "dotenv";
import { providers } from "ethers";
import {
  createUnsignedFillRelayTransactionFromFill,
  estimateTotalGasRequiredByUnsignedTransaction,
  retry,
  toBNWei,
} from "../src/utils/common";
import { toBN } from "../src/utils/BigNumberUtils";
import { expect } from "./utils";
import { buildFillForSimulatingFullDeposit } from "../src/utils";
import { Fill } from "../src/interfaces";

dotenv.config();

describe("Utils test", () => {
  it("retry", async () => {
    const failN = (numFails: number) => {
      return () =>
        new Promise((resolve, reject) => {
          if (numFails-- > 0) {
            reject();
          }
          resolve(true);
        });
    };
    await Promise.all([
      assert.doesNotReject(() => retry(failN(0), 0, 1)),
      assert.rejects(() => retry(failN(1), 0, 1)),
      assert.doesNotReject(() => retry(failN(1), 1, 1)),
      assert.rejects(() => retry(failN(2), 1, 1)),
      assert.doesNotReject(() => retry(failN(2), 2, 1)),
      assert.rejects(() => retry(failN(3), 2, 1)),
    ]);
  });

  it("apply gas multiplier", async () => {
    const spokePoolAddress = "0xB88690461dDbaB6f04Dfad7df66B7725942FEb9C"; // mainnet
    const relayerAddress = "0x893d0d70ad97717052e3aa8903d9615804167759";

    const gasPrice = toBNWei(1, 9); // 1 Gwei

    // @todo: Ensure that NODE_URL_1 is always defined in test CI?
    const rpcUrl = process.env.NODE_URL_1 ?? "https://cloudflare-eth.com";
    const provider = new providers.JsonRpcProvider(rpcUrl, 1);
    const spokePool: SpokePool = SpokePool__factory.connect(spokePoolAddress, provider);

    const fill: Fill = buildFillForSimulatingFullDeposit(
      "1",
      "usdc",
      42161,
      10,
      relayerAddress,
      undefined,
      relayerAddress,
      relayerAddress
    );
    const unsignedTxn = await createUnsignedFillRelayTransactionFromFill(spokePool, fill);
    const refGasEstimate = await estimateTotalGasRequiredByUnsignedTransaction(
      unsignedTxn,
      relayerAddress,
      provider,
      0.0,
      gasPrice
    );

    for (let gasMarkup = -0.99; gasMarkup <= 4.0; gasMarkup += 0.33) {
      const gasEstimate = await estimateTotalGasRequiredByUnsignedTransaction(
        unsignedTxn,
        relayerAddress,
        provider,
        gasMarkup,
        gasPrice
      );
      const gasMultiplier = toBNWei(1.0 + gasMarkup);

      const expectedValue = toBN(refGasEstimate).mul(gasMultiplier).div(toBNWei(1));

      expect(String(gasEstimate)).to.be.equal(String(expectedValue));
    }
  });
});
