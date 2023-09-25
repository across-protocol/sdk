import assert from "assert";
import * as poolClient from "../src/pool/poolClient";
import { BigNumber } from "ethers";
jest.useFakeTimers();

test("previewRemoval", function () {
  const user = {
    address: "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D",
    lpTokens: "900000000000000000",
    positionValue: "900000541941830509",
    totalDeposited: "900000000000000000",
    feesEarned: "541941830509",
  };
  const result = poolClient.previewRemoval(user, 0.75);
  assert.equal(BigNumber.from(result.position.recieve).add(result.position.remain).toString(), user.totalDeposited);
  assert.equal(BigNumber.from(result.fees.recieve).add(result.fees.remain).toString(), user.feesEarned);
  assert.equal(BigNumber.from(result.total.recieve).add(result.total.remain).toString(), user.positionValue);
});
