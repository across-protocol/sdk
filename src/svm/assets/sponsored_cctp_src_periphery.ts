/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/sponsored_cctp_src_periphery.json`.
 */
export type SponsoredCctpSrcPeriphery = {
  "address": "CPr4bRvkVKcSCLyrQpkZrRrwGzQeVAXutFU8WupuBLXq",
  "metadata": {
    "name": "sponsoredCctpSrcPeriphery",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "docs": [
    "# Across Sponsored CCTP Source Periphery",
    "",
    "Source chain periphery program for users to interact with to start a sponsored or a non-sponsored flow that allows",
    "custom Across-supported flows on destination chain. Uses Circle's CCTPv2 as an underlying bridge"
  ],
  "instructions": [
    {
      "name": "depositForBurn",
      "docs": [
        "Verifies a sponsored CCTP quote, records its nonce, and burns the user's tokens via CCTPv2 with hook data.",
        "",
        "The user's depositor ATA is burned via `deposit_for_burn_with_hook` CPI on the CCTPv2. The rent cost for the",
        "per-quote `used_nonce` PDA is refunded to the signer from the `rent_fund` and `rent_fund` also funds the",
        "creation of CCTP `MessageSent` event account.",
        "On success, this emits a `SponsoredDepositForBurn` event to be consumed by offchain infrastructure. This also",
        "emits a `CreatedEventAccount` event containing the address of the created CCTP `MessageSent` event account that",
        "can be reclaimed later using the `reclaim_event_account` instruction.",
        "",
        "Required Accounts:",
        "- signer (Signer, Writable): The user authorizing the burn.",
        "- state (Account): Program state PDA. Seed: [\"state\"].",
        "- rent_fund (SystemAccount, Writable): PDA used to sponsor rent and event accounts. Seed: [\"rent_fund\"].",
        "- minimum_deposit (Account): Minimum deposit state PDA. Seed: [\"minimum_deposit\", burn_token.key()].",
        "- used_nonce (Account, Writable, Init): Per-quote nonce PDA. Seed: [\"used_nonce\", nonce].",
        "- rent_claim (Optional Account, Writable, Init-If-Needed): Optional PDA to accrue rent_fund debt to the user.",
        "Seed: [\"rent_claim\", signer.key()].",
        "- depositor_token_account (InterfaceAccount<TokenAccount>, Writable): Signer ATA of the burn token.",
        "- burn_token (InterfaceAccount<Mint>, Mutable): Mint of the token to burn. Must match quote.burn_token.",
        "- denylist_account (Unchecked): CCTP denylist PDA, validated within CCTP.",
        "- token_messenger_minter_sender_authority (Unchecked): CCTP sender authority PDA.",
        "- message_transmitter (Unchecked, Mutable): CCTP MessageTransmitter account.",
        "- token_messenger (Unchecked): CCTP TokenMessenger account.",
        "- remote_token_messenger (Unchecked): Remote TokenMessenger account for destination domain.",
        "- token_minter (Unchecked): CCTP TokenMinter account.",
        "- local_token (Unchecked, Mutable): Local token account (CCTP).",
        "- cctp_event_authority (Unchecked): CCTP event authority account.",
        "- message_sent_event_data (Signer, Mutable): Fresh account to store CCTP MessageSent event data.",
        "- message_transmitter_program (Program): CCTPv2 MessageTransmitter program.",
        "- token_messenger_minter_program (Program): CCTPv2 TokenMessengerMinter program.",
        "- token_program (Interface): SPL token program.",
        "- system_program (Program): System program.",
        "",
        "Parameters:",
        "- quote: SponsoredCCTPQuote struct serialized by Anchor:",
        "- source_domain: CCTP domain ID of the source chain.",
        "- destination_domain: CCTP domain ID of the destination chain.",
        "- mint_recipient: The recipient of the minted tokens on the destination chain.",
        "- amount: The amount of tokens that the user pays on the source chain.",
        "- burn_token: The token that will be burned on the source chain.",
        "- destination_caller: The caller of the destination chain.",
        "- max_fee: Maximum fee to pay on the destination domain, specified in units of burn_token.",
        "- min_finality_threshold: Minimum finality threshold before allowed to attest.",
        "- nonce: Nonce is used to prevent replay attacks.",
        "- deadline: Timestamp of the quote after which it can no longer be used.",
        "- max_bps_to_sponsor: The maximum basis points of the amount that can be sponsored.",
        "- max_user_slippage_bps: Slippage tolerance for the fees on the destination. Used in swap flow, enforced on",
        "destination.",
        "- final_recipient: The final recipient of the sponsored deposit. This is needed as the mint_recipient will be",
        "the handler contract address instead of the final recipient.",
        "- final_token: The final token that final recipient will receive. This is needed as it can be different from",
        "the burn_token in which case we perform a swap on the destination chain.",
        "- execution_mode: Execution mode: DirectToCore (0), ArbitraryActionsToCore (1), or ArbitraryActionsToEVM (2).",
        "- action_data: Encoded action data for arbitrary execution. Empty for DirectToCore mode.",
        "- signature: 65-byte EVM signature authorizing the quote by the trusted signer.",
        "",
        "Notes:",
        "- The upgrade authority must have set the valid EVM signer for this instruction to succeed.",
        "- The operator of this program must have funded the `rent_fund` PDA with sufficient lamports to cover",
        "rent for the `used_nonce` PDA and the CCTP `MessageSent` event account."
      ],
      "discriminator": [
        215,
        60,
        61,
        46,
        114,
        55,
        128,
        176
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
              }
            ]
          }
        },
        {
          "name": "rentFund",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  110,
                  116,
                  95,
                  102,
                  117,
                  110,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "minimumDeposit",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  105,
                  109,
                  117,
                  109,
                  95,
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burnToken"
              }
            ]
          }
        },
        {
          "name": "usedNonce",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  100,
                  95,
                  110,
                  111,
                  110,
                  99,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "params.quote.nonce"
              }
            ]
          }
        },
        {
          "name": "rentClaim",
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  110,
                  116,
                  95,
                  99,
                  108,
                  97,
                  105,
                  109
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
          "name": "depositorTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "signer"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "burnToken"
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
          "name": "burnToken",
          "writable": true
        },
        {
          "name": "denylistAccount"
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
          "address": "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC"
        },
        {
          "name": "tokenMessengerMinterProgram",
          "address": "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe"
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
          "name": "params",
          "type": {
            "defined": {
              "name": "depositForBurnParams"
            }
          }
        }
      ]
    },
    {
      "name": "getUsedNonceCloseInfo",
      "docs": [
        "Returns whether a `used_nonce` PDA can be closed now and the timestamp after which it can be closed.",
        "",
        "This is a convenience \"view\" helper for off-chain systems to determine when rent can be reclaimed for a",
        "specific quote nonce.",
        "",
        "Required Accounts:",
        "- state (Account): Program state PDA. Seed: [\"state\"].",
        "- used_nonce (Account): The `used_nonce` PDA. Seed: [\"used_nonce\", nonce].",
        "",
        "Parameters:",
        "- _params.nonce: The 32-byte nonce identifying the PDA to check.",
        "",
        "Returns:",
        "- UsedNonceCloseInfo { can_close_after, can_close_now }"
      ],
      "discriminator": [
        19,
        183,
        42,
        151,
        118,
        234,
        57,
        92
      ],
      "accounts": [
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
              }
            ]
          }
        },
        {
          "name": "usedNonce",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  100,
                  95,
                  110,
                  111,
                  110,
                  99,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "_params.nonce"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "usedNonceAccountParams"
            }
          }
        }
      ],
      "returns": {
        "defined": {
          "name": "usedNonceCloseInfo"
        }
      }
    },
    {
      "name": "initialize",
      "docs": [
        "Initializes immutable program state and sets the trusted EVM quote signer.",
        "",
        "This can only be called once by the upgrade authority. It stores the local CCTP source domain and the",
        "quote `signer` that must authorize sponsored deposits.",
        "",
        "Required Accounts:",
        "- signer (Signer, Writable): Must be the program upgrade authority.",
        "- state (Writable): Program state PDA. Seed: [\"state\"].",
        "- program_data (Account): Program data account to verify the upgrade authority.",
        "- this_program (Program): This program account, used to resolve `programdata_address`.",
        "- system_program (Program): System program for account creation.",
        "",
        "Parameters:",
        "- source_domain: CCTP domain for this chain (e.g., 5 for Solana).",
        "- signer: EVM address (encoded as `Pubkey`) authorized to sign sponsored quotes."
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
              }
            ]
          }
        },
        {
          "name": "programData"
        },
        {
          "name": "thisProgram",
          "address": "CPr4bRvkVKcSCLyrQpkZrRrwGzQeVAXutFU8WupuBLXq"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "initializeParams"
            }
          }
        }
      ]
    },
    {
      "name": "reclaimEventAccount",
      "docs": [
        "Reclaims the CCTP `MessageSent` event account, returning rent to the rent fund.",
        "",
        "Required Accounts:",
        "- rent_fund (SystemAccount, Writable): PDA to receive reclaimed lamports. Seed: [\"rent_fund\"].",
        "- message_transmitter (Unchecked, Mutable): CCTP MessageTransmitter account.",
        "- message_sent_event_data (Account, Mutable): The `MessageSent` event account created during `deposit_for_burn`.",
        "- message_transmitter_program (Program): CCTPv2 MessageTransmitter program.",
        "",
        "Parameters:",
        "- params: Parameters struct required to construct reclaim_event_account instruction on the CCTPv2.",
        "- attestation: Attestation obtained from the CCTP attestation service.",
        "- nonce: bytes32 from the attested destination message.",
        "- finality_threshold_executed: uint32 BE encoded from the attested destination message.",
        "- fee_executed: uint256 BE encoded from the attested destination message body.",
        "- expiration_block: uint256 BE encoded from the attested destination message body.",
        "",
        "Notes:",
        "- This can only be called after the CCTP attestation service has processed the message and sufficient time has",
        "passed since the `MessageSent` event was created. The operator can track the closable accounts from the",
        "emitted `CreatedEventAccount` events and using the `EVENT_ACCOUNT_WINDOW_SECONDS` set in CCTP program."
      ],
      "discriminator": [
        94,
        198,
        180,
        159,
        131,
        236,
        15,
        174
      ],
      "accounts": [
        {
          "name": "rentFund",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  110,
                  116,
                  95,
                  102,
                  117,
                  110,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "messageTransmitter",
          "writable": true
        },
        {
          "name": "messageSentEventData",
          "writable": true
        },
        {
          "name": "messageTransmitterProgram",
          "address": "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC"
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
          "name": "params",
          "type": {
            "defined": {
              "name": "reclaimEventAccountParams"
            }
          }
        }
      ]
    },
    {
      "name": "reclaimUsedNonceAccount",
      "docs": [
        "Closes a `used_nonce` PDA once its quote deadline has passed, returning rent to the rent fund.",
        "",
        "Required Accounts:",
        "- state (Account): Program state PDA. Seed: [\"state\"]. Used to fetch current time.",
        "- rent_fund (SystemAccount, Writable): PDA receiving lamports upon close. Seed: [\"rent_fund\"].",
        "- used_nonce (Account, Writable, Close=rent_fund): PDA to close. Seed: [\"used_nonce\", nonce].",
        "",
        "Parameters:",
        "- params.nonce: The 32-byte nonce identifying the PDA to close.",
        "",
        "Notes:",
        "- This can only be called after the quote's deadline has passed. The operator can track closable `used_nonce`",
        "accounts from the emitted `SponsoredDepositForBurn` events (`quote_nonce` and `quote_deadline`) and using the",
        "`get_used_nonce_close_info` helper."
      ],
      "discriminator": [
        153,
        152,
        111,
        172,
        156,
        104,
        116,
        3
      ],
      "accounts": [
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
              }
            ]
          }
        },
        {
          "name": "rentFund",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  110,
                  116,
                  95,
                  102,
                  117,
                  110,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "usedNonce",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  100,
                  95,
                  110,
                  111,
                  110,
                  99,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "params.nonce"
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
          "name": "params",
          "type": {
            "defined": {
              "name": "usedNonceAccountParams"
            }
          }
        }
      ]
    },
    {
      "name": "repayRentFundDebt",
      "docs": [
        "Repays rent_fund liability for a user if rent_fund had insufficient balance at the time of deposit.",
        "",
        "Required Accounts:",
        "- rent_fund (SystemAccount, Writable): PDA used to sponsor rent and event accounts. Seed: [\"rent_fund\"].",
        "- recipient (Unchecked, Writable): The user account to repay rent fund debt to.",
        "- rent_claim (Account, Writable, Close=recipient): PDA with accrued rent_fund debt to the user.",
        "Seed: [\"rent_claim\", recipient.key()].",
        "- system_program (Program): System program."
      ],
      "discriminator": [
        111,
        95,
        222,
        174,
        241,
        41,
        61,
        78
      ],
      "accounts": [
        {
          "name": "rentFund",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  110,
                  116,
                  95,
                  102,
                  117,
                  110,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "recipient",
          "writable": true
        },
        {
          "name": "rentClaim",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  110,
                  116,
                  95,
                  99,
                  108,
                  97,
                  105,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "recipient"
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
      "args": []
    },
    {
      "name": "setCurrentTime",
      "docs": [
        "Sets the current time in test mode. No-op on mainnet builds.",
        "",
        "Required Accounts:",
        "- state (Writable): Program state PDA. Seed: [\"state\"].",
        "- signer (Signer): Any signer. Only enabled when built with `--features test`.",
        "",
        "Parameters:",
        "- new_time: New unix timestamp to set for tests."
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
          "name": "params",
          "type": {
            "defined": {
              "name": "setCurrentTimeParams"
            }
          }
        }
      ]
    },
    {
      "name": "setMinimumDepositAmount",
      "docs": [
        "Updates the minimum deposit amount for a given burn token.",
        "",
        "Only callable by the upgrade authority. This must be set at least once for a supported burn token as otherwise",
        "deposits would be blocked.",
        "",
        "Required Accounts:",
        "- signer (Signer, Writable): Must be the program upgrade authority.",
        "- minimum_deposit (Writable): Minimum deposit state PDA. Seed: [\"minimum_deposit\", burn_token.key()].",
        "- burn_token: Supported burn token for which the minimum deposit amount is being set.",
        "- program_data (Account): Program data account to verify the upgrade authority.",
        "- this_program (Program): This program account, used to resolve `programdata_address`.",
        "- system_program (Program): System program for transfers.",
        "",
        "Parameters:",
        "- amount: New minimum deposit amount for a given burn token."
      ],
      "discriminator": [
        176,
        4,
        74,
        229,
        206,
        148,
        151,
        138
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "minimumDeposit",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  105,
                  109,
                  117,
                  109,
                  95,
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burnToken"
              }
            ]
          }
        },
        {
          "name": "burnToken"
        },
        {
          "name": "programData"
        },
        {
          "name": "thisProgram",
          "address": "CPr4bRvkVKcSCLyrQpkZrRrwGzQeVAXutFU8WupuBLXq"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "setMinimumDepositAmountParams"
            }
          }
        }
      ]
    },
    {
      "name": "setSigner",
      "docs": [
        "Updates the trusted EVM quote signer.",
        "",
        "Only callable by the upgrade authority. Setting this to an invalid address (including `Pubkey::default()`) will",
        "effectively disable deposits.",
        "",
        "Required Accounts:",
        "- signer (Signer, Writable): Must be the program upgrade authority.",
        "- state (Writable): Program state PDA. Seed: [\"state\"].",
        "- program_data (Account): Program data account to verify the upgrade authority.",
        "- this_program (Program): This program account, used to resolve `programdata_address`.",
        "",
        "Parameters:",
        "- new_signer: New EVM signer address (encoded as `Pubkey`)."
      ],
      "discriminator": [
        127,
        120,
        252,
        184,
        97,
        4,
        88,
        68
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
              }
            ]
          }
        },
        {
          "name": "programData"
        },
        {
          "name": "thisProgram",
          "address": "CPr4bRvkVKcSCLyrQpkZrRrwGzQeVAXutFU8WupuBLXq"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "setSignerParams"
            }
          }
        }
      ]
    },
    {
      "name": "withdrawRentFund",
      "docs": [
        "Withdraws lamports from the rent fund PDA to an arbitrary recipient.",
        "",
        "The rent fund is used to sponsor temporary account creation (e.g., CCTP event accounts or per-quote nonce PDAs).",
        "Only callable by the upgrade authority.",
        "",
        "Required Accounts:",
        "- signer (Signer, Writable): Must be the program upgrade authority.",
        "- rent_fund (SystemAccount, Writable): PDA holding lamports used for rent sponsorship. Seed: [\"rent_fund\"].",
        "- recipient (UncheckedAccount, Writable): Destination account for the withdrawn lamports.",
        "- program_data (Account): Program data account to verify the upgrade authority.",
        "- this_program (Program): This program account, used to resolve `programdata_address`.",
        "- system_program (Program): System program for transfers.",
        "",
        "Parameters:",
        "- amount: Amount of lamports to transfer to the recipient."
      ],
      "discriminator": [
        153,
        28,
        108,
        116,
        132,
        70,
        161,
        125
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "rentFund",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  110,
                  116,
                  95,
                  102,
                  117,
                  110,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "recipient",
          "writable": true
        },
        {
          "name": "programData"
        },
        {
          "name": "thisProgram",
          "address": "CPr4bRvkVKcSCLyrQpkZrRrwGzQeVAXutFU8WupuBLXq"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "withdrawRentFundParams"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "messageSent",
      "discriminator": [
        131,
        100,
        133,
        56,
        166,
        225,
        151,
        60
      ]
    },
    {
      "name": "minimumDeposit",
      "discriminator": [
        218,
        139,
        120,
        202,
        3,
        12,
        233,
        65
      ]
    },
    {
      "name": "rentClaim",
      "discriminator": [
        13,
        5,
        183,
        82,
        60,
        122,
        72,
        11
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
      "name": "usedNonce",
      "discriminator": [
        212,
        222,
        157,
        252,
        130,
        71,
        179,
        238
      ]
    }
  ],
  "events": [
    {
      "name": "accruedRentFundLiability",
      "discriminator": [
        56,
        17,
        203,
        169,
        27,
        139,
        36,
        225
      ]
    },
    {
      "name": "createdEventAccount",
      "discriminator": [
        178,
        224,
        189,
        92,
        50,
        100,
        128,
        204
      ]
    },
    {
      "name": "minimumDepositAmountSet",
      "discriminator": [
        134,
        237,
        176,
        205,
        21,
        44,
        95,
        177
      ]
    },
    {
      "name": "reclaimedEventAccount",
      "discriminator": [
        210,
        180,
        74,
        27,
        92,
        74,
        46,
        216
      ]
    },
    {
      "name": "reclaimedUsedNonceAccount",
      "discriminator": [
        6,
        199,
        109,
        7,
        58,
        150,
        119,
        103
      ]
    },
    {
      "name": "repaidRentFundDebt",
      "discriminator": [
        134,
        86,
        59,
        173,
        10,
        250,
        191,
        190
      ]
    },
    {
      "name": "signerSet",
      "discriminator": [
        137,
        203,
        187,
        74,
        141,
        187,
        226,
        95
      ]
    },
    {
      "name": "sponsoredDepositForBurn",
      "discriminator": [
        55,
        106,
        70,
        41,
        59,
        102,
        172,
        42
      ]
    },
    {
      "name": "withdrawnRentFund",
      "discriminator": [
        110,
        180,
        127,
        254,
        32,
        122,
        209,
        22
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notUpgradeAuthority",
      "msg": "Only the upgrade authority can call this instruction"
    },
    {
      "code": 6001,
      "name": "invalidProgramData",
      "msg": "Invalid program data account"
    },
    {
      "code": 6002,
      "name": "cannotSetCurrentTime",
      "msg": "Cannot set time if not in test mode"
    },
    {
      "code": 6003,
      "name": "invalidBurnToken",
      "msg": "Invalid burn_token key"
    },
    {
      "code": 6004,
      "name": "amountNotPositive",
      "msg": "Amount must be greater than 0"
    },
    {
      "code": 6005,
      "name": "quoteDeadlineNotPassed",
      "msg": "The quote deadline has not passed!"
    },
    {
      "code": 6006,
      "name": "signerUnchanged",
      "msg": "New signer unchanged"
    },
    {
      "code": 6007,
      "name": "depositAmountBelowMinimum",
      "msg": "Deposit amount below minimum"
    },
    {
      "code": 6008,
      "name": "missingRentClaimAccount",
      "msg": "Missing rent claim account"
    },
    {
      "code": 6009,
      "name": "rentClaimOverflow",
      "msg": "Rent claim amount overflow"
    },
    {
      "code": 6010,
      "name": "invalidRecipientKey",
      "msg": "Invalid recipient key"
    }
  ],
  "types": [
    {
      "name": "accruedRentFundLiability",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "totalUserClaim",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "createdEventAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "messageSentEventData",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "depositForBurnParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "quote",
            "type": {
              "defined": {
                "name": "sponsoredCctpQuote"
              }
            }
          },
          {
            "name": "signature",
            "type": {
              "array": [
                "u8",
                65
              ]
            }
          }
        ]
      }
    },
    {
      "name": "initializeParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sourceDomain",
            "type": "u32"
          },
          {
            "name": "signer",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "messageSent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "rentPayer",
            "type": "pubkey"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "message",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "minimumDeposit",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "minimumDepositAmountSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "burnToken",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "reclaimEventAccountParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "attestation",
            "type": "bytes"
          },
          {
            "name": "nonce",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "finalityThresholdExecuted",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "feeExecuted",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "expirationBlock",
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
      "name": "reclaimedEventAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "messageSentEventData",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "reclaimedUsedNonceAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "nonce",
            "type": "bytes"
          },
          {
            "name": "usedNonce",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "rentClaim",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "repaidRentFundDebt",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "remainingUserClaim",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "setCurrentTimeParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "newTime",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "setMinimumDepositAmountParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "setSignerParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "newSigner",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "signerSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldSigner",
            "type": "pubkey"
          },
          {
            "name": "newSigner",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "sponsoredCctpQuote",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sourceDomain",
            "type": "u32"
          },
          {
            "name": "destinationDomain",
            "type": "u32"
          },
          {
            "name": "mintRecipient",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "burnToken",
            "type": "pubkey"
          },
          {
            "name": "destinationCaller",
            "type": "pubkey"
          },
          {
            "name": "maxFee",
            "type": "u64"
          },
          {
            "name": "minFinalityThreshold",
            "type": "u32"
          },
          {
            "name": "nonce",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "deadline",
            "type": "u64"
          },
          {
            "name": "maxBpsToSponsor",
            "type": "u64"
          },
          {
            "name": "maxUserSlippageBps",
            "type": "u64"
          },
          {
            "name": "finalRecipient",
            "type": "pubkey"
          },
          {
            "name": "finalToken",
            "type": "pubkey"
          },
          {
            "name": "destinationDex",
            "type": "u32"
          },
          {
            "name": "accountCreationMode",
            "type": "u8"
          },
          {
            "name": "executionMode",
            "type": "u8"
          },
          {
            "name": "actionData",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "sponsoredDepositForBurn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "quoteNonce",
            "type": "bytes"
          },
          {
            "name": "originSender",
            "type": "pubkey"
          },
          {
            "name": "finalRecipient",
            "type": "pubkey"
          },
          {
            "name": "quoteDeadline",
            "type": "u64"
          },
          {
            "name": "maxBpsToSponsor",
            "type": "u64"
          },
          {
            "name": "maxUserSlippageBps",
            "type": "u64"
          },
          {
            "name": "finalToken",
            "type": "pubkey"
          },
          {
            "name": "destinationDex",
            "type": "u32"
          },
          {
            "name": "accountCreationMode",
            "type": "u8"
          },
          {
            "name": "signature",
            "type": "bytes"
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
            "name": "sourceDomain",
            "type": "u32"
          },
          {
            "name": "signer",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "usedNonce",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "quoteDeadline",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "usedNonceAccountParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "nonce",
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
      "name": "usedNonceCloseInfo",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "canCloseAfter",
            "type": "u64"
          },
          {
            "name": "canCloseNow",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "withdrawRentFundParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "withdrawnRentFund",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          }
        ]
      }
    }
  ]
};
