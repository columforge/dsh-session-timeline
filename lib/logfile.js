/**
 * Session log file layout (pure: buffer in, text out; no plugin deps).
 *
 * A log is a concatenation of zstd frames — the harness writes the header
 * line as its own frame and one checksummed frame per flush — and it is
 * append-only. That gives two cheap entry points beside the full decode:
 * the first frame (session header fields) and the last complete frame (last
 * activity), read from both ends of the file without touching the middle.
 * Torn trailing frames (a flush in progress) are ignored everywhere.
 */
import { zstdDecompressSync } from 'node:zlib';
export const ZSTD_MAGIC = 0xFD2FB528;
const MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Decoded frame descriptor (zstd RFC §3.1.1): the variable header field byte
 *  counts and the checksum flag. Pure bit decoding, no bounds checks. */
function decodeFrameDescriptor(descriptor) {
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    return { windowDescriptorByte: singleSegment ? 0 : 1, dictionaryBytes, contentSizeBytes, checksum };
}
/** Parse the frame header at `offset` (magic, frame descriptor, optional
 *  window/dictionary/content-size fields). Null = invalid or header-truncated
 *  (reserved bits set, not enough bytes) — the caller stops at this frame. */
function readFrameHeader(buffer, offset) {
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC)
        return null;
    offset += 4;
    if (offset >= buffer.length)
        return null;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0)
        return null;
    const fields = decodeFrameDescriptor(descriptor);
    const remainingHeaderBytes = fields.windowDescriptorByte + fields.dictionaryBytes + fields.contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes)
        return null;
    return { end: offset + remainingHeaderBytes, checksum: fields.checksum };
}
/** Walk 3-byte block headers from `offset` to the frame's last block.
 *  `torn` = the frame is cut short or carries a reserved block type —
 *  the caller stops at this frame (offset is then meaningless). */
function walkBlocks(buffer, offset) {
    for (;;) {
        if (buffer.length - offset < 3)
            return { end: offset, torn: true };
        const blockHeader = buffer.readUIntLE(offset, 3);
        offset += 3;
        const lastBlock = (blockHeader & 1) !== 0;
        const blockType = (blockHeader >>> 1) & 0x03;
        const blockSize = blockHeader >>> 3;
        if (blockType === 0x03)
            return { end: offset, torn: true };
        const payloadBytes = blockType === 0x01 ? 1 : blockSize;
        if (buffer.length - offset < payloadBytes)
            return { end: offset, torn: true };
        offset += payloadBytes;
        if (lastBlock)
            return { end: offset, torn: false };
    }
}
/** Tolerant frame scan (same semantics as harness session-persistence-jsonl):
 *  ranges of every complete frame from offset 0; stops at the first invalid /
 *  header-truncated frame or torn block walk. Frames are contiguous, so the
 *  last range's end is also the end of the decodable prefix. */
export function scanZstdFrames(buffer) {
    const frames = [];
    let offset = 0;
    while (offset < buffer.length) {
        const start = offset;
        const header = readFrameHeader(buffer, offset);
        if (header === null)
            break;
        const blocks = walkBlocks(buffer, header.end);
        if (blocks.torn)
            break;
        offset = blocks.end;
        if (header.checksum) {
            if (buffer.length - offset < 4)
                break;
            offset += 4;
        }
        frames.push({ start, end: offset });
    }
    return frames;
}
/** End of the last complete frame = length of the decodable prefix (0 = none). */
export function completeEnd(buffer) {
    const frames = scanZstdFrames(buffer);
    return frames.length === 0 ? 0 : frames[frames.length - 1].end;
}
/** Decode the complete frames of `buffer` to UTF-8 text (one call over the
 *  contiguous prefix — same output as decoding the frames one by one).
 *  Null = no complete frame, or a frame fails to decode. */
export function decodeLog(buffer) {
    const end = completeEnd(buffer);
    if (end === 0)
        return null;
    try {
        return zstdDecompressSync(buffer.subarray(0, end)).toString('utf8');
    }
    catch {
        return null;
    }
}
/** Text of the first complete frame of a file prefix (`head` starts at offset
 *  0). Null = the first frame is absent or not inside `head` yet. */
export function firstFrameText(head) {
    const frames = scanZstdFrames(head);
    if (frames.length === 0)
        return null;
    try {
        return zstdDecompressSync(head.subarray(0, frames[0].end)).toString('utf8');
    }
    catch {
        return null;
    }
}
/** Text of the last complete frame of a file whose final bytes are `tail`
 *  (`tail` ends at the end of file). Null = that frame does not start inside
 *  `tail` (the caller widens the window) or fails to decode. The frame start
 *  is searched backward by magic; a candidate counts only when its frame ends
 *  exactly at the file end, so earlier frames and false magics are skipped. */
/** Decoded text of the frame that starts at `at` when it is complete and ends
 *  exactly where `tail` ends; null for a torn frame, a frame with bytes after
 *  it, or a false magic. */
function frameEndingAt(tail, at) {
    const header = readFrameHeader(tail, at);
    if (header === null)
        return null;
    const blocks = walkBlocks(tail, header.end);
    if (blocks.torn)
        return null;
    let end = blocks.end;
    if (header.checksum) {
        if (tail.length - end < 4)
            return null;
        end += 4;
    }
    if (end !== tail.length)
        return null;
    try {
        return zstdDecompressSync(tail.subarray(at, end)).toString('utf8');
    }
    catch {
        return null; // a false magic that happened to parse: keep searching
    }
}
export function lastFrameText(tail) {
    // the search index must strictly decrease: a negative offset would wrap around
    for (let at = tail.lastIndexOf(MAGIC_BYTES); at >= 0; at = at === 0 ? -1 : tail.lastIndexOf(MAGIC_BYTES, at - 1)) {
        const text = frameEndingAt(tail, at);
        if (text !== null)
            return text;
    }
    return null;
}
//# sourceMappingURL=logfile.js.map