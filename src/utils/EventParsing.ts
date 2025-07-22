import { Struct, create } from "superstruct";
import { SortableEvent, SortableEventStruct } from "../interfaces";

/**
 * Defines a contract for decoding the `args` of a raw, loosely-typed event object
 * into a strictly-typed SDK interface.
 * @template TRawArgs The raw, validated object shape of the event args.
 * @template TParsedArgs The final, richly-typed SDK object representing the args.
 * @template TContext An optional context object that can be passed to the parser.
 */
export interface EventArgsDecoder<TRawArgs, TParsedArgs, TContext = unknown> {
  struct: Struct<TRawArgs>;
  parse(valid: TRawArgs, context?: TContext): TParsedArgs;
}

/**
 * A low-level function that validates a raw object against a Superstruct schema and then
 * transforms it into a rich SDK type using a provided parser function.
 * @param raw The raw, unknown object to decode (e.g., from an event's `args`).
 * @param decoder The `EventArgsDecoder` that defines the schema and parsing logic.
 * @param context An optional context object to pass to the decoder's `parse` function.
 * @returns The parsed, richly-typed SDK object.
 * @throws {StructError} If the raw object fails validation against the decoder's struct.
 */
function decodeEvent<TRawArgs, TParsedArgs, TContext>(
  raw: unknown,
  decoder: EventArgsDecoder<TRawArgs, TParsedArgs, TContext>,
  context?: TContext
): TParsedArgs {
  const validated = create(raw, decoder.struct);
  return decoder.parse(validated, context);
}

/**
 * A high-level wrapper that decodes raw event arguments and merges them
 * with pre-validated SortableEvent properties.
 *
 * @param sortableEvent The pre-validated SortableEvent part of the log.
 * @param rawArgs The raw, unknown object containing the event-specific arguments.
 * @param decoder The `EventArgsDecoder` for the specific event type.
 * @param context An optional context object to pass to the `args` decoder.
 * @returns An object containing the parsed event args merged with the `SortableEvent` properties.
 */
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
