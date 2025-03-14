import { EvmAddress, Address, SvmAddress, toAddressType } from "../src/utils";
import bs58 from "bs58";
import { CHAIN_IDs } from "../src/constants";
import { expect, ethers } from "./utils";

describe("Address Utils: Address Type", function () {
  const randomBytes = (n: number): string => ethers.utils.hexlify(ethers.utils.randomBytes(n));
  const generateSvmAddress = () => toAddressType(bs58.encode(ethers.utils.randomBytes(32)), CHAIN_IDs.SOLANA);

  describe("Correctness of Address methods", function () {
    it("Correctly identifies address types", function () {
      const evmToken = EvmAddress.from(randomBytes(20));
      expect(Address.isAddress(evmToken)).to.be.true;
      expect(evmToken.isValidEvmAddress()).to.be.true;
      expect(ethers.utils.isAddress(evmToken.toAddress())).to.be.true;
      expect(ethers.utils.hexDataLength(evmToken.toAddress()) === 20).to.be.true;

      const svmToken = generateSvmAddress();
      expect(Address.isAddress(svmToken)).to.be.true;
      console.log(svmToken);
      expect(SvmAddress.isAddress(svmToken)).to.be.true;
      expect(ethers.utils.isHexString(svmToken.toAddress())).to.be.false;
    });
    it("Coerces addresses to their proper type when possible", function () {
      const validEvmAddress = randomBytes(20);
      const invalidEvmAddress = randomBytes(32);
      const evmAddress = toAddressType(validEvmAddress, CHAIN_IDs.MAINNET);
      const invalidEvmAddress = toAddressType(invalidEvmAddress, CHAIN_IDs.MAINNET);
      expect(EvmAddress.isAddress(evmAddress)).to.be.true;
      expect(EvmAddress.isAddress(invalidEvmAddress)).to.be.false;
      expect(Address.isAddress(invalidEvmAddress)).to.be.true;
    });
  });
});
