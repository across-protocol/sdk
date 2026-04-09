import { bs58, EvmAddress, SvmAddress, TvmAddress, toAddressType, isValidEvmAddress } from "../src/utils";
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
      const address = EvmAddress.from(b58Address);
      expect(address.toNative()).to.equal(ethers.utils.getAddress(ethers.utils.hexlify(rawAddress)));

      // Invalid EVM address length
      [19, 21].forEach((len) => {
        b58Address = bs58.encode([...padding, ...arrayify(randomBytes(len))]).toString();
        expect(() => EvmAddress.from(b58Address)).to.throw(Error, /is not a valid EVM address/);
      });

      // Invalid padding length.
      [11, 13].forEach((len) => {
        padding = new Uint8Array(len);
        b58Address = bs58.encode([...padding, ...rawAddress]).toString();
        expect(() => EvmAddress.from(b58Address)).to.throw(Error, /is not a valid EVM address/);
      });
    });
    it("Handles base16-encoded SVM addresses", function () {
      const rawAddress = randomBytes(32);
      const expectedAddress = bs58.encode(arrayify(rawAddress));

      // Valid address
      const address = SvmAddress.from(rawAddress);
      expect(address.toNative()).to.equal(expectedAddress);

      // Invalid SVM address length
      [31, 33].forEach((len) => {
        expect(() => SvmAddress.from(randomBytes(len))).to.throw(Error, /is not a valid SVM address/);
      });
    });
  });

  describe("Address.eq", function () {
    it("Returns true for identical EVM addresses", function () {
      const raw = randomBytes(20);
      const a = EvmAddress.from(raw);
      const b = EvmAddress.from(raw);
      expect(a.eq(b)).to.be.true;
    });
    it("Returns false for different EVM addresses", function () {
      const a = EvmAddress.from(randomBytes(20));
      const b = EvmAddress.from(randomBytes(20));
      expect(a.eq(b)).to.be.false;
    });
    it("Returns true for identical SVM addresses", function () {
      const raw = randomBytes(32);
      const a = SvmAddress.from(raw);
      const b = SvmAddress.from(raw);
      expect(a.eq(b)).to.be.true;
    });
    it("Returns false for different SVM addresses", function () {
      const a = generateSvmAddress();
      const b = generateSvmAddress();
      expect(a.eq(b)).to.be.false;
    });
    // Cross-type equality is not expected in practice, but verify it behaves correctly.
    it("Returns false when comparing EVM and SVM addresses", function () {
      const evmAddr = EvmAddress.from(randomBytes(20));
      const svmAddr = generateSvmAddress();
      expect(evmAddr.eq(svmAddr)).to.be.false;
    });
    it("Returns false for undefined", function () {
      const a = EvmAddress.from(randomBytes(20));
      expect(a.eq(undefined)).to.be.false;
    });
  });

  describe("Address.compare", function () {
    it("Returns 0 for identical EVM addresses", function () {
      const raw = randomBytes(20);
      const a = EvmAddress.from(raw);
      const b = EvmAddress.from(raw);
      expect(a.compare(b)).to.equal(0);
    });
    it("Returns 0 for identical SVM addresses", function () {
      const raw = randomBytes(32);
      const a = SvmAddress.from(raw);
      const b = SvmAddress.from(raw);
      expect(a.compare(b)).to.equal(0);
    });
    it("Orders EVM addresses by hex value", function () {
      const low = EvmAddress.from("0x0000000000000000000000000000000000000001");
      const high = EvmAddress.from("0x0000000000000000000000000000000000000002");
      expect(low.compare(high)).to.equal(-1);
      expect(high.compare(low)).to.equal(1);
    });
    it("Orders SVM addresses by byte value", function () {
      // Construct two SVM addresses that differ in the first byte.
      const rawLow = arrayify(randomBytes(32));
      const rawHigh = Uint8Array.from(rawLow);
      rawLow[0] = 1;
      rawHigh[0] = 2;
      const low = new SvmAddress(rawLow);
      const high = new SvmAddress(rawHigh);
      expect(low.compare(high)).to.equal(-1);
      expect(high.compare(low)).to.equal(1);
    });
    it("Sorts EVM addresses consistently", function () {
      const addresses = Array.from({ length: 20 }, () => EvmAddress.from(randomBytes(20)));
      const sorted = [...addresses].sort((a, b) => a.compare(b));

      // Verify ascending order.
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i - 1].compare(sorted[i])).to.be.at.most(0);
      }

      // A second sort should produce the same order.
      const resorted = [...addresses].sort((a, b) => a.compare(b));
      sorted.forEach((addr, i) => expect(addr.eq(resorted[i])).to.be.true);
    });
    // Cross-type comparison is not expected in practice, but verify it behaves correctly.
    it("Orders EVM and SVM addresses deterministically", function () {
      const evmAddr = EvmAddress.from(randomBytes(20));
      const svmAddr = generateSvmAddress();
      const result = evmAddr.compare(svmAddr);
      expect(result).to.be.oneOf([1, -1]);
      expect(svmAddr.compare(evmAddr)).to.equal(-result);
    });
    it("Sorts SVM addresses consistently", function () {
      const addresses = Array.from({ length: 20 }, () => generateSvmAddress());
      const sorted = [...addresses].sort((a, b) => a.compare(b));

      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i - 1].compare(sorted[i])).to.be.at.most(0);
      }

      const resorted = [...addresses].sort((a, b) => a.compare(b));
      sorted.forEach((addr, i) => expect(addr.eq(resorted[i])).to.be.true);
    });
  });

  describe("TvmAddress", function () {
    // Randomly generated each test; tronBase58 is derived from hex20 so they always correspond.
    let hex20: string;
    let tronBase58: string;

    beforeEach(function () {
      hex20 = randomBytes(20);
      tronBase58 = TvmAddress.from(hex20).toNative();
    });

    describe("Construction", function () {
      it("Constructs from a 20-byte hex address", function () {
        const addr = TvmAddress.from(hex20);
        expect(addr).to.be.instanceOf(TvmAddress);
        expect(addr.rawAddress.length).to.equal(32);
      });

      it("Constructs from a zero-padded 32-byte hex address", function () {
        const padded = ethers.utils.hexZeroPad(hex20, 32);
        const addr = TvmAddress.from(padded);
        expect(addr).to.be.instanceOf(TvmAddress);
      });

      it("Constructs from a TRON base58check address", function () {
        const addr = TvmAddress.from(tronBase58);
        expect(addr).to.be.instanceOf(TvmAddress);
      });

      it("Throws for an invalid-length hex address", function () {
        const short = "0x" + "ab".repeat(15);
        expect(() => TvmAddress.from(short)).to.throw(/not a valid TVM address/);
      });
    });

    describe("Correctness of type identification", function () {
      it("isTVM returns true", function () {
        const addr = TvmAddress.from(hex20);
        expect(addr.isTVM()).to.be.true;
      });

      it("isEVM and isSVM return false", function () {
        const addr = TvmAddress.from(hex20);
        expect(addr.isEVM()).to.be.false;
        expect(addr.isSVM()).to.be.false;
      });
    });

    describe("toNative", function () {
      it("Returns a TRON base58check address starting with T", function () {
        const addr = TvmAddress.from(hex20);
        expect(addr.toNative()).to.match(/^T/);
      });

      it("Is consistent across multiple calls", function () {
        const addr = TvmAddress.from(hex20);
        expect(addr.toNative()).to.equal(addr.toNative());
      });

      it("Round-trips from base58 input", function () {
        const addr = TvmAddress.from(tronBase58);
        expect(addr.toNative()).to.equal(tronBase58);
      });

      it("Round-trips from hex input back through base58", function () {
        const addr = TvmAddress.from(hex20);
        const native = addr.toNative();
        const roundTripped = TvmAddress.from(native);
        expect(roundTripped.toEvmAddress().toLowerCase()).to.equal(hex20.toLowerCase());
      });
    });

    describe("toHexString", function () {
      it("Returns a checksummed 20-byte EVM hex address", function () {
        const addr = TvmAddress.from(hex20);
        const hex = addr.toHexString();
        expect(hex).to.match(/^0x[0-9a-fA-F]{40}$/);
        expect(hex.toLowerCase()).to.equal(hex20.toLowerCase());
      });
    });

    describe("toEvmAddress", function () {
      it("Returns a valid EVM address", function () {
        const addr = TvmAddress.from(hex20);
        const evm = addr.toEvmAddress();
        expect(ethers.utils.isAddress(evm)).to.be.true;
      });
    });

    describe("toBytes32", function () {
      it("Returns a 66-character lowercase hex string", function () {
        const addr = TvmAddress.from(hex20);
        const b32 = addr.toBytes32();
        expect(b32).to.have.lengthOf(66);
        expect(b32).to.match(/^0x[0-9a-f]{64}$/);
      });

      it("Embeds the original address in the last 20 bytes", function () {
        const addr = TvmAddress.from(hex20);
        const b32 = addr.toBytes32();
        expect(b32.slice(-40)).to.equal(hex20.slice(2).toLowerCase());
      });
    });

    describe("toJSON", function () {
      it("Serializes to the native TRON address", function () {
        const addr = TvmAddress.from(hex20);
        expect(addr.toJSON()).to.equal(addr.toNative());
      });
    });

    describe("validate", function () {
      it("Accepts a 20-byte address", function () {
        expect(TvmAddress.validate(arrayify(hex20))).to.be.true;
      });

      it("Accepts a 32-byte address with 12 leading zero bytes", function () {
        const raw = ethers.utils.zeroPad(arrayify(hex20), 32);
        expect(TvmAddress.validate(raw)).to.be.true;
      });

      it("Rejects a 32-byte address with non-zero leading bytes", function () {
        const raw = new Uint8Array(32);
        raw[0] = 1;
        raw[31] = 0xff;
        expect(TvmAddress.validate(raw)).to.be.false;
      });

      it("Rejects addresses of invalid lengths", function () {
        expect(TvmAddress.validate(new Uint8Array(15))).to.be.false;
        expect(TvmAddress.validate(new Uint8Array(21))).to.be.false;
      });
    });

    describe("toAddressType integration", function () {
      it("Returns a TvmAddress for a TRON chain ID with hex input", function () {
        const addr = toAddressType(hex20, CHAIN_IDs.TRON);
        expect(addr).to.be.instanceOf(TvmAddress);
        expect(addr.isTVM()).to.be.true;
      });

      it("Returns a TvmAddress for a TRON chain ID with base58 input", function () {
        const addr = toAddressType(tronBase58, CHAIN_IDs.TRON);
        expect(addr).to.be.instanceOf(TvmAddress);
        expect(addr.toNative()).to.equal(tronBase58);
      });
    });

    describe("eq", function () {
      it("Returns true for identical TVM addresses", function () {
        const a = TvmAddress.from(hex20);
        const b = TvmAddress.from(hex20);
        expect(a.eq(b)).to.be.true;
      });

      it("Returns true when constructed from hex vs base58 of the same address", function () {
        const fromHex = TvmAddress.from(hex20);
        const fromBase58 = TvmAddress.from(fromHex.toNative());
        expect(fromHex.eq(fromBase58)).to.be.true;
      });

      it("Returns false for different TVM addresses", function () {
        const a = TvmAddress.from(randomBytes(20));
        const b = TvmAddress.from(randomBytes(20));
        expect(a.eq(b)).to.be.false;
      });
    });

    describe("compare", function () {
      it("Returns 0 for identical addresses", function () {
        const a = TvmAddress.from(hex20);
        const b = TvmAddress.from(hex20);
        expect(a.compare(b)).to.equal(0);
      });

      it("Orders addresses deterministically", function () {
        const rawLow = arrayify(randomBytes(20));
        const rawHigh = Uint8Array.from(rawLow);
        rawLow[0] = 1;
        rawHigh[0] = 2;
        const low = TvmAddress.from(ethers.utils.hexlify(rawLow));
        const high = TvmAddress.from(ethers.utils.hexlify(rawHigh));
        expect(low.compare(high)).to.equal(-1);
        expect(high.compare(low)).to.equal(1);
      });
    });

    describe("isZeroAddress", function () {
      it("Returns true for the zero address", function () {
        const addr = TvmAddress.from("0x" + "00".repeat(20));
        expect(addr.isZeroAddress()).to.be.true;
      });

      it("Returns false for a non-zero address", function () {
        const addr = TvmAddress.from(hex20);
        expect(addr.isZeroAddress()).to.be.false;
      });
    });
  });
});
