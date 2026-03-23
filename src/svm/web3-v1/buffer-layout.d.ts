declare module "buffer-layout" {
  export class Layout<T = any> {
    span: number;
    property?: string;
    decode(b: Buffer, offset?: number): T;
    encode(src: T, b: Buffer, offset?: number): number;
    getSpan(b?: Buffer, offset?: number): number;
    replicate(name: string): this;
  }
}
