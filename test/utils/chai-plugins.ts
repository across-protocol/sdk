import type { ChaiPlugin } from "chai";
import { Address } from "../../src/utils";

/**
 * Chai plugin that adds support for Address equality comparisons.
 *
 * This plugin overrides the `equal` assertion to detect when both values are Address instances
 * and uses the Address class's `.eq()` method for comparison instead of reference equality.
 *
 * @example
 * ```typescript
 * import chai from "chai";
 * import { addressEqualityPlugin } from "@across-protocol/sdk/test/utils/chai-plugins";
 *
 * chai.use(addressEqualityPlugin);
 *
 * // Now you can use clean equality syntax in tests
 * expect(address1).to.equal(address2);
 * ```
 */
export const addressEqualityPlugin: ChaiPlugin = function (chai, _utils) {
  const { Assertion } = chai;

  Assertion.overwriteMethod("equal", function (_super) {
    return function (this: Chai.AssertionStatic, expected: unknown, ...args: unknown[]) {
      const obj = this._obj;

      // If both are Address instances, compare their values using .eq()
      if (Address.isAddress(obj) && Address.isAddress(expected)) {
        this.assert(
          obj.eq(expected),
          "expected #{this} to equal #{exp}",
          "expected #{this} to not equal #{exp}",
          expected.toString(),
          obj.toString()
        );
      } else {
        _super.apply(this, [expected, ...args]);
      }
    };
  });
};
