import Transport from "winston-transport";
import type sinon from "sinon";

// This transport enables unit tests to validate values passed to Winston using a Sinon Spy.

type Spy = sinon.SinonSpy<unknown[]>;

type TransportOptions = ConstructorParameters<typeof Transport>[0];

export class SpyTransport extends Transport {
  private readonly spy: Spy;
  constructor(winstonOptions: TransportOptions, spyOptions: { spy: Spy }) {
    super(winstonOptions);
    this.spy = spyOptions.spy; // local instance of the spy to capture passed messages.
  }

  async log(info: unknown, callback: () => void): Promise<void> {
    // Add info sent to the winston transport to the spy. This enables unit tests to validate what is passed to winston.
    this.spy(info);
    callback();
  }
}
