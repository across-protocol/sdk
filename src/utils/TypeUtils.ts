import { AcrossConfigStoreClient, HubPoolClient } from "../clients";

export type MakeOptional<Type, Key extends keyof Type> = Omit<Type, Key> & Partial<Pick<Type, Key>>;

export type AnyObject = Record<string, unknown>;

export type Clients = {
  hubPoolClient: HubPoolClient;
  configStoreClient: AcrossConfigStoreClient;
};
