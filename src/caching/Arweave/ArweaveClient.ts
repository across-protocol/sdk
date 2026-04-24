import Arweave from "arweave";
import Transaction from "arweave/node/lib/transaction";
import { JWKInterface } from "arweave/node/lib/wallet";

import { Struct, create } from "superstruct";
import winston from "winston";
import { ARWEAVE_TAG_APP_NAME, ARWEAVE_TAG_APP_VERSION, DEFAULT_ARWEAVE_STORAGE_ADDRESS } from "../../constants";
import { BigNumber, toBN } from "../../utils/BigNumberUtils";
import { delay } from "../../utils/common";
import { fetchWithTimeout, isHttpError, postWithTimeout } from "../../utils/FetchUtils";
import { jsonReplacerWithBigNumbers } from "../../utils/JSONUtils";
import { isDefined } from "../../utils/TypeGuards";

export interface ArweaveGatewayConfig {
  host: string;
  protocol?: string;
  port?: number;
}

export const DEFAULT_ARWEAVE_GATEWAYS: ArweaveGatewayConfig[] = [{ host: "arweave.net" }, { host: "ar-io.net" }];

interface Gateway {
  client: Arweave;
  url: string;
}

interface ArweaveTransactionTag {
  name: string;
  value: string;
}

interface ArweaveTransactionResponse {
  tags?: ArweaveTransactionTag[];
}

function decodeBase64UrlUtf8(value: string): string {
  // `/tx/{id}` returns tag names and values in RFC 4648 base64url form.
  // Node's built-in `base64url` decoder handles the URL-safe alphabet and
  // omitted padding for us, so this matches the SDK's
  // `tag.get(..., { decode: true, string: true })` behavior without a custom transform.
  return Buffer.from(value, "base64url").toString("utf-8");
}

interface GraphQLTransactionsResponse {
  data?: {
    transactions?: {
      edges?: { node: { id: string } }[];
    };
  };
}

type WritePhase = "createTransaction" | "sign" | "post";

class ArweaveWriteError extends Error {
  constructor(
    message: string,
    readonly phase: WritePhase,
    readonly gateway: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "ArweaveWriteError";
  }
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
  private async _raceGateways<T>(label: string, fn: (gw: Gateway) => Promise<T>, topicTag?: string): Promise<T> {
    try {
      return await Promise.any(this.gateways.map((gw) => this._retryRequest(() => fn(gw), 0, label, gw.url, topicTag)));
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
  private async _failoverGateways<T>(
    label: string,
    fn: (gw: Gateway, attempt: number) => Promise<T>,
    topicTag?: string
  ): Promise<T> {
    const errors: Error[] = [];
    for (const [index, gw] of this.gateways.entries()) {
      try {
        return await this._retryRequest(() => fn(gw, index + 1), 0, label, gw.url, topicTag);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        errors.push(error);
        this.logger.debug({
          at: "ArweaveClient:failoverGateways",
          message: `Gateway ${gw.url} failed for ${label}, trying next gateway`,
          gateway: gw.url,
          attempt: index + 1,
          error: String(error),
        });
      }
    }
    const details = this.gateways.map((gw, i) => `${gw.url}: ${errors[i]}`).join("; ");
    throw new Error(`All Arweave gateways failed for ${label}: ${details}`);
  }

  private async _retryRequest<T>(
    request: () => Promise<T>,
    retryCount: number,
    label: string,
    gateway: string,
    topicTag?: string
  ): Promise<T> {
    try {
      return await request();
    } catch (e) {
      if (retryCount < this.retries) {
        // Implement a slightly aggressive exponential backoff to account for fierce parallelism.
        const baseDelay = this.retryDelaySeconds * Math.pow(2, retryCount);
        const delayS = baseDelay + baseDelay * Math.random();
        this.logger.debug({
          at: "ArweaveClient:retryRequest",
          message: `Arweave request failed, retrying after waiting ${delayS} seconds`,
          label,
          gateway,
          topicTag,
          retryCount,
          retryAttempt: retryCount + 1,
          maxRetries: this.retries,
          nextRetryDelaySeconds: delayS,
          error: String(e),
        });
        await delay(delayS);
        return this._retryRequest(request, retryCount + 1, label, gateway, topicTag);
      } else {
        throw e;
      }
    }
  }

  private _isNotFoundError(error: unknown): boolean {
    if (isHttpError(error)) {
      return error.status === 404;
    }
    const message = error instanceof Error ? error.message : String(error);
    return /404/i.test(message);
  }

  private _wrapWriteError(error: unknown, phase: WritePhase, gateway: string): ArweaveWriteError {
    if (error instanceof ArweaveWriteError) {
      return error;
    }
    if (isHttpError(error)) {
      return new ArweaveWriteError(error.message, phase, gateway, error.status);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new ArweaveWriteError(message, phase, gateway);
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
    const payload = JSON.stringify(value, jsonReplacerWithBigNumbers);
    let signedTransaction: Transaction | undefined;

    try {
      return await this._failoverGateways(
        "set",
        async ({ client, url }, attempt) => {
          if (!signedTransaction) {
            let createdTransaction: Transaction;
            try {
              createdTransaction = await client.createTransaction({ data: payload }, this.arweaveJWT);
            } catch (error) {
              throw this._wrapWriteError(error, "createTransaction", url);
            }

            createdTransaction.addTag("Content-Type", "application/json");
            createdTransaction.addTag("App-Name", ARWEAVE_TAG_APP_NAME);
            createdTransaction.addTag("App-Version", ARWEAVE_TAG_APP_VERSION.toString());
            if (isDefined(topicTag)) {
              createdTransaction.addTag("Topic", topicTag);
            }

            try {
              await client.transactions.sign(createdTransaction, this.arweaveJWT);
            } catch (error) {
              throw this._wrapWriteError(error, "sign", url);
            }

            signedTransaction = createdTransaction;
          }

          let result: Awaited<ReturnType<Arweave["transactions"]["post"]>>;
          try {
            result = await client.transactions.post(signedTransaction);
          } catch (error) {
            throw this._wrapWriteError(error, "post", url);
          }

          if (result.status !== 200) {
            const message = result?.data?.error?.msg ?? result.statusText ?? `HTTP ${result.status}`;
            throw new ArweaveWriteError(message, "post", url, result.status);
          }

          this.logger.debug({
            at: "ArweaveClient:set",
            message: `Arweave transaction posted with ${signedTransaction.id}`,
            gateway: url,
            attempt,
            phase: "post",
            txn: signedTransaction.id,
          });
          return signedTransaction.id;
        },
        topicTag
      );
    } catch (error) {
      this.logger.warn({
        at: "ArweaveClient:set",
        message: "Failed to persist data to Arweave after exhausting all gateways",
        topicTag,
        error: String(error),
      });
      throw error;
    }
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
      return await fetchWithTimeout(`${url}/${transactionID}`, {}, {}, 20_000);
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

    const response = await this._raceGateways(
      "getByTopic",
      async ({ url }) => {
        return await postWithTimeout<GraphQLTransactionsResponse>(`${url}/graphql`, { query }, {}, {}, 20_000);
      },
      tag
    );

    const entries = response?.data?.transactions?.edges ?? [];
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
    const failures: { hash: string; error: unknown }[] = [];
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
          failures.push({ hash: edge.node.id, error: e });
          return null;
        }
      })
    );
    const notFoundFailures = failures.filter(({ error }) => this._isNotFoundError(error));
    const unexpectedFailures = failures.filter(({ error }) => !this._isNotFoundError(error));

    if (notFoundFailures.length > 0) {
      this.logger.debug({
        at: "ArweaveClient:getByTopic",
        message: `Skipped ${notFoundFailures.length} Arweave topic entries that were not yet available`,
        tag,
        transactions: notFoundFailures.map(({ hash }) => hash),
      });
    }

    if (unexpectedFailures.length > 0) {
      this.logger.warn({
        at: "ArweaveClient:getByTopic",
        message: `Failed to fetch ${unexpectedFailures.length} Arweave topic entries`,
        tag,
        failures: unexpectedFailures.map(({ hash, error }) => ({
          hash,
          error: String(error),
        })),
      });
    }

    return results.filter(isDefined);
  }

  /**
   * Retrieves the metadata of a transaction
   * @param transactionID The transaction ID of the record to retrieve
   * @returns The metadata of the transaction if it exists, otherwise null
   */
  async getMetadata(transactionID: string): Promise<Record<string, string> | null> {
    const transaction = await this._raceGateways("getMetadata", async ({ url }) => {
      return await fetchWithTimeout<ArweaveTransactionResponse>(`${url}/tx/${transactionID}`, {}, {}, 20_000);
    });
    if (!isDefined(transaction)) {
      return null;
    }
    const tags = Object.fromEntries(
      (transaction.tags ?? []).map((tag) => [decodeBase64UrlUtf8(tag.name), decodeBase64UrlUtf8(tag.value)])
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
