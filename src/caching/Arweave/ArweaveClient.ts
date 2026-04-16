import Arweave from "arweave";
import { JWKInterface } from "arweave/node/lib/wallet";

import { Struct, create } from "superstruct";
import winston from "winston";
import { ARWEAVE_TAG_APP_NAME, ARWEAVE_TAG_APP_VERSION, DEFAULT_ARWEAVE_STORAGE_ADDRESS } from "../../constants";
import { BigNumber, delay, fetchWithTimeout, isDefined, jsonReplacerWithBigNumbers, toBN } from "../../utils";

export interface ArweaveGatewayConfig {
  host: string;
  protocol?: string;
  port?: number;
}

export const DEFAULT_ARWEAVE_GATEWAYS: ArweaveGatewayConfig[] = [
  { host: "arweave.net" },
  { host: "ar-io.net" },
];

interface Gateway {
  client: Arweave;
  url: string;
}

export class ArweaveClient {
  private gateways: Gateway[];

  public constructor(
    private arweaveJWT: JWKInterface,
    private logger: winston.Logger,
    gateways: ArweaveGatewayConfig[] = DEFAULT_ARWEAVE_GATEWAYS,
    private readonly retries = 2,
    private readonly retryDelaySeconds = 1
  ) {
    if (gateways.length === 0) {
      throw new Error("At least one gateway must be provided");
    }
    if (this.retries < 0) {
      throw new Error(`retries cannot be < 0 and must be an integer. Currently set to ${this.retries}`);
    }
    if (this.retryDelaySeconds < 0) {
      throw new Error(`delay cannot be < 0. Currently set to ${this.retryDelaySeconds}`);
    }
    this.gateways = gateways.map(({ host, protocol = "https", port = 443 }) => ({
      client: new Arweave({ host, port, protocol, timeout: 20000, logging: false }),
      url: `${protocol}://${host}:${port}`,
    }));
    this.logger.debug({
      at: "ArweaveClient:constructor",
      message: "Arweave client initialized",
      gateways: this.gateways.map((g) => g.url),
    });
  }

  /**
   * Races a request across all gateways, returning the first successful response.
   * If all gateways fail, throws an error with details from each gateway.
   */
  private async _raceGateways<T>(label: string, fn: (gw: Gateway) => Promise<T>): Promise<T> {
    try {
      return await Promise.any(this.gateways.map((gw) => this._retryRequest(() => fn(gw), 0)));
    } catch (e) {
      if (e instanceof AggregateError) {
        const details = this.gateways.map((gw, i) => `${gw.url}: ${e.errors[i]}`).join("; ");
        throw new Error(`All Arweave gateways failed for ${label}: ${details}`);
      }
      throw e;
    }
  }

  /**
   * Tries gateways sequentially, returning the first successful response.
   * Used for write operations where we want exactly one successful submission.
   */
  private async _failoverGateways<T>(label: string, fn: (gw: Gateway) => Promise<T>): Promise<T> {
    const errors: Error[] = [];
    for (const gw of this.gateways) {
      try {
        return await this._retryRequest(() => fn(gw), 0);
      } catch (e) {
        errors.push(e as Error);
        this.logger.debug({
          at: "ArweaveClient:failoverGateways",
          message: `Gateway ${gw.url} failed for ${label}, trying next: ${e}`,
        });
      }
    }
    const details = this.gateways.map((gw, i) => `${gw.url}: ${errors[i]}`).join("; ");
    throw new Error(`All Arweave gateways failed for ${label}: ${details}`);
  }

  private async _retryRequest<T>(request: () => Promise<T>, retryCount: number): Promise<T> {
    try {
      return await request();
    } catch (e) {
      if (retryCount < this.retries) {
        // Implement a slightly aggressive exponential backoff to account for fierce parallelism.
        const baseDelay = this.retryDelaySeconds * Math.pow(2, retryCount);
        const delayS = baseDelay + baseDelay * Math.random();
        this.logger.debug({
          at: "ArweaveClient:retryRequest",
          message: `Arweave request failed, retrying after waiting ${delayS} seconds: ${e}`,
          retryCount,
        });
        await delay(delayS);
        return this._retryRequest(request, retryCount + 1);
      } else {
        throw e;
      }
    }
  }

  /**
   * Stores an arbitrary record in the Arweave network. The record is stored as a JSON string and uses
   * JSON.stringify to convert the record to a string. The record has all of its big numbers converted
   * to strings for convenience.
   * @param value The value to store
   * @param topicTag An optional topic tag to add to the transaction
   * @returns The transaction ID of the stored value
   */
  async set(value: Record<string, unknown>, topicTag?: string | undefined): Promise<string | undefined> {
    return this._failoverGateways("set", async ({ client }) => {
      const transaction = await client.createTransaction(
        { data: JSON.stringify(value, jsonReplacerWithBigNumbers) },
        this.arweaveJWT
      );

      // Add tags to the transaction
      transaction.addTag("Content-Type", "application/json");
      transaction.addTag("App-Name", ARWEAVE_TAG_APP_NAME);
      transaction.addTag("App-Version", ARWEAVE_TAG_APP_VERSION.toString());
      if (isDefined(topicTag)) {
        transaction.addTag("Topic", topicTag);
      }

      // Sign the transaction
      await client.transactions.sign(transaction, this.arweaveJWT);
      // Send the transaction
      const result = await client.transactions.post(transaction);

      // Ensure that the result is successful
      if (result.status !== 200) {
        const message = result?.data?.error?.msg ?? "Unknown error";
        this.logger.error({
          at: "ArweaveClient:set",
          message,
          result,
          txn: transaction.id,
          address: await this.getAddress(),
          balance: (await this.getBalance()).toString(),
        });
        throw new Error(message);
      }

      this.logger.debug({
        at: "ArweaveClient:set",
        message: `Arweave transaction posted with ${transaction.id}`,
      });
      return transaction.id;
    });
  }

  /**
   * Retrieves a record from the Arweave network. The record is expected to be a JSON string and is
   * parsed using JSON.parse. All numeric strings are converted to big numbers for convenience.
   * @param transactionID The transaction ID of the record to retrieve
   * @param structValidator An optional struct validator to validate the retrieved value. If the value does not match the struct, null is returned.
   * @returns The record if it exists, otherwise null
   */
  async get<T>(transactionID: string, validator: Struct<T>): Promise<T | null> {
    // We query via fetchWithTimeout directly to the gateway URL. The reasoning behind this is
    // that the Arweave SDK's `getData` method is too slow and does not provide a way to set a timeout.
    // Therefore, something that could take milliseconds to complete could take tens of minutes.
    const data = await this._raceGateways("get", async ({ url }) => {
      return fetchWithTimeout(`${url}/${transactionID}`, {}, {}, 20_000);
    });
    try {
      // We should validate the data and perform any logical coercion here.
      return create(data, validator);
    } catch (e) {
      // If the data does not match the validator, log a warning and return null.
      this.logger.warn({
        at: "ArweaveClient:get",
        message: `Retrieved value from Arweave does not match the expected type: ${e}`,
      });
      return null;
    }
  }

  /**
   * Retrieves a list of records from the Arweave network that have a specific tag.
   * The records are expected to be a JSON string and are pre-filtered by the Across
   * protocol tag, the content-type tag, and this client's address. Furthermore, the
   * records are expected to be an array of the given type and will be discarded if
   * they do not match the given validator.
   * @param tag The tag to filter all the transactions by
   * @param validator The validator to validate the retrieved values
   * @param originQueryAddress An optional flag to override the originating address for the query. By default,
   *                           the address of the RL Arweave storage wallet is used.
   * @returns The records if they exist, otherwise an empty array
   */
  async getByTopic<T>(
    tag: string,
    validator: Struct<T>,
    originQueryAddress = DEFAULT_ARWEAVE_STORAGE_ADDRESS
  ): Promise<{ data: T; hash: string }[]> {
    const topicFilter = tag ? `{ name: "Topic", values: ["${tag}"] }` : "";
    const query = `{
      transactions (
        owners: ["${originQueryAddress}"]
        tags: [
          { name: "App-Name", values: ["${ARWEAVE_TAG_APP_NAME}"] },
          { name: "Content-Type", values: ["application/json"] },
          { name: "App-Version", values: ["${ARWEAVE_TAG_APP_VERSION}"] },
          ${topicFilter}
        ]
      ) { edges { node { id } } }
    }`;

    const response = await this._raceGateways("getByTopic", async ({ client }) => {
      const response = await client.api.post<{
        data: { transactions: { edges: { node: { id: string } }[] } };
      }>("/graphql", { query });
      if (!response.ok) {
        throw new Error(`Arweave GraphQL request failed with status ${response.status}`);
      }
      return response;
    });

    const entries = response?.data?.data?.transactions?.edges ?? [];
    this.logger.debug({
      at: "ArweaveClient:getByTopic",
      message: `Retrieved ${entries.length} matching transactions from Arweave`,
      transactions: entries.map((edge) => edge.node.id),
      metaInformation: {
        tag,
        originQueryAddress,
        appVersion: ARWEAVE_TAG_APP_VERSION,
      },
    });
    const results = await Promise.all(
      entries.map(async (edge) => {
        try {
          const data = await this.get<T>(edge.node.id, validator);
          return isDefined(data)
            ? {
                data,
                hash: edge.node.id,
              }
            : null;
        } catch (e) {
          this.logger.warn({
            at: "ArweaveClient:getByTopic",
            message: `Bad request for Arweave topic ${edge.node.id}: ${e}`,
          });
          return null;
        }
      })
    );
    return results.filter(isDefined);
  }

  /**
   * Retrieves the metadata of a transaction
   * @param transactionID The transaction ID of the record to retrieve
   * @returns The metadata of the transaction if it exists, otherwise null
   */
  async getMetadata(transactionID: string): Promise<Record<string, string> | null> {
    const transaction = await this._raceGateways("getMetadata", async ({ client }) => {
      return client.transactions.get(transactionID);
    });
    if (!isDefined(transaction)) {
      return null;
    }
    const tags = Object.fromEntries(
      transaction.tags.map((tag) => [
        tag.get("name", { decode: true, string: true }),
        tag.get("value", { decode: true, string: true }),
      ])
    );
    return {
      contentType: tags["Content-Type"],
      appName: tags["App-Name"],
      topic: tags.Topic,
    };
  }

  /**
   * Returns the address of the signer of the JWT. This is a local crypto
   * operation and does not require a network call.
   * @returns The address of the signer in this client
   */
  getAddress(): Promise<string> {
    return this.gateways[0].client.wallets.jwkToAddress(this.arweaveJWT);
  }

  /**
   * The balance of the signer
   * @returns The balance of the signer in winston units
   */
  async getBalance(): Promise<BigNumber> {
    const address = await this.getAddress();
    return this._raceGateways("getBalance", async ({ client }) => {
      const balanceInFloat = await client.wallets.getBalance(address);
      // @dev The reason we add in the BN.from here is because the client.getBalance call
      // does not correctly throw an error if the request fails, instead it will return the error string as the
      // balanceInFloat.
      // Sometimes the balance is returned in scientific notation, so we need to
      // convert it to a BigNumber
      if (balanceInFloat.includes("e")) {
        const [balance, exponent] = balanceInFloat.split("e");
        const resultingBN = BigNumber.from(balance).mul(toBN(10).pow(exponent.replace("+", "")));
        return BigNumber.from(resultingBN.toString());
      } else {
        return BigNumber.from(balanceInFloat);
      }
    });
  }
}
