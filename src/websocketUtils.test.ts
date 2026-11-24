import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  OPCODES,
  calMaskAndPayloadLengthBytes,
  getWebsocketFrame,
  maskPayloadData,
  readWebsocketFrame,
} from "./websocketUtils.js";
import { readUntil } from "./utils.js";

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

describe("readWebsocketFrame", () => {
  const HOST = "127.0.0.1";
  const TEST_TIMEOUT = { timeout: 3000 };
  const noop = () => {};
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  /**
   * 建立一個 server，client 連上之後由 `onConnection` 決定 server 端要怎麼寫入。
   * 回傳 client socket，測試結束後會自動清理。
   */
  async function connect(onConnection: (serverSocket: net.Socket) => void) {
    const server = net.createServer((serverSocket) => {
      serverSocket.on("error", noop);
      serverSocket.setNoDelay(true);
      onConnection(serverSocket);
    });
    await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
    const { port } = server.address() as net.AddressInfo;
    const socket = net.connect({ host: HOST, port });
    socket.on("error", noop);
    cleanups.push(() => {
      socket.destroy();
      server.close();
    });
    return socket;
  }

  /**
   * 組出完整的 wire bytes（有 maskingKey 時會自動 mask payload）
   */
  function buildFrame(params: {
    FIN?: 0 | 1;
    RSV1?: 0 | 1;
    RSV2?: 0 | 1;
    RSV3?: 0 | 1;
    opcode?: (typeof OPCODES)[keyof typeof OPCODES];
    maskingKey?: Buffer;
    payload: Buffer;
  }) {
    const { maskingKey, payload } = params;
    return getWebsocketFrame({
      FIN: params.FIN ?? 1,
      RSV1: params.RSV1 ?? 0,
      RSV2: params.RSV2 ?? 0,
      RSV3: params.RSV3 ?? 0,
      opcode: params.opcode ?? OPCODES.text,
      ...(maskingKey ? { maskingKey } : {}),
      maskAndPayloadLengthBytes: calMaskAndPayloadLengthBytes({
        mask: maskingKey ? 1 : 0,
        payloadLength: BigInt(payload.byteLength),
      }),
      payloadData: maskingKey
        ? maskPayloadData({ maskingKey, payloadData: payload })
        : payload,
    });
  }

  const maskingKey = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);

  describe("欄位解析", () => {
    it("unmasked text frame", TEST_TIMEOUT, async () => {
      const payload = Buffer.from("Hello");
      const wire = buildFrame({ payload });
      const socket = await connect((s) => s.write(wire));
      const frame = await readWebsocketFrame(socket);
      assert.equal(frame.FIN, 1);
      assert.equal(frame.RSV1, 0);
      assert.equal(frame.RSV2, 0);
      assert.equal(frame.RSV3, 0);
      assert.equal(frame.opcode, OPCODES.text);
      assert.equal(frame.mask, 0);
      assert.equal(frame.maskingKey, undefined);
      assert.equal(frame.payloadLength, 5n);
      assert.deepEqual(frame.payloadData, payload);
      assert.deepEqual(frame.raw, wire);
    });

    it("masked text frame：payloadData 維持 masked（與 raw 的 payload 部分相同）", TEST_TIMEOUT, async () => {
      const payload = Buffer.from("Hello");
      const wire = buildFrame({ payload, maskingKey });
      const socket = await connect((s) => s.write(wire));
      const frame = await readWebsocketFrame(socket);
      assert.equal(frame.mask, 1);
      assert.deepEqual(frame.maskingKey, maskingKey);
      assert.deepEqual(frame.payloadData, wire.subarray(-5));
      assert.notDeepEqual(frame.payloadData, payload);
      assert.deepEqual(frame.raw, wire);
      // 呼叫端需要明文時，自己用 maskPayloadData 還原
      assert.deepEqual(
        maskPayloadData({ maskingKey, payloadData: frame.payloadData }),
        payload,
      );
    });

    it("FIN、RSV1~3、opcode 各自獨立解析", TEST_TIMEOUT, async () => {
      const wire = buildFrame({
        FIN: 0,
        RSV1: 1,
        RSV2: 0,
        RSV3: 1,
        opcode: OPCODES.binary,
        payload: Buffer.from([1, 2, 3]),
      });
      const socket = await connect((s) => s.write(wire));
      const frame = await readWebsocketFrame(socket);
      assert.equal(frame.FIN, 0);
      assert.equal(frame.RSV1, 1);
      assert.equal(frame.RSV2, 0);
      assert.equal(frame.RSV3, 1);
      assert.equal(frame.opcode, OPCODES.binary);
    });

    for (const [name, opcode] of Object.entries(OPCODES)) {
      it(`opcode ${name}（0x${opcode.toString(16)}）`, TEST_TIMEOUT, async () => {
        const wire = buildFrame({ opcode, payload: Buffer.alloc(0) });
        const socket = await connect((s) => s.write(wire));
        const frame = await readWebsocketFrame(socket);
        assert.equal(frame.opcode, opcode);
      });
    }
  });

  describe("payload length 的三種編碼", () => {
    for (const length of [0, 1, 125, 126, 127, 65535, 65536, 100_000]) {
      it(`payloadLength = ${length}`, TEST_TIMEOUT, async () => {
        const payload = Buffer.alloc(length);
        for (let i = 0; i < length; i++) payload[i] = i % 251;
        const wire = buildFrame({ payload });
        const socket = await connect((s) => s.write(wire));
        const frame = await readWebsocketFrame(socket);
        assert.equal(frame.payloadLength, BigInt(length));
        assert.equal(frame.payloadData.compare(payload), 0);
        assert.equal(frame.raw.compare(wire), 0);
      });
    }

    it("masked 且 payloadLength = 65536（8 bytes extended length + masking key）", TEST_TIMEOUT, async () => {
      const payload = Buffer.alloc(65536, 0xab);
      const wire = buildFrame({ payload, maskingKey });
      const socket = await connect((s) => s.write(wire));
      const frame = await readWebsocketFrame(socket);
      assert.equal(frame.payloadLength, 65536n);
      assert.equal(frame.payloadData.compare(wire.subarray(-65536)), 0);
      assert.equal(
        maskPayloadData({ maskingKey, payloadData: frame.payloadData }).compare(
          payload,
        ),
        0,
      );
      assert.equal(frame.raw.compare(wire), 0);
    });

    /**
     * 只送 header（FIN + binary，不 mask，64-bit 長度），不送 payload
     */
    function headerWithPayloadLength(payloadLength: bigint) {
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(payloadLength);
      return Buffer.concat([Buffer.from([0x82, 127]), length]);
    }
    const GiB = 1024n ** 3n;

    it("payloadLength = 1 GiB 在上限內：不會 reject byteCount too large（payload 沒送完時是 insufficient）", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.end(headerWithPayloadLength(GiB)));
      await assert.rejects(
        readWebsocketFrame(socket),
        /insufficient frame payload|socket end/,
      );
    });

    for (const [name, payloadLength] of [
      ["1 GiB + 1", GiB + 1n],
      ["2^53", 2n ** 53n],
      ["2^64 - 1", 2n ** 64n - 1n],
    ] as const) {
      it(`payloadLength = ${name} 時 reject byteCount too large，且帶上上限`, TEST_TIMEOUT, async () => {
        const socket = await connect((s) =>
          s.write(headerWithPayloadLength(payloadLength)),
        );
        await assert.rejects(
          readWebsocketFrame(socket),
          new RegExp(`byteCount too large.*maxByteCount.*${GiB}`),
        );
      });
    }
  });

  describe("frame 切分", () => {
    it("一次只送 1 byte", TEST_TIMEOUT, async () => {
      const payload = Buffer.from("Hello");
      const wire = buildFrame({ payload, maskingKey });
      const socket = await connect(async (s) => {
        for (const byte of wire) {
          s.write(Buffer.from([byte]));
          await sleep(2);
        }
      });
      const frame = await readWebsocketFrame(socket);
      assert.deepEqual(
        maskPayloadData({ maskingKey, payloadData: frame.payloadData }),
        payload,
      );
      assert.deepEqual(frame.raw, wire);
    });

    it("header 與 payload 分開送", TEST_TIMEOUT, async () => {
      const payload = Buffer.alloc(300, 0x61);
      const wire = buildFrame({ payload });
      const socket = await connect(async (s) => {
        s.write(wire.subarray(0, 4)); // 2 bytes header + 2 bytes extended length
        await sleep(50);
        s.write(wire.subarray(4));
      });
      const frame = await readWebsocketFrame(socket);
      assert.equal(frame.payloadLength, 300n);
      assert.deepEqual(frame.payloadData, payload);
    });

    it("三個 frame 黏在同一個 chunk，依序讀出且不會多讀", TEST_TIMEOUT, async () => {
      const frames = [
        buildFrame({ opcode: OPCODES.text, payload: Buffer.from("a") }),
        buildFrame({ opcode: OPCODES.ping, payload: Buffer.alloc(0) }),
        buildFrame({
          opcode: OPCODES.binary,
          payload: Buffer.alloc(200, 1),
          maskingKey,
        }),
      ];
      const socket = await connect((s) => s.write(Buffer.concat(frames)));
      for (const wire of frames) {
        const frame = await readWebsocketFrame(socket);
        assert.deepEqual(frame.raw, wire);
      }
    });
  });

  describe("與 readUntil 搭配（handshake response 之後緊接著 frame）", () => {
    it("handshake response 與第一個 frame 黏在同一個 chunk", TEST_TIMEOUT, async () => {
      const response = Buffer.from(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      const payload = Buffer.from("Hello");
      const wire = buildFrame({ payload });
      const socket = await connect((s) => s.write(Buffer.concat([response, wire])));
      const head = await readUntil({
        socket,
        delimiter: Buffer.from("\r\n\r\n"),
        maxByteCount: 8192,
      });
      assert.deepEqual(head, response);
      const frame = await readWebsocketFrame(socket);
      assert.deepEqual(frame.payloadData, payload);
      assert.deepEqual(frame.raw, wire);
    });
  });

  describe("對端結束連線", () => {
    it("只送半個 header 就 FIN", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.end(Buffer.from([0x81])));
      await assert.rejects(readWebsocketFrame(socket), /insufficient frame header/);
    });

    it("extended payload length 送一半就 FIN", TEST_TIMEOUT, async () => {
      const socket = await connect((s) =>
        s.end(Buffer.from([0x81, 126, 0x01])),
      );
      await assert.rejects(
        readWebsocketFrame(socket),
        /insufficient extended payload length/,
      );
    });

    it("masking key 送一半就 FIN", TEST_TIMEOUT, async () => {
      const socket = await connect((s) =>
        s.end(Buffer.from([0x81, 0x85, 0x37, 0xfa])),
      );
      await assert.rejects(readWebsocketFrame(socket), /insufficient masking key/);
    });

    it("payload 送一半就 FIN", TEST_TIMEOUT, async () => {
      const wire = buildFrame({ payload: Buffer.from("Hello") });
      const socket = await connect((s) => s.end(wire.subarray(0, wire.length - 2)));
      await assert.rejects(readWebsocketFrame(socket), /insufficient frame payload/);
    });

    it("沒送任何資料就 FIN", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.end());
      await assert.rejects(readWebsocketFrame(socket), /socket end/);
    });

    it("server FIN 前送了兩個 frame，兩個都讀得到，第三次 reject", TEST_TIMEOUT, async () => {
      const a = buildFrame({ payload: Buffer.from("a") });
      const b = buildFrame({ payload: Buffer.from("b") });
      const socket = await connect((s) => s.end(Buffer.concat([a, b])));
      assert.deepEqual((await readWebsocketFrame(socket)).raw, a);
      assert.deepEqual((await readWebsocketFrame(socket)).raw, b);
      await assert.rejects(readWebsocketFrame(socket));
    });
  });
});
