/**
 * 內部工具：不對外 export。
 *
 * package.json 的 "exports" 只開放 "./http2" 與 "./websocket"，
 * 且 `index.ts` 不 re-export 這個檔案，所以使用這個套件的人無法 import。
 */
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import assert from "node:assert";

/**
 * `readExactly` 接受的 `byteCount` 上限（1 GiB）
 *
 * Node 的 `socket.read(size)` 規定 `size` 必須 <= 1 GiB，超過會丟 `ERR_OUT_OF_RANGE`
 */
const MAX_BYTE_COUNT = 1024 ** 3;

/**
 * 從 socket 讀取剛好 `byteCount` bytes，不會多讀
 *
 * 呼叫前，須確保 socket 沒有註冊其他 "readable" 或 "data" event
 *
 * `byteCount` 必須是 0 ~ {@link MAX_BYTE_COUNT}（1 GiB）的整數，否則 reject
 *
 * `label` 用於 reject 訊息，例如 "frame header" => "insufficient frame header"
 *
 * reject 的情況：
 * - "readableEnded"：socket 的 "end" 已發生，沒有資料可讀（`byteCount` 為 0 時不檢查）
 * - "socket not readable"：buffer 資料不足，且 socket 不可再讀
 * - "insufficient `label`"：socket 結束時，剩餘資料少於 `byteCount`
 * - "socket end" / "socket close"：等待資料期間 socket 結束或關閉
 */
async function readExactly(params: {
  socket: Socket | TLSSocket,
  byteCount: number,
  label: string,
}) {
  const { socket, byteCount, label } = params;
  assert(Number.isInteger(byteCount) && byteCount >= 0);
  if (byteCount > MAX_BYTE_COUNT) {
    throw new Error(
      JSON.stringify({
        reason: "byteCount too large",
        byteCount,
        maxByteCount: MAX_BYTE_COUNT,
      }),
    );
  }
  assert(socket.listenerCount("readable") === 0);
  assert(socket.listenerCount("data") === 0);
  assert(socket.readableFlowing === null);

  return new Promise<Buffer>((resolve, reject) => {
    if (byteCount === 0) {
      resolve(Buffer.alloc(0));
      return;
    }
    if (socket.readableEnded) {
      assert(socket.readableLength === 0);
      reject(new Error(JSON.stringify({ reason: "readableEnded" })));
      return;
    }
    function tryRead() {
      const maybeChunk = socket.read(byteCount);
      if (maybeChunk === null) {
        if (socket.readable) {
          socket.once("readable", tryRead);
          return;
        }
        cleanup();
        reject(
          new Error(
            JSON.stringify({
              reason: "socket not readable",
              data: socket.read(),
            }),
          ),
        );
        return;
      }
      assert(maybeChunk instanceof Buffer);
      assert(maybeChunk.byteLength <= byteCount);
      cleanup();
      if (maybeChunk.byteLength < byteCount) {
        reject(
          new Error(
            JSON.stringify({
              reason: `insufficient ${label}`,
              byteCount,
              maybeChunk,
            }),
          ),
        );
        return;
      }
      resolve(maybeChunk);
    }
    function end() {
      cleanup();
      reject(new Error(JSON.stringify({ reason: "socket end" })));
    }
    function close() {
      cleanup();
      reject(new Error(JSON.stringify({ reason: "socket close" })));
    }
    function error(err: Error) {
      cleanup();
      reject(err);
    }
    function cleanup() {
      socket.removeListener("readable", tryRead);
      socket.removeListener("end", end);
      socket.removeListener("close", close);
      socket.removeListener("error", error);
    }
    socket.once("end", end);
    socket.once("close", close);
    socket.once("error", error);
    // 先直接讀一次：buffer 可能已有資料（例如連續呼叫，或 socket 已 destroyed）
    tryRead();
  });
}

export { readExactly };
