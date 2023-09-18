import { HubPool, HubPool__factory, HubPoolInterface } from "../typechain";

import { providers, utils as ethersUtils, Signer } from "ethers";
import { Balances, SerializableEvent } from "./utils";

export type Instance = HubPool;
export const Factory = HubPool__factory;
export type Interface = HubPoolInterface;

export function connect(address: string, provider: providers.Provider | Signer): Instance {
  return Factory.connect(address, provider as Signer);
}

export type TokenEventState = {
  tokenBalances: Balances;
  lpTokenBalances: Balances;
  l1Token?: string;
  lpToken?: string;
  enabled?: boolean;
};
export type EventState = Record<string, TokenEventState>;

export function eventStateDefaults(): EventState {
  return {};
}
function tokenEventStateDefaults(): TokenEventState {
  return {
    tokenBalances: {},
    lpTokenBalances: {},
  };
}

function reduceEvents(state: EventState, event: SerializableEvent): EventState {
  const hubPoolInterface = new ethersUtils.Interface(Factory.abi);

  const eventName = event.event ?? "unknown";
  const { args } = hubPoolInterface.parseLog(event);
  const { l1Token } = args;
  const tokenEventState = state[l1Token] || tokenEventStateDefaults();
  const tokens = Balances(tokenEventState.tokenBalances);
  const lpTokens = Balances(tokenEventState.lpTokenBalances);

  switch (eventName) {
    case "LiquidityAdded":
    case "LiquidityRemoved": {
      const { amount, liquidityProvider } = args;
      tokens.add(liquidityProvider, amount.toString());
      if (event.event === "LiquidityAdded") {
        lpTokens.add(liquidityProvider, args.lpTokensMinted.toString());
      } else {
        lpTokens.sub(liquidityProvider, args.lpTokensBurnt.toString());
      }

      return {
        ...state,
        [l1Token]: {
          ...tokenEventState,
          l1Token,
          tokenBalances: {
            ...tokens.balances,
          },
          lpTokenBalances: {
            ...lpTokens.balances,
          },
        },
      };
    }

    case "L1TokenEnabledForLiquidityProvision":
    case "L2TokenDisabledForLiquidityProvision": {
      const { lpToken } = args;
      const enabled = event.event === "L1TokenEnabledForLiquidityProvision";
      return {
        ...state,
        [l1Token]: {
          ...tokenEventState,
          lpToken,
          l1Token,
          enabled,
        },
      };
    }
  }

  return state;
}
export function getEventState(events: SerializableEvent[], eventState: EventState = eventStateDefaults()): EventState {
  return events.reduce(reduceEvents, eventState);
}
