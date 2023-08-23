import assert from "assert";
import { SpokePool, SpokePool__factory } from "@across-protocol/contracts-v2";
import dotenv from "dotenv";
import { providers } from "ethers";
import {
  createUnsignedFillRelayTransaction,
  estimateTotalGasRequiredByUnsignedTransaction,
  retry,
  toBNWei,
} from "./common";
import { toBN } from "./FormattingUtils";

dotenv.config();

describe("Utils test", () => {
  it("retry", async () => {
    const failN = (numFails: number) => async () => {
      if (numFails-- > 0) throw new Error("Failed!");
      return true;
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
    const usdcAddress = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8";
    const relayerAddress = "0x893d0d70ad97717052e3aa8903d9615804167759";

    const gasPrice = toBNWei(1, 9); // 1 Gwei

    // @todo: Ensure that NODE_URL_1 is always defined in test CI?
    const rpcUrl = process.env.NODE_URL_1 ?? "https://cloudflare-eth.com";
    const provider = new providers.JsonRpcProvider(rpcUrl, 1);
    const spokePool: SpokePool = SpokePool__factory.connect(spokePoolAddress, provider);

    const unsignedTxn = await createUnsignedFillRelayTransaction(spokePool, usdcAddress, relayerAddress);
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
      expect(toBN(gasEstimate).eq(toBN(refGasEstimate).mul(gasMultiplier).div(toBNWei(1)))).toBe(true);
    }
  }, 50000);
});
