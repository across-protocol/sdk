import { assign, number, omit, type, string } from "superstruct";
import { BigNumberValidator } from "../../utils";

export const EVM_SPOKE_POOL_CLIENT_TYPE = "EVM";
export const SVM_SPOKE_POOL_CLIENT_TYPE = "SVM";

const RelayDataRaw = type({
  originChainId: number(),
  depositId: BigNumberValidator,
  depositor: string(),
  recipient: string(),
  inputToken: string(),
  outputToken: string(),
  inputAmount: BigNumberValidator,
  outputAmount: BigNumberValidator,
  quoteTimestamp: number(),
  fillDeadline: number(),
  message: string(),
  exclusivityDeadline: number(),
  exclusiveRelayer: string(),
});

export const FundsDepositedRaw = assign(omit(RelayDataRaw, ["originChainId"]), type({ destinationChainId: number() }));

export const FilledRelayRaw = assign(
  omit(RelayDataRaw, ["message", "quoteTimestamp"]),
  type({
    messageHash: string(),
    relayer: string(),
    repaymentChainId: number(),
    relayExecutionInfo: type({
      updatedRecipient: string(),
      updatedOutputAmount: BigNumberValidator,
      updatedMessageHash: string(),
      fillType: number(),
    }),
  })
);
