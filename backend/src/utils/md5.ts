const shiftAmounts = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

const constants = Array.from({ length: 64 }, (_, index) =>
  Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0
);

export function md5Hex(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  const padded = createPaddedMessage(bytes);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = readWords(padded, offset);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let index = 0; index < 64; index += 1) {
      const { value, wordIndex } = roundValue(index, b, c, d);
      const next = d;
      d = c;
      c = b;
      b = (b + leftRotate((a + value + constants[index]! + words[wordIndex]!) >>> 0, shiftAmounts[index]!)) >>> 0;
      a = next;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return [a0, b0, c0, d0].map(wordToLittleEndianHex).join("");
}

function createPaddedMessage(bytes: Uint8Array): Uint8Array {
  const lengthWithMarker = bytes.length + 1;
  const zeroPaddingLength =
    lengthWithMarker % 64 <= 56
      ? 56 - (lengthWithMarker % 64)
      : 120 - (lengthWithMarker % 64);
  const padded = new Uint8Array(lengthWithMarker + zeroPaddingLength + 8);
  const bitLength = bytes.length * 8;

  padded.set(bytes);
  padded[bytes.length] = 0x80;

  for (let index = 0; index < 8; index += 1) {
    padded[padded.length - 8 + index] = Math.floor(bitLength / 2 ** (8 * index)) & 0xff;
  }

  return padded;
}

function readWords(bytes: Uint8Array, offset: number): number[] {
  const words: number[] = [];

  for (let index = 0; index < 16; index += 1) {
    const wordOffset = offset + index * 4;
    words[index] =
      (bytes[wordOffset]! |
        (bytes[wordOffset + 1]! << 8) |
        (bytes[wordOffset + 2]! << 16) |
        (bytes[wordOffset + 3]! << 24)) >>>
      0;
  }

  return words;
}

function roundValue(index: number, b: number, c: number, d: number): { value: number; wordIndex: number } {
  if (index < 16) {
    return { value: (b & c) | (~b & d), wordIndex: index };
  }

  if (index < 32) {
    return { value: (d & b) | (~d & c), wordIndex: (5 * index + 1) % 16 };
  }

  if (index < 48) {
    return { value: b ^ c ^ d, wordIndex: (3 * index + 5) % 16 };
  }

  return { value: c ^ (b | ~d), wordIndex: (7 * index) % 16 };
}

function leftRotate(value: number, amount: number): number {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

function wordToLittleEndianHex(word: number): string {
  let result = "";

  for (let index = 0; index < 4; index += 1) {
    result += ((word >>> (index * 8)) & 0xff).toString(16).padStart(2, "0");
  }

  return result;
}
