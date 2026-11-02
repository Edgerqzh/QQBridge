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
  const output = {};
  for (const side of [198, 720]) {
    const image = await sharp(bytes, { limitInputPixels: 40000000, failOn: 'error' })
      .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 }).toBuffer();
    output[side] = image.toString('base64');
  }
  process.stdout.write(JSON.stringify(output));
} catch { process.exitCode = 1; }
