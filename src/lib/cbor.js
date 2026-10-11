// src/lib/cbor.js —— 极简 CBOR 解码（覆盖 WebAuthn 用到的子集：int/bytes/text/array/map/bool/null）
export function cborDecode(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const td = new TextDecoder();
  function readLen(ai, pos) {
    if (ai < 24) return [ai, pos];
    if (ai === 24) return [bytes[pos], pos + 1];
    if (ai === 25) return [view.getUint16(pos), pos + 2];
    if (ai === 26) return [view.getUint32(pos), pos + 4];
    throw new Error('CBOR: unsupported length ' + ai);
  }
  function dec(pos) {
    const ib = bytes[pos], major = ib >> 5, ai = ib & 31;
    let v, np;
    switch (major) {
      case 0: [v, np] = readLen(ai, pos + 1); return [v, np];
      case 1: [v, np] = readLen(ai, pos + 1); return [-1 - v, np];
      case 2: [v, np] = readLen(ai, pos + 1); return [bytes.slice(np, np + v), np + v];
      case 3: [v, np] = readLen(ai, pos + 1); return [td.decode(bytes.slice(np, np + v)), np + v];
      case 4: { [v, np] = readLen(ai, pos + 1); const arr = []; for (let i = 0; i < v; i++) { const [x, p2] = dec(np); arr.push(x); np = p2; } return [arr, np]; }
      case 5: { [v, np] = readLen(ai, pos + 1); const obj = {};
        for (let i = 0; i < v; i++) { const [k, p2] = dec(np); const [val, p3] = dec(p2);
          obj[k instanceof Uint8Array ? [...k].join(',') : String(k)] = val; np = p3; } return [obj, np]; }
      case 7: switch (ai) { case 20: return [false, pos + 1]; case 21: return [true, pos + 1]; case 22: return [null, pos + 1]; case 23: return [undefined, pos + 1];
        default: throw new Error('CBOR: unsupported simple ' + ai); }
      default: throw new Error('CBOR: unsupported major ' + major);
    }
  }
  return dec(0)[0];
}
