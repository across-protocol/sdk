import { BaseAbstractClient } from "../src/clients/BaseAbstractClient";
import { createSpyLogger, expect } from "./utils";

class TestAbstractClient extends BaseAbstractClient {}

describe("Test that the BaseAbstractClient class works as expected", () => {
  it("Test that the constructor works as expected", () => {
    const client = new TestAbstractClient(createSpyLogger().spyLogger);
    expect(client).to.be.instanceOf(TestAbstractClient);
  });
  it("Test that the isUpdated variable works as expected", () => {
    const client = new TestAbstractClient(createSpyLogger().spyLogger);
    expect(client.isUpdated).to.not.be.undefined;
    expect(client.isUpdated).to.be.false;
    client.isUpdated = true;
    expect(client.isUpdated).to.be.true;
    expect(() => {
      client.isUpdated = false;
    }).to.throw();
  });
});
