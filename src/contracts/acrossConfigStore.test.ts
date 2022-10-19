import { Client } from "./acrossConfigStore";

describe("Contracts Config Store", () => {
  const BASE_TRUTH = {
    rateModel: { UBar: "750000000000000000", R0: "21000000000000000", R1: "0", R2: "600000000000000000" },
    transferThreshold: "0",
  };
  it("should parse parseL1TokenConfig correctly with exactly the right data", () => {
    const structure = BASE_TRUTH;
    expect(Client.parseL1TokenConfig(JSON.stringify(structure))).toEqual(BASE_TRUTH);
  });
  it("should parse parseL1TokenConfig correctly with additional unneeded params", () => {
    const structure = {
      rateModel: { UBar: "750000000000000000", R0: "21000000000000000", R1: "0", R2: "600000000000000000" },
      transferThreshold: "0",
      spokeTargetBalances: {
        "10": { threshold: "50000000000000000000", target: "20000000000000000000" },
        "42161": { threshold: "100000000000000000000", target: "20000000000000000000" },
      },
    };
    expect(Client.parseL1TokenConfig(JSON.stringify(structure))).toEqual(BASE_TRUTH);
  });
  it("should fail to parse the data to parseL1TokenConfig with malformed input", () => {
    const structure = {
      rateModel: { UBar: "750000000000000000", R0: "21000000000000000", R1: "0", R2: "600000000000000000" },
    };
    expect(() => Client.parseL1TokenConfig(JSON.stringify(structure))).toThrow();
  });
});
