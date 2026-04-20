import ArLocal from "arlocal";
import Arweave from "arweave";
import { JWKInterface } from "arweave/node/lib/wallet";
import { expect } from "chai";
import { object, string } from "superstruct";
import winston from "winston";
import { ArweaveClient, ArweaveGatewayConfig } from "../src/caching";
import { ARWEAVE_TAG_APP_NAME } from "../src/constants";
import { fetchWithTimeout, toBN } from "../src/utils";
import { assertPromiseError, sinon } from "./utils";

const INITIAL_FUNDING_AMNT = "5000000000";
const LOCAL_ARWEAVE_GATEWAY: ArweaveGatewayConfig = {
  protocol: "http",
  host: "localhost",
  port: 1984,
};
const LOCAL_ARWEAVE_URL = `${LOCAL_ARWEAVE_GATEWAY.protocol}://${LOCAL_ARWEAVE_GATEWAY.host}:${LOCAL_ARWEAVE_GATEWAY.port}`;

const mineBlock = () => fetchWithTimeout(`${LOCAL_ARWEAVE_URL}/mine`, {}, {}, undefined, "text");

describe("ArweaveClient", () => {
  const arLocal = new ArLocal(LOCAL_ARWEAVE_GATEWAY.port as number, true);

  let jwk: JWKInterface;
  let client: ArweaveClient;
  // Before running any of the tests, we need to fund the address with some AR
  // so that we can post to our testnet node
  before(async () => {
    // Start the local arweave node
    await arLocal.start();
    // Generate a new JWK for our tests
    jwk = await Arweave.init({}).wallets.generate();
    // Resolve the address of the JWK
    const address = await Arweave.init({}).wallets.jwkToAddress(jwk);
    // Call into the local arweave node to fund the address
    await fetchWithTimeout(`${LOCAL_ARWEAVE_URL}/mint/${address}/${INITIAL_FUNDING_AMNT}`, {}, {}, undefined, "text");
    // Wait for the transaction to be mined
    await mineBlock();
  });

  beforeEach(() => {
    // Create a new Arweave client
    client = new ArweaveClient(
      jwk,
      // Define default winston logger
      winston.createLogger({
        level: "info",
        format: winston.format.json(),
        defaultMeta: { service: "arweave-client" },
        transports: [
          new winston.transports.Console({
            level: "debug",
          }),
        ],
      }),
      [LOCAL_ARWEAVE_GATEWAY]
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  it(`should have ${INITIAL_FUNDING_AMNT} initial AR in the address`, async () => {
    const balance = (await client.getBalance()).toString();
    expect(balance.toString()).to.equal(INITIAL_FUNDING_AMNT.toString());
  });

  it("should be able to set a basic record and view it on the network", async () => {
    const value = { test: "value" };
    const txID = await client.set(value);
    expect(txID).to.not.be.undefined;

    // Wait for the transaction to be mined
    await mineBlock();
    await mineBlock();

    const retrievedValue = await client.get(txID!, object());
    expect(retrievedValue).to.deep.equal(value);
  });

  it("should successfully set a record with a BigNumber", async () => {
    const value = { test: "value", bigNumber: toBN("1000000000000000000") };
    const txID = await client.set(value);
    expect(txID).to.not.be.undefined;

    // Wait for the transaction to be mined
    await mineBlock();
    await mineBlock();

    const retrievedValue = await client.get(txID!, object());

    const expectedValue = { test: "value", bigNumber: "1000000000000000000" };
    expect(retrievedValue).to.deep.equal(expectedValue);
  });

  it("should validate the record with a struct validator", async () => {
    const value = { test: "value" };
    const txID = await client.set(value);
    expect(txID).to.not.be.undefined;

    // Wait for the transaction to be mined
    await mineBlock();
    await mineBlock();

    const validatorStruct = object({ test: string() });

    const retrievedValue = await client.get(txID!, validatorStruct);
    expect(retrievedValue).to.deep.equal(value);
  });

  it("should fail validation of the record with a struct validator that doesn't match the returned type", async () => {
    const value = { test: "value" };
    const txID = await client.set(value);
    expect(txID).to.not.be.undefined;

    // Wait for the transaction to be mined
    await mineBlock();
    await mineBlock();

    const validatorStruct = object({ invalid: string() });

    const retrievedValue = await client.get(txID!, validatorStruct);
    expect(retrievedValue).to.eq(null);
  });

  it("should retrieve the metadata of a transaction", async () => {
    const value = { test: "value" };
    const txID = await client.set(value);
    expect(txID).to.not.be.undefined;

    // Wait for the transaction to be mined
    await mineBlock();
    await mineBlock();

    const metadata = await client.getMetadata(txID!);
    expect(metadata).to.deep.equal({
      contentType: "application/json",
      appName: ARWEAVE_TAG_APP_NAME,
      topic: undefined,
    });
  });

  it("should retrieve the metadata of a transaction with a topic tag", async () => {
    const value = { test: "value" };
    const topicTag = "test-topic";
    const txID = await client.set(value, topicTag);
    expect(txID).to.not.be.undefined;

    // Wait for the transaction to be mined
    await mineBlock();
    await mineBlock();

    const metadata = await client.getMetadata(txID!);
    expect(metadata).to.deep.equal({
      contentType: "application/json",
      appName: ARWEAVE_TAG_APP_NAME,
      topic: topicTag,
    });
  });

  it("should fetch metadata from /tx/{id} and decode base64url tags", async () => {
    const fetchStub = sinon.stub(globalThis, "fetch").resolves(
      new Response(
        JSON.stringify({
          tags: [
            { name: "Q29udGVudC1UeXBl", value: "YXBwbGljYXRpb24vanNvbg" },
            { name: "QXBwLU5hbWU", value: "YWNyb3NzLXByb3RvY29s" },
            { name: "VG9waWM", value: "dGVzdC10b3BpYw" },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );

    const metadata = await client.getMetadata("test-tx-id");

    expect(fetchStub.calledOnce).to.be.true;
    expect(fetchStub.firstCall.args[0]).to.equal(`${LOCAL_ARWEAVE_URL}/tx/test-tx-id`);
    expect(metadata).to.deep.equal({
      contentType: "application/json",
      appName: "across-protocol",
      topic: "test-topic",
    });
  });

  it("should retrieve the data by the topic tag", async () => {
    const value = { test: "value" };
    const topicTag = "test-topic-for-get-by-topic";
    const txID = await client.set(value, topicTag);
    expect(txID).to.not.be.undefined;

    // Wait for the transaction to be mined
    await mineBlock();
    await mineBlock();

    const data = await client.getByTopic(topicTag, object({ test: string() }), await client.getAddress());

    expect(data).to.deep.equal([
      {
        data: value,
        hash: txID,
      },
    ]);
  });

  it("should gracefully handle out of funds errors", async () => {
    const jwk = await Arweave.init({}).wallets.generate();
    // Create a new Arweave client
    const client = new ArweaveClient(
      jwk,
      // Define default winston logger
      winston.createLogger({
        level: "info",
        format: winston.format.json(),
        defaultMeta: { service: "arweave-client" },
        transports: [new winston.transports.Console()],
      }),
      [LOCAL_ARWEAVE_GATEWAY]
    );
    await assertPromiseError(client.set({ test: "value" }), "You don't have enough tokens");
  });

  after(async () => {
    await arLocal.stop();
  });
});
