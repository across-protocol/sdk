import { SpokePoolClient } from "../src/clients"; // tested
import { originChainId, destinationChainId } from "./constants";
import { Contract, createSpyLogger, deploySpokePool, enableRoutes, ethers, expect, randomAddress } from "./utils";
import { Address } from "../src/utils";

let spokePool: Contract;

let spokePoolClient: SpokePoolClient;

describe("SpokePoolClient: Deposit Routes", function () {
  beforeEach(async function () {
    // Deploy a minimal spokePool, without using the fixture as this does some route enabling within it.
    ({ spokePool } = await deploySpokePool(ethers));
    const deploymentBlock = await spokePool.provider.getBlockNumber();
    spokePoolClient = new SpokePoolClient(createSpyLogger().spyLogger, spokePool, null, originChainId, deploymentBlock);
  });

  it("Fetches enabled deposit routes", async function () {
    await spokePoolClient.update();
    expect(spokePoolClient.getDepositRoutes()).to.deep.equal({});

    const originToken = Address.fromHex(randomAddress());
    await enableRoutes(spokePool, [{ originToken: originToken.toAddress(), destinationChainId }]);
    await spokePoolClient.update();
    expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
      [originToken.toString()]: { [destinationChainId]: true },
    });

    // Enable another destination chain with the same origin token should append to the previous structure.
    const destinationChainId2 = destinationChainId + 1;
    await enableRoutes(spokePool, [{ originToken: originToken.toAddress(), destinationChainId: destinationChainId2 }]);
    await spokePoolClient.update();
    expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
      [originToken.toString()]: { [destinationChainId]: true, [destinationChainId2]: true },
    });

    // Enable another token should append at the key level of the structure.
    const originToken1 = Address.fromHex(randomAddress());
    await enableRoutes(spokePool, [{ originToken: originToken1.toAddress(), destinationChainId }]);
    await spokePoolClient.update();

    expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
      [originToken.toString()]: { [destinationChainId]: true, [destinationChainId2]: true },
      [originToken1.toString()]: { [destinationChainId]: true },
    });
  });
  it("Correctly toggles to disabled when a route is turned off", async function () {
    const originToken = Address.fromHex(randomAddress());
    await enableRoutes(spokePool, [{ originToken: originToken.toAddress(), destinationChainId }]);
    await spokePoolClient.update();
    expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
      [originToken.toString()]: { [destinationChainId]: true },
    });

    await spokePool.setEnableRoute(originToken.toAddress(), destinationChainId, false); // Disable the route.
    await spokePoolClient.update();
    expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
      [originToken.toString()]: { [destinationChainId]: false },
    });
    const destinationChainId2 = destinationChainId + 1;
    await enableRoutes(spokePool, [{ originToken: originToken.toAddress(), destinationChainId: destinationChainId2 }]);
    await spokePoolClient.update();
    expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
      [originToken.toString()]: { [destinationChainId]: false, [destinationChainId2]: true },
    });
  });
});
