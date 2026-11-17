// How wide and how tall a picture is, read from its own header: PNG, JPEG, GIF, WebP and HEIC (HEIF, AVIF).
//
// The app keeps a picture's place at its real shape before the bytes arrive, so a conversation does not jump
// when the picture loads. Only the header is read here; nothing is decoded. A file that is cut short, damaged
// or not a picture gets null, never an error, and the app then does what it did before sizes were kept.
//
// The size is the picture as it is shown: a photo stored on its side with a note saying which way is up (Exif
// orientation in a JPEG, a rotation in a HEIC) comes back turned.

// No picture under the upload limits is anywhere near this; a header that claims more is damaged.
const MAX_SIDE = 100000;
const sized = (width, height) => Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE
  ? { width, height } : null;
const text = (data, from, to) => data.toString("latin1", from, to);

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function png(data) {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG) || text(data, 12, 16) !== "IHDR") return null;
  return sized(data.readUInt32BE(16), data.readUInt32BE(20));
}

function gif(data) {
  if (data.length < 10 || !/^GIF8[79]a$/.test(text(data, 0, 6))) return null;
  return sized(data.readUInt16LE(6), data.readUInt16LE(8));
}

// Exif orientation 5 to 8 is a quarter turn: the picture is shown as tall as it is stored wide.
function exifTurned(segment) {
  if (segment.length < 14 || text(segment, 0, 6) !== "Exif\0\0") return null;
  const tiff = segment.subarray(6);
  const order = text(tiff, 0, 2);
  if (order !== "II" && order !== "MM") return null;
  const u16 = at => order === "II" ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const u32 = at => order === "II" ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
  if (u16(2) !== 42) return null;
  const directory = u32(4);
  if (directory + 2 > tiff.length) return null;
  const entries = u16(directory);
  for (let i = 0; i < entries; i++) {
    const entry = directory + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    if (u16(entry) === 0x0112) { const way = u16(entry + 8); return way >= 5 && way <= 8; }
  }
  return null;
}

function jpeg(data) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let at = 2, turned = false;
  while (at + 4 <= data.length) {
    if (data[at] !== 0xff) return null;
    const marker = data[at + 1];
    // Any number of 0xFF bytes may pad the space before a marker.
    if (marker === 0xff) { at++; continue; }
    at += 2;
    // Markers that stand alone, with no length after them.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // The picture itself starts, or the file ends, and no frame header has said its size.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = data.readUInt16BE(at);
    if (length < 2) return null;
    // A frame header (SOF0 to SOF15, which are not the Huffman table, JPG or arithmetic markers among them).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 7 > data.length) return null;
      const height = data.readUInt16BE(at + 3), width = data.readUInt16BE(at + 5);
      return turned ? sized(height, width) : sized(width, height);
    }
    if (marker === 0xe1) turned = exifTurned(data.subarray(at + 2, Math.min(data.length, at + length))) ?? turned;
    at += length;
  }
  return null;
}

function webp(data) {
  if (data.length < 21 || text(data, 0, 4) !== "RIFF" || text(data, 8, 12) !== "WEBP") return null;
  const kind = text(data, 12, 16);
  // Extended: the canvas size, each stored one less, in three bytes.
  if (kind === "VP8X") return data.length < 30 ? null : sized(1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3));
  // Lossless: a signature byte, then 14 bits of width and 14 of height, each stored one less.
  if (kind === "VP8L") {
    if (data.length < 25 || data[20] !== 0x2f) return null;
    const bits = data.readUInt32LE(21);
    return sized(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
  }
  // Lossy: three bytes of frame tag, the start code 9d 01 2a, then 14 bits each of width and height.
  if (kind === "VP8 ") {
    if (data.length < 30 || data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return null;
    return sized(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
  }
  return null;
}

// HEIC, HEIF and AVIF are boxes inside boxes: a size, a four-letter name, then what the box holds.
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "avif", "avis"]);
function boxes(data, start, end) {
  const found = [];
  let at = start;
  while (at + 8 <= end) {
    let size = data.readUInt32BE(at), header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      const long = data.readBigUInt64BE(at + 8);
      if (long > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(long); header = 16;
    } else if (size === 0) size = end - at;
    // A box that runs past the end: the file is cut short here. What came before it still counts.
    if (size < header || at + size > end) break;
    found.push({ type: text(data, at + 4, at + 8), start: at + header, end: at + size });
    at += size;
  }
  return found;
}

function heif(data) {
  if (data.length < 16 || text(data, 4, 8) !== "ftyp") return null;
  const first = data.readUInt32BE(0);
  if (first < 16 || first > data.length) return null;
  const brands = [text(data, 8, 12)];
  for (let at = 16; at + 4 <= first; at += 4) brands.push(text(data, at, at + 4));
  if (!brands.some(brand => HEIF_BRANDS.has(brand))) return null;
  const meta = boxes(data, 0, data.length).find(box => box.type === "meta");
  if (!meta) return null;
  // Which item is the picture, the list of properties, and which properties belong to which item.
  let primary = null, links = null;
  const properties = [];
  for (const box of boxes(data, meta.start + 4, meta.end)) {
    if (box.type === "pitm") primary = data[box.start] === 0 ? data.readUInt16BE(box.start + 4) : data.readUInt32BE(box.start + 4);
    if (box.type !== "iprp") continue;
    for (const inner of boxes(data, box.start, box.end)) {
      if (inner.type === "ipco") properties.push(...boxes(data, inner.start, inner.end));
      if (inner.type === "ipma") links = inner;
    }
  }
  let mine = null;
  if (links && primary !== null) {
    mine = [];
    const version = data[links.start], wide = data[links.start + 3] & 1;
    const entries = data.readUInt32BE(links.start + 4);
    let at = links.start + 8;
    for (let i = 0; i < entries && at < links.end; i++) {
      const item = version < 1 ? data.readUInt16BE(at) : data.readUInt32BE(at);
      at += version < 1 ? 2 : 4;
      const count = data[at++];
      for (let j = 0; j < count; j++) {
        const index = wide ? data.readUInt16BE(at) & 0x7fff : data[at] & 0x7f;
        at += wide ? 2 : 1;
        if (item === primary && properties[index - 1]) mine.push(properties[index - 1]);
      }
    }
  }
  const area = box => data.readUInt32BE(box.start + 4) * data.readUInt32BE(box.start + 8);
  // The picture's own size. A phone's photo is a grid of small tiles, each with a size of its own: when the
  // file does not say which size is the picture's, the largest one is.
  const extent = mine?.find(box => box.type === "ispe")
    ?? properties.filter(box => box.type === "ispe" && box.end - box.start >= 12).sort((a, b) => area(b) - area(a))[0];
  if (!extent || extent.end - extent.start < 12) return null;
  let width = data.readUInt32BE(extent.start + 4), height = data.readUInt32BE(extent.start + 8);
  // The part of the stored picture that is shown: an encoder that needs even sides stores 38 by 24 for a
  // picture of 37 by 23 and says so here. Each side is a fraction.
  const shown = mine?.find(box => box.type === "clap" && box.end - box.start >= 16);
  if (shown) {
    const across = data.readUInt32BE(shown.start) / data.readUInt32BE(shown.start + 4), down = data.readUInt32BE(shown.start + 8) / data.readUInt32BE(shown.start + 12);
    if (Number.isInteger(across) && Number.isInteger(down) && across > 0 && down > 0 && across <= width && down <= height) { width = across; height = down; }
  }
  // A rotation in quarter turns: one or three shows the picture on its side.
  const rotation = (mine ?? properties).find(box => box.type === "irot" && box.end > box.start);
  return rotation && data[rotation.start] & 1 ? sized(height, width) : sized(width, height);
}

/**
 * `{ width, height }` in pixels, as the picture is shown, or null when the bytes do not say.
 * Takes a Buffer or the Uint8Array SQLite gives back for a stored file.
 */
export function imageSize(bytes) {
  try {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return png(data) ?? jpeg(data) ?? gif(data) ?? webp(data) ?? heif(data);
  } catch {
    // A length inside the file pointed past its end.
    return null;
  }
}

/** A size the sender's app gave with an upload, or null when it gave none that makes sense. */
export function claimedSize(value) {
  return value && typeof value === "object" ? sized(value.width, value.height) : null;
}

/**
 * The size to keep with a stored file `{ mime, data, width?, height? }`: what its own header says. A picture
 * or a video whose header does not say (a video's never does here) keeps the size the sender's app gave.
 */
export function pictureSize(file) {
  return imageSize(file.data) ?? (/^(image|video)\//.test(file.mime) ? claimedSize(file) : null);
}

/** A stored file's row as the app receives it: `width` and `height` only when they are known. */
export function withPictureSize({ width, height, ...file }) {
  return width && height ? { ...file, width, height } : file;
}
