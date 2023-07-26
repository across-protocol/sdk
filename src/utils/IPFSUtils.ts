import PinataClient from "@pinata/sdk";
import axios from "axios";

/**
 * Build an IPFS client for interacting with the IPFS API
 * @param APIKey The project ID
 * @param secretAPIKey The project secret
 * @returns An IPFS client for interacting with Pinata
 */
export function buildIPFSClient(APIKey: string, secretAPIKey: string): PinataClient {
  return new PinataClient(APIKey, secretAPIKey);
}

/**
 * Retrieves a value from an IPFS gateway
 * @param contentHash The content hash of the value to retrieve
 * @param publicGatewayURL The URL of the public IPFS gateway to use
 * @returns The value retrieved from the IPFS gateway
 * @throws Error if the value could not be retrieved
 */
export async function retrieveValueFromIPFS(contentHash: string, publicGatewayURL: string): Promise<string> {
  const result = await axios.get(`${publicGatewayURL}/ipfs/${contentHash}`, {
    // We need to set the Accept header to text/plain to avoid
    // any anomalies with the response
    headers: {
      Accept: "text/plain",
    },
    // We want just the raw response, not the parsed response
    transformResponse: (r) => r,
  });
  return result.data;
}

/**
 * Pins a value to the IPFS network
 * @param key A key to use for pinning the value. This is a metadata field.
 * @param content The value to pin
 * @param client The IPFS client to use
 * @returns The content hash of the pinned value
 */
export async function storeValueInIPFS(key: string, content: string, client: PinataClient): Promise<string> {
  const result = await client.pinJSONToIPFS(JSON.parse(content), {
    pinataMetadata: {
      name: key,
    },
  });
  return result.IpfsHash;
}
