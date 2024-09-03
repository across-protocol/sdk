import assert from "assert";
import { SpokePool, SpokePool__factory } from "@across-protocol/contracts";
import dotenv from "dotenv";
import { providers } from "ethers";
import { DEFAULT_SIMULATED_RELAYER_ADDRESS } from "../src/constants";
import {
  estimateTotalGasRequiredByUnsignedTransaction,
  fixedPointAdjustment,
  populateV3Relay,
  retry,
  toBNWei,
} from "../src/utils";
import { toBN } from "../src/utils/BigNumberUtils";
import { buildDepositForRelayerFeeTest, expect } from "./utils";

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
    const spokePoolAddress = "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5"; // mainnet
    const relayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS;

    // @todo: Ensure that NODE_URL_1 is always defined in test CI?
    const rpcUrl = process.env.NODE_URL_1 ?? "https://cloudflare-eth.com";
    const provider = new providers.JsonRpcProvider(rpcUrl, 1);
    const spokePool: SpokePool = SpokePool__factory.connect(spokePoolAddress, provider);

    const gasPrice = await provider.getGasPrice();

    const deposit = buildDepositForRelayerFeeTest("1", "usdc", 10, 1);
    const fill = await populateV3Relay(spokePool, deposit, relayerAddress);
    const { nativeGasCost: refGasCost, tokenGasCost: refGasEstimate } =
      await estimateTotalGasRequiredByUnsignedTransaction(fill, relayerAddress, provider, 0.0, gasPrice);
    expect(toBN(refGasEstimate).eq(toBN(refGasCost).mul(gasPrice))).to.be.true;

    for (let gasMarkup = -0.99; gasMarkup <= 4.0; gasMarkup += 0.33) {
      const { nativeGasCost, tokenGasCost } = await estimateTotalGasRequiredByUnsignedTransaction(
        fill,
        relayerAddress,
        provider,
        gasMarkup,
        gasPrice
      );
      const gasMultiplier = toBNWei(1.0 + gasMarkup);

      expect(toBN(nativeGasCost).eq(toBN(refGasCost).mul(gasMultiplier).div(fixedPointAdjustment))).to.be.true;
      expect(toBN(tokenGasCost).eq(toBN(refGasEstimate).mul(gasMultiplier).div(fixedPointAdjustment))).to.be.true;
    }
  });
});
