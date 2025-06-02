import { expect } from "chai";
import { SvmSpokeClient } from "@across-protocol/contracts";
// import { Address } from "../src/utils";
import { address } from "@solana/kit";
import { unwrapEventData } from "../src/arch/svm/utils";
import { BigNumber } from "ethers";

describe("Solana EventData", () => {
  it("should unwrap event data", () => {
    const fill: SvmSpokeClient.FilledRelay = {
      inputToken: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      outputToken: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      inputAmount: BigInt(0),
      outputAmount: BigInt(0),
      repaymentChainId: BigInt(0),
      originChainId: BigInt(0),
      depositId: new Uint8Array([1]),
      fillDeadline: 0,
      exclusivityDeadline: 0,
      exclusiveRelayer: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      relayer: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      depositor: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      recipient: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      messageHash: new Uint8Array([1]),
      relayExecutionInfo: {
        updatedRecipient: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        updatedMessageHash: new Uint8Array([1]),
        updatedOutputAmount: BigInt(0),
        fillType: 0,
      },
    };

    const expectedUnwrapped = {
      inputToken: "0x054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa8404105448d",
      outputToken: "0x054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa8404105448d",
      inputAmount: BigNumber.from(0),
      outputAmount: BigNumber.from(0),
      repaymentChainId: 0,
      originChainId: 0,
      depositId: BigNumber.from(1),
      fillDeadline: 0,
      exclusivityDeadline: 0,
      exclusiveRelayer: "0x054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa8404105448d",
      relayer: "0x054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa8404105448d",
      depositor: "0x054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa8404105448d",
      recipient: "0x054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa8404105448d",
      messageHash: "0x01",
      relayExecutionInfo: {
        updatedRecipient: "0x054a535a992921064d24e87160da387c7c35b5ddbc92bb81e41fa8404105448d",
        updatedMessageHash: "0x01",
        updatedOutputAmount: BigNumber.from(0),
        fillType: 0,
      },
    };

    expect(unwrapEventData(fill)).to.deep.equal(expectedUnwrapped);
  });
});
