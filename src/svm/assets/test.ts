/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/test.json`.
 */
export type Test = {
  "address": "8tsEfDSiE4WUMf97oyyyasLAvWwjeRZb2GByh4w7HckA",
  "metadata": {
    "name": "test",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "bitmapAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  105,
                  116,
                  109,
                  97,
                  112,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "testEmitLargeLog",
      "discriminator": [
        126,
        64,
        160,
        189,
        160,
        160,
        238,
        68
      ],
      "accounts": [],
      "args": [
        {
          "name": "length",
          "type": "u32"
        }
      ]
    },
    {
      "name": "testIsClaimed",
      "discriminator": [
        82,
        227,
        141,
        60,
        27,
        165,
        109,
        90
      ],
      "accounts": [
        {
          "name": "bitmapAccount"
        }
      ],
      "args": [
        {
          "name": "index",
          "type": "u32"
        }
      ],
      "returns": "bool"
    },
    {
      "name": "testSetClaimed",
      "discriminator": [
        15,
        155,
        67,
        241,
        20,
        247,
        21,
        189
      ],
      "accounts": [
        {
          "name": "bitmapAccount",
          "writable": true
        },
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "index",
          "type": "u32"
        }
      ]
    },
    {
      "name": "verify",
      "discriminator": [
        133,
        161,
        141,
        48,
        120,
        198,
        88,
        150
      ],
      "accounts": [],
      "args": [
        {
          "name": "root",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "leaf",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "proof",
          "type": {
            "vec": {
              "array": [
                "u8",
                32
              ]
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "bitmapAccount",
      "discriminator": [
        152,
        161,
        147,
        85,
        213,
        38,
        59,
        48
      ]
    }
  ],
  "events": [
    {
      "name": "testEvent",
      "discriminator": [
        28,
        52,
        39,
        105,
        8,
        210,
        91,
        9
      ]
    }
  ],
  "types": [
    {
      "name": "bitmapAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "claimedBitmap",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "testEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "message",
            "type": "string"
          }
        ]
      }
    }
  ]
};
