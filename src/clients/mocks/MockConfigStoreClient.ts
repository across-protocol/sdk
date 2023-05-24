import { DEFAULT_CONFIG_STORE_VERSION } from "../../utils";
import { AcrossConfigStoreClient } from "../AcrossConfigStoreClient";

export class MockConfigStoreClient extends AcrossConfigStoreClient {
  public configStoreVersion = DEFAULT_CONFIG_STORE_VERSION;

  setConfigStoreVersion(version: number): void {
    this.configStoreVersion = version;
  }

  isValidConfigStoreVersion(_version: number): boolean {
    return this.configStoreVersion >= _version;
  }
}
