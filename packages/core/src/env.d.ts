// `@liminal-lv/core` targets plain ES2023 with no `lib.dom` and no `@types/node` — its
// tsconfig sets `"types": []` so that a stray `window` or `Buffer` is a compile error rather
// than something that only fails once someone runs the package on the other host.
//
// `TextDecoder` is the single global it does need. It is a WHATWG Encoding API global,
// present in every browser and in Node since v11, so declaring exactly the slice used here
// is more honest than pulling in a whole `lib` for it.

declare class TextDecoder {
  constructor(label?: string);
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
