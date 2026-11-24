/**
 * 通用的 socket 讀取工具，HTTP/2 與 WebSocket 共用。
 *
 * 對外 export：
 * - package.json 的 "exports" 有 "./utils"
 * - `index.ts` 有 re-export
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

/**
 * `readUntil` 的 `maxByteCount` 預設值（64 KiB）
 *
 * 每次收到新資料，`readUntil` 都會複製整份累積的資料，所以上限不宜太大。
 * 64 KiB 足以容納一般的 HTTP header（例如 WebSocket handshake response）。
 */
const DEFAULT_READ_UNTIL_MAX_BYTE_COUNT = 64 * 1024;

/**
 * 從 socket 讀取，直到累積的資料包含 `delimiter`（例如 HTTP header 結尾的 "\r\n\r\n"）
 *
 * 回傳的 `Buffer` 從第一個 byte 到 `delimiter` 結尾（包含 `delimiter`）。
 * 讀過頭的 bytes（`delimiter` 之後的部分）會用 `socket.unshift()` 放回 socket，
 * 之後的 {@link readExactly} 或 {@link readUntil} 可以接著讀。
 *
 * 呼叫前，須確保 socket 沒有註冊其他 "readable" 或 "data" event
 *
 * `maxByteCount`：`delimiter` 必須在前 `maxByteCount` bytes 內結束，否則 reject。
 * 預設值是 {@link DEFAULT_READ_UNTIL_MAX_BYTE_COUNT}（64 KiB）。
 * reject 時，已經讀出的資料不會放回 socket。
 *
 * reject 的情況：
 * - "readableEnded"：socket 的 "end" 已發生，沒有資料可讀
 * - "socket not readable"：socket 不可再讀
 * - "maxByteCount exceeded"：讀了 `maxByteCount` bytes 仍沒有找到 `delimiter`
 * - "socket end" / "socket close"：等待資料期間 socket 結束或關閉
 */
async function readUntil(params: {
  socket: Socket | TLSSocket,
  delimiter: Buffer,
  maxByteCount?: number,
}) {
  const {
    socket,
    delimiter,
    maxByteCount = DEFAULT_READ_UNTIL_MAX_BYTE_COUNT,
  } = params;
  assert(delimiter.byteLength > 0);
  assert(
    Number.isInteger(maxByteCount) && maxByteCount >= delimiter.byteLength,
  );
  assert(socket.listenerCount("readable") === 0);
  assert(socket.listenerCount("data") === 0);
  assert(socket.readableFlowing === null);

  return new Promise<Buffer>((resolve, reject) => {
    if (socket.readableEnded) {
      assert(socket.readableLength === 0);
      reject(new Error(JSON.stringify({ reason: "readableEnded" })));
      return;
    }
    let accumulated = Buffer.alloc(0);
    function tryRead() {
      const maybeChunk = socket.read();
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
              received: accumulated.toString("latin1"),
            }),
          ),
        );
        return;
      }
      assert(maybeChunk instanceof Buffer);
      // delimiter 可能被切在兩個 chunk 中間，所以要從「舊資料的尾端往前 delimiter.byteLength - 1 個 byte」開始找
      const searchFrom = Math.max(
        0,
        accumulated.byteLength - delimiter.byteLength + 1,
      );
      accumulated = Buffer.concat([accumulated, maybeChunk]);
      const index = accumulated
        .subarray(0, maxByteCount)
        .indexOf(delimiter, searchFrom);
      if (index !== -1) {
        const end = index + delimiter.byteLength;
        const remainder = accumulated.subarray(end);
        cleanup();
        // 必須在 "end" 事件發出之前呼叫（這裡是同步流程，所以安全）
        if (remainder.byteLength > 0) socket.unshift(remainder);
        resolve(accumulated.subarray(0, end));
        return;
      }
      if (accumulated.byteLength >= maxByteCount) {
        cleanup();
        reject(
          new Error(
            JSON.stringify({
              reason: "maxByteCount exceeded",
              maxByteCount,
              received: accumulated.toString("latin1"),
            }),
          ),
        );
        return;
      }
      // 這一輪的資料不夠，繼續讀（buffer 內可能還有資料，所以直接再讀一次）
      tryRead();
    }
    function end() {
      cleanup();
      reject(
        new Error(
          JSON.stringify({
            reason: "socket end",
            received: accumulated.toString("latin1"),
          }),
        ),
      );
    }
    function close() {
      cleanup();
      reject(
        new Error(
          JSON.stringify({
            reason: "socket close",
            received: accumulated.toString("latin1"),
          }),
        ),
      );
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
    tryRead();
  });
}

export { readExactly, readUntil };
