import { BaseAbstractClient } from "../src/clients/BaseAbstractClient";

class TestAbstractClient extends BaseAbstractClient {}

describe("Test that the BaseAbstractClient class works as expected", () => {
  it("Test that the constructor works as expected", () => {
    const client = new TestAbstractClient();
    expect(client).toBeInstanceOf(TestAbstractClient);
  });
  it("Test that the isUdpated variable works as expected", () => {
    const client = new TestAbstractClient();
    expect(client.isUpdated).toBeDefined();
    expect(client.isUpdated).toBeFalsy();
    client.isUpdated = true;
    expect(client.isUpdated).toBeTruthy();
    expect(() => {
      client.isUpdated = false;
    }).toThrowError();
  });
});
