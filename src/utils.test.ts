import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { readExactly } from "./utils.js";

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
