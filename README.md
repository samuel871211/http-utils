# http-utils

Shared TypeScript utilities for building, parsing, and testing raw HTTP/2 and WebSocket frames.

## Setup

```bash
pnpm install
pnpm build   # compile to dist/
```

| Script       | Description                          |
| ------------ | ------------------------------------ |
| `pnpm build` | Compile `src/` to `dist/`            |
| `pnpm dev`   | Compile in watch mode                |
| `pnpm check` | Run the TypeScript type check        |
| `pnpm test`  | Run `src/*.test.ts` with `node:test` |

## HTTP/2

| function or constant | RFC Section |
| --- | --- |
| `magic` | [RFC 9113 3.4 HTTP/2 Connection Preface](https://datatracker.ietf.org/doc/html/rfc9113#section-3.4) |
| `http2ConnectionPreface` | [RFC 9113 3.4 HTTP/2 Connection Preface](https://datatracker.ietf.org/doc/html/rfc9113#section-3.4) |
| `Http2FrameTypes` | [RFC 9113 4.1 Frame Format](https://datatracker.ietf.org/doc/html/rfc9113#section-4.1) |
| `readHttp2Frame` | [RFC 9113 4.1 Frame Format](https://datatracker.ietf.org/doc/html/rfc9113#section-4.1) |
| `readHttp2FramesUntil` | [RFC 9113 4.1 Frame Format](https://datatracker.ietf.org/doc/html/rfc9113#section-4.1) |
| `readUntilEndStream` | [RFC 9113 4.1 Frame Format](https://datatracker.ietf.org/doc/html/rfc9113#section-4.1) |
| `numberTo1ByteBuffer` | [RFC 9113 4.1 Frame Format](https://datatracker.ietf.org/doc/html/rfc9113#section-4.1) |
| `numberTo3BytesBuffer` | [RFC 9113 4.1 Frame Format](https://datatracker.ietf.org/doc/html/rfc9113#section-4.1) |
| `numberTo4BytesBuffer` | [RFC 9113 4.1 Frame Format](https://datatracker.ietf.org/doc/html/rfc9113#section-4.1) |
| `getDataFrame` | [RFC 9113 6.1 DATA](https://datatracker.ietf.org/doc/html/rfc9113#section-6.1) |
| `getHeadersFrame` | [RFC 9113 6.2 HEADERS](https://datatracker.ietf.org/doc/html/rfc9113#section-6.2) |
| `getPriorityFrame` | [RFC 9113 6.3 PRIORITY](https://datatracker.ietf.org/doc/html/rfc9113#section-6.3) |
| `getRSTFrame` | [RFC 9113 6.4 RST_STREAM](https://datatracker.ietf.org/doc/html/rfc9113#section-6.4) |
| `getSettingsFrame` | [RFC 9113 6.5 SETTINGS](https://datatracker.ietf.org/doc/html/rfc9113#section-6.5) |
| `emptySettingsFrame` | [RFC 9113 6.5 SETTINGS](https://datatracker.ietf.org/doc/html/rfc9113#section-6.5) |
| `waitForLocalSettings` | [RFC 9113 6.5 SETTINGS](https://datatracker.ietf.org/doc/html/rfc9113#section-6.5) |
| `waitForRemoteSettings` | [RFC 9113 6.5 SETTINGS](https://datatracker.ietf.org/doc/html/rfc9113#section-6.5) |
| `settingsACKFrame` | [RFC 9113 6.5.3 Settings Synchronization](https://datatracker.ietf.org/doc/html/rfc9113#section-6.5.3) |
| `waitForSettingsACKFrame` | [RFC 9113 6.5.3 Settings Synchronization](https://datatracker.ietf.org/doc/html/rfc9113#section-6.5.3) |
| `waitForSettingsFrameAndAckBack` | [RFC 9113 6.5.3 Settings Synchronization](https://datatracker.ietf.org/doc/html/rfc9113#section-6.5.3) |
| `getPushPromiseFrame` | [RFC 9113 6.6 PUSH_PROMISE](https://datatracker.ietf.org/doc/html/rfc9113#section-6.6) |
| `pingFrame` | [RFC 9113 6.7 PING](https://datatracker.ietf.org/doc/html/rfc9113#section-6.7) |
| `getGoawayFrame` | [RFC 9113 6.8 GOAWAY](https://datatracker.ietf.org/doc/html/rfc9113#section-6.8) |
| `getWindowUpdateFrame` | [RFC 9113 6.9 WINDOW_UPDATE](https://datatracker.ietf.org/doc/html/rfc9113#section-6.9) |
| `getContinuationFrame` | [RFC 9113 6.10 CONTINUATION](https://datatracker.ietf.org/doc/html/rfc9113#section-6.10) |
| `ERROR_CODES` | [RFC 9113 7 Error Codes](https://datatracker.ietf.org/doc/html/rfc9113#section-7) |
| `encodeIntegerRFC7541` | [RFC 7541 5.1 Integer Representation](https://datatracker.ietf.org/doc/html/rfc7541#section-5.1) |
| `encodeOverlongIntegerRFC7541` | [RFC 7541 5.1 Integer Representation](https://datatracker.ietf.org/doc/html/rfc7541#section-5.1) |
| `encodeStringLiteralsRFC7541` | [RFC 7541 5.2 String Literal Representation](https://datatracker.ietf.org/doc/html/rfc7541#section-5.2) |
| `HPACK_STATIC_TABLE` | [RFC 7541 Appendix A. Static Table Definition](https://datatracker.ietf.org/doc/html/rfc7541#appendix-A) |

## WebSocket

| function or constant | RFC Section |
| --- | --- |
| `getWebsocketFrame` | [RFC 6455 5.2 Base Framing Protocol](https://datatracker.ietf.org/doc/html/rfc6455#section-5.2) |
| `readWebsocketFrame` | [RFC 6455 5.2 Base Framing Protocol](https://datatracker.ietf.org/doc/html/rfc6455#section-5.2) |
| `OPCODES` | [RFC 6455 5.2 Base Framing Protocol (Opcode)](https://datatracker.ietf.org/doc/html/rfc6455#section-5.2) |
| `calMaskAndPayloadLengthBytes` | [RFC 6455 5.2 Base Framing Protocol (Payload length)](https://datatracker.ietf.org/doc/html/rfc6455#section-5.2) |
| `maskPayloadData` | [RFC 6455 5.3 Client-to-Server Masking](https://datatracker.ietf.org/doc/html/rfc6455#section-5.3) |
