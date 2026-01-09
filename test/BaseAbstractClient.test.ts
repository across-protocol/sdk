import { BaseAbstractClient } from "../src/clients/BaseAbstractClient";
import { expect } from "./utils";

class TestAbstractClient extends BaseAbstractClient {}

describe("Test that the BaseAbstractClient class works as expected", () => {
  it("Test that the constructor works as expected", () => {
    const client = new TestAbstractClient();
    expect(client).to.be.instanceOf(TestAbstractClient);
  });
  it("Test that the isUpdated variable works as expected", () => {
    const client = new TestAbstractClient();
    expect(client.isUpdated).to.not.be.undefined;
    expect(client.isUpdated).to.be.false;
    client.isUpdated = true;
    expect(client.isUpdated).to.be.true;
    expect(() => {
      client.isUpdated = false;
    }).to.throw();
  });
});
