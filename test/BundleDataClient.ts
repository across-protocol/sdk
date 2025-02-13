import { expect } from "chai";
import { BundleData, BundleDataClient } from "../src/clients/BundleDataClient";
import { getMessageHash, randomAddress, toBN } from "../src/utils";
import { UNDEFINED_MESSAGE_HASH } from "../src/constants";
import { MockSpokePoolClient } from "../src/clients/mocks";
import { createSpyLogger } from "./utils";

const random = () => Math.round(Math.random() * 1e6);

describe("BundleDataClient", function () {
  let chainIds: number[];
  let spokePoolClients: { [chainId: number]: MockSpokePoolClient };
  let bundleDataClient: BundleDataClient;

  const logger = createSpyLogger().spyLogger;
  const l1Token = randomAddress();
  const originChainId = 1;

  beforeEach(function () {
    spokePoolClients = {};
    bundleDataClient = new BundleDataClient(
      logger,
      {}, // commonClients
      spokePoolClients,
      chainIds,
      {} // block buffers
    );
  });

  it("Correctly appends message hashes to deposit and fill events", function () {
    const eventData = {
      depositor: randomAddress(),
      recipient: randomAddress(),
      originChainId,
      destinationChainId: random(),
      inputToken: randomAddress(),
      outputToken: randomAddress(),
      inputAmount: toBN(random()),
      outputAmount: toBN(random()),
      message: "0x",
      messageHash: UNDEFINED_MESSAGE_HASH,
      depositId: toBN(random()),
      quoteTimestamp: random(),
      fillDeadline: random(),
      exclusivityDeadline: random(),
      exclusiveRelayer: randomAddress(),
      fromLiteChain: false,
      toLiteChain: false,
      quoteBlockNumber: random(),
    };

    const blockFields = {
      transactionHash: "",
      blockNumber: 0,
      transactionIndex: 0,
      logIndex: 0,
    };

    const miscFill = {
      relayer: randomAddress(),
      repaymentChainId: random(),
      relayExecutionInfo: {
        updatedRecipient: eventData.recipient,
        updatedMessage: eventData.message,
        updatedOutputAmount: eventData.outputAmount,
        fillType: random(),
      },
    };

    const bundleData: Pick<BundleData, "bundleDepositsV3" | "bundleFillsV3"> = {
      bundleDepositsV3: {
        [originChainId]: {
          [l1Token]: [
            {
              ...eventData,
              ...blockFields,
              message: "0x",
              messageHash: UNDEFINED_MESSAGE_HASH,
            },
            {
              ...eventData,
              ...blockFields,
              message: "0x1234",
              messageHash: UNDEFINED_MESSAGE_HASH,
            },
          ],
        },
      },
      bundleFillsV3: {
        [originChainId]: {
          [l1Token]: {
            fills: [
              {
                ...eventData,
                ...blockFields,
                ...miscFill,
                lpFeePct: toBN(random()),
              },
              {
                ...eventData,
                ...blockFields,
                ...miscFill,
                lpFeePct: toBN(random()),
              },
            ],
            totalRefundAmount: toBN(random()),
            realizedLpFees: toBN(random()),
            refunds: {},
          },
        },
      },
    };

    bundleDataClient.backfillMessageHashes(bundleData);

    Object.values(bundleData.bundleDepositsV3[originChainId][l1Token]).forEach((deposit) => {
      expect(deposit.message).to.exist;
      expect(deposit.messageHash).to.not.equal(UNDEFINED_MESSAGE_HASH);
      expect(deposit.messageHash).to.equal(getMessageHash(deposit.message));
    });
  });
});
