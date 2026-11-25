export declare const ZSTD_MAGIC = 4247762216;
/** Byte range of one complete frame. */
export interface FrameRange {
    start: number;
    end: number;
}
/** Frame header parse result: where the block area starts + whether the frame
 *  carries a 4-byte checksum after its last block. */
export interface FrameHeader {
    end: number;
    checksum: boolean;
}
/** Tolerant frame scan (same semantics as harness session-persistence-jsonl):
 *  ranges of every complete frame from offset 0; stops at the first invalid /
 *  header-truncated frame or torn block walk. Frames are contiguous, so the
 *  last range's end is also the end of the decodable prefix. */
export declare function scanZstdFrames(buffer: Buffer): FrameRange[];
/** End of the last complete frame = length of the decodable prefix (0 = none). */
export declare function completeEnd(buffer: Buffer): number;
/** Decode the complete frames of `buffer` to UTF-8 text (one call over the
 *  contiguous prefix — same output as decoding the frames one by one).
 *  Null = no complete frame, or a frame fails to decode. */
export declare function decodeLog(buffer: Buffer): string | null;
/** Text of the first complete frame of a file prefix (`head` starts at offset
 *  0). Null = the first frame is absent or not inside `head` yet. */
export declare function firstFrameText(head: Buffer): string | null;
export declare function lastFrameText(tail: Buffer): string | null;
