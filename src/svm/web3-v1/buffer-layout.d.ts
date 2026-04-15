declare module "buffer-layout" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class Layout<T = any> {
    span: number;
    property?: string;
    decode(b: Buffer, offset?: number): T;
    encode(src: T, b: Buffer, offset?: number): number;
    getSpan(b?: Buffer, offset?: number): number;
    replicate(name: string): this;
  }
}
