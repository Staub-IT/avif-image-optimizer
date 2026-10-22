import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { convertImageToAvif, resolveOutputPath } from '../image-processor.js';
import { DEFAULT_CONFIG } from '../constants.js';

let tmp;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'avif-sidecar-'));
  await fs.mkdir(path.join(tmp, 'uploads', '2026', '07'), { recursive: true });
  await sharp({ create: { width: 1536, height: 1229, channels: 3, background: { r: 120, g: 90, b: 60 } } })
    .jpeg().toFile(path.join(tmp, 'uploads', '2026', '07', 'photo-1536x1229.jpg'));
});
afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('resolveOutputPath', () => {
  test('default keeps legacy naming', () => {
    expect(resolveOutputPath('/a/b/photo.jpg', {})).toBe('/a/b/photo.avif');
  });
  test('keepExtension appends .avif', () => {
    expect(resolveOutputPath('/a/b/photo.jpg', { keepExtension: true })).toBe('/a/b/photo.jpg.avif');
  });
  test('baseDir mirrors structure under outputDir', () => {
    expect(resolveOutputPath('/w/uploads/2026/07/p.jpg', { keepExtension: true, outputDir: '/w/out', baseDir: '/w/uploads' }))
      .toBe('/w/out/2026/07/p.jpg.avif');
  });
  test('baseDir outside input falls back to flat outputDir', () => {
    expect(resolveOutputPath('/x/p.jpg', { outputDir: '/w/out', baseDir: '/w/uploads' })).toBe('/w/out/p.avif');
  });
});

describe('WordPress sidecar mode', () => {
  test('noResize keeps WordPress size variants untouched and names sidecar correctly', async () => {
    const input = path.join(tmp, 'uploads', '2026', '07', 'photo-1536x1229.jpg');
    const out = path.join(tmp, 'webpc');
    const r = await convertImageToAvif(input, { ...DEFAULT_CONFIG, noResize: true, keepExtension: true, outputDir: out, baseDir: path.join(tmp, 'uploads'), effort: 2 });
    expect(r.error).toBeUndefined();
    expect(r.outputPath).toBe(path.join(out, '2026', '07', 'photo-1536x1229.jpg.avif'));
    const meta = await sharp(r.outputPath).metadata();
    expect(meta.width).toBe(1536);
    expect(meta.height).toBe(1229);
  });
  test('noResize applies EXIF orientation', async () => {
    const input = path.join(tmp, 'uploads', '2026', '07', 'rotated.jpg');
    await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .jpeg().withMetadata({ orientation: 6 }).toFile(input);
    const r = await convertImageToAvif(input, { ...DEFAULT_CONFIG, noResize: true, keepExtension: true, effort: 2 });
    const meta = await sharp(r.outputPath).metadata();
    expect([meta.width, meta.height]).toEqual([200, 300]);
  });
  test('default config still resizes to 1200', async () => {
    const input = path.join(tmp, 'uploads', '2026', '07', 'photo-1536x1229.jpg');
    const r = await convertImageToAvif(input, { ...DEFAULT_CONFIG, outputDir: path.join(tmp, 'flat'), effort: 2 });
    const meta = await sharp(r.outputPath).metadata();
    expect(meta.width).toBe(1200);
  });
});
