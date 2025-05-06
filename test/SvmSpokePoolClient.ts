import { CHAIN_IDs } from "@across-protocol/constants";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { MockSvmSpokePoolClient } from "./mocks/MockSvmSpokePoolClient";
import { createSpyLogger } from "./utils";
import { EventWithData, SVMEventNames } from "../src/arch/svm";
import { expect } from "chai";

describe("SvmSpokePoolClient: Event fetching", function () {
  const logger = createSpyLogger().spyLogger;

  it("Correctly retrieves FundsDeposited events", async function () {
    const spokePoolClient = new MockSvmSpokePoolClient(logger, CHAIN_IDs.SOLANA_DEVNET);
    const mockEventsClient = spokePoolClient.mockEventsClient;
    mockEventsClient.setSlotHeight(BigInt(1000));

    // Inject a series of DepositWithBlock events.
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
      expect(depositEvent.depositId.toString()).to.equal(expectedDeposit.data.depositId.toString());
    });
  });
});
