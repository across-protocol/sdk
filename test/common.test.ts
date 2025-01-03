import assert from "assert";
import { retry } from "../src/utils";

describe("Utils test", () => {
  it("retry", async () => {
    const failN = (numFails: number) => {
      return () =>
        new Promise((resolve, reject) => {
          if (numFails-- > 0) {
            reject();
          }
          resolve(true);
        });
    };
    await Promise.all([
      assert.doesNotReject(() => retry(failN(0), 0, 1)),
      assert.rejects(() => retry(failN(1), 0, 1)),
      assert.doesNotReject(() => retry(failN(1), 1, 1)),
      assert.rejects(() => retry(failN(2), 1, 1)),
      assert.doesNotReject(() => retry(failN(2), 2, 1)),
      assert.rejects(() => retry(failN(3), 2, 1)),
    ]);
  });
});
