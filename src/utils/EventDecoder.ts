import { create, Struct } from "superstruct";
import { Deposit, DepositRaw, DepositRawStruct, SortableEvent } from "../interfaces";
import { toAddressType } from "./AddressUtils";
import { BigNumber } from "./BigNumberUtils";
import { getMessageHash } from "./SpokeUtils";

export interface EventArgsDecoder<TRawArgs, TParsedArgs, TContext = unknown> {
  struct: Struct<TRawArgs>;
  parse(valid: TRawArgs, context?: TContext): TParsedArgs;
}

function decodeEvent<TRawArgs, TParsedArgs, TContext>(
  raw: unknown,
  decoder: EventArgsDecoder<TRawArgs, TParsedArgs, TContext>,
  context?: TContext
): TParsedArgs {
  const validated = create(raw, decoder.struct);
  return decoder.parse(validated, context);
}

export function decodeSortableEvent<TRawArgs, TParsedArgs, TContext>(
  sortableEvent: SortableEvent,
  rawArgs: unknown,
  decoder: EventArgsDecoder<TRawArgs, TParsedArgs, TContext>,
  context?: TContext
): TParsedArgs & SortableEvent {
  // Validate and parse the event-specific args from the raw log.
  const parsedArgs = decodeEvent(rawArgs, decoder, context);

  // Merge the parsed args with the existing SortableEvent data.
  return {
    ...parsedArgs,
    ...sortableEvent,
  };
}

type SpokePoolClientContext = {
  chainId: number;
};

export const DepositArgsDecoder: EventArgsDecoder<
  DepositRaw,
  Omit<Deposit, "fromLiteChain" | "toLiteChain">,
  SpokePoolClientContext
> = {
  struct: DepositRawStruct,
  parse: (raw, context) => {
    if (!context) throw new Error("chainId context is required");

    const {
      // Separate out fields that are going to be re-typed
      depositor,
      recipient,
      inputToken,
      outputToken,
      exclusiveRelayer,
      depositId,
      inputAmount,
      outputAmount,
      updatedRecipient,
      updatedOutputAmount,
      // Spread the rest of the fields
      ...rest
    } = raw;

    const parsed = {
      ...rest,
      depositor: toAddressType(depositor, context.chainId),
      recipient: toAddressType(recipient, raw.destinationChainId),
      inputToken: toAddressType(inputToken, context.chainId),
      outputToken: toAddressType(outputToken, raw.destinationChainId),
      exclusiveRelayer: toAddressType(exclusiveRelayer, raw.destinationChainId),
      depositId: BigNumber.from(depositId),
      inputAmount: BigNumber.from(inputAmount),
      outputAmount: BigNumber.from(outputAmount),
      messageHash: getMessageHash(raw.message),
      updatedRecipient:
        updatedRecipient !== undefined ? toAddressType(updatedRecipient, raw.destinationChainId) : undefined,
      updatedOutputAmount: updatedOutputAmount !== undefined ? BigNumber.from(updatedOutputAmount) : undefined,
    } satisfies Omit<Deposit, "fromLiteChain" | "toLiteChain">;

    return parsed;
  },
};
