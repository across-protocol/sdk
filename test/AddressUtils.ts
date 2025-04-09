import { EvmAddress, Address, SvmAddress, toAddressType } from "../src/utils";
import { CHAIN_IDs } from "../src/constants";
import { bs58 } from "../src/utils";
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
      expect(SvmAddress.isAddress(svmToken)).to.be.true;
      expect(ethers.utils.isHexString(svmToken.toAddress())).to.be.false;
    });
    it("Coerces addresses to their proper type when possible", function () {
      const evmAddress = toAddressType(randomBytes(20), CHAIN_IDs.MAINNET);
      expect(EvmAddress.isAddress(evmAddress)).to.be.true;

      const invalidEvmAddress = toAddressType(randomBytes(32), CHAIN_IDs.MAINNET);
      expect(EvmAddress.isAddress(invalidEvmAddress)).to.be.false;
      expect(Address.isAddress(invalidEvmAddress)).to.be.true;
    });
    it("Handles base58-encoded EVM addresses", function () {
      const rawAddress = ethers.utils.arrayify(randomBytes(20));

      // Valid padding length
      let padding = new Uint8Array(12);
      let b58Address = bs58.encode([ ...padding, ...rawAddress]).toString();
      let address = EvmAddress.from(b58Address, "base58");
      expect(address.toAddress()).to.equal(ethers.utils.getAddress(ethers.utils.hexlify(rawAddress)));

      // Wrong encoding
      expect(() => EvmAddress.from(b58Address, "base16"))
        .to.throw(Error, /invalid arrayify value/);

      // Invalid EVM address length
      [19, 21].forEach((len) => {
        b58Address = bs58.encode(
          [ ...padding, ...ethers.utils.arrayify(randomBytes(len))]
        ).toString();
        expect(() => EvmAddress.from(b58Address, "base58"))
          .to.throw(Error, /Not a valid base58-encoded EVM address/);
      });

      // Invalid padding length.
      [11, 13].forEach((len) => {
        padding = new Uint8Array(len);
        b58Address = bs58.encode([ ...padding, ...rawAddress]).toString();
        expect(() => EvmAddress.from(b58Address, "base58"))
          .to.throw(Error, /Not a valid base58-encoded EVM address/);
      });
    });
    it("Handles base16-encoded SVM addresses", function () {
      const rawAddress = randomBytes(32);
      const expectedAddress = bs58.encode(ethers.utils.arrayify(rawAddress));

      // Valid address
      let address = SvmAddress.from(rawAddress, "base16");
      expect(address.toAddress()).to.equal(expectedAddress);

      // Wrong encoding
      expect(() => SvmAddress.from(rawAddress, "base58"))
        .to.throw(Error, /Non-base58 character/);

      // Invalid SVM address length
      [31, 33].forEach((len) => {
        expect(() => SvmAddress.from(randomBytes(len), "base16"))
          .to.throw(Error, /Not a valid base16-encoded SVM address/);
      });
    });
  });
});
