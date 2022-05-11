import assert from "assert";
import { retry } from "./utils";

describe("Utils test", () => {
  it("retry", async () => {
    const failN = (numFails: number) => async () => {
      console.log("failN", numFails);
      if (numFails-- > 0) throw new Error("Failed!");
    };

    assert(
      !(await retry(failN(2), 1, 1).catch(() => {
        console.log("outer catch called");
        return false;
      }))
    );

    // await Promise.all([
    //     assert.doesNotReject(() => retry(failN(0), 0, 1)),
    //     assert.rejects(() => retry(failN(1), 0, 1)),
    //     assert.doesNotReject(() => retry(failN(1), 1, 1)),
    //     assert.rejects(() => retry(failN(2), 1, 1)),
    //     assert.doesNotReject(() => retry(failN(2), 2, 1)),
    //     assert.rejects(() => retry(failN(3), 2, 1)),
    // ]);
  });
});
