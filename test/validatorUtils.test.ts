import { expect } from "chai";
import { utils, interfaces } from "../src";
import { ZERO_ADDRESS } from "../src/constants";
import { toBN } from "@across-protocol/contracts-v2";
import { cloneDeep } from "lodash";
import { objectWithBigNumberReviver } from "../src/utils";
import { Deposit } from "../src/interfaces";

describe("validatorUtils", () => {
  describe("isDeposit", () => {
    let deposit: interfaces.DepositWithBlock;
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
        realizedLpFeePct: toBN(0),
        destinationToken: ZERO_ADDRESS,
        transactionHash: "0xa",
        blockNumber: 0,
        transactionIndex: 0,
        logIndex: 0,
        quoteBlockNumber: 0,
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
    it("should successfully rehydrate real deposits", () => {
      const deposits: string[] = [
        '{"amount":{"type":"BigNumber","hex":"0x038d7ea4c68000"},"originChainId":42161,"destinationChainId":10,"relayerFeePct":{"type":"BigNumber","hex":"0xee042a4c72e9a8"},"depositId":1160366,"quoteTimestamp":1697088000,"originToken":"0x82aF49447D8a07e3bd95BD0d56f35241523fBab1","recipient":"0x525D59654479cFaED622C1Ca06f237ce1072c2AB","depositor":"0x269727F088F16E1Aea52Cf5a97B1CD41DAA3f02D","message":"0x","blockNumber":139874261,"transactionIndex":1,"logIndex":1,"transactionHash":"0x4c4273f4cceb288a76aa7d6c057a8e3ab571a19711a59a965726e06b04e6b821","realizedLpFeePct":{"type":"BigNumber","hex":"0x016b90ac8ef5b9"},"destinationToken":"0x4200000000000000000000000000000000000006","quoteBlockNumber":18332204}',
      ];
      const rehydratedDeposits = deposits.map((d) => JSON.parse(d, objectWithBigNumberReviver) as Deposit);
      expect(rehydratedDeposits.every(utils.isDepositFormedCorrectly)).to.be.true;
    });
  });
});
