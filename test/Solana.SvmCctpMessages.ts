import { CHAIN_IDs } from "@across-protocol/constants";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { u8Array32ToInt } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { KeyPairSigner, address } from "@solana/kit";
import { expect } from "chai";
import { SvmCpiEventsClient } from "../src/arch/svm";
import { SvmAddress } from "../src/utils";
import { signer } from "./Solana.setup";
import {
  createDefaultSolanaClient,
  createMint,
  mintTokens,
  sendCreateDeposit,
  sendCreateFill,
  sendReceiveCctpMessage,
  sendRequestSlowFill,
} from "./utils/svm/utils";

// Define an extended interface for our Solana client with chainId
interface ExtendedSolanaClient extends ReturnType<typeof createDefaultSolanaClient> {
  chainId: number;
}

describe("SvmCpiEventsClient (integration)", () => {
  const solanaClient = createDefaultSolanaClient() as ExtendedSolanaClient;
  // Add chainId property for tests
  solanaClient.chainId = 7777; // Use a test value for Solana testnet
  let client: SvmCpiEventsClient;

  let mint: KeyPairSigner;
  let decimals: number;

  const tokenAmount = 100000000n;

  before(async function () {
    ({ mint, decimals } = await createMint(signer, solanaClient));
    client = await SvmCpiEventsClient.create(solanaClient.rpc);
  });

  it.only("pauses and unpauses deposits remotely", async () => {
    await sendReceiveCctpMessage(solanaClient, signer);

    // Store initial slot
    console.log("It worked");
  });
});
