/**
 * Generates Codama TypeScript clients from IDL files.
 * Reads IDL assets from the locally generated src/svm/assets/idl/ directory
 * (populated by generateSvmAssets.sh).
 *
 * This is the SDK's own generation script, equivalent to the one in the contracts repo.
 */
import { createFromRoot } from "codama";
import { rootNodeFromAnchor, AnchorIdl } from "@codama/nodes-from-anchor";
import { renderVisitor as renderJavaScriptVisitor } from "@codama/renderers-js";
import path from "path";

// Read IDL files directly from the generated assets
const idlPath = path.join(__dirname, "..", "..", "src", "svm", "assets", "idl");
const clientsPath = path.join(__dirname, "..", "..", "src", "svm", "clients");

const SvmSpokeIdl = require(path.join(idlPath, "svm_spoke.json"));
const MulticallHandlerIdl = require(path.join(idlPath, "multicall_handler.json"));
const MessageTransmitterIdl = require(path.join(idlPath, "message_transmitter.json"));
const TokenMessengerMinterIdl = require(path.join(idlPath, "token_messenger_minter.json"));
const MessageTransmitterV2Idl = require(path.join(idlPath, "message_transmitter_v2.json"));
const TokenMessengerMinterV2Idl = require(path.join(idlPath, "token_messenger_minter_v2.json"));
const SponsoredCctpSrcPeripheryIdl = require(path.join(idlPath, "sponsored_cctp_src_periphery.json"));

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
