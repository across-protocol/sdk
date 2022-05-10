import { HubPool, HubPool__factory, HubPoolInterface } from "@across-protocol/contracts-v2";

import type { SignerOrProvider, GetEventType, SerializableEvent } from "@uma/sdk";
import * as uma from "@uma/sdk";
const { Balances } = uma.utils;

export type Instance = HubPool;
export const Factory = HubPool__factory;
export type Interface = HubPoolInterface;

export function connect(address: string, provider: SignerOrProvider): Instance {
  return Factory.connect(address, provider);
}

export type LiquidityAdded = GetEventType<Instance, "LiquidityAdded">;
export type LiquidityRemoved = GetEventType<Instance, "LiquidityRemoved">;
export type L1TokenEnabledForLiquidityProvision = GetEventType<Instance, "L1TokenEnabledForLiquidityProvision">;
export type L2TokenDisabledForLiquidityProvision = GetEventType<Instance, "L2TokenDisabledForLiquidityProvision">;

export type TokenEventState = {
  tokenBalances: uma.utils.Balances;
  lpTokenBalances: uma.utils.Balances;
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

export function reduceEvents(state: EventState, event: SerializableEvent): EventState {
  switch (event.event) {
    case "LiquidityAdded": {
      const typedEvent = event as LiquidityAdded;
      const { amount, lpTokensMinted, liquidityProvider, l1Token } = typedEvent.args;
      const tokenEventState = state[l1Token] || tokenEventStateDefaults();
      const tokens = Balances(tokenEventState.tokenBalances);
      const lpTokens = Balances(tokenEventState.lpTokenBalances);
      tokens.add(liquidityProvider, amount.toString());
      lpTokens.add(liquidityProvider, lpTokensMinted.toString());

      const tokenState = {
        ...tokenEventState,
        l1Token,
        tokenBalances: {
          ...tokens.balances,
        },
        lpTokenBalances: {
          ...lpTokens.balances,
        },
      };

      return {
        ...state,
        [l1Token]: tokenState,
      };
    }
    case "LiquidityRemoved": {
      const typedEvent = event as LiquidityRemoved;
      const { amount, lpTokensBurnt, liquidityProvider, l1Token } = typedEvent.args;
      const tokenEventState = state[l1Token] || tokenEventStateDefaults();
      const tokens = Balances(tokenEventState.tokenBalances);
      const lpTokens = Balances(tokenEventState.lpTokenBalances);
      tokens.sub(liquidityProvider, amount.toString());
      lpTokens.sub(liquidityProvider, lpTokensBurnt.toString());

      const tokenState = {
        ...tokenEventState,
        l1Token,
        tokenBalances: {
          ...tokens.balances,
        },
        lpTokenBalances: {
          ...lpTokens.balances,
        },
      };

      return {
        ...state,
        [l1Token]: tokenState,
      };
    }
    case "L1TokenEnabledForLiquidityProvision": {
      const typedEvent = event as L1TokenEnabledForLiquidityProvision;
      const { l1Token, lpToken } = typedEvent.args;
      const tokenEventState = state[l1Token] || tokenEventStateDefaults();
      return {
        ...state,
        [l1Token]: {
          ...tokenEventState,
          lpToken,
          l1Token,
          enabled: true,
        },
      };
    }
    case "L2TokenDisabledForLiquidityProvision": {
      const typedEvent = event as L2TokenDisabledForLiquidityProvision;
      const { l1Token, lpToken } = typedEvent.args;
      const tokenEventState = state[l1Token] || tokenEventStateDefaults();
      return {
        ...state,
        [l1Token]: {
          ...tokenEventState,
          lpToken,
          l1Token,
          enabled: false,
        },
      };
    }
  }
  return state;
}
export function getEventState(events: SerializableEvent[], eventState: EventState = eventStateDefaults()): EventState {
  return events.reduce(reduceEvents, eventState);
}
