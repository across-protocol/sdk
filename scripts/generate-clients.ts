import { createFromRoot } from 'codama';
import { rootNodeFromAnchor, AnchorIdl } from '@codama/nodes-from-anchor';
import { renderVisitor as renderJavaScriptVisitor } from "@codama/renderers-js";
import { SvmSpokeIdl, MulticallHandlerIdl } from "@across-protocol/contracts"
import path from 'path';

let codama = createFromRoot(rootNodeFromAnchor(SvmSpokeIdl as AnchorIdl));
const clientsPath = path.join(__dirname, "..", "src", "svm", "clients");

codama.accept(
    renderJavaScriptVisitor(path.join(clientsPath, "SvmSpoke"))
);

codama = createFromRoot(rootNodeFromAnchor(MulticallHandlerIdl as AnchorIdl));
codama.accept(
    renderJavaScriptVisitor(path.join(clientsPath, "MulticallHandler"))
);

// codama = createFromRoot(rootNodeFromAnchor(MessageTransmitterIdl as AnchorIdl));
// codama.accept(
//     renderJavaScriptVisitor(path.join(clientsPath, "MessageTransmitter"))
// );

// codama = createFromRoot(rootNodeFromAnchor(TokenMessengerMinterIdl as AnchorIdl));
// codama.accept(
//     renderJavaScriptVisitor(path.join(clientsPath, "TokenMessengerMinter"))
// );  