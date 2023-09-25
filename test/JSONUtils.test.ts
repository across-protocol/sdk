import { parseJSONWithNumericString } from "../src/utils/JSONUtils";
import { expect } from "./utils";

describe("Test that the parseJSONWithNumericString function works as expected", () => {
  it("Converting a single number should result in a string", () => {
    const result = parseJSONWithNumericString("1");
    expect(result).to.be.eq("1");
  });
  it("Converting a single number with a decimal should result in a string", () => {
    const result = parseJSONWithNumericString("1.2");
    expect(result).to.be.eq("1");
  });
  it("Converting a basic object should result in a numeric string", () => {
    const result = parseJSONWithNumericString(
      JSON.stringify({
        a: 1,
        b: 2,
      })
    );
    expect(result).to.be.deep.eq({
      a: "1",
      b: "2",
    });
  });
});
