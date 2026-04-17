import { create, is } from "superstruct";
import { isAddress as viemIsAddress } from "viem";
import { isAddress as solanaKitIsAddress } from "@solana/kit";
import { TronWeb } from "tronweb";
import { bs58, EvmAddress, RawAddress, SvmAddress, TvmAddress } from "../src/utils";
import { AddressType, BundleDataSS } from "../src/clients/BundleDataClient/utils/SuperstructUtils";
import { expect, ethers } from "./utils";

describe("BundleDataClient: Arweave payload address coercer", function () {
  // Regression anchor: the Tron depositor that triggered the original executor crash.
  const KNOWN_TRON_BASE58 = "TRhnR1swKs7cgv4bEmq7jBAfYLRg4j7qCw";
  const KNOWN_TRON_BYTES32 = "0x000000000000000000000000ac973fbbfc469852000d20a60f8b0f15a29e8fc6";
  const BAD_TRON_BYTES32_LEGACY = "0x0000000000000041ac973fbbfc469852000d20a60f8b0f15a29e8fc65c2c04a4";

  const randomEvmHex = (): string => ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)));
  const randomSvmBase58 = (): string => bs58.encode(ethers.utils.randomBytes(32));

  // Two leading zero bytes + 30 bytes of 0xff encode to 43 chars — the less-common SVM length.
  const svm43Base58 = (): string => {
    const bytes = new Uint8Array(32);
    for (let i = 2; i < 32; i++) bytes[i] = 0xff;
    const encoded = bs58.encode(bytes);
    expect(encoded).to.have.lengthOf(43);
    return encoded;
  };

  describe("routes each well-formed input to the correct family", function () {
    it("42-char 0x-hex → EvmAddress", function () {
      const value = randomEvmHex();
      const addr = create(value, AddressType);
      expect(addr).to.be.instanceOf(EvmAddress);
      expect(addr.isEVM()).to.be.true;
      expect(addr.toNative()).to.equal(value);
    });

    it("42-char 0x-hex in all-lowercase and all-UPPERCASE both → EvmAddress", function () {
      // Legacy Arweave payloads may carry non-EIP-55 hex; must not regress to RawAddress.
      const lower = "0x9a8f92a830a5cb89a3816e3d267cb7791c16b04d";
      const upper = "0x9A8F92A830A5CB89A3816E3D267CB7791C16B04D";
      expect(create(lower, AddressType)).to.be.instanceOf(EvmAddress);
      expect(create(upper, AddressType)).to.be.instanceOf(EvmAddress);
    });

    it("34-char T-prefix (canonical Tron) → TvmAddress", function () {
      const addr = create(KNOWN_TRON_BASE58, AddressType);
      expect(addr).to.be.instanceOf(TvmAddress);
      expect(addr.isTVM()).to.be.true;
      expect(addr.toNative()).to.equal(KNOWN_TRON_BASE58);
    });

    it("44-char base58 (typical SVM pubkey) → SvmAddress", function () {
      let value = "";
      for (let i = 0; i < 32 && value.length !== 44; i++) value = randomSvmBase58();
      expect(value).to.have.lengthOf(44);
      const addr = create(value, AddressType);
      expect(addr).to.be.instanceOf(SvmAddress);
      expect(addr.isSVM()).to.be.true;
      expect(addr.toNative()).to.equal(value);
    });

    it("43-char base58 (leading-zero-byte SVM pubkey) → SvmAddress", function () {
      const value = svm43Base58();
      expect(value).to.have.lengthOf(43);
      const addr = create(value, AddressType);
      expect(addr).to.be.instanceOf(SvmAddress);
      expect(addr.isSVM()).to.be.true;
      expect(addr.toNative()).to.equal(value);
    });
  });

  describe("prefix mismatch at a matching length → RawAddress (no family attempted)", function () {
    it("42-char value not starting with 0x → RawAddress", function () {
      // Decodes to ~31 bytes; not 0x-prefixed and wrong length for SVM — must land on RawAddress.
      const value = "2".repeat(42);
      const addr = create(value, AddressType);
      expect(addr).to.be.instanceOf(RawAddress);
      expect(addr.isEVM()).to.be.false;
    });

    it("34-char value not starting with T → RawAddress", function () {
      const value = "1" + "2".repeat(33);
      const addr = create(value, AddressType);
      expect(addr).to.be.instanceOf(RawAddress);
      expect(addr.isTVM()).to.be.false;
    });

    it("43/44-char value starting with 0x → RawAddress", function () {
      const value = "0x" + "a".repeat(42);
      const addr = create(value, AddressType);
      expect(addr).to.be.instanceOf(RawAddress);
      expect(addr.isSVM()).to.be.false;
    });
  });

  describe("unrecognised lengths → RawAddress", function () {
    it("66-char bytes32 hex (legacy form) is no longer routed to EvmAddress", function () {
      const value = ethers.utils.hexZeroPad(randomEvmHex(), 32);
      const addr = create(value, AddressType);
      expect(addr).to.be.instanceOf(RawAddress);
    });

    it("shorter-than-any-family base58 → RawAddress", function () {
      const value = "1".repeat(10);
      const addr = create(value, AddressType);
      expect(addr).to.be.instanceOf(RawAddress);
    });

    it(">32-byte decoded payload throws (base Address constructor guard)", function () {
      // 100-char 0x-hex is 50 bytes after decoding, exceeding the 32-byte Address cap.
      const value = "0x" + "ab".repeat(50);
      expect(() => create(value, AddressType)).to.throw();
    });
  });

  describe("shape matches but family rejects → RawAddress via try/catch", function () {
    it("34-char T-prefix with corrupt checksum → RawAddress (not a crash)", function () {
      const decoded = bs58.decode(KNOWN_TRON_BASE58);
      decoded[5] ^= 0xff;
      const corrupted = bs58.encode(decoded);
      const addr = create(corrupted, AddressType);
      expect(addr).to.be.instanceOf(RawAddress);
      expect(addr.isTVM()).to.be.false;
    });
  });

  describe("round-trips preserve bytes32 identity", function () {
    it("EVM: toNative → coerce → same bytes32", function () {
      const original = EvmAddress.from(ethers.utils.hexlify(ethers.utils.randomBytes(20)));
      const roundTripped = create(original.toNative(), AddressType);
      expect(roundTripped).to.be.instanceOf(EvmAddress);
      expect(roundTripped.toBytes32()).to.equal(original.toBytes32());
    });

    it("TVM: toNative → coerce → same bytes32", function () {
      const original = TvmAddress.from(KNOWN_TRON_BASE58);
      const roundTripped = create(original.toNative(), AddressType);
      expect(roundTripped).to.be.instanceOf(TvmAddress);
      expect(roundTripped.toBytes32()).to.equal(original.toBytes32());
    });

    it("SVM: toNative → coerce → same bytes32", function () {
      const original = SvmAddress.from(randomSvmBase58());
      const roundTripped = create(original.toNative(), AddressType);
      expect(roundTripped).to.be.instanceOf(SvmAddress);
      expect(roundTripped.toBytes32()).to.equal(original.toBytes32());
    });
  });

  describe("regression: the executor-crashing Tron depositor", function () {
    it("deserialises TRhnR1sw… to the canonical 20-byte bytes32, not the 25-byte legacy form", function () {
      const addr = create(KNOWN_TRON_BASE58, AddressType);
      expect(addr).to.be.instanceOf(TvmAddress);
      expect(addr.toBytes32()).to.equal(KNOWN_TRON_BYTES32);
      expect(addr.toBytes32()).to.not.equal(BAD_TRON_BYTES32_LEGACY);
    });

    it("coerces back through toNative without mutation", function () {
      const addr = create(KNOWN_TRON_BASE58, AddressType);
      expect(addr.toNative()).to.equal(KNOWN_TRON_BASE58);
    });
  });

  describe("AddressInstanceSS accepts every concrete subclass", function () {
    it("all four subclasses satisfy the union used by AddressType", function () {
      // `is` exercises the validator path without the coerce step.
      expect(is(EvmAddress.from(ethers.utils.hexlify(ethers.utils.randomBytes(20))), AddressType)).to.be.true;
      expect(is(TvmAddress.from(KNOWN_TRON_BASE58), AddressType)).to.be.true;
      expect(is(SvmAddress.from(randomSvmBase58()), AddressType)).to.be.true;
      expect(is(new RawAddress(ethers.utils.randomBytes(16)), AddressType)).to.be.true;
    });
  });

  describe("SVM masquerade: @solana/kit.isAddress accepts, SvmAddress.validate rejects", function () {
    // 12 leading zero bytes + 20-byte EVM tail: kit.isAddress accepts, SvmAddress.validate
    // rejects. The coercer's try/catch must rescue rather than crash or tag as SVM.
    it("12-leading-zero-byte 32B base58 falls through try/catch to RawAddress", function () {
      const bytes = new Uint8Array(32);
      bytes.set(ethers.utils.arrayify("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D"), 12);
      const masquerade = bs58.encode(bytes);
      const addr = create(masquerade, AddressType);
      expect(addr).to.be.instanceOf(RawAddress);
      expect(addr.isSVM()).to.be.false;
      expect(addr.isEVM()).to.be.false;
    });
  });

  describe("integration: full BundleDataSS with Tron depositor", function () {
    // End-to-end check on the bucket layout that crashed the executor.
    const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    const TRON_USDT_BYTES32 = "0x000000000000000000000000a614f803b6fd780986a42c78ec9c7f77e6ded13c";
    const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const EVM_RECIPIENT = "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D";
    const EVM_ZERO = "0x0000000000000000000000000000000000000000";

    const tronOriginDeposit = {
      quoteBlockNumber: 81910700,
      destinationChainId: 8453,
      quoteTimestamp: 1776400000,
      blockNumber: 81910727,
      logIndex: 0,
      transactionHash: "0x6459b00efc569042640134b0dfb1ecbd1a72e36a284fc430e85ae90662cfda72",
      inputToken: TRON_USDT,
      inputAmount: "1500000",
      outputToken: BASE_USDC,
      outputAmount: "1495279",
      fillDeadline: 1776406847,
      exclusiveRelayer: EVM_ZERO,
      exclusivityDeadline: 0,
      originChainId: 728126428,
      depositor: KNOWN_TRON_BASE58,
      recipient: EVM_RECIPIENT,
      depositId: "27",
      message: "0x",
    };

    it("coerces a Tron-origin expired deposit end-to-end with TVM family intact", function () {
      const bundle = {
        bundleDepositsV3: {},
        expiredDepositsToRefundV3: {
          "728126428": { [TRON_USDT_BYTES32]: [tronOriginDeposit] },
        },
        unexecutableSlowFills: {},
        bundleSlowFillsV3: {},
        bundleFillsV3: {},
      };

      const parsed = create(bundle, BundleDataSS);
      const [deposit] = parsed.expiredDepositsToRefundV3[728126428][TRON_USDT_BYTES32];

      expect(deposit.depositor).to.be.instanceOf(TvmAddress);
      expect(deposit.depositor.isTVM()).to.be.true;
      expect(deposit.depositor.toBytes32()).to.equal(KNOWN_TRON_BYTES32);
      expect(deposit.depositor.toBytes32()).to.not.equal(BAD_TRON_BYTES32_LEGACY);
      expect(deposit.depositor.toNative()).to.equal(KNOWN_TRON_BASE58);

      expect(deposit.inputToken).to.be.instanceOf(TvmAddress);
      expect(deposit.outputToken).to.be.instanceOf(EvmAddress);
      expect(deposit.recipient).to.be.instanceOf(EvmAddress);
      expect(deposit.exclusiveRelayer).to.be.instanceOf(EvmAddress);
    });
  });

  describe("upstream validators never throw (regression guard)", function () {
    // If upstream `isAddress` throws instead of returning false, the shared try/catch would
    // short-circuit later branches. Pin the boolean-return contract.
    const badInputs = ["", "not-an-address", "garbage"];

    const probe = (name: string, validator: (v: string) => unknown) => {
      it(`${name} returns false (not throws) for invalid input`, function () {
        for (const input of badInputs) {
          let result: unknown;
          expect(() => {
            result = validator(input);
          }).to.not.throw();
          expect(result).to.be.false;
        }
      });
    };

    probe("viem.isAddress", viemIsAddress);
    probe("TronWeb.isAddress", (v) => TronWeb.isAddress(v));
    probe("@solana/kit.isAddress", solanaKitIsAddress);
  });
});
