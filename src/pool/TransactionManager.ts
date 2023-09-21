import assert from "assert";
import { Signer } from "ethers";
import { TransactionRequest, TransactionReceipt } from "@ethersproject/abstract-provider";
import { isDefined } from "../utils";

export type Emit = (event: string, key: string, data: TransactionReceipt | string | TransactionRequest | Error) => void;

function makeKey(tx: TransactionRequest) {
  return JSON.stringify(
    Object.entries(tx).map(([key, value]) => {
      return [key, (value || "").toString()];
    })
  );
}

type Config = {
  confirmations?: number;
};

export class TransactionManager {
  protected confirmations: number;
  protected requests: Record<string, TransactionRequest> = {};
  protected mined: Record<string, TransactionReceipt> = {};
  protected submissions: Record<string, string> = {};

  constructor(
    config: Config,
    private readonly signer: Signer,
    private readonly emit: Emit = () => null
  ) {
    assert(signer.provider, "signer requires a provider, use signer.connect(provider)");
    this.confirmations = config.confirmations ?? 3;
  }

  request(unsignedTx: TransactionRequest): string {
    // this no longer calls signer.populateTransaction, to allow metamask to fill in missing details instead
    // use overrides if you want to manually fill in other tx details, including the overrides.customData field.
    const populated = unsignedTx;
    const key = makeKey(populated);
    assert(!isDefined(this.requests[key]), "Transaction already in progress");
    this.requests[key] = populated;
    return key;
  }

  async processRequest(key: string): Promise<void> {
    const request = this.requests[key];
    assert(request, "invalid request");
    delete this.requests[key]; // always delete request, it should only be submitted once.
    try {
      const sent = await this.signer.sendTransaction(request);
      this.submissions[key] = sent.hash;
      this.emit("submitted", key, sent.hash);
    } catch (err) {
      this.emit("error", key, err as Error);
    }
  }

  async processSubmission(key: string) {
    const hash = this.submissions[key];
    assert(hash, "invalid submission");
    assert(this.signer.provider, "signer requires a provider, use signer.connect(provider)");
    // we look for this transaction, but it may never find it if its sped up
    const receipt = await this.signer.provider.getTransactionReceipt(hash).catch(() => undefined);
    if (receipt == null) return;
    if (receipt.confirmations < this.confirmations) return;
    delete this.submissions[key];
    this.mined[key] = receipt;
    this.emit("mined", key, receipt);
  }

  isMined(key: string): boolean {
    return isDefined(this.mined[key]);
  }

  async update() {
    for (const key of Object.keys(this.requests)) {
      await this.processRequest(key);
    }
    for (const key of Object.keys(this.submissions)) {
      await this.processSubmission(key);
    }
  }
}
