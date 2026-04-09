import { CHAIN_IDs } from "../src/constants";
import { blockExplorerLinks, blockExplorerLink, resolveBlockExplorerDomain } from "../src/utils/BlockExplorerUtils";
import { expect } from "./utils";

const TRON_CHAIN_ID = CHAIN_IDs.TRON;
const TRON_TX_64_HEX = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const TRON_ADDRESS_BASE58 = "TWhDfwC8QE6pQyiYy248dNor3uphPEw5M2";

describe("BlockExplorerUtils", () => {
  describe("blockExplorerLink", () => {
    it("should return a valid block explorer link for a transaction hash", () => {
      const txHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const chainId = 1;
      const expectedLink = `<https://etherscan.io/tx/${txHash} | 0x123..bcdef>`;
      expect(blockExplorerLink(txHash, chainId)).to.be.eq(expectedLink);
    });

    it("should return a valid block explorer link for an address", () => {
      const address = "0x1234567890abcdef1234567890abcdef12345678";
      const chainId = 1;
      const expectedLink = `<https://etherscan.io/address/${address} | 0x123..45678>`;
      expect(blockExplorerLink(address, chainId)).to.be.eq(expectedLink);
    });

    it("should return an unsupported link for an unsupported chainId", () => {
      const hash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const chainId = 123;
      const expectedLink = `<unsupported chain/hash ${chainId}:${hash}>}`;
      expect(blockExplorerLink(hash, chainId)).to.be.eq(expectedLink);
    });

    it("should return <> for an invalid hex string", () => {
      const invalidHex = "not a hex string";
      const chainId = 1;
      expect(blockExplorerLink(invalidHex, chainId)).to.be.eq("<>");
    });

    it("TVM: should link a transaction with path transaction/ and no 0x prefix in URL", () => {
      const txWith0x = `0x${TRON_TX_64_HEX}`;
      const expectedLink = `<https://tronscan.org/#/transaction/${TRON_TX_64_HEX} | 0x123..bcdef>`;
      expect(blockExplorerLink(txWith0x, TRON_CHAIN_ID)).to.be.eq(expectedLink);
    });

    it("TVM: should accept tx id without 0x prefix", () => {
      const expectedLink = `<https://tronscan.org/#/transaction/${TRON_TX_64_HEX} | 12345..bcdef>`;
      expect(blockExplorerLink(TRON_TX_64_HEX, TRON_CHAIN_ID)).to.be.eq(expectedLink);
    });

    it("TVM: should link a Base58Check address", () => {
      const expectedLink = `<https://tronscan.org/#/address/${TRON_ADDRESS_BASE58} | TWhDf..Ew5M2>`;
      expect(blockExplorerLink(TRON_ADDRESS_BASE58, TRON_CHAIN_ID)).to.be.eq(expectedLink);
    });

    it("TVM: should return <> for hex account strings (addresses must be Base58Check)", () => {
      expect(blockExplorerLink("0x1234567890abcdef1234567890abcdef12345678", TRON_CHAIN_ID)).to.be.eq("<>");
      expect(blockExplorerLink("0x4184716914c0fdf7110a44030d04d0c4923504d9cc", TRON_CHAIN_ID)).to.be.eq("<>");
    });

    it("TVM: should return <> for invalid input (not tx hex, not Tron base58)", () => {
      expect(blockExplorerLink("not-tron", TRON_CHAIN_ID)).to.be.eq("<>");
    });
  });

  describe("resolveBlockExplorerDomain", () => {
    it("should return the correct block explorer domain for a supported network", () => {
      const networkId = 1;
      const expectedDomain = "https://etherscan.io";
      expect(resolveBlockExplorerDomain(networkId)).to.be.eq(expectedDomain);
    });

    it("should return undefined for an unsupported network", () => {
      const networkId = 123;
      expect(resolveBlockExplorerDomain(networkId)).to.be.undefined;
    });
  });

  describe("blockExplorerLinks", () => {
    it("should return a list of block explorer links for a list of transaction hashes or addresses", () => {
      const txHashesOrAddresses = [
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        "0x1234567890abcdef1234567890abcdef12345678",
      ];
      const chainId = 1;
      const expectedLinks = [
        "<https://etherscan.io/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef | 0x123..bcdef>\n",
        "<https://etherscan.io/address/0x1234567890abcdef1234567890abcdef12345678 | 0x123..45678>\n",
      ].join("");
      expect(blockExplorerLinks(txHashesOrAddresses, chainId)).to.be.eq(expectedLinks);
    });
  });
});
