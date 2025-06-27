import { EVMSpokePoolClient, SpokePoolClient } from "../src/clients";
import { bnOne, toBN, InvalidFill, deploy as deployMulticall, getRelayEventKey } from "../src/utils";
import { CHAIN_ID_TEST_LIST, originChainId, destinationChainId, repaymentChainId } from "./constants";
import {
  expect,
  BigNumber,
  toBNWei,
  ethers,
  SignerWithAddress,
  deposit,
  setupTokensForWallet,
  deploySpokePoolWithToken,
  Contract,
  createSpyLogger,
  deployAndConfigureHubPool,
  enableRoutesOnHubPool,
  deployConfigStore,
  getLastBlockTime,
  winston,
} from "./utils";
import { MockConfigStoreClient, MockHubPoolClient } from "./mocks";
import sinon from "sinon";

describe("SpokePoolClient: Find Deposits", function () {
  let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract, hubPool: Contract;
  let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
  let spokePool1DeploymentBlock: number;
  let l1Token: Contract, configStore: Contract;
  let spyLogger: winston.Logger;
  let spokePoolClient1: SpokePoolClient, configStoreClient: MockConfigStoreClient;
  let inputToken: string, outputToken: string;
  let inputAmount: BigNumber, outputAmount: BigNumber;
  let hubPoolClient: MockHubPoolClient;

  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    await deployMulticall(owner);
    ({
      spokePool: spokePool_1,
      erc20: erc20_1,
      deploymentBlock: spokePool1DeploymentBlock,
    } = await deploySpokePoolWithToken(originChainId));
    ({ spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId));
    ({ hubPool, l1Token_1: l1Token } = await deployAndConfigureHubPool(owner, [
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
      { l2ChainId: originChainId, spokePool: spokePool_1 },
      { l2ChainId: repaymentChainId, spokePool: spokePool_1 },
      { l2ChainId: 1, spokePool: spokePool_1 },
    ]));
    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token, destinationToken: erc20_1 },
      { destinationChainId: destinationChainId, l1Token, destinationToken: erc20_2 },
    ]);
    ({ spyLogger } = createSpyLogger());
    ({ configStore } = await deployConfigStore(owner, [l1Token]));
    configStoreClient = new MockConfigStoreClient(spyLogger, configStore, undefined, undefined, CHAIN_ID_TEST_LIST);
    await configStoreClient.update();
    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
    hubPoolClient.setTokenMapping(l1Token.address, originChainId, erc20_1.address);
    hubPoolClient.setTokenMapping(l1Token.address, destinationChainId, erc20_2.address);
    await hubPoolClient.update();
    spokePoolClient1 = new EVMSpokePoolClient(
      spyLogger,
      spokePool_1,
      hubPoolClient,
      originChainId,
      spokePool1DeploymentBlock
    );
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], undefined, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_2], undefined, 10);
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    inputToken = erc20_1.address;
    inputAmount = toBNWei(1);
    outputToken = erc20_2.address;
    outputAmount = inputAmount.sub(bnOne);
  });

  describe("findAllDeposits", function () {
    it("finds deposits in memory and on-chain", async function () {
      const depositEvent = await deposit(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );
      await spokePoolClient1.update();
      const result = await spokePoolClient1.findAllDeposits(depositEvent.depositId);
      expect(result.found).to.be.true;
      if (result.found) {
        expect(result.deposits).to.have.lengthOf(1);
        expect(result.deposits[0]).to.deep.include({
          depositId: depositEvent.depositId,
          originChainId: depositEvent.originChainId,
          destinationChainId: depositEvent.destinationChainId,
          depositor: depositEvent.depositor,
          recipient: depositEvent.recipient,
          inputToken: depositEvent.inputToken,
          outputToken: depositEvent.outputToken,
          inputAmount: depositEvent.inputAmount,
          outputAmount: depositEvent.outputAmount,
        });
      }
    });

    it("returns empty result for non-existent deposit ID", async function () {
      await spokePoolClient1.update();
      const nonExistentId = toBN(999999);
      const result = await spokePoolClient1.findAllDeposits(nonExistentId);
      expect(result.found).to.be.false;
      if (!result.found) {
        expect(result.code).to.equal(InvalidFill.DepositIdNotFound);
        expect(result.reason).to.be.a("string");
      }
    });

    it("finds a single deposit for a given ID", async function () {
      const depositEvent = await deposit(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );
      await spokePoolClient1.update();
      const result = await spokePoolClient1.findAllDeposits(depositEvent.depositId);
      expect(result.found).to.be.true;
      if (result.found) {
        expect(result.deposits).to.have.lengthOf(1);
        expect(result.deposits[0]).to.deep.include({
          depositId: depositEvent.depositId,
          originChainId: depositEvent.originChainId,
          destinationChainId: depositEvent.destinationChainId,
          depositor: depositEvent.depositor,
          recipient: depositEvent.recipient,
          inputToken: depositEvent.inputToken,
          outputToken: depositEvent.outputToken,
          inputAmount: depositEvent.inputAmount,
          outputAmount: depositEvent.outputAmount,
        });
      }
    });

    it("simulates fetching a deposit from chain during update", async function () {
      const depositEvent = await deposit(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );
      await spokePoolClient1.update();
      const depositHash = getRelayEventKey(depositEvent);
      delete spokePoolClient1["depositHashes"][depositHash];
      const fakeEvent = {
        args: {
          depositId: depositEvent.depositId,
          originChainId: depositEvent.originChainId,
          destinationChainId: depositEvent.destinationChainId,
          depositor: depositEvent.depositor,
          recipient: depositEvent.recipient,
          inputToken: depositEvent.inputToken,
          inputAmount: depositEvent.inputAmount,
          outputToken: depositEvent.outputToken,
          outputAmount: depositEvent.outputAmount,
          quoteTimestamp: depositEvent.quoteTimestamp,
          message: depositEvent.message,
          fillDeadline: depositEvent.fillDeadline,
          exclusivityDeadline: depositEvent.exclusivityDeadline,
          exclusiveRelayer: depositEvent.exclusiveRelayer,
        },
        blockNumber: depositEvent.blockNumber,
        transactionHash: depositEvent.txnRef,
        transactionIndex: depositEvent.txnIndex,
        logIndex: depositEvent.logIndex,
      };
      const queryFilterStub = sinon.stub(spokePool_1, "queryFilter");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFilterStub.resolves([fakeEvent as any]);
      await spokePoolClient1.update();
      const result = await spokePoolClient1.findAllDeposits(depositEvent.depositId);
      expect(result.found).to.be.true;
      if (result.found) {
        expect(result.deposits).to.have.lengthOf(2);
        expect(result.deposits[0]).to.deep.include({
          depositId: depositEvent.depositId,
          originChainId: depositEvent.originChainId,
          destinationChainId: depositEvent.destinationChainId,
          depositor: depositEvent.depositor,
          recipient: depositEvent.recipient,
          inputToken: depositEvent.inputToken,
          outputToken: depositEvent.outputToken,
          inputAmount: depositEvent.inputAmount,
          outputAmount: depositEvent.outputAmount,
        });
      }
      queryFilterStub.restore();
    });
  });
});
