import { DepositWithBlock, FillType, FillWithBlock } from "../src/interfaces";
import { bnOne, bnZero, toBN } from "../src/utils";
import { ZERO_ADDRESS } from "../src/constants";
import { originChainId, destinationChainId, repaymentChainId } from "./constants";
import { expect, randomAddress } from "./utils";
import { verifyFillRepayment } from "../src/clients/BundleDataClient";
import { MockedProvider } from "../src/providers/mockProvider";
import { createRandomBytes32 } from "@across-protocol/contracts/dist/test-utils";
import { TransactionResponse } from "@ethersproject/abstract-provider";

describe("FillUtils", function () {
  let deposit: DepositWithBlock;
  let fill: FillWithBlock;
  let relayer: string;
  let spokeProvider: MockedProvider;
  let validChainIds: number[];

  const NOT_VALID_EVM_CHAIN = 9999;
  const INVALID_EVM_ADDRESS = createRandomBytes32();

  beforeEach(function () {
    validChainIds = [originChainId, repaymentChainId];
    relayer = randomAddress();
    spokeProvider = new MockedProvider(bnZero, bnZero);
    deposit = {
      depositId: bnOne,
      depositor: ZERO_ADDRESS,
      destinationChainId,
      originChainId,
      inputAmount: toBN(100),
      inputToken: ZERO_ADDRESS,
      outputAmount: toBN(100),
      outputToken: ZERO_ADDRESS,
      message: "",
      quoteTimestamp: 0,
      recipient: ZERO_ADDRESS,
      updatedRecipient: ZERO_ADDRESS,
      fillDeadline: 100,
      exclusiveRelayer: ZERO_ADDRESS,
      exclusivityDeadline: 100,
      transactionHash: "0xa",
      blockNumber: 0,
      transactionIndex: 0,
      logIndex: 0,
      quoteBlockNumber: 0,
      fromLiteChain: false,
      toLiteChain: false,
    };
    fill = {
      ...deposit,
      relayExecutionInfo: {
        updatedMessage: deposit.message,
        updatedOutputAmount: deposit.outputAmount,
        updatedRecipient: deposit.recipient,
        fillType: FillType.FastFill,
      },
      relayer,
      repaymentChainId,
    };
  });

  describe("verifyFillRepayment", function () {
    it("Original repayment is valid", async function () {
      const result = await verifyFillRepayment(fill, spokeProvider, deposit, validChainIds);
      expect(result).to.not.be.undefined;
    });
    it("SlowFill always valid", async function () {
      const slowFill = { ...fill };
      slowFill.relayExecutionInfo.fillType = FillType.SlowFill;
      const result = await verifyFillRepayment(slowFill, spokeProvider, deposit, validChainIds);
      expect(result).to.not.be.undefined;
      expect(slowFill.relayExecutionInfo.fillType).to.equal(FillType.SlowFill);
    });
    it("Lite chain originChain used as repayment and origin chain is valid repayment chain", async function () {
      const liteChainDeposit = {
        ...deposit,
        fromLiteChain: true,
      };
      const result = await verifyFillRepayment(fill, spokeProvider, liteChainDeposit, [originChainId]);
      expect(result).to.not.be.undefined;

      // Repayment chain is untouched, it will be modified when computing bundle refunds.
      expect(result!.repaymentChainId).to.equal(repaymentChainId);
    });
    it("Lite chain originChain used as repayment but origin chain is invalid repayment chain", async function () {
      const liteChainDeposit = {
        ...deposit,
        fromLiteChain: true,
      };
      const liteChainFill = {
        ...fill,
        originChainId: NOT_VALID_EVM_CHAIN,
      };
      const result = await verifyFillRepayment(liteChainFill, spokeProvider, liteChainDeposit, validChainIds);
      expect(result).to.be.undefined;
    });
    it("Repayment chain is invalid", async function () {
      // valid chain ID's doesn't contain repayment chain.
      const invalidRepaymentFill = {
        ...fill,
        repaymentChainId: NOT_VALID_EVM_CHAIN,
      };
      const result = await verifyFillRepayment(invalidRepaymentFill, spokeProvider, deposit, [repaymentChainId]);
      expect(result).to.be.undefined;
    });
    it("Lite chain deposit and relayer is not valid EVM address; relayer gets overwritten to msg.sender", async function () {
      const liteChainDeposit = {
        ...deposit,
        fromLiteChain: true,
      };
      const invalidRepaymentFill = {
        ...fill,
        relayer: INVALID_EVM_ADDRESS,
      };
      spokeProvider._setTransaction(fill.transactionHash, {
        from: relayer,
      } as unknown as TransactionResponse);
      const result = await verifyFillRepayment(invalidRepaymentFill, spokeProvider, liteChainDeposit, [originChainId]);
      expect(result).to.not.be.undefined;
      expect(result!.relayer).to.equal(relayer);
      // Repayment chain is untouched.
      expect(result!.repaymentChainId).to.equal(repaymentChainId);
    });
    it("Relayer is not valid EVM address, relayer gets overwritten to msg.sender", async function () {
      // valid chain ID's doesn't contain repayment chain.
      const invalidRepaymentFill = {
        ...fill,
        relayer: INVALID_EVM_ADDRESS,
      };
      spokeProvider._setTransaction(fill.transactionHash, {
        from: relayer,
      } as unknown as TransactionResponse);
      const result = await verifyFillRepayment(invalidRepaymentFill, spokeProvider, deposit, [repaymentChainId]);
      expect(result).to.not.be.undefined;
      expect(result!.relayer).to.equal(relayer);
      // Repayment chain is untouched.
      expect(result!.repaymentChainId).to.equal(repaymentChainId);
    });
    it("Lite chain deposit and relayer is not valid EVM address; msg.sender is invalid", async function () {
      const liteChainDeposit = {
        ...deposit,
        fromLiteChain: true,
      };
      const invalidRepaymentFill = {
        ...fill,
        relayer: INVALID_EVM_ADDRESS,
      };
      spokeProvider._setTransaction(fill.transactionHash, {
        from: INVALID_EVM_ADDRESS,
      } as unknown as TransactionResponse);
      const result = await verifyFillRepayment(invalidRepaymentFill, spokeProvider, liteChainDeposit, [originChainId]);
      expect(result).to.be.undefined;
    });
    it("Relayer is not valid EVM address, and msg.sender is invalid", async function () {
      // Simulate what happens if the repayment chain is an EVM chain, the repayment address is not a vaid EVM address,
      // and the msg.sender is not a valid EVM address. This could happen if the fill was sent on Solana and the
      // repayment chain is Ethereum and the repayment address is an SVM address.
      const invalidRepaymentFill = {
        ...fill,
        relayer: INVALID_EVM_ADDRESS,
      };
      spokeProvider._setTransaction(fill.transactionHash, {
        from: INVALID_EVM_ADDRESS,
      } as unknown as TransactionResponse);
      const result = await verifyFillRepayment(invalidRepaymentFill, spokeProvider, deposit, [repaymentChainId]);
      expect(result).to.be.undefined;
    });
  });
});
