declare module "mux.js/lib/mp4" {
  interface TransmuxedSegment {
    initSegment?: Uint8Array;
    data: Uint8Array;
  }

  export class Transmuxer {
    setBaseMediaDecodeTime(time: number): void;
    on(event: "data", callback: (data: TransmuxedSegment) => void): void;
    push(data: Uint8Array): void;
    flush(): void;
  }
}
