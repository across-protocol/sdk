import { blockExplorerLinks, blockExplorerLink, resolveBlockExplorerDomain } from "../src/utils/BlockExplorerUtils";

describe("BlockExplorerUtils", () => {
  describe("blockExplorerLink", () => {
    it("should return a valid block explorer link for a transaction hash", () => {
      const txHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const chainId = 1;
      const expectedLink = `<https://etherscan.io/tx/${txHash}|0x1..def>`;
      expect(blockExplorerLink(txHash, chainId)).toEqual(expectedLink);
    });

    it("should return a valid block explorer link for an address", () => {
      const address = "0x1234567890abcdef1234567890abcdef12345678";
      const chainId = 1;
      const expectedLink = `<https://etherscan.io/address/${address}|0x1..678>`;
      expect(blockExplorerLink(address, chainId)).toEqual(expectedLink);
    });

    it("should return an unsupported link for an unsupported chainId", () => {
      const hash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const chainId = 123;
      const expectedLink = `<unsupported chain/hash ${chainId}:${hash}>}`;
      expect(blockExplorerLink(hash, chainId)).toEqual(expectedLink);
    });

    it("should return <> for an invalid hex string", () => {
      const invalidHex = "not a hex string";
      const chainId = 1;
      expect(blockExplorerLink(invalidHex, chainId)).toEqual("<>");
    });
  });

  describe("resolveBlockExplorerDomain", () => {
    it("should return the correct block explorer domain for a supported network", () => {
      const networkId = 1;
      const expectedDomain = "https://etherscan.io";
      expect(resolveBlockExplorerDomain(networkId)).toEqual(expectedDomain);
    });

    it("should return undefined for an unsupported network", () => {
      const networkId = 123;
      expect(resolveBlockExplorerDomain(networkId)).toBeUndefined();
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
        "<https://etherscan.io/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef|0x1..def>\n",
        "<https://etherscan.io/address/0x1234567890abcdef1234567890abcdef12345678|0x1..678>\n",
      ].join("");
      expect(blockExplorerLinks(txHashesOrAddresses, chainId)).toEqual(expectedLinks);
    });
  });
});
