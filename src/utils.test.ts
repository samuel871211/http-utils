import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { readExactly, readUntil } from "./utils.js";

const HOST = "127.0.0.1";
// 任何一個測試卡住（Promise 永遠 pending）都會被這個 timeout 抓到
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
 * 輪詢直到條件成立，避免用固定的 sleep 造成測試不穩定。
 */
async function until(condition: () => boolean) {
  while (!condition()) await sleep(5);
}

/**
 * 等待 socket close。不使用 `events.once`，因為它在等待期間收到 'error'
 * 會直接 reject。
 */
function closed(socket: net.Socket) {
  return new Promise<void>((resolve) => {
    if (socket.closed) return resolve();
    socket.once("close", () => resolve());
  });
}

function listenerCounts(socket: net.Socket) {
  return Object.fromEntries(
    (["readable", "end", "close", "error"] as const).map((event) => [
      event,
      socket.listenerCount(event),
    ]),
  );
}

describe("readExactly", () => {
  it("byteCount 為 0 時回傳空 Buffer，不讀取 socket", TEST_TIMEOUT, async () => {
    const socket = await connect(() => {});
    const chunk = await readExactly({ socket, byteCount: 0, label: "bytes" });
    assert.equal(chunk.byteLength, 0);
  });

  it("只讀 byteCount bytes，剩餘資料留在 socket", TEST_TIMEOUT, async () => {
    const data = Buffer.from([1, 2, 3, 4, 5, 6]);
    const socket = await connect((s) => s.write(data));
    assert.deepEqual(
      await readExactly({ socket, byteCount: 2, label: "bytes" }),
      data.subarray(0, 2),
    );
    assert.deepEqual(
      await readExactly({ socket, byteCount: 4, label: "bytes" }),
      data.subarray(2),
    );
  });

  it("資料分多次到達", TEST_TIMEOUT, async () => {
    const data = Buffer.from([1, 2, 3, 4]);
    const socket = await connect(async (s) => {
      for (const byte of data) {
        s.write(Buffer.from([byte]));
        await sleep(5);
      }
    });
    assert.deepEqual(
      await readExactly({ socket, byteCount: 4, label: "bytes" }),
      data,
    );
  });

  it("socket 結束時資料不足，reject 並帶上 label", TEST_TIMEOUT, async () => {
    const socket = await connect((s) => s.end(Buffer.from([1, 2])));
    await assert.rejects(
      readExactly({ socket, byteCount: 4, label: "foo" }),
      /insufficient foo/,
    );
  });

  it("等待過程中收到 FIN", TEST_TIMEOUT, async () => {
    const socket = await connect((s) => {
      setTimeout(() => s.end(), 50);
    });
    await assert.rejects(
      readExactly({ socket, byteCount: 4, label: "bytes" }),
      /socket end/,
    );
  });

  it("成功與 reject 之後都不會洩漏 listener", TEST_TIMEOUT, async () => {
    const socket = await connect((s) => s.end(Buffer.from([1, 2, 3])));
    const before = listenerCounts(socket);
    await readExactly({ socket, byteCount: 2, label: "bytes" });
    assert.deepEqual(listenerCounts(socket), before);
    await assert.rejects(
      readExactly({ socket, byteCount: 4, label: "bytes" }),
    );
    assert.deepEqual(listenerCounts(socket), before);
  });

  it("end 事件已發生之後再讀，reject readableEnded", TEST_TIMEOUT, async () => {
    const socket = await connect((s) => s.end(Buffer.from([1, 2])));
    await readExactly({ socket, byteCount: 2, label: "bytes" });
    await until(() => socket.readableEnded);
    await assert.rejects(
      readExactly({ socket, byteCount: 1, label: "bytes" }),
      /readableEnded/,
    );
  });

  it("end 事件已發生之後 byteCount 為 0，仍回傳空 Buffer", TEST_TIMEOUT, async () => {
    const socket = await connect((s) => s.end(Buffer.from([1, 2])));
    await readExactly({ socket, byteCount: 2, label: "bytes" });
    await until(() => socket.readableEnded);
    const chunk = await readExactly({ socket, byteCount: 0, label: "bytes" });
    assert.equal(chunk.byteLength, 0);
  });

  describe("參數與前置條件（reject）", () => {
    it("byteCount 不合法時 reject AssertionError", async () => {
      const socket = await connect(() => {});
      for (const byteCount of [
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        await assert.rejects(
          readExactly({ socket, byteCount, label: "bytes" }),
          { name: "AssertionError" },
          `byteCount = ${byteCount}`,
        );
      }
    });

    it("byteCount 超過 1 GiB 時 reject，且訊息帶上上限", async () => {
      const socket = await connect(() => {});
      for (const byteCount of [
        1024 ** 3 + 1,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER + 1,
        2 ** 64,
      ]) {
        await assert.rejects(
          readExactly({ socket, byteCount, label: "bytes" }),
          /byteCount too large.*maxByteCount.*1073741824/,
          `byteCount = ${byteCount}`,
        );
      }
    });

    it("byteCount 剛好 1 GiB 不會因為 too large 而 reject", async () => {
      const socket = await connect(() => {});
      const promise = readExactly({ socket, byteCount: 1024 ** 3, label: "bytes" });
      promise.catch(noop); // afterEach destroy socket 時會 reject
    });

    it("socket 已有 'readable' listener 時 reject", async () => {
      const socket = await connect(() => {});
      socket.on("readable", noop);
      await assert.rejects(
        readExactly({ socket, byteCount: 1, label: "bytes" }),
        { name: "AssertionError" },
      );
    });

    it("socket 已有 'data' listener 時 reject", async () => {
      const socket = await connect(() => {});
      socket.on("data", noop);
      await assert.rejects(
        readExactly({ socket, byteCount: 1, label: "bytes" }),
        { name: "AssertionError" },
      );
    });

    it("socket 已被 pause()（readableFlowing 不是 null）時 reject", async () => {
      const socket = await connect(() => {});
      socket.pause();
      await assert.rejects(
        readExactly({ socket, byteCount: 1, label: "bytes" }),
        { name: "AssertionError" },
      );
    });

    it("前一次呼叫還沒結束就再呼叫，第二次 reject", async () => {
      const socket = await connect(() => {});
      const first = readExactly({ socket, byteCount: 1, label: "bytes" });
      first.catch(noop); // afterEach destroy socket 時會 reject
      await assert.rejects(
        readExactly({ socket, byteCount: 1, label: "bytes" }),
        { name: "AssertionError" },
      );
    });
  });

  describe("讀取成功", () => {
    it("FIN 與資料同時到達，且資料剛好足夠", TEST_TIMEOUT, async () => {
      const data = Buffer.from([1, 2, 3, 4]);
      const socket = await connect((s) => s.end(data));
      assert.deepEqual(
        await readExactly({ socket, byteCount: 4, label: "bytes" }),
        data,
      );
    });

    it("buffer 被讀空後，下一次呼叫等待新資料", TEST_TIMEOUT, async () => {
      const socket = await connect(async (s) => {
        s.write(Buffer.from([1, 2]));
        await sleep(50);
        s.write(Buffer.from([3, 4]));
      });
      assert.deepEqual(
        await readExactly({ socket, byteCount: 2, label: "bytes" }),
        Buffer.from([1, 2]),
      );
      assert.deepEqual(
        await readExactly({ socket, byteCount: 2, label: "bytes" }),
        Buffer.from([3, 4]),
      );
    });

    it("byteCount 大於 highWaterMark（200000 bytes）", TEST_TIMEOUT, async () => {
      const data = Buffer.alloc(200_000);
      for (let i = 0; i < data.length; i++) data[i] = i % 251;
      const socket = await connect((s) => s.write(data));
      const chunk = await readExactly({
        socket,
        byteCount: data.length,
        label: "bytes",
      });
      assert.equal(chunk.compare(data), 0);
    });

    it("socket 已 destroy，buffer 仍有足夠資料時讀得到", TEST_TIMEOUT, async () => {
      const data = Buffer.from([1, 2, 3, 4, 5, 6]);
      const socket = await connect((s) => s.write(data));
      await until(() => socket.readableLength >= data.length);
      socket.destroy();
      await closed(socket);
      assert.deepEqual(
        await readExactly({ socket, byteCount: 4, label: "bytes" }),
        data.subarray(0, 4),
      );
    });
  });

  describe("reject 的原因", () => {
    it("等待過程中資料不足就收到 FIN", TEST_TIMEOUT, async () => {
      const socket = await connect(async (s) => {
        s.write(Buffer.from([1, 2]));
        await sleep(50);
        s.end();
      });
      await assert.rejects(
        readExactly({ socket, byteCount: 4, label: "foo" }),
        /insufficient foo/,
      );
    });

    it("等待過程中 client 自己 destroy", TEST_TIMEOUT, async () => {
      const socket = await connect(() => {});
      const promise = readExactly({ socket, byteCount: 4, label: "bytes" });
      setTimeout(() => socket.destroy(), 20);
      await assert.rejects(promise, /socket close/);
    });

    it("等待過程中收到 RST", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => {
        setTimeout(() => s.resetAndDestroy(), 50);
      });
      await assert.rejects(
        readExactly({ socket, byteCount: 4, label: "bytes" }),
        /ECONNRESET/,
      );
    });

    it("socket 已 destroy 且 buffer 是空的", TEST_TIMEOUT, async () => {
      const socket = await connect(() => {});
      socket.destroy();
      await closed(socket);
      await assert.rejects(
        readExactly({ socket, byteCount: 1, label: "bytes" }),
        /socket not readable/,
      );
    });

    it("socket 已 destroy 且 buffer 資料不足", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.write(Buffer.from([1, 2])));
      await until(() => socket.readableLength >= 2);
      socket.destroy();
      await closed(socket);
      await assert.rejects(
        readExactly({ socket, byteCount: 4, label: "bytes" }),
        /socket not readable/,
      );
    });
  });

  describe("每一種 reject 都不會洩漏 listener", () => {
    const cases: Array<{
      name: string;
      setup: (socket: net.Socket) => void;
      server: (s: net.Socket) => void;
      expected: RegExp;
    }> = [
      {
        name: "socket end",
        server: (s) => {
          setTimeout(() => s.end(), 20);
        },
        setup: noop,
        expected: /socket end/,
      },
      {
        name: "socket close",
        server: noop,
        setup: (socket) => {
          setTimeout(() => socket.destroy(), 20);
        },
        expected: /socket close/,
      },
      {
        name: "error（RST）",
        server: (s) => {
          setTimeout(() => s.resetAndDestroy(), 20);
        },
        setup: noop,
        expected: /ECONNRESET/,
      },
      {
        name: "insufficient（FIN 時資料不足）",
        server: (s) => {
          s.write(Buffer.from([1, 2]));
          setTimeout(() => s.end(), 20);
        },
        setup: noop,
        expected: /insufficient/,
      },
    ];
    for (const { name, server, setup, expected } of cases) {
      it(name, TEST_TIMEOUT, async () => {
        const socket = await connect(server);
        const before = listenerCounts(socket);
        const promise = readExactly({ socket, byteCount: 4, label: "bytes" });
        setup(socket);
        await assert.rejects(promise, expected);
        assert.deepEqual(listenerCounts(socket), before);
      });
    }
  });
});

describe("readUntil", () => {
  const CRLF2 = Buffer.from("\r\n\r\n");
  const ru = (socket: net.Socket, maxByteCount = 8192, delimiter = CRLF2) =>
    readUntil({ socket, delimiter, maxByteCount });

  describe("讀取成功", () => {
    it("回傳到 delimiter 結尾為止（包含 delimiter）", TEST_TIMEOUT, async () => {
      const head = Buffer.from("HTTP/1.1 101 Switching Protocols\r\nA: b\r\n\r\n");
      const socket = await connect((s) => s.write(head));
      assert.deepEqual(await ru(socket), head);
    });

    it("delimiter 在最開頭", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.write(CRLF2));
      assert.deepEqual(await ru(socket), CRLF2);
    });

    it("多讀的 bytes 會放回 socket，readExactly 可以接著讀", TEST_TIMEOUT, async () => {
      const head = Buffer.from("HTTP/1.1 101\r\n\r\n");
      const rest = Buffer.from([1, 2, 3, 4, 5]);
      const socket = await connect((s) => s.write(Buffer.concat([head, rest])));
      assert.deepEqual(await ru(socket), head);
      assert.deepEqual(
        await readExactly({ socket, byteCount: 5, label: "bytes" }),
        rest,
      );
    });

    it("delimiter 剛好在 chunk 結尾（沒有多讀），之後的資料照常讀得到", TEST_TIMEOUT, async () => {
      const head = Buffer.from("abc\r\n\r\n");
      const socket = await connect(async (s) => {
        s.write(head);
        await sleep(50);
        s.write(Buffer.from([9, 8]));
      });
      assert.deepEqual(await ru(socket), head);
      assert.deepEqual(
        await readExactly({ socket, byteCount: 2, label: "bytes" }),
        Buffer.from([9, 8]),
      );
    });

    it("有多個 delimiter 時只讀到第一個，第二個留給下一次呼叫", TEST_TIMEOUT, async () => {
      const first = Buffer.from("a\r\n\r\n");
      const second = Buffer.from("b\r\n\r\n");
      const socket = await connect((s) => s.write(Buffer.concat([first, second])));
      assert.deepEqual(await ru(socket), first);
      assert.deepEqual(await ru(socket), second);
    });

    it("delimiter 被切在兩個 chunk 中間", TEST_TIMEOUT, async () => {
      const head = Buffer.from("abc\r\n\r\n");
      for (let cut = 1; cut < head.byteLength; cut++) {
        const socket = await connect(async (s) => {
          s.write(head.subarray(0, cut));
          await sleep(20);
          s.write(head.subarray(cut));
        });
        assert.deepEqual(await ru(socket), head, `cut = ${cut}`);
      }
    });

    it("一次只送 1 byte", TEST_TIMEOUT, async () => {
      const head = Buffer.from("HTTP/1.1 101\r\n\r\n");
      const socket = await connect(async (s) => {
        for (const byte of head) {
          s.write(Buffer.from([byte]));
          await sleep(2);
        }
      });
      assert.deepEqual(await ru(socket), head);
    });

    it("資料與 FIN 同時到達，仍讀得到", TEST_TIMEOUT, async () => {
      const head = Buffer.from("abc\r\n\r\n");
      const socket = await connect((s) => s.end(head));
      assert.deepEqual(await ru(socket), head);
    });

    it("delimiter 之後還有資料，且 server 已 FIN：多讀的 bytes 仍然讀得到", TEST_TIMEOUT, async () => {
      const head = Buffer.from("abc\r\n\r\n");
      const rest = Buffer.from([1, 2, 3]);
      const socket = await connect((s) => s.end(Buffer.concat([head, rest])));
      assert.deepEqual(await ru(socket), head);
      assert.deepEqual(
        await readExactly({ socket, byteCount: 3, label: "bytes" }),
        rest,
      );
    });

    it("delimiter 不是 CRLF2 也可以（單一 byte）", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.write(Buffer.from("abc\nrest")));
      assert.deepEqual(
        await ru(socket, 100, Buffer.from("\n")),
        Buffer.from("abc\n"),
      );
    });
  });

  describe("maxByteCount", () => {
    it("delimiter 剛好在 maxByteCount 結束", TEST_TIMEOUT, async () => {
      const head = Buffer.from("abc\r\n\r\n"); // 7 bytes
      const socket = await connect((s) => s.write(head));
      assert.deepEqual(await ru(socket, 7), head);
    });

    it("delimiter 在 maxByteCount + 1 結束，reject", TEST_TIMEOUT, async () => {
      const head = Buffer.from("abcd\r\n\r\n"); // 8 bytes
      const socket = await connect((s) => s.write(head));
      await assert.rejects(ru(socket, 7), /maxByteCount exceeded/);
    });

    it("剛好收滿 maxByteCount bytes 仍沒有 delimiter：立刻 reject，不再等下一個 byte", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.write(Buffer.alloc(50, 0x61)));
      await assert.rejects(ru(socket, 50), /maxByteCount exceeded/);
    });

    it("一直沒有 delimiter，累積超過 maxByteCount 就 reject", TEST_TIMEOUT, async () => {
      const socket = await connect(async (s) => {
        for (let i = 0; i < 20; i++) {
          s.write(Buffer.alloc(10, 0x61));
          await sleep(2);
        }
      });
      await assert.rejects(ru(socket, 50), /maxByteCount exceeded/);
    });
  });

  describe("maxByteCount 的預設值（64 KiB）", () => {
    it("沒傳 maxByteCount：delimiter 在 64 KiB 結尾剛好結束，讀得到", TEST_TIMEOUT, async () => {
      const head = Buffer.concat([
        Buffer.alloc(64 * 1024 - CRLF2.byteLength, 0x61),
        CRLF2,
      ]);
      const socket = await connect((s) => s.write(head));
      const actual = await readUntil({ socket, delimiter: CRLF2 });
      assert.equal(actual.compare(head), 0);
    });

    it("沒傳 maxByteCount：delimiter 超出 64 KiB，reject", TEST_TIMEOUT, async () => {
      const head = Buffer.concat([
        Buffer.alloc(64 * 1024 - CRLF2.byteLength + 1, 0x61),
        CRLF2,
      ]);
      const socket = await connect((s) => s.write(head));
      await assert.rejects(
        readUntil({ socket, delimiter: CRLF2 }),
        /maxByteCount exceeded.*65536/,
      );
    });
  });

  describe("reject 的原因", () => {
    it("沒有 delimiter 就 FIN，訊息帶上已收到的資料", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.end(Buffer.from("abc")));
      await assert.rejects(ru(socket), /socket end.*abc/);
    });

    it("沒送任何資料就 FIN", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.end());
      await assert.rejects(ru(socket), /socket end/);
    });

    it("end 事件已發生之後再讀，reject readableEnded", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.end(Buffer.from("a\r\n\r\n")));
      await ru(socket);
      await until(() => socket.readableEnded);
      await assert.rejects(ru(socket), /readableEnded/);
    });

    it("等待過程中 client 自己 destroy", TEST_TIMEOUT, async () => {
      const socket = await connect(() => {});
      const promise = ru(socket);
      setTimeout(() => socket.destroy(), 20);
      await assert.rejects(promise, /socket close/);
    });

    it("等待過程中收到 RST", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => {
        setTimeout(() => s.resetAndDestroy(), 50);
      });
      await assert.rejects(ru(socket), /ECONNRESET/);
    });

    it("socket 已 destroy 且 buffer 是空的", TEST_TIMEOUT, async () => {
      const socket = await connect(() => {});
      socket.destroy();
      await closed(socket);
      await assert.rejects(ru(socket), /socket not readable/);
    });
  });

  describe("參數與前置條件（reject）", () => {
    it("delimiter 是空 Buffer", async () => {
      const socket = await connect(() => {});
      await assert.rejects(ru(socket, 10, Buffer.alloc(0)), {
        name: "AssertionError",
      });
    });

    it("maxByteCount 不合法", async () => {
      const socket = await connect(() => {});
      for (const maxByteCount of [3, -1, 10.5, Number.NaN]) {
        await assert.rejects(
          ru(socket, maxByteCount),
          { name: "AssertionError" },
          `maxByteCount = ${maxByteCount}`,
        );
      }
    });

    it("socket 已有 'readable' / 'data' listener，或已 pause()", async () => {
      const a = await connect(() => {});
      a.on("readable", noop);
      await assert.rejects(ru(a), { name: "AssertionError" });
      const b = await connect(() => {});
      b.on("data", noop);
      await assert.rejects(ru(b), { name: "AssertionError" });
      const c = await connect(() => {});
      c.pause();
      await assert.rejects(ru(c), { name: "AssertionError" });
    });
  });

  describe("listener 清理", () => {
    it("成功之後不會洩漏 listener", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.write(Buffer.from("a\r\n\r\nrest")));
      const before = listenerCounts(socket);
      await ru(socket);
      assert.deepEqual(listenerCounts(socket), before);
    });

    for (const [name, server, setup] of [
      ["socket end", (s: net.Socket) => void setTimeout(() => s.end(), 20), noop],
      [
        "socket close",
        noop,
        (socket: net.Socket) => void setTimeout(() => socket.destroy(), 20),
      ],
      [
        "error（RST）",
        (s: net.Socket) => void setTimeout(() => s.resetAndDestroy(), 20),
        noop,
      ],
    ] as const) {
      it(`${name} 之後不會洩漏 listener`, TEST_TIMEOUT, async () => {
        const socket = await connect(server);
        const before = listenerCounts(socket);
        const promise = ru(socket);
        setup(socket);
        await assert.rejects(promise);
        assert.deepEqual(listenerCounts(socket), before);
      });
    }

    it("maxByteCount exceeded 之後不會洩漏 listener", TEST_TIMEOUT, async () => {
      const socket = await connect((s) => s.write(Buffer.alloc(100, 0x61)));
      const before = listenerCounts(socket);
      await assert.rejects(ru(socket, 50), /maxByteCount exceeded/);
      assert.deepEqual(listenerCounts(socket), before);
    });
  });
});
