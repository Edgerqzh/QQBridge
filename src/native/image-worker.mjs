// Keep the image library out of the Windows QQ host: both ship a libvips DLL.
let size = 0;
const input = [];
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 24 * 1024 * 1024) throw new Error();
    input.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(input).toString('utf8'));
  if (typeof request.data !== 'string') throw new Error();
  const bytes = Buffer.from(request.data, 'base64');
  if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw new Error();
  const { default: sharp } = await import('sharp');
  sharp.cache(false);
  sharp.concurrency(1);
  let output;
  if (request.mode === 'avatar') {
    if (bytes.length > 6 * 1024 * 1024) throw new Error();
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const gif = ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
    const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!png && !jpeg && !gif && !webp) throw new Error();
    // Only open the first frame, including for GIF and animated WebP. Decode it
    // fully before resizing so truncated images cannot pass a metadata check.
    const image = sharp(bytes, { limitInputPixels: 40000000, failOn: 'warning', page: 0, pages: 1 });
    const meta = await image.metadata();
    const height = meta.pageHeight ?? meta.height;
    if (!['png', 'jpeg', 'gif', 'webp'].includes(meta.format) ||
        !Number.isInteger(meta.width) || !Number.isInteger(height) ||
        meta.width < 1 || height < 1 || meta.width * height > 40000000) throw new Error();
    const decoded = await image.autoOrient().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    const { width, channels } = decoded.info, decodedHeight = decoded.info.height;
    if (width * decodedHeight > 40000000 || ![3, 4].includes(channels)) throw new Error();
    let transparent = false;
    if (channels === 4) for (let i = 3; i < decoded.data.length; i += 4) {
      if (decoded.data[i] !== 255) { transparent = true; break; }
    }
    const resized = sharp(decoded.data, { raw: { width, height: decodedHeight, channels } })
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true });
    const converted = await (transparent ? resized.png() : resized.jpeg({ quality: 90 })).toBuffer({ resolveWithObject: true });
    if (converted.data.length > 6 * 1024 * 1024) throw new Error();
    output = { format: transparent ? 'png' : 'jpeg', width: converted.info.width, height: converted.info.height, data: converted.data.toString('base64') };
  } else {
    if (request.mode !== undefined && request.mode !== 'thumbnails') throw new Error();
    output = {};
    for (const side of [198, 720]) {
      const image = await sharp(bytes, { limitInputPixels: 40000000, failOn: 'error' })
        .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 }).toBuffer();
      output[side] = image.toString('base64');
    }
  }
  process.stdout.write(JSON.stringify(output));
} catch { process.exitCode = 1; }
