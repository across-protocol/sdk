/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/multicall_handler.json`.
 */
export type MulticallHandler = {
  "address": "HaQe51FWtnmaEcuYEfPA7MRCXKrtqptat4oJdJ8zV5Be",
  "metadata": {
    "name": "multicallHandler",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "handleV3AcrossMessage",
      "discriminator": [
        131,
        141,
        52,
        71,
        16,
        59,
        196,
        92
      ],
      "accounts": [],
      "args": [
        {
          "name": "message",
          "type": "bytes"
        }
      ]
    }
  ]
};
