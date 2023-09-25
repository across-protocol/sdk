import { parseJSONWithNumericString } from "./JSONUtils";

describe("Test that the parseJSONWithNumericString function works as expected", () => {
  test("Converting a single number should result in a string", () => {
    const result = parseJSONWithNumericString("1");
    expect(result).toBe("1");
  });
  test("Converting a single number with a decimal should result in a string", () => {
    const result = parseJSONWithNumericString("1.2");
    expect(result).toBe("1");
  });
  test("Converting a basic object should result in a numeric string", () => {
    const result = parseJSONWithNumericString(
      JSON.stringify({
        a: 1,
        b: 2,
      })
    );
    expect(result).toStrictEqual({
      a: "1",
      b: "2",
    });
  });
});
