import { Contract, Signer } from "ethers";
import { getContractFactory } from "../utils/getContractFactory";
import { identifier, refundProposalLiveness } from "../constants";
import { utf8ToHex } from "../../src/utils";

// Re-export SignerWithAddress type
export type SignerWithAddress = Signer & { address: string };

export async function setupUmaEcosystem(owner: SignerWithAddress): Promise<{
  timer: Contract;
  finder: Contract;
  collateralWhitelist: Contract;
  identifierWhitelist: Contract;
  store: Contract;
  optimisticOracle: Contract;
  mockOracle: Contract;
}> {
  // Setup minimum UMA ecosystem contracts. Note that we don't use the umaEcosystemFixture because Hardhat Fixture's
  // seem to produce non-deterministic behavior between tests.
  const timer = await (await getContractFactory("Timer", owner)).deploy();
  const finder = await (await getContractFactory("Finder", owner)).deploy();
  const identifierWhitelist = await (await getContractFactory("IdentifierWhitelist", owner)).deploy();
  const mockOracle = await (
    await getContractFactory("MockOracleAncillary", owner)
  ).deploy(finder.address, timer.address);
  const optimisticOracle = await (
    await getContractFactory("SkinnyOptimisticOracle", owner)
  ).deploy(refundProposalLiveness, finder.address, timer.address);
  const collateralWhitelist = await (await getContractFactory("AddressWhitelist", owner)).deploy();
  const store = await (
    await getContractFactory("Store", owner)
  ).deploy({ rawValue: "0" }, { rawValue: "0" }, timer.address);
  await finder.changeImplementationAddress(utf8ToHex("CollateralWhitelist"), collateralWhitelist.address);
  await finder.changeImplementationAddress(utf8ToHex("IdentifierWhitelist"), identifierWhitelist.address);
  await finder.changeImplementationAddress(utf8ToHex("SkinnyOptimisticOracle"), optimisticOracle.address);
  await finder.changeImplementationAddress(utf8ToHex("Store"), store.address);
  await finder.changeImplementationAddress(utf8ToHex("Oracle"), mockOracle.address);
  await identifierWhitelist.addSupportedIdentifier(identifier);
  return {
    timer,
    finder,
    collateralWhitelist,
    identifierWhitelist,
    store,
    optimisticOracle,
    mockOracle,
  };
}
