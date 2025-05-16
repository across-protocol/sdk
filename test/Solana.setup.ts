import { validatorSetup, validatorTeardown } from "./utils/svm/validator.setup";
import { createDefaultSolanaClient, generateKeyPairSignerWithSol, initializeSvmSpoke } from "./utils/svm/utils";

// Create the signer
let signer: Awaited<ReturnType<typeof generateKeyPairSignerWithSol>>;

before(async function () {
  /* Local validator spin‑up can take a few seconds */
  this.timeout(60_000);
  await validatorSetup();

  const solanaClient = createDefaultSolanaClient();

  // Generate the signer
  signer = await generateKeyPairSignerWithSol(solanaClient);

  // Initialize the program and get the state
  await initializeSvmSpoke(signer, solanaClient, signer.address);
});

after(() => {
  validatorTeardown();
});

// Export signer for use in tests
export { signer };
