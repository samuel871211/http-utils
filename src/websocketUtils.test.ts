import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OPCODES,
  calMaskAndPayloadLengthBytes,
  getWebsocketFrame,
  maskPayloadData,
} from "./websocketUtils.js";

const MAX_UINT64 = 2n ** 64n - 1n;

describe("calMaskAndPayloadLengthBytes", () => {
  describe("沒傳 extendedPayloadLengthByteCount（照 RFC 6455 Section 5.2 選最短編碼）", () => {
    it("payloadLength = 0", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: 0n,
      });
      assert.deepEqual(actual, Buffer.from([0x00]));
    });

    it("payloadLength = 125（7-bit 的上限）", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: 125n,
      });
      assert.deepEqual(actual, Buffer.from([0x7d]));
    });

    it("payloadLength = 126（16-bit 的下限）", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: 126n,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x7e,       // Payload len = 126
        0x00, 0x7e, // Extended payload length (16-bit)
      ]));
    });

    it("payloadLength = 65535（16-bit 的上限）", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: 65535n,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x7e,       // Payload len = 126
        0xff, 0xff, // Extended payload length (16-bit)
      ]));
    });

    it("payloadLength = 65536（64-bit 的下限）", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: 65536n,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x7f,                                           // Payload len = 127
        0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, // Extended payload length (64-bit)
      ]));
    });

    it("payloadLength = 2^64 - 1（刻意讓 most significant bit 為 1）", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: MAX_UINT64,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x7f,                                           // Payload len = 127
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // Extended payload length (64-bit)
      ]));
    });

    it("payloadLength = 2^63（most significant bit 為 1 的最小值）", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: 2n ** 63n,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x7f,                                           // Payload len = 127
        0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Extended payload length (64-bit)
      ]));
    });
  });

  describe("mask = 1（byte 0 的最高位為 MASK bit）", () => {
    it("7-bit", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 1,
        payloadLength: 5n,
      });
      assert.deepEqual(actual, Buffer.from([0x85]));
    });

    it("payloadLength = 125", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 1,
        payloadLength: 125n,
      });
      assert.deepEqual(actual, Buffer.from([0xfd]));
    });

    it("16-bit", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 1,
        payloadLength: 126n,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0xfe,       // MASK = 1 + Payload len = 126
        0x00, 0x7e, // Extended payload length (16-bit)
      ]));
    });

    it("64-bit", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 1,
        payloadLength: 65536n,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0xff,                                           // MASK = 1 + Payload len = 127
        0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, // Extended payload length (64-bit)
      ]));
    });

    it("payloadLength = 2^64 - 1（most significant bit 為 1）", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 1,
        payloadLength: MAX_UINT64,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0xff,                                           // MASK = 1 + Payload len = 127
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // Extended payload length (64-bit)
      ]));
    });
  });

  describe("有傳 extendedPayloadLengthByteCount（overlong encoding）", () => {
    it("payloadLength = 5，用 0 bytes（等同最短編碼）", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: 5n,
        extendedPayloadLengthByteCount: 0,
      });
      assert.deepEqual(actual, Buffer.from([0x05]));
    });

    it("payloadLength = 5，用 2 bytes", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: 5n,
        extendedPayloadLengthByteCount: 2,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x7e,       // Payload len = 126
        0x00, 0x05, // Extended payload length (16-bit)
      ]));
    });

    it("payloadLength = 5，用 8 bytes", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: 5n,
        extendedPayloadLengthByteCount: 8,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x7f,                                           // Payload len = 127
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, // Extended payload length (64-bit)
      ]));
    });

    it("payloadLength = 125（7-bit 的上限），用 2 bytes", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: 125n,
        extendedPayloadLengthByteCount: 2,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x7e,       // Payload len = 126
        0x00, 0x7d, // Extended payload length (16-bit)
      ]));
    });

    it("payloadLength = 65535（16-bit 的上限），用 8 bytes", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: 65535n,
        extendedPayloadLengthByteCount: 8,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x7f,                                           // Payload len = 127
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, // Extended payload length (64-bit)
      ]));
    });

    it("payloadLength = 125（7-bit 的上限），用 0 bytes（等同最短編碼）", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: 125n,
        extendedPayloadLengthByteCount: 0,
      });
      assert.deepEqual(actual, Buffer.from([0x7d]));
    });

    it("payloadLength = 125（7-bit 的上限），用 8 bytes", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: 125n,
        extendedPayloadLengthByteCount: 8,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x7f,                                           // Payload len = 127
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7d, // Extended payload length (64-bit)
      ]));
    });

    it("payloadLength = 65535（16-bit 的上限），用 2 bytes（等同最短編碼）", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 0,
        payloadLength: 65535n,
        extendedPayloadLengthByteCount: 2,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x7e,       // Payload len = 126
        0xff, 0xff, // Extended payload length (16-bit)
      ]));
    });

    it("mask = 1，payloadLength = 5，用 2 bytes", () => {
      const actual = calMaskAndPayloadLengthBytes({
        mask: 1,
        payloadLength: 5n,
        extendedPayloadLengthByteCount: 2,
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0xfe,       // MASK = 1 + Payload len = 126
        0x00, 0x05, // Extended payload length (16-bit)
      ]));
    });
  });

  describe("payloadLength 超出範圍", () => {
    it("payloadLength < 0", () => {
      assert.throws(
        () => calMaskAndPayloadLengthBytes({ mask: 0, payloadLength: -1n }),
        /payloadLength must >= 0/,
      );
    });

    it("payloadLength = 2^64", () => {
      assert.throws(
        () =>
          calMaskAndPayloadLengthBytes({
            mask: 0,
            payloadLength: MAX_UINT64 + 1n,
          }),
        /payloadLength must <= 18446744073709551615/,
      );
    });
  });

  describe("payloadLength 放不進指定的 extendedPayloadLengthByteCount（too short）", () => {
    it("payloadLength = 126，用 0 bytes", () => {
      assert.throws(
        () =>
          calMaskAndPayloadLengthBytes({
            mask: 0,
            payloadLength: 126n,
            extendedPayloadLengthByteCount: 0,
          }),
        /payloadLength must <= 125 for 0 extended bytes/,
      );
    });

    it("payloadLength = 65535，用 0 bytes", () => {
      assert.throws(
        () =>
          calMaskAndPayloadLengthBytes({
            mask: 0,
            payloadLength: 65535n,
            extendedPayloadLengthByteCount: 0,
          }),
        /payloadLength must <= 125 for 0 extended bytes/,
      );
    });

    it("payloadLength = 65536，用 2 bytes", () => {
      assert.throws(
        () =>
          calMaskAndPayloadLengthBytes({
            mask: 0,
            payloadLength: 65536n,
            extendedPayloadLengthByteCount: 2,
          }),
        /payloadLength must <= 65535 for 2 extended bytes/,
      );
    });
  });
});

describe("maskPayloadData", () => {
  // RFC 6455 Section 5.7：masked single-frame "Hello"
  const maskingKey = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
  const hello = Buffer.from("Hello");
  // prettier-ignore
  const maskedHello = Buffer.from([0x7f, 0x9f, 0x4d, 0x51, 0x58]);

  it("符合 RFC 6455 Section 5.7 的範例", () => {
    const actual = maskPayloadData({ maskingKey, payloadData: hello });
    assert.deepEqual(actual, maskedHello);
  });

  it("mask 兩次會還原成原資料", () => {
    const once = maskPayloadData({ maskingKey, payloadData: hello });
    const twice = maskPayloadData({ maskingKey, payloadData: once });
    assert.deepEqual(twice, hello);
  });

  it("長度不是 4 的倍數時，masking key 依 index % 4 循環使用", () => {
    // prettier-ignore
    const payloadData = Buffer.from([
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00,
    ]);
    // payload 全為 0，XOR 的結果就是 masking key 重複出現
    // prettier-ignore
    const expected = Buffer.from([
      0x37, 0xfa, 0x21, 0x3d,
      0x37, 0xfa, 0x21, 0x3d,
      0x37,
    ]);
    assert.deepEqual(maskPayloadData({ maskingKey, payloadData }), expected);
  });

  it("masking key 的 byte 為 0xff（XOR 等同 bitwise NOT）", () => {
    const actual = maskPayloadData({
      maskingKey: Buffer.from([0xff, 0xff, 0xff, 0xff]),
      payloadData: Buffer.from([0x00, 0x0f, 0xf0, 0xff]),
    });
    assert.deepEqual(actual, Buffer.from([0xff, 0xf0, 0x0f, 0x00]));
  });

  it("masking key 全為 0（payload 不變）", () => {
    const actual = maskPayloadData({
      maskingKey: Buffer.alloc(4),
      payloadData: hello,
    });
    assert.deepEqual(actual, hello);
  });

  it("payload 為空", () => {
    const actual = maskPayloadData({
      maskingKey,
      payloadData: Buffer.alloc(0),
    });
    assert.deepEqual(actual, Buffer.alloc(0));
  });

  it("不會修改傳入的 payloadData", () => {
    const payloadData = Buffer.from("Hello");
    maskPayloadData({ maskingKey, payloadData });
    assert.deepEqual(payloadData, hello);
  });

  it("masking key 不是 4 bytes 會 throw", () => {
    for (const length of [0, 3, 5]) {
      assert.throws(
        () =>
          maskPayloadData({
            maskingKey: Buffer.alloc(length),
            payloadData: hello,
          }),
        /maskingKey.byteLength should be 4/,
      );
    }
  });
});

describe("getWebsocketFrame", () => {
  const noPayload = Buffer.alloc(0);
  const zeroLength = Buffer.from([0x00]);

  describe("RFC 6455 Section 5.7 的範例", () => {
    it("unmasked single-frame text message", () => {
      const actual = getWebsocketFrame({
        FIN: 1,
        RSV1: 0,
        RSV2: 0,
        RSV3: 0,
        opcode: OPCODES.text,
        maskAndPayloadLengthBytes: calMaskAndPayloadLengthBytes({
          mask: 0,
          payloadLength: 5n,
        }),
        payloadData: Buffer.from("Hello"),
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x81,                         // FIN = 1 + opcode = text
        0x05,                         // MASK = 0 + Payload len = 5
        0x48, 0x65, 0x6c, 0x6c, 0x6f, // "Hello"
      ]));
    });

    it("masked single-frame text message", () => {
      const maskingKey = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
      const actual = getWebsocketFrame({
        FIN: 1,
        RSV1: 0,
        RSV2: 0,
        RSV3: 0,
        opcode: OPCODES.text,
        maskingKey,
        maskAndPayloadLengthBytes: calMaskAndPayloadLengthBytes({
          mask: 1,
          payloadLength: 5n,
        }),
        payloadData: maskPayloadData({
          maskingKey,
          payloadData: Buffer.from("Hello"),
        }),
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x81,                         // FIN = 1 + opcode = text
        0x85,                         // MASK = 1 + Payload len = 5
        0x37, 0xfa, 0x21, 0x3d,       // Masking-key
        0x7f, 0x9f, 0x4d, 0x51, 0x58, // Masked "Hello"
      ]));
    });
  });

  describe("byte 0 的 bit 位置", () => {
    const cases = [
      { name: "只有 FIN", FIN: 1, RSV1: 0, RSV2: 0, RSV3: 0, expected: 0x80 },
      { name: "只有 RSV1", FIN: 0, RSV1: 1, RSV2: 0, RSV3: 0, expected: 0x40 },
      { name: "只有 RSV2", FIN: 0, RSV1: 0, RSV2: 1, RSV3: 0, expected: 0x20 },
      { name: "只有 RSV3", FIN: 0, RSV1: 0, RSV2: 0, RSV3: 1, expected: 0x10 },
      { name: "全部為 0", FIN: 0, RSV1: 0, RSV2: 0, RSV3: 0, expected: 0x00 },
      { name: "全部為 1", FIN: 1, RSV1: 1, RSV2: 1, RSV3: 1, expected: 0xf0 },
    ] as const;

    for (const { name, expected, ...bits } of cases) {
      it(`${name}（opcode = continuation）`, () => {
        const actual = getWebsocketFrame({
          ...bits,
          opcode: OPCODES.continuation,
          maskAndPayloadLengthBytes: zeroLength,
          payloadData: noPayload,
        });
        assert.equal(actual.readUInt8(0), expected);
      });
    }

    it("opcode 只佔低 4 bits，不會影響 FIN 與 RSV", () => {
      for (const opcode of Object.values(OPCODES)) {
        const actual = getWebsocketFrame({
          FIN: 0,
          RSV1: 0,
          RSV2: 0,
          RSV3: 0,
          opcode,
          maskAndPayloadLengthBytes: zeroLength,
          payloadData: noPayload,
        });
        assert.equal(actual.readUInt8(0), opcode);
      }
    });
  });

  describe("bytes 的排列順序", () => {
    it("byte 0、mask 與 length、masking key、payload", () => {
      const actual = getWebsocketFrame({
        FIN: 1,
        RSV1: 0,
        RSV2: 0,
        RSV3: 0,
        opcode: OPCODES.binary,
        maskingKey: Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]),
        maskAndPayloadLengthBytes: Buffer.from([0x82]),
        payloadData: Buffer.from([0x01, 0x02]),
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x82,                   // FIN = 1 + opcode = binary
        0x82,                   // MASK = 1 + Payload len = 2
        0xaa, 0xbb, 0xcc, 0xdd, // Masking-key
        0x01, 0x02,             // Payload
      ]));
    });

    it("沒傳 maskingKey 就不會寫入 masking key", () => {
      const actual = getWebsocketFrame({
        FIN: 1,
        RSV1: 0,
        RSV2: 0,
        RSV3: 0,
        opcode: OPCODES.binary,
        maskAndPayloadLengthBytes: Buffer.from([0x02]),
        payloadData: Buffer.from([0x01, 0x02]),
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x82,       // FIN = 1 + opcode = binary
        0x02,       // MASK = 0 + Payload len = 2
        0x01, 0x02, // Payload
      ]));
    });
  });

  describe("不會檢查參數是否一致（用於 negative test）", () => {
    it("MASK = 1 但沒有 masking key", () => {
      const actual = getWebsocketFrame({
        FIN: 1,
        RSV1: 0,
        RSV2: 0,
        RSV3: 0,
        opcode: OPCODES.text,
        maskAndPayloadLengthBytes: Buffer.from([0x81]),
        payloadData: Buffer.from("a"),
      });
      assert.deepEqual(actual, Buffer.from([0x81, 0x81, 0x61]));
    });

    it("MASK = 0 但有 masking key", () => {
      const actual = getWebsocketFrame({
        FIN: 1,
        RSV1: 0,
        RSV2: 0,
        RSV3: 0,
        opcode: OPCODES.text,
        maskingKey: Buffer.from([0x01, 0x02, 0x03, 0x04]),
        maskAndPayloadLengthBytes: Buffer.from([0x01]),
        payloadData: Buffer.from("a"),
      });
      assert.deepEqual(
        actual,
        Buffer.from([0x81, 0x01, 0x01, 0x02, 0x03, 0x04, 0x61]),
      );
    });

    it("宣告的 payload length 與實際的 payload 長度不同", () => {
      const actual = getWebsocketFrame({
        FIN: 1,
        RSV1: 0,
        RSV2: 0,
        RSV3: 0,
        opcode: OPCODES.text,
        maskAndPayloadLengthBytes: calMaskAndPayloadLengthBytes({
          mask: 0,
          payloadLength: 10n,
        }),
        payloadData: Buffer.from("abc"),
      });
      assert.deepEqual(actual, Buffer.from([0x81, 0x0a, 0x61, 0x62, 0x63]));
    });

    it("maskAndPayloadLengthBytes 可以是 overlong encoding", () => {
      const actual = getWebsocketFrame({
        FIN: 1,
        RSV1: 0,
        RSV2: 0,
        RSV3: 0,
        opcode: OPCODES.text,
        maskAndPayloadLengthBytes: calMaskAndPayloadLengthBytes({
          mask: 0,
          payloadLength: 1n,
          extendedPayloadLengthByteCount: 8,
        }),
        payloadData: Buffer.from("a"),
      });
      // prettier-ignore
      assert.deepEqual(actual, Buffer.from([
        0x81,                                           // FIN = 1 + opcode = text
        0x7f,                                           // Payload len = 127
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, // Extended payload length (64-bit)
        0x61,                                           // Payload
      ]));
    });
  });
});
