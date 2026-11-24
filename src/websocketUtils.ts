import assert from "node:assert";
import { Buffer } from "node:buffer";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { readExactly } from "./utils.js";

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

export type WebsocketFrame = {
	FIN: 0 | 1;
	RSV1: 0 | 1;
	RSV2: 0 | 1;
	RSV3: 0 | 1;
	opcode: OPCODE;
	payloadLength: bigint;
	/**
	 * wire 上的原樣：`mask === 1` 時是 masked，
	 * 需要明文時，用 {@link maskPayloadData} 搭配 `maskingKey` 還原（XOR 對稱）
	 */
	payloadData: Buffer;
	raw: Buffer;
} & (
	| { mask: 0; maskingKey?: undefined }
	| { mask: 1; maskingKey: Buffer } 
);

/**
 * 呼叫前，須確保 socket 沒有註冊其他 "readable" 或 "data" event
 *
 * 只讀一個 Websocket Frame 就停止
 *
 * `payloadLength` 超過 1 GiB 時會 reject（上限由 {@link readExactly} 決定）
 */
async function readWebsocketFrame (socket: Socket | TLSSocket): Promise<WebsocketFrame> {
    // 1. FIN, RSV1~3, opcode, MASK, Payload len (7 bits)
    const firstTwoBytes = await readExactly({
        socket,
        byteCount: 2,
        label: "frame header",
    });
    const firstByte = firstTwoBytes[0] as number;
    const secondByte = firstTwoBytes[1] as number;
    const FIN = ((firstByte >> 7) & 1) as 0 | 1;
    const RSV1 = ((firstByte >> 6) & 1) as 0 | 1;
    const RSV2 = ((firstByte >> 5) & 1) as 0 | 1;
    const RSV3 = ((firstByte >> 4) & 1) as 0 | 1;
    const opcode = (firstByte & 0x0f) as OPCODE;
    const mask = ((secondByte >> 7) & 1) as 0 | 1;
    const payloadLength7Bits = secondByte & 0x7f;

    const extendedPayloadLengthByteCount = (() => {
        if (payloadLength7Bits === 126) return 2;
        if (payloadLength7Bits === 127) return 8;
        return 0;
    })();
    const extendedPayloadLengthBytes = await readExactly({
        socket,
        byteCount: extendedPayloadLengthByteCount,
        label: "extended payload length",
    });
    const payloadLength = (() => {
        if (extendedPayloadLengthByteCount === 2) {
            return BigInt(extendedPayloadLengthBytes.readUInt16BE());
        }
        if (extendedPayloadLengthByteCount === 8) {
            return extendedPayloadLengthBytes.readBigUInt64BE();
        }
        return BigInt(payloadLength7Bits);
    })();

    // 3. Masking key (0 或 4 bytes)
    const maskingKeyBytes = await readExactly({
        socket,
        byteCount: mask === 1 ? 4 : 0,
        label: "masking key",
    });

    // 4. Payload data（wire 上的原樣，mask === 1 時是 masked）
    const wirePayloadData = await readExactly({
        socket,
        byteCount: Number(payloadLength),
        label: "frame payload",
    });

    const base = {
        FIN,
        RSV1,
        RSV2,
        RSV3,
        opcode,
        payloadLength,
        raw: Buffer.concat([
            firstTwoBytes,
            extendedPayloadLengthBytes,
            maskingKeyBytes,
            wirePayloadData,
        ]),
    };
    if (mask === 1) {
        return {
            ...base,
            mask,
            maskingKey: maskingKeyBytes,
            payloadData: wirePayloadData,
        };
    }
    return { ...base, mask, payloadData: wirePayloadData };
}

export {
    OPCODES,
    getWebsocketFrame,
    calMaskAndPayloadLengthBytes,
    maskPayloadData,
    readWebsocketFrame,
}