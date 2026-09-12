# Contracts beta compatibility

This work starts [ACP-227](https://linear.app/uma/issue/ACP-227) against the exact
`@across-protocol/contracts@6.0.0-beta.2` release. It prepares SDK package compatibility;
it does not complete the coordinated light-chain cutover or publish an SDK prerelease.

## SDK API changes

The following functions are exported from `arch.svm`:

| Previous API | Replacement |
| --- | --- |
| `AttestedCCTPMessage` | `AttestedCCTPV2Message`: `{ messageBytes, attestation }` |
| `getCCTPV1ReceiveMessageTx` | `getCCTPV2ReceiveMessageTx(rpc, signer, message, expectedTokenRecipient?)` |
| `hasCCTPV1MessageBeenProcessed` | `hasCCTPV2MessageBeenProcessed(rpc, nonce)` |
| `getCCTPNoncePda(rpc, signer, nonce, sourceDomain)` | `getCCTPNoncePda(nonce)` |
| `finalizeCCTPV1Messages` | `finalizeCCTPV2Messages(rpc, messages, signer, options?)` |

`nonce` is the complete 32 bytes at offsets 12–43 of the **attested V2 message**,
accepted as bytes or a hex string. It is neither a sequential number nor the
placeholder nonce emitted at initiation. `decodeCCTPV2Message` exposes these bytes,
header addresses/domains and executed finality. `decodeCCTPV2BurnMessage` exposes the
burn amount, maximum/executed fees, recipient, expiration block and hook data.

`fetchCCTPV2Messages(transactionHash, sourceDomain, isMainnet, options?)` polls Iris
with bounded waits and retries pending, missing, rate-limited and server-error
responses. It selects Solana messages using the attested bytes; optional `recipient`
and 32-byte hex `nonce` filters select a particular delivery. It waits for V2
attestations in that transaction to complete. For multiple ordered admin/root
operations, select and deliver them in source order; do not sort by nonce.

The receive builder dispatches using the attested receiver and enforces the
attested destination caller. Spoke delivery authenticates the current remote domain
and admin, requires executed finality >=2000, supports all five receiver calls and
resolves current root-bundle state. Token delivery resolves Circle's TokenPair and
LocalToken, custody and fee-recipient ATA, uses the attested mint recipient and
supports both finalized and unfinalized messages. `expectedTokenRecipient` optionally
restricts token delivery to a selected destination token account. Circle's program
remains responsible for attestation verification and token-message validity.

`getCCTPV2ReceiveMessageTx` returns an unsigned transaction for consumer signing,
compute-budget and lookup-table infrastructure. Provision the recipient/fee token
accounts and lookup tables before delivery. Token transactions may need address
lookup tables to fit Solana's transaction size limit. The optional convenience
finalizer accepts `lookupTables`, `expectedTokenRecipient` and `simulate`, confirms
each transaction before building the next, and returns `null` for an already-used
nonce (including races), `""` for simulation, or a confirmed signature. Unconfirmed
or failed transactions throw and can be retried with the same attested message.

`getAccountMetasForTokenlessMessage` and `createReceiveMessageInstruction` now live
in `CCTPUtils.ts`, alongside the new `getAccountMetasForCCTPV2TokenMessage`.
Consumers should import these through `arch.svm`. The V1-only
`isDepositForBurnEvent` helper and obsolete `getTransferLiabilityPda` are removed.
The generic `getCCTPDepositAccounts` remains available for downstream V2 burn builders.

## Events and historical data

Active SVM events no longer include `TokensBridged` or `BridgedToHubPool`; EVM
`TokensBridged` support remains intact. `SvmCpiEventsClient.create()` uses
`SvmSpokeEventsIdl`, which supplements the new IDL with just those two event
definitions copied from contracts 5.0.26. This lets queries span the upgrade without
failing on historical events. Explicit historical readers can use
`createFor(rpc, programId, SvmSpokeEventsIdl)` and query the legacy names. No V1
instructions or finalization helpers are restored.

Outstanding V1 transfers must be drained before cutover or recovered by an explicit
legacy consumer implementation pinned to the old SDK/contracts. This compatibility
change does not establish that there are no outstanding V1 transfers.

## Validation and remaining phase 2 work

The validator fixtures now clone Circle V2 and use the test binaries from the pinned
contracts release. CI resolves its Solana version from that release's Cargo.lock.
The EVM MockSpokePool test wrapper and fixtures pass the new Gateway constructor
argument (zero for V4 tests). ABI staging removes stale generated artifacts before
regeneration so local builds cannot hide removed beta exports.

Validation: **50 focused tests passed** together with Solana 2.1.21 and the released
beta binaries. Checks used for this change:

- `yarn build` (clean CJS, ESM and declarations), `hardhat compile`, focused TypeScript
  checking and linting.
- Unit coverage for header/burn decoding, nonce PDAs/status, all receiver account
  layouts, authentication/finality/caller rejection, token fees and recipients,
  Iris polling/selection, replay races, confirmation errors and historical events.
- Solana 2.1.21 validator tests against the released test binaries: all five Spoke
  receiver calls, sequential delivery, replay after admin updates/root deletion,
  and existing Spoke event/client regression tests.
- EVM `SpokePoolClient.v3Events.ts`, including retained `TokensBridged` behavior.

Token account construction is unit-tested; real token delivery with nonzero fees
and public-network attestations still needs end-to-end consumer validation.
Repository-wide test type-checking also exposes errors outside the focused
suites; this change does not claim the entire repository test suite is green.

Next steps remain the origin-only repayment/light-chain accounting audit (including
both `fromLiteChain` and `toLiteChain` paths), consumer initiation/finalization and
inventory-fee reconciliation, indexer upgrade-boundary integration, historical V1
recovery decisions, and an exact SDK beta publication. Keep production pins and
activation unchanged until the coordinated program/configuration cutover.
