import { SpokePoolClient } from "../clients";

export type MakeOptional<Type, Key extends keyof Type> = Omit<Type, Key> & Partial<Pick<Type, Key>>;

export type AnyObject = Record<string, unknown>;

export type SpokePoolClients = Record<number, SpokePoolClient>;

export type Reviver = (key: string, value: unknown) => unknown;
