// Reads intrinsic dimensions from a container header. PNG, JPEG, GIF and WebP
// all encode width and height within the first few kilobytes, so this works on
// a partial buffer and never needs the whole image decoded.
//
// Shared by the README probe (which sizes candidates without downloading them)
// and the renderer (which sizes a downloaded preview to choose crop vs contain).
const jpegSize = (buffer) => {
  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    // SOF0..SOF15 carry the frame dimensions. DHT (0xc4), JPG (0xc8) and DAC
    // (0xcc) share the range but do not, so they are skipped.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
};

const webpSize = (buffer) => {
  const format = buffer.subarray(12, 16).toString();
  if (format === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  if (format === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  if (format === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
};

export const imageSize = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;

  if (buffer[0] === 0x89 && buffer.subarray(1, 4).toString() === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.subarray(0, 3).toString('latin1') === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return jpegSize(buffer);
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') {
    return webpSize(buffer);
  }
  return null;
};
