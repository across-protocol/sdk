// Lowest ConfigStore version where the UBA model is in effect.
export const UBA_MIN_CONFIG_STORE_VERSION = 20;

export function isUBA(version: number): boolean {
  return version >= UBA_MIN_CONFIG_STORE_VERSION;
}
