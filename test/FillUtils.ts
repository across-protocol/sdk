import { DepositWithBlock, FillType, FillWithBlock } from "../src/interfaces";
import { bnOne, bnZero, toBN } from "../src/utils";
import { ZERO_ADDRESS } from "../src/constants";
import { originChainId, destinationChainId, repaymentChainId } from "./constants";
import {
  createSpyLogger,
  deployConfigStore,
  expect,
  hubPoolFixture,
  randomAddress,
  SignerWithAddress,
  ethers,
} from "./utils";
import { verifyFillRepayment } from "../src/clients/BundleDataClient";
import { MockedProvider } from "../src/providers/mockProvider";
import { createRandomBytes32 } from "@across-protocol/contracts/dist/test-utils";
import { TransactionResponse } from "@ethersproject/abstract-provider";
import { MockConfigStoreClient, MockHubPoolClient } from "./mocks";

describe("FillUtils", function () {
  let deposit: DepositWithBlock;
  let fill: FillWithBlock;
  let relayer: string;
  let spokeProvider: MockedProvider;
  let hubPoolClient: MockHubPoolClient;
  let owner: SignerWithAddress;

  const INVALID_EVM_ADDRESS = createRandomBytes32();

  beforeEach(async function () {
    relayer = randomAddress();
    [owner] = await ethers.getSigners();
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
      messageHash: "0x",
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
        updatedMessageHash: deposit.messageHash,
        updatedOutputAmount: deposit.outputAmount,
        updatedRecipient: deposit.recipient,
        fillType: FillType.FastFill,
      },
      relayer,
      repaymentChainId,
    };
    const { hubPool } = await hubPoolFixture();
    const { configStore } = await deployConfigStore(owner, []);
    const configStoreClient = new MockConfigStoreClient(createSpyLogger().spyLogger, configStore);
    hubPoolClient = new MockHubPoolClient(createSpyLogger().spyLogger, hubPool, configStoreClient);
  });

  describe("verifyFillRepayment", function () {
    describe("Deposit repayment is not mapped to a PoolRebalanceRoute", function () {
      it("Repayment gets overwritten to origin chain if only destination chain is mapped to a PoolRebalanceRoute", async function () {
        hubPoolClient.setTokenMapping(ZERO_ADDRESS, deposit.destinationChainId, deposit.outputToken);
        const result = await verifyFillRepayment(fill, spokeProvider, deposit, hubPoolClient);
        expect(result).to.not.be.undefined;
        expect(result!.relayer).to.equal(relayer);

        expect(result!.repaymentChainId).to.equal(originChainId);
        expect(result!.relayer).to.equal(relayer);
      });
      it("Repayment gets overwritten to origin chain if origin chain is not mapped to a PoolRebalanceRoute", async function () {
        const result = await verifyFillRepayment(fill, spokeProvider, deposit, hubPoolClient);
        expect(result).to.not.be.undefined;
        expect(result!.relayer).to.equal(relayer);

        expect(result!.repaymentChainId).to.equal(originChainId);
        expect(result!.relayer).to.equal(relayer);
      });
      it("Relayer is not valid EVM address; relayer gets overwritten to msg.sender on destination chain if destination and origin chain are mapped to PoolRebalanceRoute", async function () {
        hubPoolClient.setTokenMapping(ZERO_ADDRESS, deposit.destinationChainId, deposit.outputToken);
        hubPoolClient.setTokenMapping(ZERO_ADDRESS, deposit.originChainId, deposit.inputToken);
        const invalidRepaymentFill = {
          ...fill,
          relayer: INVALID_EVM_ADDRESS,
        };
        spokeProvider._setTransaction(fill.transactionHash, {
          from: relayer,
        } as unknown as TransactionResponse);
        const result = await verifyFillRepayment(invalidRepaymentFill, spokeProvider, deposit, hubPoolClient);
        expect(result).to.not.be.undefined;
        expect(result!.relayer).to.equal(relayer);
        expect(result!.repaymentChainId).to.equal(destinationChainId);
      });
      it("Relayer is not valid EVM address; relayer gets overwritten to msg.sender on origin chain if origin chain is not mapped to PoolRebalanceRoute", async function () {
        // Origin chain is not mapped:
        hubPoolClient.setTokenMapping(ZERO_ADDRESS, deposit.destinationChainId, deposit.outputToken);
        const invalidRepaymentFill = {
          ...fill,
          relayer: INVALID_EVM_ADDRESS,
        };
        spokeProvider._setTransaction(fill.transactionHash, {
          from: relayer,
        } as unknown as TransactionResponse);
        const result = await verifyFillRepayment(invalidRepaymentFill, spokeProvider, deposit, hubPoolClient);
        expect(result).to.not.be.undefined;
        expect(result!.relayer).to.equal(relayer);
        expect(result!.repaymentChainId).to.equal(originChainId);
      });
      it("Relayer is not valid EVM address; msg.sender is also invalid", async function () {
        const invalidRepaymentFill = {
          ...fill,
          relayer: INVALID_EVM_ADDRESS,
        };
        spokeProvider._setTransaction(fill.transactionHash, {
          from: INVALID_EVM_ADDRESS,
        } as unknown as TransactionResponse);
        const result = await verifyFillRepayment(invalidRepaymentFill, spokeProvider, deposit, hubPoolClient);
        expect(result).to.be.undefined;
      });
    });
    describe("Deposit has valid origin and repayment chain PoolRebalanceRoute mapping", function () {
      beforeEach(function () {
        hubPoolClient.setTokenMapping(ZERO_ADDRESS, deposit.originChainId, deposit.inputToken);
        hubPoolClient.setTokenMapping(ZERO_ADDRESS, fill.repaymentChainId, ZERO_ADDRESS);
      });
      it("Original repayment chain and address is valid", async function () {
        const result = await verifyFillRepayment(fill, spokeProvider, deposit, hubPoolClient);
        expect(result).to.not.be.undefined;
        expect(result!.repaymentChainId).to.equal(fill.repaymentChainId);
        expect(result!.relayer).to.equal(fill.relayer);
      });
      it("SlowFill always valid", async function () {
        // We don't set the repayment chain mapping for the input token because a slow fill should always be valid.
        hubPoolClient.deleteTokenMapping(ZERO_ADDRESS, fill.repaymentChainId);
        const slowFill = { ...fill };
        slowFill.relayExecutionInfo.fillType = FillType.SlowFill;
        const result = await verifyFillRepayment(slowFill, spokeProvider, deposit, hubPoolClient);
        expect(result).to.not.be.undefined;
        expect(slowFill.relayExecutionInfo.fillType).to.equal(FillType.SlowFill);
      });
      it("Lite chain originChain used as repayment and relayer address is valid", async function () {
        // We don't set repayment chain mapping since repayment happens on origin chain.
        hubPoolClient.deleteTokenMapping(ZERO_ADDRESS, fill.repaymentChainId);
        const liteChainDeposit = {
          ...deposit,
          fromLiteChain: true,
        };
        const result = await verifyFillRepayment(fill, spokeProvider, liteChainDeposit, hubPoolClient);
        expect(result).to.not.be.undefined;
        expect(result!.relayer).to.equal(relayer);

        expect(result!.repaymentChainId).to.equal(originChainId);
        expect(result!.relayer).to.equal(relayer);
      });
      it("Lite chain deposit and relayer is not valid EVM address; relayer gets overwritten to msg.sender", async function () {
        // We don't set repayment chain mapping since repayment happens on origin chain.
        hubPoolClient.deleteTokenMapping(ZERO_ADDRESS, fill.repaymentChainId);
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
        const result = await verifyFillRepayment(invalidRepaymentFill, spokeProvider, liteChainDeposit, hubPoolClient);
        expect(result).to.not.be.undefined;
        expect(result!.relayer).to.equal(relayer);
        expect(result!.repaymentChainId).to.equal(originChainId);
      });
      it("Relayer is not valid EVM address, relayer gets overwritten to msg.sender on destination chain if destination chain has valid PoolRebalanceRoute mapping", async function () {
        hubPoolClient.setTokenMapping(ZERO_ADDRESS, deposit.destinationChainId, deposit.outputToken);
        // valid chain ID's doesn't contain repayment chain.
        const invalidRepaymentFill = {
          ...fill,
          relayer: INVALID_EVM_ADDRESS,
        };
        spokeProvider._setTransaction(fill.transactionHash, {
          from: relayer,
        } as unknown as TransactionResponse);
        const result = await verifyFillRepayment(invalidRepaymentFill, spokeProvider, deposit, hubPoolClient);
        expect(result).to.not.be.undefined;
        expect(result!.relayer).to.equal(relayer);
        // Repayment chain gets overwritten to destination chain.
        expect(result!.repaymentChainId).to.equal(destinationChainId);
      });
      it("Relayer is not valid EVM address, relayer gets overwritten to msg.sender on original repayment chain if destination chain does not have valid PoolRebalanceRoute mapping", async function () {
        // valid chain ID's doesn't contain repayment chain.
        const invalidRepaymentFill = {
          ...fill,
          relayer: INVALID_EVM_ADDRESS,
        };
        spokeProvider._setTransaction(fill.transactionHash, {
          from: relayer,
        } as unknown as TransactionResponse);
        const result = await verifyFillRepayment(invalidRepaymentFill, spokeProvider, deposit, hubPoolClient);
        expect(result).to.not.be.undefined;
        expect(result!.relayer).to.equal(relayer);
        expect(result!.repaymentChainId).to.equal(repaymentChainId);
      });
      it("Lite chain deposit and relayer is not valid EVM address; msg.sender is invalid", async function () {
        // We don't set repayment chain mapping since repayment happens on origin chain.
        hubPoolClient.deleteTokenMapping(ZERO_ADDRESS, fill.repaymentChainId);
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
        const result = await verifyFillRepayment(invalidRepaymentFill, spokeProvider, liteChainDeposit, hubPoolClient);
        expect(result).to.be.undefined;
      });
      it("Relayer is not valid EVM address, and msg.sender is invalid", async function () {
        hubPoolClient.setTokenMapping(ZERO_ADDRESS, fill.repaymentChainId, ZERO_ADDRESS);
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
        const result = await verifyFillRepayment(invalidRepaymentFill, spokeProvider, deposit, hubPoolClient);
        expect(result).to.be.undefined;
      });
    });
  });
});
