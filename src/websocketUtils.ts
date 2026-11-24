import assert from "node:assert";
import { Buffer } from "node:buffer";

const OPCODES = {
    continuation: 0x00,
    text: 0x01,
    binary: 0x02,

    // 0x03 - 0x07 reserved for further non-control frames
    reserved0x03: 0x03,
    reserved0x04: 0x04,
    reserved0x05: 0x05,
    reserved0x06: 0x06,
    reserved0x07: 0x07,

    close: 0x08,
    ping: 0x09,
    pong: 0x0a,

    // 0x0b - 0x0f reserved for further control frames
    reserved0x0b: 0x0b,
    reserved0x0c: 0x0c,
    reserved0x0d: 0x0d,
    reserved0x0e: 0x0e,
    reserved0x0f: 0x0f,
} as const

type OPCODE = typeof OPCODES[keyof typeof OPCODES];

/**
 * 這個函式只負責組裝 websocket frame：
 * 
 * - 不會 mask `payloadData`，呼叫端要自己用 {@link maskPayloadData} 處理
 * 
 * - 不會檢查 `maskingKey`, `maskAndPayloadLengthBytes` 跟 `payloadData` 的 masking 是否一致
 * 
 * - 不會檢查 `maskAndPayloadLengthBytes` 是否合法
 * 
 * - 不會檢查 `maskAndPayloadLengthBytes` 的長度是否等於 `payloadData` 的長度
 * 
 * 因此可以產生違反 RFC 的 frame，用於 negative test
 */
function getWebsocketFrame (params: {
    FIN: 0 | 1;
    RSV1: 0 | 1;
    RSV2: 0 | 1;
    RSV3: 0 | 1;
    opcode: OPCODE;
    maskingKey?: Buffer;
    maskAndPayloadLengthBytes: Buffer;
    payloadData: Buffer;
}): Buffer {
    const {
        FIN,
        RSV1,
        RSV2,
        RSV3,
        opcode,
        maskingKey,
        maskAndPayloadLengthBytes,
        payloadData
    } = params;
    const firstByte = Buffer.from([
        (FIN << 7) |
        (RSV1 << 6) |
        (RSV2 << 5) |
        (RSV3 << 4) |
        opcode
    ]);
    return Buffer.concat([
        firstByte,
        maskAndPayloadLengthBytes,
        maskingKey || Buffer.alloc(0),
        payloadData
    ]);
}

function calMaskAndPayloadLengthBytes (params: {
    mask: 0 | 1;
    payloadLength: bigint;
    /**
     * 沒傳 => 照 RFC 6455 的規範走
     * 
     * 有傳 => 可以用來測試 overlong encoding
     */
    extendedPayloadLengthByteCount?: 0 | 2 | 8;
}): Buffer {
    const { mask, payloadLength } = params;
    const bitMask = mask === 0 ? 0x00 : 0x80;
    if (payloadLength < 0) {
        throw new Error("payloadLength must >= 0");
    }
    // 2^64 - 1 (刻意讓 most significant bit 可以為 1)
    if (payloadLength > 18446744073709551615n) {
        throw new Error("payloadLength must <= 18446744073709551615");
    }
    const extendedPayloadLengthByteCount = (() => {
        if (params.extendedPayloadLengthByteCount !== undefined) {
            return params.extendedPayloadLengthByteCount;
        }
        if (payloadLength <= 125) return 0;
        if (payloadLength <= 65535) return 2;
        return 8;
    })();
    if (extendedPayloadLengthByteCount === 0) {
        if (payloadLength > 125) {
            throw new Error("payloadLength must <= 125 for 0 extended bytes");
        }
        return Buffer.from([Number(payloadLength) | bitMask]);
    }
    if (extendedPayloadLengthByteCount === 2) {
        if (payloadLength > 65535) {
            throw new Error("payloadLength must <= 65535 for 2 extended bytes");
        }
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(Number(payloadLength));
        return Buffer.concat([Buffer.from([126 | bitMask]), buf]);
    }
    assert(extendedPayloadLengthByteCount === 8);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(payloadLength);
    return Buffer.concat([Buffer.from([127 | bitMask]), buf]);
}

function maskPayloadData (params: {
    maskingKey: Buffer;
    payloadData: Buffer;
}): Buffer {
    const { maskingKey, payloadData } = params;
    if (maskingKey.byteLength !== 4) throw new Error("maskingKey.byteLength should be 4");
    const maskedPayloadData = Buffer.alloc(payloadData.byteLength);
    payloadData.forEach((byte, index) => {
        const selectedMaskingByte = maskingKey[index % 4] as number;
        maskedPayloadData[index] = byte ^ selectedMaskingByte;
    })
    return maskedPayloadData;
}

export {
    OPCODES,
    getWebsocketFrame,
    calMaskAndPayloadLengthBytes,
    maskPayloadData
}