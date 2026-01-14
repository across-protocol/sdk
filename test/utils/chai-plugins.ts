import type { ChaiPlugin } from "chai";
import { Address } from "../../src/utils";

/**
 * Chai plugin that adds support for direct Address equality comparisons.
 *
 * This plugin overrides the `equal` assertion to detect when both values are Address instances
 * and uses the Address class's `.eq()` method for comparison instead of reference equality.
 *
 * Note: This plugin only handles direct Address-to-Address comparisons with `.to.equal()`.
 * For objects containing Address instances, you'll need to manually compare Address fields
 * using `.eq()` or use Chai's `.excludingEvery()` to exclude Address fields from deep equality checks.
 *
 * @example
 * ```typescript
 * import chai from "chai";
 * import { addressEqualityPlugin } from "@across-protocol/sdk/test/utils/chai-plugins";
 *
 * chai.use(addressEqualityPlugin);
 *
 * // Direct Address comparison works
 * expect(address1).to.equal(address2);
 *
 * // For objects with Address fields, manually check each Address field
 * expect(obj1.depositor).to.equal(obj2.depositor);
 * expect(obj1.recipient).to.equal(obj2.recipient);
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
