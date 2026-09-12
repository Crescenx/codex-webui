import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const assets = new URL('../web/assets/', import.meta.url);
const source = await readFile(new URL('logo-source.png', assets));
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  const images = await page.evaluate(async data => {
    const image = new Image(); image.src = data; await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = image.width, top = image.height, right = 0, bottom = 0;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      if (pixels[(y * image.width + x) * 4 + 3] > 16) {
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
    }
    const width = right - left + 1, height = bottom - top + 1;
    return [16, 32, 48, 64, 128, 256].map(size => {
      canvas.width = canvas.height = size;
      context.fillStyle = '#f5f1e9'; context.fillRect(0, 0, size, size);
      context.imageSmoothingQuality = 'high';
      const scale = size * 0.84 / Math.max(width, height);
      context.drawImage(image, left, top, width, height, (size - width * scale) / 2, (size - height * scale) / 2, width * scale, height * scale);
      return { size, png: canvas.toDataURL('image/png').split(',')[1] };
    });
  }, 'data:image/png;base64,' + source.toString('base64'));
  const pngs = images.map(image => Buffer.from(image.png, 'base64'));
  const header = Buffer.alloc(6 + images.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size }, i) => {
    const entry = 6 + i * 16; header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(pngs[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += pngs[i].length;
  });
  await writeFile(new URL('icon.png', assets), pngs.at(-1));
  await writeFile(new URL('icon.ico', assets), Buffer.concat([header, ...pngs]));
  console.log('Generated icon.png and icon.ico (16–256 px) from logo-source.png');
} finally { await browser.close(); }
