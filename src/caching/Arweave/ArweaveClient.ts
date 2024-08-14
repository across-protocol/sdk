import Arweave from "arweave";
import { JWKInterface } from "arweave/node/lib/wallet";
import axios from "axios";
import { BigNumber, ethers } from "ethers";
import { Struct, create } from "superstruct";
import winston from "winston";
import { ARWEAVE_TAG_APP_NAME, ARWEAVE_TAG_APP_VERSION, DEFAULT_ARWEAVE_STORAGE_ADDRESS } from "../../constants";
import { isDefined, jsonReplacerWithBigNumbers, toBN } from "../../utils";

export class ArweaveClient {
  private client: Arweave;
  private gatewayUrl: string;

  public constructor(
    private arweaveJWT: JWKInterface,
    private logger: winston.Logger,
    gatewayURL = "arweave.net",
    protocol = "https",
    port = 443
  ) {
    this.gatewayUrl = `${protocol}://${gatewayURL}:${port}`;
    this.client = new Arweave({
      host: gatewayURL,
      port,
      protocol,
      timeout: 20000,
      logging: false,
    });
    this.logger.debug({
      at: "ArweaveClient:constructor",
      message: "Arweave client initialized",
      gateway: this.gatewayUrl,
    });
  }

  /**
   * Stores an arbitrary record in the Arweave network. The record is stored as a JSON string and uses
   * JSON.stringify to convert the record to a string. The record has all of its big numbers converted
   * to strings for convenience.
   * @param value The value to store
   * @param topicTag An optional topic tag to add to the transaction
   * @returns The transaction ID of the stored value
   * @
   */
  async set(value: Record<string, unknown>, topicTag?: string | undefined): Promise<string | undefined> {
    const transaction = await this.client.createTransaction(
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
    await this.client.transactions.sign(transaction, this.arweaveJWT);
    // Send the transaction
    const result = await this.client.transactions.post(transaction);

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
    } else {
      this.logger.debug({
        at: "ArweaveClient:set",
        message: `Arweave transaction posted with ${transaction.id}`,
      });
    }
    return transaction.id;
  }

  /**
   * Retrieves a record from the Arweave network. The record is expected to be a JSON string and is
   * parsed using JSON.parse. All numeric strings are converted to big numbers for convenience.
   * @param transactionID The transaction ID of the record to retrieve
   * @param structValidator An optional struct validator to validate the retrieved value. If the value does not match the struct, null is returned.
   * @returns The record if it exists, otherwise null
   */
  async get<T>(transactionID: string, validator: Struct<T>): Promise<T | null> {
    // Resolve the URL of the transaction
    const transactionUrl = `${this.gatewayUrl}/${transactionID}`;
    // We should query in via Axios directly to the gateway URL. The reasoning behind this is
    // that the Arweave SDK's `getData` method is too slow and does not provide a way to set a timeout.
    // Therefore, something that could take milliesconds to complete could take tens of minutes.
    const { data, status: responseStatus } = await axios.get<Record<string, unknown>>(transactionUrl);
    // Ensure that the result is successful. If it is not, the retrieved value is not our expected type
    // but rather a {status: string, statusText: string} object. We can detect that and return null.
    if (responseStatus !== 200 || ("status" in data && data["status"] !== 200)) {
      this.logger.debug({
        at: "ArweaveClient:get",
        message: "Failed to retrieve value from Arweave - network error or invalid response status",
        transactionID,
        responseStatus,
        data,
      });
      return null;
    }
    try {
      // We should validate the data and perform any logical coercion here.
      return create(data, validator);
    } catch (e) {
      // If the data does not match the validator, log a warning and return null.
      this.logger.warn({
        at: "ArweaveClient:get",
        message: "Retrieved value from Arweave does not match the expected type",
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
    const transactions = await this.client.api.post<{
      data: {
        transactions: {
          edges: {
            node: {
              id: string;
            };
          }[];
        };
      };
    }>("/graphql", {
      query: `
        { 
          transactions (
            owners: ["${originQueryAddress}"]
            tags: [
              { name: "App-Name", values: ["${ARWEAVE_TAG_APP_NAME}"] },
              { name: "Content-Type", values: ["application/json"] },
              { name: "App-Version", values: ["${ARWEAVE_TAG_APP_VERSION}"] },
              ${tag ? `{ name: "Topic", values: ["${tag}"] } ` : ""}
            ]
          ) { edges { node { id } } } 
        }`,
    });
    const entries = transactions?.data?.data?.transactions?.edges ?? [];
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
        const data = await this.get<T>(edge.node.id, validator);
        return isDefined(data)
          ? {
              data,
              hash: edge.node.id,
            }
          : null;
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
    const transaction = await this.client.transactions.get(transactionID);
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
   * Returns the address of the signer of the JWT
   * @returns The address of the signer in this client
   */
  getAddress(): Promise<string> {
    return this.client.wallets.jwkToAddress(this.arweaveJWT);
  }

  /**
   * The balance of the signer
   * @returns The balance of the signer in winston units
   */
  async getBalance(): Promise<ethers.BigNumber> {
    const address = await this.getAddress();
    const balanceInFloat = await this.client.wallets.getBalance(address);
    // Sometimes the balance is returned in scientific notation, so we need to
    // convert it to a BigNumber
    if (balanceInFloat.includes("e")) {
      const [balance, exponent] = balanceInFloat.split("e");
      const resultingBN = ethers.BigNumber.from(balance).mul(toBN(10).pow(exponent.replace("+", "")));
      return BigNumber.from(resultingBN.toString());
    } else {
      return BigNumber.from(balanceInFloat);
    }
  }
}
