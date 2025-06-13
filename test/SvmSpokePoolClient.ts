import { CHAIN_IDs } from "@across-protocol/constants";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { MockSvmSpokePoolClient } from "../src/clients/mocks";
import { createSpyLogger } from "./utils";
import { EventWithData, SVMEventNames } from "../src/arch/svm";
import { expect } from "chai";
import { BigNumber, toAddressType } from "../src/utils";
import { hexlify } from "ethers/lib/utils";

describe("SvmSpokePoolClient: Event fetching", function () {
  const logger = createSpyLogger().spyLogger;

  it("Correctly retrieves FundsDeposited events", async function () {
    const spokePoolClient = new MockSvmSpokePoolClient(logger, CHAIN_IDs.SOLANA_DEVNET);
    const mockEventsClient = spokePoolClient.mockEventsClient;
    mockEventsClient.setSlotHeight(BigInt(1000));

    // Inject a series of FundsDeposited events.
    const depositEvents: (EventWithData & { data: SvmSpokeClient.FundsDeposited })[] = [];

    for (let idx = 0; idx < 10; ++idx) {
      depositEvents.push(
        spokePoolClient.deposit({} as SvmSpokeClient.FundsDeposited) as EventWithData & {
          data: SvmSpokeClient.FundsDeposited;
        }
      );
    }
    await spokePoolClient.update([SVMEventNames.FundsDeposited]);

    const deposits = spokePoolClient.getDeposits();
    expect(deposits.length).to.equal(depositEvents.length);

    deposits.forEach((depositEvent, idx) => {
      const expectedDeposit = depositEvents[idx];
      expect(depositEvent.depositId).to.equal(BigNumber.from(hexlify(expectedDeposit.data.depositId)));
      expect(depositEvent.depositor.eq(toAddressType(expectedDeposit.data.depositor))).to.be.true;
      expect(depositEvent.recipient.eq(toAddressType(expectedDeposit.data.recipient))).to.be.true;
    });
  });

  it("Correctly retrieves FilledRelay events", async function () {
    const spokePoolClient = new MockSvmSpokePoolClient(logger, CHAIN_IDs.SOLANA_DEVNET);
    const mockEventsClient = spokePoolClient.mockEventsClient;
    mockEventsClient.setSlotHeight(BigInt(1000));

    // Inject a series of FilledRelay events
    const fillEvents: (EventWithData & { data: SvmSpokeClient.FilledRelay })[] = [];

    for (let idx = 0; idx < 10; ++idx) {
      fillEvents.push(
        spokePoolClient.fillRelay({} as SvmSpokeClient.FilledRelay) as EventWithData & {
          data: SvmSpokeClient.FilledRelay;
        }
      );
    }
    await spokePoolClient.update([SVMEventNames.FilledRelay]);

    const fills = spokePoolClient.getFills();
    expect(fills.length).to.equal(fillEvents.length);

    fills.forEach((fillEvent, idx) => {
      const expectedFill = fillEvents[idx];
      expect(fillEvent.depositId).to.equal(BigNumber.from(hexlify(expectedFill.data.depositId)));
      expect(fillEvent.depositor.eq(toAddressType(expectedFill.data.depositor))).to.be.true;
      expect(fillEvent.recipient.eq(toAddressType(expectedFill.data.recipient))).to.be.true;
    });
  });
});
