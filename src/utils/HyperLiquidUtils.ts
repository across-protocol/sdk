import * as hl from "@nktkas/hyperliquid";

export function getDefaultHlTransport(extraOptions: ConstructorParameters<typeof hl.HttpTransport> = []) {
  return new hl.HttpTransport(...extraOptions);
}

export function getHlInfoClient(transport: hl.HttpTransport | hl.WebSocketTransport = getDefaultHlTransport()) {
  return new hl.InfoClient({ transport });
}

export async function isHlAccountActive(account: string): Promise<boolean> {
  const client = getHlInfoClient();
  const userRole = await client.userRole({ user: account });
  return userRole.role !== "missing";
}
