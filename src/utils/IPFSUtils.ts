import PinataClient from "@pinata/sdk";
import axios from "axios";
import { BigNumber } from "ethers";

/**
 *  Build an IPFS client for interacting with the IPFS API
 * @param APIKey The project ID
 * @param secretAPIKey The project secret
 * @returns An IPFS client for interacting with Pinata
 */
export function buildIPFSClient(APIKey: string, secretAPIKey: string): PinataClient {
  return new PinataClient(APIKey, secretAPIKey);
}

export async function retrieveValueFromIPFS(
  contentHash: string,
  publicGatewayURL: string
): Promise<string | undefined> {
  try {
    const result = await axios.get(`${publicGatewayURL}/ipfs/${contentHash}`, {
      headers: {
        Accept: "text/plain",
      },
    });
    console.log(result.data);
    return result.data;
  } catch (e) {
    return undefined;
  }
}

export async function storeValueInIPFS(content: string, client: PinataClient): Promise<string> {
  const result = await client.pinJSONToIPFS(JSON.parse(content));
  return result.IpfsHash;
}

/**
 * A replacer for use in `JSON.stringify` that converts big numbers to numeric strings.
 * @param _key Unused
 * @param value The value to convert
 * @returns The converted value
 */
export function jsonReplacerWithBigNumbers(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  } else if (value instanceof BigNumber) {
    return value.toString();
  }
  return value;
}

/**
 * A reviver for use in `JSON.parse` that converts numeric strings to big numbers.
 * @param _key Unused
 * @param value The value to convert
 * @returns The converted value
 */
export function jsonReviverWithBigNumbers(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const bigNumber = BigNumber.from(value);
    if (bigNumber.toString() === value) {
      return bigNumber;
    }
  }
  return value;
}
