import { validatorSetup, validatorTeardown } from "./utils/svm/validator.setup";

before(async function () {
  /* Local validator spin‑up can take a few seconds */
  this.timeout(60_000);
  await validatorSetup();
});

after(() => {
  validatorTeardown();
});
