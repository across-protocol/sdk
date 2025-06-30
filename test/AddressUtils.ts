import { bs58, EvmAddress, SvmAddress, toAddressType, isValidEvmAddress } from "../src/utils";
import { CHAIN_IDs } from "../src/constants";
import { expect, ethers } from "./utils";

describe("Address Utils: Address Type", function () {
  const EVM_ZERO_PAD = "0x000000000000000000000000";
  const randomBytes = (n: number): string => ethers.utils.hexlify(ethers.utils.randomBytes(n));
  const generateSvmAddress = () => toAddressType(bs58.encode(ethers.utils.randomBytes(32)), CHAIN_IDs.SOLANA);
  const { arrayify } = ethers.utils;

  describe("Correctness of Address methods", function () {
    it("Correctly identifies address types", function () {
      const evmToken = EvmAddress.from(randomBytes(20));
      expect(evmToken.isEVM()).to.be.true;
      expect(isValidEvmAddress(evmToken.toHexString())).to.be.true;
      expect(ethers.utils.isAddress(evmToken.toNative())).to.be.true;
      expect(ethers.utils.hexDataLength(evmToken.toNative()) === 20).to.be.true;

      const svmToken = generateSvmAddress();
      expect(svmToken.isSVM()).to.be.true;
      expect(ethers.utils.isHexString(svmToken.toNative())).to.be.false;
    });
    it("Coerces addresses to their proper type when possible", function () {
      let evmAddress = toAddressType(randomBytes(20), CHAIN_IDs.MAINNET);
      expect(evmAddress.isEVM()).to.be.true;

      // Should also accept 32-byte zero-padded addresses.
      evmAddress = toAddressType(EVM_ZERO_PAD + randomBytes(20).slice(2), CHAIN_IDs.MAINNET);
      expect(evmAddress.isEVM()).to.be.true;

      const invalidEvmAddress = randomBytes(32);
      expect(EvmAddress.validate(arrayify(invalidEvmAddress))).to.be.false;
      expect(() => toAddressType(invalidEvmAddress, CHAIN_IDs.MAINNET)).to.throw;
    });
    it("Rejects padded SVM (suspect EVM) addresses", function () {
      const rawAddress = arrayify(EVM_ZERO_PAD + randomBytes(20).slice(2));
      expect(rawAddress.slice(0, 12).every((field: number) => field === 0)).to.be.true;

      expect(() => new SvmAddress(rawAddress)).to.throw;
    });
    it("Rejects invalid SVM address lengths", function () {
      [20, 31, 33].forEach((len) => {
        const rawAddress = arrayify(randomBytes(len));
        expect(() => new SvmAddress(rawAddress)).to.throw;
      });

      const rawAddress = arrayify(randomBytes(32));
      expect(new SvmAddress(rawAddress)).to.not.throw;
    });
    it("Handles base58-encoded EVM addresses", function () {
      const rawAddress = arrayify(randomBytes(20));

      // Valid padding length
      let padding = new Uint8Array(12);
      let b58Address = bs58.encode([...padding, ...rawAddress]).toString();
      const address = EvmAddress.from(b58Address, "base58");
      expect(address.toNative()).to.equal(ethers.utils.getAddress(ethers.utils.hexlify(rawAddress)));

      // Wrong encoding
      expect(() => EvmAddress.from(b58Address, "base16")).to.throw(Error, /invalid arrayify value/);

      // Invalid EVM address length
      [19, 21].forEach((len) => {
        b58Address = bs58.encode([...padding, ...arrayify(randomBytes(len))]).toString();
        expect(() => EvmAddress.from(b58Address, "base58")).to.throw(Error, /is not a valid EVM address/);
      });

      // Invalid padding length.
      [11, 13].forEach((len) => {
        padding = new Uint8Array(len);
        b58Address = bs58.encode([...padding, ...rawAddress]).toString();
        expect(() => EvmAddress.from(b58Address, "base58")).to.throw(Error, /is not a valid EVM address/);
      });
    });
    it("Handles base16-encoded SVM addresses", function () {
      const rawAddress = randomBytes(32);
      const expectedAddress = bs58.encode(arrayify(rawAddress));

      // Valid address
      const address = SvmAddress.from(rawAddress, "base16");
      expect(address.toNative()).to.equal(expectedAddress);

      // Wrong encoding
      expect(() => SvmAddress.from(rawAddress, "base58")).to.throw(Error, /Non-base58 character/);

      // Invalid SVM address length
      [31, 33].forEach((len) => {
        expect(() => SvmAddress.from(randomBytes(len), "base16")).to.throw(Error, /is not a valid SVM address/);
      });
    });
  });
});
