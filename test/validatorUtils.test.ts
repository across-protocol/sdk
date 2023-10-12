import { expect } from "chai";
import { utils, interfaces } from "../src";
import { ZERO_ADDRESS } from "../src/constants";
import { toBN } from "@across-protocol/contracts-v2";
import { cloneDeep } from "lodash";

describe("validatorUtils", () => {
  describe("isDeposit", () => {
    let deposit: interfaces.Deposit;
    beforeEach(() => {
      deposit = {
        depositId: 1,
        depositor: ZERO_ADDRESS,
        destinationChainId: 1,
        originChainId: 1,
        amount: toBN(100),
        message: "",
        quoteTimestamp: 0,
        recipient: ZERO_ADDRESS,
        updatedRecipient: ZERO_ADDRESS,
        originToken: ZERO_ADDRESS,
        relayerFeePct: toBN(0),
        destinationToken: ZERO_ADDRESS,
      };
    });

    it("should return false if an undefined value is passed", () => {
      expect(utils.isDepositFormedCorrectly(undefined)).to.be.false;
    });
    it("should return true on positive conditions", () => {
      // We should be able to return true for the default deposit
      expect(utils.isDepositFormedCorrectly(deposit)).to.be.true;
      // Let's change the recipient to a valid address
      deposit.recipient = utils.randomAddress();
      expect(utils.isDepositFormedCorrectly(deposit)).to.be.true;
    });
    it("should return false if deposit is not close to being formed correctly", () => {
      // Empty Object
      expect(utils.isDepositFormedCorrectly({})).to.be.false;
      // A number
      expect(utils.isDepositFormedCorrectly(1)).to.be.false;
      // A string
      expect(utils.isDepositFormedCorrectly("")).to.be.false;
      // A boolean
      expect(utils.isDepositFormedCorrectly(false)).to.be.false;
      // An array
      expect(utils.isDepositFormedCorrectly([])).to.be.false;
      // A null value
      expect(utils.isDepositFormedCorrectly(null)).to.be.false;
      // A undefined value
      expect(utils.isDepositFormedCorrectly(undefined)).to.be.false;
    });
    it("should return false for nearly valid deposits", () => {
      // Construct a list of changes to make to the deposit to make it invalid
      const changesToMakeInvalid: ((d: interfaces.Deposit) => unknown)[] = [
        // Change the deposit ID to a negative number
        (d) => (d.depositId = -1),
        // Change the depositor to an invalid address
        (d) => (d.depositor = "0x123"),
        // Change the destination chain ID to a negative number
        (d) => (d.destinationChainId = -1),
        // Remove a required field
        (d) => delete (d as unknown as Record<string, unknown>)["originChainId"],
      ];

      // Iterate over each change and ensure that the deposit is made to be invalid
      // We can also sanity check that the deposit is valid before the change
      for (const change of changesToMakeInvalid) {
        // Perform a deep copy
        const depositCopy = cloneDeep(deposit);
        // Sanity check - ensure that default deposit is valid
        expect(utils.isDepositFormedCorrectly(depositCopy)).to.be.true;
        // Make the change
        change(depositCopy);
        // Ensure that the deposit is now invalid
        expect(utils.isDepositFormedCorrectly(depositCopy)).to.be.false;
      }
    });
  });
});
