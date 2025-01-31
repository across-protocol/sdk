import { ZERO_BYTES } from "../src/constants";
import { getMessageHash, keccak256 } from "../src/utils";
import { expect } from "./utils";

describe("SpokeUtils", function () {
  it("getMessageHash correctly handles empty messages", function () {
    expect(getMessageHash("")).to.equal(ZERO_BYTES);
    expect(getMessageHash("0x")).to.equal(ZERO_BYTES);
    expect(getMessageHash("0x1234")).to.equal(keccak256("0x1234"));
  });
});
