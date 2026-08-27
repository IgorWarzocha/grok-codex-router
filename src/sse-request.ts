import zlib from "node:zlib";

const ZSTD_COMPRESSION_LEVEL = 3;

export type SerializedSseRequest =
  | { body: ArrayBuffer; contentEncoding: "zstd" }
  | { body: string; contentEncoding?: undefined };

export function serializeSseRequest(value: unknown): SerializedSseRequest {
  const json = JSON.stringify(value);
  try {
    const compressed = zlib.zstdCompressSync(json, {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_COMPRESSION_LEVEL }
    });
    const body = new Uint8Array(compressed.byteLength);
    body.set(compressed);
    return {
      body: body.buffer,
      contentEncoding: "zstd"
    };
  } catch {
    return { body: json };
  }
}
