import { create, is } from "superstruct";
import { isAddress as viemIsAddress } from "viem";
import { isAddress as solanaKitIsAddress } from "@solana/kit";
import { TronWeb } from "tronweb";
import { bs58, EvmAddress, RawAddress, SvmAddress, TvmAddress } from "../src/utils";
import { AddressType, BundleDataSS } from "../src/clients/BundleDataClient/utils/SuperstructUtils";
import { expect, ethers } from "./utils";

describe("BundleDataClient: Arweave payload address coercer", function () {
  // The specific Tron depositor whose mis-decoding surfaced the original bug. Keeping this as a
  // regression anchor: after the fix, its bytes32 representation must be the canonical 12-zero
  // + 20-byte body form, not the 7-zero + 25-byte (base58-decoded-with-checksum) form.
  const KNOWN_TRON_BASE58 = "TRhnR1swKs7cgv4bEmq7jBAfYLRg4j7qCw";
  const KNOWN_TRON_BYTES32 = "0x000000000000000000000000ac973fbbfc469852000d20a60f8b0f15a29e8fc6";
  const BAD_TRON_BYTES32_LEGACY = "0x0000000000000041ac973fbbfc469852000d20a60f8b0f15a29e8fc65c2c04a4";

  const randomEvmHex = (): string => ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)));
  const randomSvmBase58 = (): string => bs58.encode(ethers.utils.randomBytes(32));

  // Construct a 32-byte pubkey whose base58 encoding is exactly 43 characters. Two leading
  // zero bytes contribute two leading '1' chars; 30 bytes of 0xff encode to 41 chars, giving
  // 43 total. This exercises the less-common valid SVM length.
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

    it("34-char T-prefix (canonical Tron) → TvmAddress", function () {
      const addr = create(KNOWN_TRON_BASE58, AddressType);
      expect(addr).to.be.instanceOf(TvmAddress);
      expect(addr.isTVM()).to.be.true;
      expect(addr.toNative()).to.equal(KNOWN_TRON_BASE58);
    });

    it("44-char base58 (typical SVM pubkey) → SvmAddress", function () {
      const value = randomSvmBase58();
      // Skip unusual generations that don't land on 44 chars — pick until we do.
      const fortyFourChar =
        value.length === 44
          ? value
          : (function retry() {
              for (let i = 0; i < 32; i++) {
                const candidate = randomSvmBase58();
                if (candidate.length === 44) return candidate;
              }
              throw new Error("could not generate a 44-char SVM address");
            })();
      const addr = create(fortyFourChar, AddressType);
      expect(addr).to.be.instanceOf(SvmAddress);
      expect(addr.isSVM()).to.be.true;
      expect(addr.toNative()).to.equal(fortyFourChar);
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
      // 42 base58 '2' characters encode to the integer (58^42 - 1)/57 ≈ 2^246, which occupies
      // ~31 bytes — within the 32-byte Address cap, so the RawAddress fallback succeeds. The
      // value is neither 0x-prefixed (42+0x=EVM) nor the right length for SVM (43/44), so the
      // only correct routing is RawAddress.
      const value = "2".repeat(42);
      const addr = create(value, AddressType);
      expect(addr).to.be.instanceOf(RawAddress);
      expect(addr.isEVM()).to.be.false;
    });

    it("34-char value not starting with T → RawAddress", function () {
      // 34-char base58 that doesn't start with T. Avoid any leading 'T' or '0'.
      const value = "1" + "2".repeat(33);
      expect(value).to.have.lengthOf(34);
      expect(value.startsWith("T")).to.be.false;
      const addr = create(value, AddressType);
      expect(addr).to.be.instanceOf(RawAddress);
      expect(addr.isTVM()).to.be.false;
    });

    it("43/44-char value starting with 0x → RawAddress", function () {
      // 0x + 42 hex chars = 44 chars total, arrayifies to 21 bytes (≤ 32). Doesn't match any
      // EVM-valid length (42 or 66), so the 0x-prefix must block it from the SVM branch and
      // route it to the RawAddress fallback.
      const value = "0x" + "a".repeat(42);
      expect(value).to.have.lengthOf(44);
      const addr = create(value, AddressType);
      expect(addr).to.be.instanceOf(RawAddress);
      expect(addr.isSVM()).to.be.false;
    });
  });

  describe("unrecognised lengths → RawAddress", function () {
    it("66-char bytes32 hex (legacy form) is no longer routed to EvmAddress", function () {
      // After the fix, only 42-char (20-byte) EVM native is recognised. 66-char bytes32 is a
      // legacy serialisation that only the old buggy RawAddress.toNative path produced.
      const value = ethers.utils.hexZeroPad(randomEvmHex(), 32);
      expect(value).to.have.lengthOf(66);
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
      // Flip a non-trailing byte of a valid Tron address to break the base58check checksum
      // without changing the 34-char length. `TvmAddress.from` throws inside TronWeb; the
      // coercer must catch and fall back to RawAddress rather than propagating.
      const decoded = bs58.decode(KNOWN_TRON_BASE58);
      decoded[5] ^= 0xff; // corrupt a byte in the 21-byte body portion
      const corrupted = bs58.encode(decoded);
      expect(corrupted).to.have.lengthOf(34);
      expect(corrupted.startsWith("T")).to.be.true;

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
      // Prove we are not reproducing the pre-fix shape: 7 zero bytes + 25 decoded bytes.
      expect(addr.toBytes32()).to.not.equal(BAD_TRON_BYTES32_LEGACY);
    });

    it("coerces back through toNative without mutation", function () {
      const addr = create(KNOWN_TRON_BASE58, AddressType);
      expect(addr.toNative()).to.equal(KNOWN_TRON_BASE58);
    });
  });

  describe("AddressInstanceSS accepts every concrete subclass", function () {
    it("all four subclasses satisfy the union used by AddressType", function () {
      const evm = EvmAddress.from(ethers.utils.hexlify(ethers.utils.randomBytes(20)));
      const tvm = TvmAddress.from(KNOWN_TRON_BASE58);
      const svm = SvmAddress.from(randomSvmBase58());
      const raw = new RawAddress(ethers.utils.randomBytes(16));
      // `is` exercises the validator path without the coerce step.
      expect(is(evm, AddressType)).to.be.true;
      expect(is(tvm, AddressType)).to.be.true;
      expect(is(svm, AddressType)).to.be.true;
      expect(is(raw, AddressType)).to.be.true;
    });
  });

  describe("SVM masquerade: @solana/kit.isAddress accepts, SvmAddress.validate rejects", function () {
    it("12-leading-zero-byte 32B base58 falls through try/catch to RawAddress", function () {
      // Construct a 32-byte payload whose first 12 bytes are zero and whose tail is an EVM
      // address. `@solana/kit.isAddress` accepts this as a valid 32-byte pubkey (its public
      // contract), but the SDK's `SvmAddress.validate` deliberately rejects the shape to
      // prevent EVM addresses masquerading as SVM. The coercer's try/catch is the only thing
      // keeping this from either crashing or getting silently tagged as SVM.
      const bytes = new Uint8Array(32);
      const evmTail = ethers.utils.arrayify("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D");
      bytes.set(evmTail, 12);
      const masquerade = bs58.encode(bytes);

      const addr = create(masquerade, AddressType);
      expect(addr).to.be.instanceOf(RawAddress);
      expect(addr.isSVM()).to.be.false;
      expect(addr.isEVM()).to.be.false;
    });
  });

  describe("integration: full BundleDataSS with Tron depositor", function () {
    // End-to-end sanity check: the exact bucket layout that crashed the executor, fed through
    // the real BundleDataSS schema. Proves that `AddressType` is wired into every relevant
    // field via the nested record structure and that the Tron depositor survives the full
    // deserialisation with its TVM family tag intact.
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
      expect(deposit.depositor.toNative()).to.equal(KNOWN_TRON_BASE58);

      // The other fields should each land on their own correct family.
      expect(deposit.inputToken).to.be.instanceOf(TvmAddress);
      expect(deposit.outputToken).to.be.instanceOf(EvmAddress);
      expect(deposit.recipient).to.be.instanceOf(EvmAddress);
      expect(deposit.exclusiveRelayer).to.be.instanceOf(EvmAddress);
    });

    it("does not reproduce the pre-fix 25-byte bytes32 anywhere in the parsed bundle", function () {
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

      // The original bug was producing `0x0000000000000041ac97…04a4`; the Tron bytes32 form
      // must instead have 12 leading zero bytes and the 20-byte body with no checksum.
      expect(deposit.depositor.toBytes32()).to.not.equal(BAD_TRON_BYTES32_LEGACY);
    });
  });

  describe("upstream validators never throw (regression guard)", function () {
    // The `AddressType` coercer's try/catch wraps all three family branches. If any upstream
    // `isAddress` starts throwing on invalid input instead of returning `false`, a malformed
    // string in one branch would short-circuit the others. This test pins the boolean-return
    // contract so an upstream semantic change breaks CI loudly.
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
