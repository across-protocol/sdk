import { validatorSetup, validatorTeardown } from "./utils/svm/validator.setup";
import { createDefaultSolanaClient, generateKeyPairSignerWithSol, initializeSvmSpoke } from "./utils/svm/utils";
import { airdropFactory, generateKeyPairSigner, lamports } from "@solana/kit";
// Create the signer
let signer: Awaited<ReturnType<typeof generateKeyPairSignerWithSol>>;

before(async function () {
  // Generate the signer
  signer = await generateKeyPairSigner();

  /* Local validator spin‑up can take a few seconds */
  this.timeout(60_000);
  await validatorSetup(signer.address);

  const solanaClient = createDefaultSolanaClient();

  // Airdrop SOL to the signer
  await airdropFactory(solanaClient)({
    recipientAddress: signer.address,
    lamports: lamports(1_000_000_000n),
    commitment: "confirmed",
  });

  // Initialize the program and get the state
  await initializeSvmSpoke(signer, solanaClient, signer.address);
});

after(() => {
  validatorTeardown();
});

// Export signer for use in tests
export { signer };
