import { EVMSpokePoolClient, SpokePoolClient, SvmSpokePoolClient } from "../src/clients"; // tested
import { originChainId, destinationChainId } from "./constants";
import { Contract, createSpyLogger, deploySpokePool, enableRoutes, ethers, expect, randomAddress } from "./utils";
import { MockSolanaEventClient } from "./mocks/MockSolanaEventClient";
import { Address, Signature, UnixTimestamp } from "@solana/kit";

describe("SpokePoolClient: Deposit Routes", function () {
  describe("EVM", function () {
    let spokePool: Contract;
    let spokePoolClient: SpokePoolClient;

    beforeEach(async function () {
      // Deploy a minimal spokePool, without using the fixture as this does some route enabling within it.
      ({ spokePool } = await deploySpokePool(ethers));
      const deploymentBlock = await spokePool.provider.getBlockNumber();
      spokePoolClient = new EVMSpokePoolClient(
        createSpyLogger().spyLogger,
        spokePool,
        null,
        originChainId,
        deploymentBlock
      );
    });

    it("Fetches enabled deposit routes", async function () {
      await spokePoolClient.update();
      expect(spokePoolClient.getDepositRoutes()).to.deep.equal({});

      const originToken = randomAddress();
      await enableRoutes(spokePool, [{ originToken, destinationChainId }]);
      await spokePoolClient.update();
      expect(spokePoolClient.getDepositRoutes()).to.deep.equal({ [originToken]: { [destinationChainId]: true } });

      // Enable another destination chain with the same origin token should append to the previous structure.
      const destinationChainId2 = destinationChainId + 1;
      await enableRoutes(spokePool, [{ originToken, destinationChainId: destinationChainId2 }]);
      await spokePoolClient.update();
      expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
        [originToken]: { [destinationChainId]: true, [destinationChainId2]: true },
      });

      // Enable another token should append at the key level of the structure.
      const originToken1 = randomAddress();
      await enableRoutes(spokePool, [{ originToken: originToken1, destinationChainId }]);
      await spokePoolClient.update();

      expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
        [originToken]: { [destinationChainId]: true, [destinationChainId2]: true },
        [originToken1]: { [destinationChainId]: true },
      });
    });
    it("Correctly toggles to disabled when a route is turned off", async function () {
      const originToken = randomAddress();
      await enableRoutes(spokePool, [{ originToken, destinationChainId }]);
      await spokePoolClient.update();
      expect(spokePoolClient.getDepositRoutes()).to.deep.equal({ [originToken]: { [destinationChainId]: true } });

      await spokePool.setEnableRoute(originToken, destinationChainId, false); // Disable the route.
      await spokePoolClient.update();
      expect(spokePoolClient.getDepositRoutes()).to.deep.equal({ [originToken]: { [destinationChainId]: false } });
      const destinationChainId2 = destinationChainId + 1;
      await enableRoutes(spokePool, [{ originToken, destinationChainId: destinationChainId2 }]);
      await spokePoolClient.update();
      expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
        [originToken]: { [destinationChainId]: false, [destinationChainId2]: true },
      });
    });
  });
  describe("SVM", function () {
    let eventClient: MockSolanaEventClient;
    let spokePoolClient: SpokePoolClient;

    beforeEach(async function () {
      eventClient = new MockSolanaEventClient();
      eventClient.setSlotHeight(5n);
      spokePoolClient = await SvmSpokePoolClient.createWithExistingEventClient(
        createSpyLogger().spyLogger,
        null,
        originChainId,
        0n,
        { from: 0, maxLookBack: 1 },
        eventClient
      );
    });
    it("Fetches enabled deposit routes", async function () {
      await spokePoolClient.update();
      expect(spokePoolClient.getDepositRoutes()).to.deep.equal({});

      const originToken = randomAddress();
      eventClient.setEvents([
        {
          slot: 10n,
          signature: "0x123" as Signature,
          name: "EnabledDepositRoute",
          data: {
            originToken,
            destinationChainId,
            enabled: true,
          },
          confirmationStatus: "confirmed",
          blockTime: 1234567890n as UnixTimestamp,
          program: "0x123" as Address,
        },
      ]);
      await spokePoolClient.update();
      expect(spokePoolClient.getDepositRoutes()).to.deep.equal({ [originToken]: { [destinationChainId]: true } });

      // Enable another destination chain with the same origin token should append to the previous structure.
      const destinationChainId2 = destinationChainId + 1;
      eventClient.setEvents([
        {
          slot: 20n,
          signature: "0x123" as Signature,
          name: "EnabledDepositRoute",
          data: {
            originToken,
            destinationChainId: destinationChainId2,
            enabled: true,
          },
          confirmationStatus: "confirmed",
          blockTime: 1234567890n as UnixTimestamp,
          program: "0x123" as Address,
        },
      ]);
      await spokePoolClient.update();
      expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
        [originToken]: { [destinationChainId]: true, [destinationChainId2]: true },
      });

      // Enable another token should append at the key level of the structure.
      const originToken1 = randomAddress();
      eventClient.setEvents([
        {
          slot: 30n,
          signature: "0x123" as Signature,
          name: "EnabledDepositRoute",
          data: {
            originToken: originToken1,
            destinationChainId,
            enabled: true,
          },
          confirmationStatus: "confirmed",
          blockTime: 1234567890n as UnixTimestamp,
          program: "0x123" as Address,
        },
      ]);

      await spokePoolClient.update();

      expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
        [originToken]: { [destinationChainId]: true, [destinationChainId2]: true },
        [originToken1]: { [destinationChainId]: true },
      });
    });
    it("Correctly toggles to disabled when a route is turned off", async function () {
      const originToken = randomAddress();
      eventClient.setEvents([
        {
          slot: 10n,
          signature: "0x123" as Signature,
          name: "EnabledDepositRoute",
          data: {
            originToken,
            destinationChainId,
            enabled: true,
          },
          confirmationStatus: "confirmed",
          blockTime: 1234567890n as UnixTimestamp,
          program: "0x123" as Address,
        },
      ]);

      await spokePoolClient.update();
      expect(spokePoolClient.getDepositRoutes()).to.deep.equal({ [originToken]: { [destinationChainId]: true } });
      eventClient.setEvents([
        {
          slot: 20n,
          signature: "0x123" as Signature,
          name: "EnabledDepositRoute",
          data: {
            originToken,
            destinationChainId,
            enabled: false,
          },
          confirmationStatus: "confirmed",
          blockTime: 1234567890n as UnixTimestamp,
          program: "0x123" as Address,
        },
      ]);
      await spokePoolClient.update();
      expect(spokePoolClient.getDepositRoutes()).to.deep.equal({ [originToken]: { [destinationChainId]: false } });
      const destinationChainId2 = destinationChainId + 1;

      eventClient.setEvents([
        {
          slot: 30n,
          signature: "0x123" as Signature,
          name: "EnabledDepositRoute",
          data: {
            originToken,
            destinationChainId: destinationChainId2,
            enabled: true,
          },
          confirmationStatus: "confirmed",
          blockTime: 1234567890n as UnixTimestamp,
          program: "0x123" as Address,
        },
      ]);

      await spokePoolClient.update();
      expect(spokePoolClient.getDepositRoutes()).to.deep.equal({
        [originToken]: { [destinationChainId]: false, [destinationChainId2]: true },
      });
    });
  });
});
