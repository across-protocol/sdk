import { buildIPFSClient, retrieveValueFromIPFS, storeValueInIPFS } from "../../utils/IPFSUtils";
import { CachingMechanismInterface } from "../../interfaces";
import { Struct } from "superstruct";
import winston from "winston";
import PinataClient from "@pinata/sdk";
import { jsonReviverWithBigNumbers, jsonReplacerWithBigNumbers, formattedLog } from "../../utils";

/**
 * A client for interacting with the IPFS. This is a wrapper around the IPFS API.
 * This client also is a part of the caching mechanism interface.
 * @see https://docs.ipfs.io/reference/http/api/
 */
export class PinataIPFSClient implements CachingMechanismInterface {
  /**
   * The IPFS client instance
   */
  private client: PinataClient;

  /**
   * Public IPFS gateway URL to retrieve the content from
   */
  private publicGatewayURL: string;

  /**
   * An optional logger for logging messages
   */
  private logger?: winston.Logger;

  public constructor(projectId: string, projectSecret: string, publicGatewayURL: string, logger?: winston.Logger) {
    this.client = buildIPFSClient(projectId, projectSecret);
    this.publicGatewayURL = publicGatewayURL;
    this.logger = logger;
  }

  /**
   * Calls to a public IPFS gateway to retrieve a value.
   * @param key The key to retrieve.
   * @param _structValidator An optional struct validator to validate the retrieved value. If the value does not match the struct, null is returned.
   * @returns The value if it exists, otherwise null.
   */
  async get<ObjectType>(key?: string, _structValidator?: Struct<unknown, unknown>): Promise<ObjectType | null> {
    if (!key) {
      return null;
    }
    formattedLog(this.logger, {
      level: "debug",
      message: `Retrieving value from IPFS with key ${key}`,
      at: {
        location: "IPFSClient",
        function: "get",
      },
    });

    const arrivedResult = await retrieveValueFromIPFS(key, this.publicGatewayURL);
    if (!arrivedResult) {
      return null;
    }
    const revivedResult = JSON.parse(arrivedResult, jsonReviverWithBigNumbers);

    if (_structValidator && !_structValidator.is(revivedResult)) {
      formattedLog(this.logger, {
        level: "warn",
        message: `Retrieved value from IPFS with key ${key} does not match the expected type`,
        at: {
          location: "IPFSClient",
          function: "get",
        },
      });
      return null;
    }

    return revivedResult as ObjectType;
  }

  /**
   * Stores a value in the IPFS and returns the CID of the value stored.
   * @param key An optional key to store the value with. This is purely in the metadata of the CID.
   * @param value The value to store.
   * @returns The CID of the value stored.
   */
  set<T>(key: string, value: T): Promise<string | undefined> {
    formattedLog(this.logger, {
      level: "debug",
      message: `Setting value from IPFS with key ${key}`,
      at: {
        location: "IPFSClient",
        function: "setWithReturnID",
      },
    });
    return storeValueInIPFS(key, JSON.stringify(value, jsonReplacerWithBigNumbers), this.client);
  }
}
