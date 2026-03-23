/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/svm_spoke.json`.
 */
export type SvmSpoke = {
  "address": "DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru",
  "metadata": {
    "name": "svmSpoke",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "bridgeTokensToHubPool",
      "docs": [
        "Bridges tokens to the Hub Pool.",
        "",
        "This function initiates the process of sending tokens from the vault to the Hub Pool based on the outstanding",
        "token liability this Spoke Pool has accrued. Enables the caller to choose a custom amount to work around CCTP",
        "bridging limits. enforces that amount is less than or equal to liability. On execution decrements liability.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that authorizes the bridge operation.",
        "- payer (Signer): The account responsible for paying the transaction fees.",
        "- mint (InterfaceAccount): The mint account for the token being bridged.",
        "- state (Account): Spoke state PDA. Seed: [\"state\",state.seed] where seed is 0 on mainnet.",
        "- transfer_liability (Account): Account tracking the pending amount to be sent to the Hub Pool. Incremented on",
        "relayRootBundle() and decremented on when this function is called. Seed: [\"transfer_liability\",mint].",
        "- vault (InterfaceAccount): The ATA for the token being bridged. Authority must be the state.",
        "- token_messenger_minter_sender_authority (UncheckedAccount): Authority for the token messenger minter.",
        "- message_transmitter (UncheckedAccount): Account for the message transmitter.",
        "- token_messenger (UncheckedAccount): Account for the token messenger.",
        "- remote_token_messenger (UncheckedAccount): Account for the remote token messenger.",
        "- token_minter (UncheckedAccount): Account for the token minter.",
        "- local_token (UncheckedAccount): Account for the local token.",
        "- cctp_event_authority (UncheckedAccount): Authority for CCTP events.",
        "- message_sent_event_data (Signer): Account for message sent event data.",
        "- message_transmitter_program (Program): Program for the message transmitter.",
        "- token_messenger_minter_program (Program): Program for the token messenger minter.",
        "- token_program (Interface): The token program.",
        "- system_program (Program): The system program.",
        "",
        "### Parameters:",
        "- amount: The amount of tokens to bridge to the Hub Pool."
      ],
      "discriminator": [
        1,
        83,
        255,
        59,
        232,
        55,
        64,
        216
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "state",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "transferLiability",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  110,
                  115,
                  102,
                  101,
                  114,
                  95,
                  108,
                  105,
                  97,
                  98,
                  105,
                  108,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "state"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenMessengerMinterSenderAuthority"
        },
        {
          "name": "messageTransmitter",
          "writable": true
        },
        {
          "name": "tokenMessenger"
        },
        {
          "name": "remoteTokenMessenger"
        },
        {
          "name": "tokenMinter"
        },
        {
          "name": "localToken",
          "writable": true
        },
        {
          "name": "cctpEventAuthority"
        },
        {
          "name": "messageSentEventData",
          "writable": true,
          "signer": true
        },
        {
          "name": "messageTransmitterProgram",
          "address": "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd"
        },
        {
          "name": "tokenMessengerMinterProgram",
          "address": "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claimRelayerRefund",
      "docs": [
        "Claims a relayer refund for the caller.",
        "",
        "In the event a relayer refund was sent to a claim account, then this function enables the relayer to claim it by",
        "transferring the claim amount from the vault to their token account. The claim account is closed after refund.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that authorizes the claim.",
        "- initializer (UncheckedAccount): Must be the same account that initialized the claim account.",
        "- state (Account): Spoke state PDA. Seed: [\"state\",state.seed] where seed is 0 on mainnet.",
        "- vault (InterfaceAccount): The ATA for the refunded mint. Authority must be the state.",
        "- mint (InterfaceAccount): The mint account for the token being refunded.",
        "- refund_address: token account authority receiving the refund.",
        "- token_account (InterfaceAccount): The receiving token account for the refund. When refund_address is different",
        "from the signer, this must match its ATA.",
        "- claim_account (Account): The claim account PDA. Seed: [\"claim_account\",mint,refund_address].",
        "- token_program (Interface): The token program."
      ],
      "discriminator": [
        205,
        34,
        34,
        224,
        204,
        103,
        81,
        176
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "initializer",
          "writable": true
        },
        {
          "name": "state",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "state"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "refundAddress"
        },
        {
          "name": "tokenAccount",
          "writable": true
        },
        {
          "name": "claimAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  108,
                  97,
                  105,
                  109,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "refundAddress"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "closeClaimAccount",
      "docs": [
        "Closes a claim account for a relayer refund.",
        "",
        "This function is used to close the claim account associated with a specific mint and refund address,",
        "effectively marking the end of its lifecycle. It can only be called once the claim account is empty. It",
        "transfers any remaining lamports to the signer and resets the account.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that authorizes the closure. Must be the initializer of the claim account.",
        "- mint: The mint associated with the claim account.",
        "- refund_address: The refund address associated with the claim account.",
        "- claim_account (Writable): The claim account PDA to be closed. Seed: [\"claim_account\",mint,refund_address]."
      ],
      "discriminator": [
        241,
        146,
        203,
        216,
        58,
        222,
        91,
        118
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "refundAddress"
        },
        {
          "name": "claimAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  108,
                  97,
                  105,
                  109,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "refundAddress"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "closeFillPda",
      "docs": [
        "Closes the FillStatusAccount PDA to reclaim relayer rent.",
        "",
        "This function is used to close the FillStatusAccount associated with a specific relay hash, effectively marking",
        "the end of its lifecycle. This can only be done once the fill deadline has passed. Relayers should do this for",
        "all fills once they expire to reclaim their rent.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that authorizes the closure. Must be the relayer in the fill_status PDA.",
        "- state (Writable): Spoke state PDA. Seed: [\"state\",state.seed] where seed is 0 on mainnet.",
        "- fill_status (Writable): The FillStatusAccount PDA to be closed."
      ],
      "discriminator": [
        224,
        39,
        208,
        68,
        8,
        226,
        23,
        214
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "state",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "fillStatus",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "closeInstructionParams",
      "docs": [
        "Closes the instruction parameters account.",
        "",
        "This function is used to close the instruction parameters account, effectively marking the end of its lifecycle.",
        "It transfers any remaining lamports to the signer and resets the account.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that authorizes the closure.",
        "- instruction_params (UncheckedAccount): The account to be closed. seed: [\"instruction_params\",signer]. Not",
        "the signer being within the seed here implicitly protects this from only being called by the creator."
      ],
      "discriminator": [
        224,
        44,
        254,
        10,
        216,
        8,
        172,
        96
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "instructionParams",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  115,
                  116,
                  114,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  112,
                  97,
                  114,
                  97,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "signer"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "createTokenAccounts",
      "docs": [
        "Creates token accounts in batch for a set of addresses.",
        "",
        "This helper function allows the caller to pass in a set of remaining accounts to create a batch of Associated",
        "Token Accounts (ATAs) for addresses. It is particularly useful for relayers to call before filling a deposit.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that authorizes the creation of token accounts.",
        "- mint (InterfaceAccount): The mint account for the token.",
        "- token_program (Interface): The token program.",
        "- associated_token_program (Program): The associated token program.",
        "- system_program (Program): The system program required for account creation."
      ],
      "discriminator": [
        163,
        216,
        49,
        204,
        97,
        16,
        80,
        167
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "deposit",
      "docs": [
        "Request to bridge input_token to a target chain and receive output_token.",
        "",
        "The fee paid to relayers and the system is captured in the spread between the input and output amounts,",
        "denominated in the input token. A relayer on the destination chain will send `output_amount` of `output_token`",
        "to the recipient and receive `input_token` on a repayment chain of their choice. The fee accounts for:",
        "destination transaction costs, relayer's opportunity cost of capital while waiting for a refund during the",
        "optimistic challenge window in the HubPool, and the system fee charged to the relayer.",
        "",
        "On the destination chain, a unique hash of the deposit data is used to identify this deposit. Modifying any",
        "parameters will result in a different hash, creating a separate deposit. The hash is computed using all parameters",
        "of this function along with the chain's `chainId()`. Relayers are refunded only for deposits with hashes that",
        "exactly match those emitted by this contract.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that authorizes the deposit.",
        "- state (Writable): Spoke state PDA. Seed: [\"state\",state.seed] where seed is 0 on mainnet.",
        "- depositor_token_account (Writable): The depositor's ATA for the input token.",
        "- vault (Writable): Programs ATA for the associated input token. This is where the depositor's assets are sent.",
        "Authority must be the state.",
        "- mint (Account): The mint account for the input token.",
        "- token_program (Interface): The token program.",
        "- delegate (Account): The account used to delegate the input amount of the input token.",
        "",
        "### Parameters",
        "- depositor: The account credited with the deposit. Can be different from the signer.",
        "- recipient: The account receiving funds on the destination chain. Depending on the output chain can be an ETH",
        "address or a contract address or any other address type encoded as a bytes32 field.",
        "- input_token: The token pulled from the caller's account and locked into this program's vault on deposit.",
        "- output_token: The token that the relayer will send to the recipient on the destination chain.",
        "- input_amount: The amount of input tokens to pull from the caller's account and lock into the vault. This",
        "amount will be sent to the relayer on their repayment chain of choice as a refund following an optimistic",
        "challenge window in the HubPool, less a system fee.",
        "- output_amount: The amount of output tokens that the relayer will send to the recipient on the destination.",
        "This is big-endian encoded as a 32-byte array to match its underlying byte representation on EVM side.",
        "- destination_chain_id: The destination chain identifier where the fill should be made.",
        "- exclusive_relayer: The relayer that will be exclusively allowed to fill this deposit before the exclusivity",
        "deadline timestamp. This must be a valid, non-zero address if the exclusivity deadline is greater than the",
        "current block timestamp.",
        "- quote_timestamp: The HubPool timestamp that is used to determine the system fee paid by the depositor. This",
        "must be set to some time between [currentTime - depositQuoteTimeBuffer, currentTime].",
        "- fill_deadline: The deadline for the relayer to fill the deposit. After this destination chain timestamp, the",
        "fill will revert on the destination chain. Must be set before currentTime + fillDeadlineBuffer.",
        "- exclusivity_parameter: Sets the exclusivity deadline timestamp for the exclusiveRelayer to fill the deposit.",
        "1. If 0, no exclusivity period.",
        "2. If less than MAX_EXCLUSIVITY_PERIOD_SECONDS, adds this value to the current block timestamp.",
        "3. Otherwise, uses this value as the exclusivity deadline timestamp.",
        "- message: The message to send to the recipient on the destination chain if the recipient is a contract.",
        "If not empty, the recipient contract must implement handleV3AcrossMessage() or the fill will revert."
      ],
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "delegate"
        },
        {
          "name": "depositorTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "arg",
                "path": "depositor"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "state"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "depositor",
          "type": "pubkey"
        },
        {
          "name": "recipient",
          "type": "pubkey"
        },
        {
          "name": "inputToken",
          "type": "pubkey"
        },
        {
          "name": "outputToken",
          "type": "pubkey"
        },
        {
          "name": "inputAmount",
          "type": "u64"
        },
        {
          "name": "outputAmount",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "destinationChainId",
          "type": "u64"
        },
        {
          "name": "exclusiveRelayer",
          "type": "pubkey"
        },
        {
          "name": "quoteTimestamp",
          "type": "u32"
        },
        {
          "name": "fillDeadline",
          "type": "u32"
        },
        {
          "name": "exclusivityParameter",
          "type": "u32"
        },
        {
          "name": "message",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "depositNow",
      "docs": [
        "Equivalent to deposit except quote_timestamp is set to the current time.",
        "The deposit `fill_deadline` is calculated as the current time plus `fill_deadline_offset`."
      ],
      "discriminator": [
        75,
        228,
        135,
        221,
        200,
        25,
        148,
        26
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "delegate"
        },
        {
          "name": "depositorTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "arg",
                "path": "depositor"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "state"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "depositor",
          "type": "pubkey"
        },
        {
          "name": "recipient",
          "type": "pubkey"
        },
        {
          "name": "inputToken",
          "type": "pubkey"
        },
        {
          "name": "outputToken",
          "type": "pubkey"
        },
        {
          "name": "inputAmount",
          "type": "u64"
        },
        {
          "name": "outputAmount",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "destinationChainId",
          "type": "u64"
        },
        {
          "name": "exclusiveRelayer",
          "type": "pubkey"
        },
        {
          "name": "fillDeadlineOffset",
          "type": "u32"
        },
        {
          "name": "exclusivityParameter",
          "type": "u32"
        },
        {
          "name": "message",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "emergencyDeleteRootBundle",
      "docs": [
        "Deletes a root bundle in case of emergencies where bad bundle has reached the Spoke. Only callable by the owner.",
        "",
        "This function will close the PDA for the associated `root_bundle_id`.",
        "Note: Using this function does not decrement `state.root_bundle_id`.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that must be the owner to authorize the deletion.",
        "- closer (SystemAccount): The account that will receive the lamports from closing the root_bundle account.",
        "- state (Writable): Spoke state PDA. Seed: [\"state\",state.seed] where seed is 0 on mainnet.",
        "- root_bundle (Writable): The root bundle PDA to be closed. Seed: [\"root_bundle\",state.seed,root_bundle_id].",
        "",
        "### Parameters:",
        "- root_bundle_id: Index of the root bundle that needs to be deleted."
      ],
      "discriminator": [
        226,
        158,
        1,
        74,
        84,
        113,
        24,
        152
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "closer",
          "writable": true
        },
        {
          "name": "state",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "rootBundle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  116,
                  95,
                  98,
                  117,
                  110,
                  100,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              },
              {
                "kind": "arg",
                "path": "rootBundleId"
              }
            ]
          }
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "rootBundleId",
          "type": "u32"
        }
      ]
    },
    {
      "name": "executeRelayerRefundLeaf",
      "docs": [
        "Executes relayer refund leaf.",
        "",
        "Processes a relayer refund leaf, verifying its inclusion in a previous Merkle root and that it was not",
        "previously executed. Function has two modes of operation: a) transfers all relayer refunds directly to",
        "relayers ATA or b) credits relayers with claimable claim_account PDA that they can use later to claim their",
        "refund. In the happy path, (a) should be used. (b) should only be used if there is a relayer within the bundle",
        "who can't receive the transfer for some reason, such as failed token transfers due to blacklisting. Executing",
        "relayer refunds requires the caller to create a LUT and load the execution params into it. This is needed to",
        "fit the data in a single instruction. The exact structure and validation of the leaf is defined in the Accross",
        "UMIP: https://github.com/UMAprotocol/UMIPs/blob/master/UMIPs/umip-179.md",
        "",
        "instruction_params Parameters:",
        "- root_bundle_id: The ID of the root bundle containing the relayer refund root.",
        "- relayer_refund_leaf: The relayer refund leaf to be executed. Contents must include:",
        "- amount_to_return: The amount to be to be sent back to mainnet Ethereum from this Spoke pool.",
        "- chain_id: The targeted chainId for the refund. Validated against state.chain_id.",
        "- refund_amounts: The amounts to be returned to the relayer for each refund_address.",
        "- leaf_id: The leaf ID of the relayer refund leaf.",
        "- mint_public_key: The public key of the mint (refunded token) being refunded.",
        "- refund_addresses: The addresses to be refunded.",
        "- proof: The Merkle proof for the relayer refund leaf.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that authorizes the execution. No permission requirements.",
        "- instruction_params (Account): LUT containing the execution parameters. seed: [\"instruction_params\",signer]",
        "- state (Writable): Spoke state PDA. Seed: [\"state\",state.seed] where seed is 0 on mainnet.",
        "- root_bundle (Writable): The root bundle PDA containing the relayer refund root, created when the root bundle",
        "was initially bridged. seed: [\"root_bundle\",state.seed,root_bundle_id].",
        "- vault (Writable): The ATA for refunded mint. Authority must be the state.",
        "- mint (Account): The mint account for the token being refunded.",
        "- transfer_liability (Writable): Account to track pending refunds to be sent to the Ethereum hub pool. Only used",
        "if the amount_to_return value is non-zero within the leaf. Seed: [\"transfer_liability\",mint]",
        "- token_program: The token program.",
        "- system_program: The system program required for account creation.",
        "",
        "execute_relayer_refund_leaf executes in mode where refunds are sent to ATA directly."
      ],
      "discriminator": [
        27,
        136,
        159,
        240,
        127,
        68,
        123,
        164
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "instructionParams",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  115,
                  116,
                  114,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  112,
                  97,
                  114,
                  97,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "signer"
              }
            ]
          }
        },
        {
          "name": "state",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "rootBundle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  116,
                  95,
                  98,
                  117,
                  110,
                  100,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              },
              {
                "kind": "account",
                "path": "instruction_params.root_bundle_id",
                "account": "executeRelayerRefundLeafParams"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "state"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "transferLiability",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  110,
                  115,
                  102,
                  101,
                  114,
                  95,
                  108,
                  105,
                  97,
                  98,
                  105,
                  108,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "executeRelayerRefundLeafDeferred",
      "docs": [
        "Similar to execute_relayer_refund_leaf, but executes in mode where refunds are allocated to claim_account PDAs."
      ],
      "discriminator": [
        110,
        112,
        89,
        208,
        38,
        116,
        93,
        10
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "instructionParams",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  115,
                  116,
                  114,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  112,
                  97,
                  114,
                  97,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "signer"
              }
            ]
          }
        },
        {
          "name": "state",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "rootBundle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  116,
                  95,
                  98,
                  117,
                  110,
                  100,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              },
              {
                "kind": "account",
                "path": "instruction_params.root_bundle_id",
                "account": "executeRelayerRefundLeafParams"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "state"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "transferLiability",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  110,
                  115,
                  102,
                  101,
                  114,
                  95,
                  108,
                  105,
                  97,
                  98,
                  105,
                  108,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "executeSlowRelayLeaf",
      "docs": [
        "Executes a slow relay leaf stored as part of a root bundle relayed by the HubPool.",
        "",
        "Executing a slow fill leaf is equivalent to filling the relayData, so this function cannot be used to",
        "double fill a recipient. The relayData that is filled is included in the slowFillLeaf and is hashed",
        "like any other fill sent through fillRelay(). There is no relayer credited with filling this relay since funds",
        "are sent directly out of this program's vault.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that authorizes the execution. No permission requirements.",
        "- instruction_params (Account): Optional account to load instruction parameters when they are not passed in the",
        "instruction data due to message size constraints. Pass this program ID to represent None. When Some, this must",
        "be derived from the signer's public key with seed [\"instruction_params\",signer].",
        "- state (Writable): Spoke state PDA. Seed: [\"state\",state.seed] where seed is 0 on mainnet.",
        "- root_bundle (Account): Root bundle PDA with slowRelayRoot. Seed: [\"root_bundle\",state.seed,root_bundle_id].",
        "- fill_status (Writable): The fill status PDA, created when slow request was made. Updated to track slow fill.",
        "Used to prevent double request and fill. Seed: [\"fills\",relay_hash].",
        "- mint (Account): The mint account for the output token.",
        "- recipient_token_account (Writable): The recipient's ATA for the output token.",
        "- vault (Writable): The ATA for refunded mint. Authority must be the state.",
        "- token_program (Interface): The token program.",
        "- system_program (Program): The system program.",
        "",
        "### Parameters:",
        "- _relay_hash: The hash identifying the deposit to be filled. Used to identify the deposit to be filled.",
        "- slow_fill_leaf: Contains all data necessary to uniquely verify the slow fill. This struct contains:",
        "- relayData: Struct containing all the data needed to identify the original deposit to be slow filled. Same",
        "as the relay_data struct in fill_relay().",
        "- chainId: Chain identifier where slow fill leaf should be executed. If this doesn't match this chain's",
        "chainId, then this function will revert.",
        "- updatedOutputAmount: Amount to be sent to recipient out of this contract's balance. Can be set differently",
        "from relayData.outputAmount to charge a different fee because this deposit was \"slow\" filled. Usually,",
        "this will be set higher to reimburse the recipient for waiting for the slow fill.",
        "- _root_bundle_id: Unique ID of root bundle containing slow relay root that this leaf is contained in.",
        "- proof: Inclusion proof for this leaf in slow relay root in root bundle.",
        "Note: slow_fill_leaf, _root_bundle_id, and proof are optional parameters. If None for any of these is passed,",
        "the caller must load them via the instruction_params account.",
        "Note: When verifying the slow fill leaf, the relay data is hashed using AnchorSerialize::serialize that encodes",
        "output token amounts to little-endian format while input token amount preserves its big-endian encoding as it",
        "is passed as [u8; 32] array."
      ],
      "discriminator": [
        26,
        207,
        3,
        168,
        193,
        252,
        59,
        127
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "instructionParams",
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  115,
                  116,
                  114,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  112,
                  97,
                  114,
                  97,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "signer"
              }
            ]
          }
        },
        {
          "name": "state",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "rootBundle",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  116,
                  95,
                  98,
                  117,
                  110,
                  100,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              },
              {
                "kind": "arg",
                "path": "_root_bundle_id.unwrap_or_else(| |\ninstruction_params"
              }
            ]
          }
        },
        {
          "name": "fillStatus",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  105,
                  108,
                  108,
                  115
                ]
              },
              {
                "kind": "arg",
                "path": "relayHash"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "recipientTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "arg",
                "path": "slowFillLeaf"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "state"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "relayHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "slowFillLeaf",
          "type": {
            "option": {
              "defined": {
                "name": "slowFill"
              }
            }
          }
        },
        {
          "name": "rootBundleId",
          "type": {
            "option": "u32"
          }
        },
        {
          "name": "proof",
          "type": {
            "option": {
              "vec": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          }
        }
      ]
    },
    {
      "name": "fillRelay",
      "docs": [
        "Fulfill request to bridge cross chain by sending specified output tokens to recipient.",
        "",
        "Relayer & system fee is captured in the spread between input and output amounts. This fee accounts for tx costs,",
        "relayer's capital opportunity cost, and a system fee. The relay_data hash uniquely identifies the deposit to",
        "fill, ensuring relayers are refunded only for deposits matching the original hash from the origin SpokePool.",
        "This hash includes all parameters from deposit() and must match the destination_chain_id. Note the relayer",
        "creates an ATA in calling this method to store the fill_status. This should be closed once the deposit has",
        "expired to let the relayer re-claim their rent. Cannot fill more than once. Partial fills are not supported.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that authorizes the fill (filler). No permission requirements.",
        "- instruction_params (Account): Optional account to load instruction parameters when they are not passed in the",
        "instruction data due to message size constraints. Pass this program ID to represent None. When Some, this must",
        "be derived from the signer's public key with seed [\"instruction_params\",signer].",
        "- state (Writable): Spoke state PDA. Seed: [\"state\",state.seed] where seed is 0 on mainnet.",
        "- mint (Account): The mint of the output token, sent from the relayer to the recipient.",
        "- relayer_token_account (Writable): The relayer's ATA for the input token.",
        "- recipient_token_account (Writable): The recipient's ATA for the output token.",
        "- fill_status (Writable): The fill status PDA, created on this function call to track the fill status to prevent",
        "re-entrancy & double fills. Also used to track requested slow fills. Seed: [\"fills\",relay_hash].",
        "- token_program (Interface): The token program.",
        "- associated_token_program (Interface): The associated token program.",
        "- system_program (Interface): The system program.",
        "- delegate (Account): The account used to delegate the output amount of the output token.",
        "",
        "### Parameters:",
        "- relay_hash: The hash identifying the deposit to be filled. Caller must pass this in. Computed as hash of",
        "the flattened relay_data & destination_chain_id.",
        "- relay_data: Struct containing all the data needed to identify the deposit to be filled. Should match",
        "all the same-named parameters emitted in the origin chain FundsDeposited event.",
        "- depositor: The account credited with the deposit.",
        "- recipient: The account receiving funds on this chain.",
        "- input_token: The token pulled from the caller's account to initiate the deposit. The equivalent of this",
        "token on the repayment chain will be sent as a refund to the caller.",
        "- output_token: The token that the caller will send to the recipient on this chain.",
        "- input_amount: This amount, less a system fee, will be sent to the caller on their repayment chain.",
        "This is big-endian encoded as a 32-byte array to match its underlying byte representation on EVM side",
        "- output_amount: The amount of output tokens that the caller will send to the recipient.",
        "- origin_chain_id: The origin chain identifier.",
        "- exclusive_relayer: The relayer that will be exclusively allowed to fill this deposit before the",
        "exclusivity deadline timestamp.",
        "- fill_deadline: The deadline for the caller to fill the deposit. After this timestamp, the deposit will be",
        "cancelled and the depositor will be refunded on the origin chain.",
        "- exclusivity_deadline: The deadline for the exclusive relayer to fill the deposit. After this timestamp,",
        "anyone can fill this deposit.",
        "- message: The message to send to the recipient if the recipient is a contract that implements a",
        "handle_across_message() public function.",
        "- repayment_chain_id: Chain of SpokePool where relayer wants to be refunded after the challenge window has",
        "passed. Will receive input_amount of the equivalent token to input_token on the repayment chain.",
        "- repayment_address: The address of the recipient on the repayment chain that they want to be refunded to.",
        "Note: relay_data, repayment_chain_id, and repayment_address are optional parameters. If None for any of these",
        "is passed, the caller must load them via the instruction_params account."
      ],
      "discriminator": [
        100,
        84,
        222,
        90,
        106,
        209,
        58,
        222
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "instructionParams",
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  115,
                  116,
                  114,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  112,
                  97,
                  114,
                  97,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "signer"
              }
            ]
          }
        },
        {
          "name": "state",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "delegate"
        },
        {
          "name": "mint"
        },
        {
          "name": "relayerTokenAccount",
          "writable": true
        },
        {
          "name": "recipientTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "arg",
                "path": "relayData"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "fillStatus",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  105,
                  108,
                  108,
                  115
                ]
              },
              {
                "kind": "arg",
                "path": "relayHash"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "relayHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "relayData",
          "type": {
            "option": {
              "defined": {
                "name": "relayData"
              }
            }
          }
        },
        {
          "name": "repaymentChainId",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "repaymentAddress",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    },
    {
      "name": "getUnsafeDepositId",
      "docs": [
        "Computes the deposit ID for the depositor using the provided deposit_nonce. This acts like a \"view\" function for",
        "off-chain actors to compute what the expected deposit ID is for a given depositor and deposit nonce will be.",
        "",
        "### Parameters:",
        "- signer: The public key of the depositor sender.",
        "- depositor: The public key of the depositor.",
        "- deposit_nonce: The nonce used to derive the deposit ID."
      ],
      "discriminator": [
        118,
        10,
        135,
        0,
        168,
        243,
        223,
        117
      ],
      "accounts": [],
      "args": [
        {
          "name": "signer",
          "type": "pubkey"
        },
        {
          "name": "depositor",
          "type": "pubkey"
        },
        {
          "name": "depositNonce",
          "type": "u64"
        }
      ],
      "returns": {
        "array": [
          "u8",
          32
        ]
      }
    },
    {
      "name": "handleReceiveMessage",
      "docs": [
        "Handles cross-chain messages received from L1 Ethereum over CCTP.",
        "",
        "This function serves as the permissioned entry point for messages sent from the Ethereum mainnet to the Solana",
        "SVM Spoke program over CCTP. It processes the incoming message by translating it into a corresponding Solana",
        "instruction and then invokes the instruction within this program.",
        "",
        "### Required Accounts:",
        "- authority_pda: A signer account that ensures this instruction can only be called by the Message Transmitter.",
        "This acts to block that only the CCTP Message Transmitter can send messages to this program.",
        "seed:[\"message_transmitter_authority\", program_id]",
        "- state (Account): Spoke state PDA. Seed: [\"state\",state.seed] where seed is 0 on mainnet. Enforces that the",
        "remote domain and sender are valid.",
        "- self_authority: An unchecked account used for authenticating self-CPI invoked by the received message.",
        "seed: [\"self_authority\"].",
        "- program: The SVM Spoke program account.",
        "",
        "### Parameters:",
        "- params: Contains information to process the received message, containing the following fields:",
        "- remote_domain: The remote domain of the message sender.",
        "- sender: The sender of the message.",
        "- message_body: The body of the message.",
        "- authority_bump: The authority bump for the message transmitter."
      ],
      "discriminator": [
        133,
        102,
        1,
        180,
        145,
        11,
        138,
        180
      ],
      "accounts": [
        {
          "name": "authorityPda",
          "signer": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  101,
                  115,
                  115,
                  97,
                  103,
                  101,
                  95,
                  116,
                  114,
                  97,
                  110,
                  115,
                  109,
                  105,
                  116,
                  116,
                  101,
                  114,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "const",
                "value": [
                  183,
                  102,
                  64,
                  134,
                  222,
                  55,
                  238,
                  112,
                  130,
                  28,
                  16,
                  68,
                  91,
                  22,
                  47,
                  44,
                  126,
                  200,
                  121,
                  91,
                  208,
                  128,
                  12,
                  20,
                  98,
                  148,
                  158,
                  35,
                  40,
                  209,
                  221,
                  90
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                166,
                95,
                201,
                137,
                219,
                95,
                93,
                66,
                117,
                159,
                58,
                84,
                96,
                88,
                239,
                205,
                205,
                192,
                191,
                60,
                24,
                152,
                7,
                45,
                142,
                180,
                93,
                209,
                216,
                5,
                8,
                206
              ]
            }
          }
        },
        {
          "name": "state",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "selfAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  108,
                  102,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program",
          "address": "DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "handleReceiveMessageParams"
            }
          }
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "Initializes the state for the SVM Spoke Pool. Only callable once.",
        "",
        "### Required Accounts:",
        "- signer (Writable, Signer): The account that pays for the transaction and will own the state.",
        "- state (Writable): Spoke state PDA. Seed: [\"state\",state.seed] where seed is 0 on mainnet.",
        "- system_program: The system program required for account creation.",
        "",
        "### Parameters:",
        "- seed: A unique seed used to derive the state account's address. Must be 0 on Mainnet.",
        "- initial_number_of_deposits: The initial number of deposits. Used to offset in upgrades.",
        "- chain_id: The chain ID for Solana, used to identify the Solana spoke in the rest of the Across protocol.",
        "- remote_domain: The CCTP domain for Mainnet Ethereum.",
        "- cross_domain_admin: The HubPool on Mainnet Ethereum.",
        "- deposit_quote_time_buffer: Quote timestamps can't be set more than this amount into the past from deposit.",
        "- fill_deadline_buffer: Fill deadlines can't be set more than this amount into the future from deposit."
      ],
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
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "seed"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "seed",
          "type": "u64"
        },
        {
          "name": "initialNumberOfDeposits",
          "type": "u32"
        },
        {
          "name": "chainId",
          "type": "u64"
        },
        {
          "name": "remoteDomain",
          "type": "u32"
        },
        {
          "name": "crossDomainAdmin",
          "type": "pubkey"
        },
        {
          "name": "depositQuoteTimeBuffer",
          "type": "u32"
        },
        {
          "name": "fillDeadlineBuffer",
          "type": "u32"
        }
      ]
    },
    {
      "name": "initializeClaimAccount",
      "docs": [
        "Initializes a claim account for a relayer refund.",
        "",
        "This function sets up a claim account for a relayer to claim their refund at a later time and should only be",
        "used in the un-happy path where a bundle cant not be executed due to a recipient in the bundle having a blocked",
        "or uninitialized claim ATA. The refund address becomes the \"owner\" of the claim_account.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that pays for the transaction and initializes the claim account.",
        "- mint: The mint associated with the claim account.",
        "- refund_address: The refund address associated with the claim account.",
        "- claim_account (Writable): The newly created claim account PDA to store claim data for this associated mint.",
        "Seed: [\"claim_account\",mint,refund_address].",
        "- system_program: The system program required for account creation."
      ],
      "discriminator": [
        22,
        247,
        214,
        191,
        90,
        74,
        87,
        216
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "refundAddress"
        },
        {
          "name": "claimAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  108,
                  97,
                  105,
                  109,
                  95,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "refundAddress"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializeInstructionParams",
      "docs": [
        "Initializes the instruction parameters account. Used by data worker when relaying bundles",
        "",
        "This function sets up an account to store raw data fragments for instructions (LUT).",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that pays for the transaction and initializes the instruction parameters.",
        "- instruction_params (UncheckedAccount): The account where raw data will be stored. Initialized with specified",
        "size. seed: [\"instruction_params\",signer].",
        "- system_program: The system program required for account creation.",
        "",
        "### Parameters:",
        "- _total_size: The total size of the instruction parameters account."
      ],
      "discriminator": [
        94,
        206,
        190,
        192,
        127,
        8,
        186,
        28
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "instructionParams",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  115,
                  116,
                  114,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  112,
                  97,
                  114,
                  97,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "signer"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "totalSize",
          "type": "u32"
        }
      ]
    },
    {
      "name": "pauseDeposits",
      "docs": [
        "Pauses the Spoke Pool from accepting deposits. Only callable by the owner.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that must be the owner to authorize the pause.",
        "- state (Writable): The Spoke state PDA. Seed: [\"state\",state.seed], where `seed` is 0 on mainnet.",
        "",
        "### Parameters:",
        "- pause: `true` to pause the system, `false` to unpause it."
      ],
      "discriminator": [
        206,
        186,
        203,
        153,
        253,
        61,
        206,
        122
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "pause",
          "type": "bool"
        }
      ]
    },
    {
      "name": "pauseFills",
      "docs": [
        "Pauses the Spoke Pool from processing fills. Only callable by the owner.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that must be the owner to authorize the pause.",
        "- state (Writable): The Spoke state PDA. Seed: [\"state\",state.seed], where `seed` is 0 on mainnet.",
        "",
        "### Parameters:",
        "- pause: `true` to pause the system, `false` to unpause it."
      ],
      "discriminator": [
        92,
        114,
        214,
        49,
        13,
        243,
        73,
        35
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "pause",
          "type": "bool"
        }
      ]
    },
    {
      "name": "relayRootBundle",
      "docs": [
        "Stores a new root bundle for later execution. Only callable by the owner.",
        "",
        "Once stored, these roots are used to execute relayer refunds, slow fills, and pool rebalancing actions.",
        "This method initializes a root_bundle PDA to store the root bundle data. The caller",
        "of this method is responsible for paying the rent for this PDA.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that must be the owner to authorize the addition of the new root bundle.",
        "- payer (Signer): The account who pays rent to create root_bundle PDA.",
        "- state (Writable): Spoke state PDA. Seed: [\"state\",state.seed] where seed is 0 on mainnet.",
        "- root_bundle (Writable): The newly created bundle PDA to store root bundle data. Each root bundle has an",
        "incrementing ID, stored in the state. Seed: [\"root_bundle\",state.seed,root_bundle_id].",
        "- system_program (Program): The system program required for account creation.",
        "",
        "### Parameters:",
        "- relayer_refund_root: Merkle root of the relayer refund tree.",
        "- slow_relay_root: Merkle root of the slow relay tree."
      ],
      "discriminator": [
        69,
        13,
        223,
        204,
        251,
        61,
        105,
        6
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "rootBundle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  111,
                  116,
                  95,
                  98,
                  117,
                  110,
                  100,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              },
              {
                "kind": "account",
                "path": "state.root_bundle_id",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "relayerRefundRoot",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "slowRelayRoot",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "requestSlowFill",
      "docs": [
        "Requests Across to send LP funds to this program to fulfill a slow fill.",
        "",
        "Slow fills are not possible unless the input and output tokens are \"equivalent\", i.e., they route to the same L1",
        "token via PoolRebalanceRoutes. Slow fills are created by inserting slow fill objects into a Merkle tree that is",
        "included in the next HubPool \"root bundle\". Once the optimistic challenge window has passed, the HubPool will",
        "relay the slow root to this chain via relayRootBundle(). Once the slow root is relayed, the slow fill can be",
        "executed by anyone who calls executeSlowRelayLeaf(). Cant request a slow fill if the fill deadline has",
        "passed. Cant request a slow fill if the relay has already been filled or a slow fill has already been requested.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that authorizes the slow fill request.",
        "- instruction_params (Account): Optional account to load instruction parameters when they are not passed in the",
        "instruction data due to message size constraints. Pass this program ID to represent None. When Some, this must",
        "be derived from the signer's public key with seed [\"instruction_params\",signer].",
        "- state (Writable): Spoke state PDA. Seed: [\"state\",state.seed] where seed is 0 on mainnet.",
        "- fill_status (Writable): The fill status PDA, created on this function call. Updated to track slow fill status.",
        "Used to prevent double request and fill. Seed: [\"fills\",relay_hash].",
        "- system_program (Interface): The system program.",
        "",
        "### Parameters:",
        "- _relay_hash: The hash identifying the deposit to be filled. Caller must pass this in. Computed as hash of",
        "the flattened relay_data & destination_chain_id.",
        "- relay_data: Struct containing all the data needed to identify the deposit that should be slow filled. If any",
        "of the params are missing or different from the origin chain deposit, then Across will not include a slow",
        "fill for the intended deposit. See fill_relay & RelayData struct for more details.",
        "Note: relay_data is optional parameter. If None for it is passed, the caller must load it via the",
        "instruction_params account."
      ],
      "discriminator": [
        39,
        157,
        165,
        187,
        88,
        217,
        207,
        98
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "instructionParams",
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  115,
                  116,
                  114,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  112,
                  97,
                  114,
                  97,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "signer"
              }
            ]
          }
        },
        {
          "name": "state",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "fillStatus",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  105,
                  108,
                  108,
                  115
                ]
              },
              {
                "kind": "arg",
                "path": "relayHash"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "relayHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "relayData",
          "type": {
            "option": {
              "defined": {
                "name": "relayData"
              }
            }
          }
        }
      ]
    },
    {
      "name": "setCrossDomainAdmin",
      "docs": [
        "Sets the cross-domain admin for the Spoke Pool. Only callable by owner. Used if Hubpool upgrades.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that must be the owner to authorize the admin change.",
        "- state (Writable): Spoke state PDA. Seed: [\"state\",state.seed] where seed is 0 on mainnet.",
        "",
        "### Parameters:",
        "- cross_domain_admin: The public key of the new cross-domain admin."
      ],
      "discriminator": [
        102,
        206,
        237,
        106,
        63,
        141,
        42,
        248
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "crossDomainAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setCurrentTime",
      "docs": [
        "Sets the current time for the SVM Spoke Pool when running in test mode. Disabled on Mainnet."
      ],
      "discriminator": [
        69,
        100,
        169,
        193,
        125,
        0,
        150,
        69
      ],
      "accounts": [
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "signer",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newTime",
          "type": "u32"
        }
      ]
    },
    {
      "name": "transferOwnership",
      "docs": [
        "Transfers ownership of the Spoke Pool. Only callable by the current owner.",
        "",
        "### Required Accounts:",
        "- signer (Signer): The account that must be the current owner to authorize the transfer.",
        "- state (Writable): The Spoke state PDA. Seed: [\"state\",state.seed] where `seed` is 0 on mainnet.",
        "",
        "### Parameters:",
        "- new_owner: The public key of the new owner."
      ],
      "discriminator": [
        65,
        177,
        215,
        73,
        53,
        45,
        99,
        47
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "newOwner",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "unsafeDeposit",
      "docs": [
        "Equivalent to deposit, except that it doesn't use the global `number_of_deposits` counter as the deposit",
        "nonce. Instead, it allows the caller to pass a `deposit_nonce`. This function is designed for anyone who",
        "wants to pre-compute their resultant deposit ID, which can be useful for filling a deposit faster and",
        "avoiding the risk of a deposit ID unexpectedly changing due to another deposit front-running this one and",
        "incrementing the global deposit ID counter. This enables the caller to influence the deposit ID, making it",
        "deterministic for the depositor. The computed `depositID` is the keccak256 hash of [signer, depositor, deposit_nonce]."
      ],
      "discriminator": [
        196,
        187,
        166,
        179,
        3,
        146,
        150,
        246
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "state",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "state.seed",
                "account": "state"
              }
            ]
          }
        },
        {
          "name": "delegate"
        },
        {
          "name": "depositorTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "arg",
                "path": "depositor"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "state"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "depositor",
          "type": "pubkey"
        },
        {
          "name": "recipient",
          "type": "pubkey"
        },
        {
          "name": "inputToken",
          "type": "pubkey"
        },
        {
          "name": "outputToken",
          "type": "pubkey"
        },
        {
          "name": "inputAmount",
          "type": "u64"
        },
        {
          "name": "outputAmount",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "destinationChainId",
          "type": "u64"
        },
        {
          "name": "exclusiveRelayer",
          "type": "pubkey"
        },
        {
          "name": "depositNonce",
          "type": "u64"
        },
        {
          "name": "quoteTimestamp",
          "type": "u32"
        },
        {
          "name": "fillDeadline",
          "type": "u32"
        },
        {
          "name": "exclusivityParameter",
          "type": "u32"
        },
        {
          "name": "message",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "writeInstructionParamsFragment",
      "docs": [
        "Writes a fragment of raw data into the instruction parameters account.",
        "",
        "This function allows writing a fragment of data into a specified offset within the instruction parameters",
        "account. It ensures that the data does not overflow the account's allocated space.",
        "",
        "### Required Accounts:",
        "- signer (Signer): Account that authorizes the write operation.",
        "- instruction_params (UncheckedAccount): Account to write raw data to. seed: [\"instruction_params\",signer].",
        "- system_program: The system program required for account operations.",
        "",
        "### Parameters:",
        "- offset: The starting position within the account's data where the fragment will be written.",
        "- fragment: The raw data fragment to be written into the account."
      ],
      "discriminator": [
        238,
        182,
        109,
        113,
        124,
        255,
        72,
        18
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "instructionParams",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  115,
                  116,
                  114,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  112,
                  97,
                  114,
                  97,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "signer"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "offset",
          "type": "u32"
        },
        {
          "name": "fragment",
          "type": "bytes"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "claimAccount",
      "discriminator": [
        113,
        109,
        47,
        96,
        242,
        219,
        61,
        165
      ]
    },
    {
      "name": "executeRelayerRefundLeafParams",
      "discriminator": [
        192,
        59,
        93,
        9,
        171,
        77,
        28,
        250
      ]
    },
    {
      "name": "executeSlowRelayLeafParams",
      "discriminator": [
        135,
        208,
        119,
        251,
        14,
        222,
        66,
        155
      ]
    },
    {
      "name": "fillRelayParams",
      "discriminator": [
        50,
        243,
        51,
        185,
        89,
        60,
        43,
        202
      ]
    },
    {
      "name": "fillStatusAccount",
      "discriminator": [
        105,
        89,
        88,
        35,
        24,
        147,
        178,
        137
      ]
    },
    {
      "name": "requestSlowFillParams",
      "discriminator": [
        5,
        54,
        214,
        89,
        197,
        37,
        118,
        28
      ]
    },
    {
      "name": "rootBundle",
      "discriminator": [
        66,
        221,
        214,
        231,
        25,
        222,
        184,
        219
      ]
    },
    {
      "name": "state",
      "discriminator": [
        216,
        146,
        107,
        94,
        104,
        75,
        182,
        177
      ]
    },
    {
      "name": "transferLiability",
      "discriminator": [
        157,
        137,
        86,
        109,
        206,
        241,
        183,
        79
      ]
    }
  ],
  "events": [
    {
      "name": "bridgedToHubPool",
      "discriminator": [
        181,
        111,
        52,
        218,
        105,
        53,
        240,
        205
      ]
    },
    {
      "name": "claimedRelayerRefund",
      "discriminator": [
        161,
        134,
        155,
        159,
        211,
        37,
        150,
        41
      ]
    },
    {
      "name": "emergencyDeletedRootBundle",
      "discriminator": [
        45,
        150,
        89,
        248,
        134,
        142,
        200,
        114
      ]
    },
    {
      "name": "executedRelayerRefundRoot",
      "discriminator": [
        198,
        167,
        248,
        175,
        34,
        3,
        4,
        240
      ]
    },
    {
      "name": "filledRelay",
      "discriminator": [
        25,
        58,
        182,
        0,
        50,
        99,
        160,
        117
      ]
    },
    {
      "name": "fundsDeposited",
      "discriminator": [
        157,
        209,
        100,
        95,
        59,
        100,
        3,
        68
      ]
    },
    {
      "name": "pausedDeposits",
      "discriminator": [
        94,
        129,
        187,
        122,
        94,
        30,
        91,
        247
      ]
    },
    {
      "name": "pausedFills",
      "discriminator": [
        81,
        4,
        134,
        23,
        170,
        56,
        234,
        234
      ]
    },
    {
      "name": "relayedRootBundle",
      "discriminator": [
        188,
        206,
        117,
        10,
        66,
        78,
        77,
        115
      ]
    },
    {
      "name": "requestedSlowFill",
      "discriminator": [
        221,
        123,
        11,
        14,
        71,
        37,
        178,
        167
      ]
    },
    {
      "name": "setXDomainAdmin",
      "discriminator": [
        164,
        13,
        119,
        18,
        103,
        226,
        98,
        66
      ]
    },
    {
      "name": "tokensBridged",
      "discriminator": [
        200,
        201,
        199,
        39,
        5,
        238,
        214,
        196
      ]
    },
    {
      "name": "transferredOwnership",
      "discriminator": [
        235,
        235,
        154,
        16,
        153,
        94,
        21,
        117
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidQuoteTimestamp",
      "msg": "Invalid quote timestamp!"
    },
    {
      "code": 6001,
      "name": "invalidFillDeadline",
      "msg": "Invalid fill deadline!"
    },
    {
      "code": 6002,
      "name": "notExclusiveRelayer",
      "msg": "Caller is not the exclusive relayer and exclusivity deadline has not passed!"
    },
    {
      "code": 6003,
      "name": "noSlowFillsInExclusivityWindow",
      "msg": "The Deposit is still within the exclusivity window!"
    },
    {
      "code": 6004,
      "name": "relayFilled",
      "msg": "The relay has already been filled!"
    },
    {
      "code": 6005,
      "name": "invalidSlowFillRequest",
      "msg": "Slow fill requires status of Unfilled!"
    },
    {
      "code": 6006,
      "name": "expiredFillDeadline",
      "msg": "The fill deadline has passed!"
    },
    {
      "code": 6007,
      "name": "invalidMerkleProof",
      "msg": "Invalid Merkle proof!"
    },
    {
      "code": 6008,
      "name": "invalidChainId",
      "msg": "Invalid chain id!"
    },
    {
      "code": 6009,
      "name": "invalidMerkleLeaf",
      "msg": "Invalid Merkle leaf!"
    },
    {
      "code": 6010,
      "name": "claimedMerkleLeaf",
      "msg": "Leaf already claimed!"
    },
    {
      "code": 6011,
      "name": "depositsArePaused",
      "msg": "Deposits are currently paused!"
    },
    {
      "code": 6012,
      "name": "fillsArePaused",
      "msg": "Fills are currently paused!"
    },
    {
      "code": 6013,
      "name": "insufficientSpokePoolBalanceToExecuteLeaf",
      "msg": "Insufficient spoke pool balance to execute leaf"
    },
    {
      "code": 6014,
      "name": "invalidExclusiveRelayer",
      "msg": "Invalid exclusive relayer!"
    },
    {
      "code": 6015,
      "name": "invalidOutputToken",
      "msg": "Invalid output token!"
    }
  ],
  "types": [
    {
      "name": "bridgedToHubPool",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "mint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "claimAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "initializer",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "claimedRelayerRefund",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "l2TokenAddress",
            "type": "pubkey"
          },
          {
            "name": "claimAmount",
            "type": "u64"
          },
          {
            "name": "refundAddress",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "emergencyDeletedRootBundle",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rootBundleId",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "executeRelayerRefundLeafParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rootBundleId",
            "type": "u32"
          },
          {
            "name": "relayerRefundLeaf",
            "type": {
              "defined": {
                "name": "relayerRefundLeaf"
              }
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
    },
    {
      "name": "executeSlowRelayLeafParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "slowFillLeaf",
            "type": {
              "defined": {
                "name": "slowFill"
              }
            }
          },
          {
            "name": "rootBundleId",
            "type": "u32"
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
    },
    {
      "name": "executedRelayerRefundRoot",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amountToReturn",
            "type": "u64"
          },
          {
            "name": "chainId",
            "type": "u64"
          },
          {
            "name": "refundAmounts",
            "type": {
              "vec": "u64"
            }
          },
          {
            "name": "rootBundleId",
            "type": "u32"
          },
          {
            "name": "leafId",
            "type": "u32"
          },
          {
            "name": "l2TokenAddress",
            "type": "pubkey"
          },
          {
            "name": "refundAddresses",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "deferredRefunds",
            "type": "bool"
          },
          {
            "name": "caller",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "fillRelayParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "relayData",
            "type": {
              "defined": {
                "name": "relayData"
              }
            }
          },
          {
            "name": "repaymentChainId",
            "type": "u64"
          },
          {
            "name": "repaymentAddress",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "fillStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "unfilled"
          },
          {
            "name": "requestedSlowFill"
          },
          {
            "name": "filled"
          }
        ]
      }
    },
    {
      "name": "fillStatusAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "fillStatus"
              }
            }
          },
          {
            "name": "relayer",
            "type": "pubkey"
          },
          {
            "name": "fillDeadline",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "fillType",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "fastFill"
          },
          {
            "name": "replacedSlowFill"
          },
          {
            "name": "slowFill"
          }
        ]
      }
    },
    {
      "name": "filledRelay",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "inputToken",
            "type": "pubkey"
          },
          {
            "name": "outputToken",
            "type": "pubkey"
          },
          {
            "name": "inputAmount",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "outputAmount",
            "type": "u64"
          },
          {
            "name": "repaymentChainId",
            "type": "u64"
          },
          {
            "name": "originChainId",
            "type": "u64"
          },
          {
            "name": "depositId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "fillDeadline",
            "type": "u32"
          },
          {
            "name": "exclusivityDeadline",
            "type": "u32"
          },
          {
            "name": "exclusiveRelayer",
            "type": "pubkey"
          },
          {
            "name": "relayer",
            "type": "pubkey"
          },
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "messageHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "relayExecutionInfo",
            "type": {
              "defined": {
                "name": "relayExecutionEventInfo"
              }
            }
          }
        ]
      }
    },
    {
      "name": "fundsDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "inputToken",
            "type": "pubkey"
          },
          {
            "name": "outputToken",
            "type": "pubkey"
          },
          {
            "name": "inputAmount",
            "type": "u64"
          },
          {
            "name": "outputAmount",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "destinationChainId",
            "type": "u64"
          },
          {
            "name": "depositId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "quoteTimestamp",
            "type": "u32"
          },
          {
            "name": "fillDeadline",
            "type": "u32"
          },
          {
            "name": "exclusivityDeadline",
            "type": "u32"
          },
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "exclusiveRelayer",
            "type": "pubkey"
          },
          {
            "name": "message",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "handleReceiveMessageParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "remoteDomain",
            "type": "u32"
          },
          {
            "name": "sender",
            "type": "pubkey"
          },
          {
            "name": "messageBody",
            "type": "bytes"
          },
          {
            "name": "authorityBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "pausedDeposits",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "isPaused",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "pausedFills",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "isPaused",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "relayData",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "exclusiveRelayer",
            "type": "pubkey"
          },
          {
            "name": "inputToken",
            "type": "pubkey"
          },
          {
            "name": "outputToken",
            "type": "pubkey"
          },
          {
            "name": "inputAmount",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "outputAmount",
            "type": "u64"
          },
          {
            "name": "originChainId",
            "type": "u64"
          },
          {
            "name": "depositId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "fillDeadline",
            "type": "u32"
          },
          {
            "name": "exclusivityDeadline",
            "type": "u32"
          },
          {
            "name": "message",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "relayExecutionEventInfo",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "updatedRecipient",
            "type": "pubkey"
          },
          {
            "name": "updatedMessageHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "updatedOutputAmount",
            "type": "u64"
          },
          {
            "name": "fillType",
            "type": {
              "defined": {
                "name": "fillType"
              }
            }
          }
        ]
      }
    },
    {
      "name": "relayedRootBundle",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rootBundleId",
            "type": "u32"
          },
          {
            "name": "relayerRefundRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "slowRelayRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "relayerRefundLeaf",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amountToReturn",
            "type": "u64"
          },
          {
            "name": "chainId",
            "type": "u64"
          },
          {
            "name": "refundAmounts",
            "type": {
              "vec": "u64"
            }
          },
          {
            "name": "leafId",
            "type": "u32"
          },
          {
            "name": "mintPublicKey",
            "type": "pubkey"
          },
          {
            "name": "refundAddresses",
            "type": {
              "vec": "pubkey"
            }
          }
        ]
      }
    },
    {
      "name": "requestSlowFillParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "relayData",
            "type": {
              "defined": {
                "name": "relayData"
              }
            }
          }
        ]
      }
    },
    {
      "name": "requestedSlowFill",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "inputToken",
            "type": "pubkey"
          },
          {
            "name": "outputToken",
            "type": "pubkey"
          },
          {
            "name": "inputAmount",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "outputAmount",
            "type": "u64"
          },
          {
            "name": "originChainId",
            "type": "u64"
          },
          {
            "name": "depositId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "fillDeadline",
            "type": "u32"
          },
          {
            "name": "exclusivityDeadline",
            "type": "u32"
          },
          {
            "name": "exclusiveRelayer",
            "type": "pubkey"
          },
          {
            "name": "depositor",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "messageHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "rootBundle",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "relayerRefundRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "slowRelayRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "claimedBitmap",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "setXDomainAdmin",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "newAdmin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "slowFill",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "relayData",
            "type": {
              "defined": {
                "name": "relayData"
              }
            }
          },
          {
            "name": "chainId",
            "type": "u64"
          },
          {
            "name": "updatedOutputAmount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "state",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pausedDeposits",
            "type": "bool"
          },
          {
            "name": "pausedFills",
            "type": "bool"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "seed",
            "type": "u64"
          },
          {
            "name": "numberOfDeposits",
            "type": "u32"
          },
          {
            "name": "chainId",
            "type": "u64"
          },
          {
            "name": "currentTime",
            "type": "u32"
          },
          {
            "name": "remoteDomain",
            "type": "u32"
          },
          {
            "name": "crossDomainAdmin",
            "type": "pubkey"
          },
          {
            "name": "rootBundleId",
            "type": "u32"
          },
          {
            "name": "depositQuoteTimeBuffer",
            "type": "u32"
          },
          {
            "name": "fillDeadlineBuffer",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "tokensBridged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amountToReturn",
            "type": "u64"
          },
          {
            "name": "chainId",
            "type": "u64"
          },
          {
            "name": "leafId",
            "type": "u32"
          },
          {
            "name": "l2TokenAddress",
            "type": "pubkey"
          },
          {
            "name": "caller",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "transferLiability",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pendingToHubPool",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "transferredOwnership",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "newOwner",
            "type": "pubkey"
          }
        ]
      }
    }
  ]
};
