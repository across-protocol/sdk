/// <reference types="node" />
/**
 * Generates Codama TypeScript clients from IDL files.
 * Reads IDL assets from the locally generated src/svm/assets/idl/ directory
 * (populated by generateSvmAssets.sh).
 *
 * This is the SDK's own generation script, equivalent to the one in the contracts repo.
 */
import path from "path";
import { createFromRoot } from "codama";
import { rootNodeFromAnchor, AnchorIdl } from "@codama/nodes-from-anchor";
import { renderVisitor as renderJavaScriptVisitor } from "@codama/renderers-js";

import SvmSpokeIdl from "../../src/svm/assets/idl/svm_spoke.json";
import MulticallHandlerIdl from "../../src/svm/assets/idl/multicall_handler.json";
import MessageTransmitterIdl from "../../src/svm/assets/idl/message_transmitter.json";
import TokenMessengerMinterIdl from "../../src/svm/assets/idl/token_messenger_minter.json";
import MessageTransmitterV2Idl from "../../src/svm/assets/idl/message_transmitter_v2.json";
import TokenMessengerMinterV2Idl from "../../src/svm/assets/idl/token_messenger_minter_v2.json";
import SponsoredCctpSrcPeripheryIdl from "../../src/svm/assets/idl/sponsored_cctp_src_periphery.json";

const clientsPath = path.join(__dirname, "..", "..", "src", "svm", "clients");

// Generate clients for each program
let codama = createFromRoot(rootNodeFromAnchor(SvmSpokeIdl as AnchorIdl));
codama.accept(renderJavaScriptVisitor(path.join(clientsPath, "SvmSpoke")));

codama = createFromRoot(rootNodeFromAnchor(MulticallHandlerIdl as AnchorIdl));
codama.accept(renderJavaScriptVisitor(path.join(clientsPath, "MulticallHandler")));

codama = createFromRoot(rootNodeFromAnchor(MessageTransmitterIdl as AnchorIdl));
codama.accept(renderJavaScriptVisitor(path.join(clientsPath, "MessageTransmitter")));

codama = createFromRoot(rootNodeFromAnchor(TokenMessengerMinterIdl as AnchorIdl));
codama.accept(renderJavaScriptVisitor(path.join(clientsPath, "TokenMessengerMinter")));

codama = createFromRoot(rootNodeFromAnchor(MessageTransmitterV2Idl as AnchorIdl));
codama.accept(renderJavaScriptVisitor(path.join(clientsPath, "MessageTransmitterV2")));

codama = createFromRoot(rootNodeFromAnchor(TokenMessengerMinterV2Idl as AnchorIdl));
codama.accept(renderJavaScriptVisitor(path.join(clientsPath, "TokenMessengerMinterV2")));

codama = createFromRoot(rootNodeFromAnchor(SponsoredCctpSrcPeripheryIdl as AnchorIdl));
codama.accept(renderJavaScriptVisitor(path.join(clientsPath, "SponsoredCctpSrcPeriphery")));

console.log("Codama clients generated at", clientsPath);
