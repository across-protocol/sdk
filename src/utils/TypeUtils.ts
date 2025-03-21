import { SpokePoolClient } from "../clients";
import { CrosschainProvider } from "../providers";

export type MakeOptional<Type, Key extends keyof Type> = Omit<Type, Key> & Partial<Pick<Type, Key>>;

export type AnyObject = Record<string, unknown>;

export type SpokePoolClients<P extends CrosschainProvider> = Record<number, SpokePoolClient<P>>;

export type Reviver = (key: string, value: unknown) => unknown;
