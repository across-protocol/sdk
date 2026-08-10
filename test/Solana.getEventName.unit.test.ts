import { expect } from "chai";
import { getEventName, SVMEventNames } from "../src/arch/svm";

/**
 * Regression test for `getEventName` narrowing.
 *
 * The guard behind `getEventName` must test for an *own* property of `SVMEventNames`. An earlier
 * revision used `name in SVMEventNames`, which also matches keys inherited from `Object.prototype`
 * ("toString", "constructor", ...). That made `getEventName` return an unknown name instead of
 * throwing, so a bogus name could reach `SvmCpiEventsClient.queryEvents()` as a real event name and
 * `MockSvmCpiEventsClient.setEvents()` would blow up dereferencing the inherited value as an array.
 */
describe("getEventName", () => {
  it("accepts every declared event name", () => {
    for (const name of Object.keys(SVMEventNames)) {
      expect(getEventName(name)).to.equal(name);
    }
  });

  it("rejects keys inherited from Object.prototype", () => {
    for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty", "isPrototypeOf", "__proto__"]) {
      expect(() => getEventName(name)).to.throw(`Unknown event name: ${name}`);
    }
  });

  it("rejects unknown and partially-matching event names", () => {
    for (const name of ["", "Bogus", "filledrelay", "FilledRelayX", "XFilledRelay"]) {
      expect(() => getEventName(name)).to.throw(`Unknown event name: ${name}`);
    }
  });
});
