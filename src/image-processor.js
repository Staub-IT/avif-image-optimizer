/**
 * @fileoverview Core image processing module for AVIF Image Optimizer
 * 
 * Handles image conversion, dimension optimization, and metadata processing
 * with support for HEIC/HEIF formats and comprehensive error handling.
 * 
 * @module image-processor
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import {
  verbose,
  formatTime,
  formatBytes
} from './output-formatter.js';
import {
  ERROR_TYPES,
  createError,
  createTimedErrorResponse
} from './error-handler.js';
import { DEFAULT_CONFIG } from './constants.js';

/**
 * Timing utility functions for high precision measurement
 * @returns {{end: function(): number}} Timer object with end method
 * @example
 * const timer = createTimer();
 * // ... do some work ...
 * const elapsedMs = timer.end(); // Returns elapsed time in milliseconds
 */
export function createTimer() {
  const startTime = process.hrtime.bigint();
  
  return {
    end() {
      const endTime = process.hrtime.bigint();
      const duration = endTime - startTime;
      return Number(duration) / 1000000; // Convert nanoseconds to milliseconds
    }
  };
}

/**
 * Get optimized dimensions while maintaining aspect ratio
 * @param {number} width - Original width in pixels
 * @param {number} height - Original height in pixels
 * @param {number} maxWidth - Maximum allowed width in pixels
 * @param {number} maxHeight - Maximum allowed height in pixels
 * @returns {{width: number, height: number}} Optimized dimensions that fit within constraints
 * @example
 * // Scale a 3000x2000 image to fit within 1200x1200
 * const dims = getOptimizedDimensions(3000, 2000, 1200, 1200);
 * // Returns { width: 1200, height: 800 }
 */
export function getOptimizedDimensions(width, height, maxWidth, maxHeight) {
  const aspectRatio = width / height;
  
  if (width <= maxWidth && height <= maxHeight) {
    return { width, height };
  }
  
  let newWidth, newHeight;
  
  if (width > height) {
    newWidth = Math.min(width, maxWidth);
    newHeight = Math.round(newWidth / aspectRatio);
  } else {
    newHeight = Math.min(height, maxHeight);
    newWidth = Math.round(newHeight * aspectRatio);
  }
  
  // Ensure we don't exceed max dimensions
  if (newWidth > maxWidth) {
    newWidth = maxWidth;
    newHeight = Math.round(newWidth / aspectRatio);
  }
  
  if (newHeight > maxHeight) {
    newHeight = maxHeight;
    newWidth = Math.round(newHeight * aspectRatio);
  }
  
  return { width: newWidth, height: newHeight };
}

/**
 * Convert HEIC/HEIF to intermediate format for Sharp processing
 * @param {Buffer} inputBuffer - Input image buffer
 * @param {number} quality - Quality setting (0-1 scale)
 * @returns {Promise<{buffer: Buffer|null, success: boolean, error?: string}>} Preprocessing result
 * @private
 */
async function preprocessHeicImage(inputBuffer, quality = 0.85) {
  try {
    verbose('  📱 Converting HEIC/HEIF to JPEG for processing...');
    
    const outputBuffer = await heicConvert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: quality
    });
    
    return {
      buffer: outputBuffer,
      success: true
    };
  } catch (error) {
    return {
      buffer: null,
      success: false,
      error: error.message
    };
  }
}

/**
 * Known HEIC/HEIF brand identifiers found in the ISO BMFF "ftyp" box
 * @constant {string[]}
 * @private
 */
const HEIC_BRANDS = [
  'heic', 'heix', 'hevc', 'hevx',
  'heim', 'heis', 'hevm', 'hevs',
  'mif1', 'msf1'
];

/**
 * Detect whether a buffer contains HEIC/HEIF image data
 *
 * Checks the ISO BMFF "ftyp" box magic bytes: 'ftyp' at byte offset 4
 * followed by a known HEIC/HEIF brand at byte offset 8.
 *
 * @param {Buffer} buffer - Buffer to inspect
 * @returns {boolean} True if the buffer looks like a HEIC/HEIF image
 * @example
 * if (isHeicBuffer(uploadedBuffer)) {
 *   console.log('iPhone HEIC photo detected');
 * }
 */
export function isHeicBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return false;
  }

  if (buffer.toString('ascii', 4, 8) !== 'ftyp') {
    return false;
  }

  const brand = buffer.toString('ascii', 8, 12);
  return HEIC_BRANDS.includes(brand);
}

/**
 * Convert an in-memory image buffer to an AVIF buffer
 *
 * Designed for server-side use cases (e.g. Next.js upload routes) where
 * images should be converted without touching the filesystem. Accepts the
 * same formats as the file API (JPG, PNG, WebP, TIFF) plus HEIC/HEIF
 * buffers (e.g. iPhone uploads), which are detected via {@link isHeicBuffer}
 * and transparently preprocessed with heic-convert. Images are never
 * upscaled.
 *
 * NOTE: Unlike the file-based API (convertImageToAvif), which returns an
 * object with an `error` property on failure, this function THROWS on
 * invalid input or conversion failure.
 *
 * @param {Buffer} inputBuffer - Input image buffer
 * @param {Object} [options={}] - Conversion options
 * @param {number} [options.maxWidth] - Maximum width in pixels (default: DEFAULT_CONFIG.maxWidth)
 * @param {number} [options.maxHeight] - Maximum height in pixels (default: DEFAULT_CONFIG.maxHeight)
 * @param {number} [options.maxDimension] - Shorthand that sets both maxWidth and maxHeight
 * @param {number} [options.quality] - AVIF quality 1-100 (default: DEFAULT_CONFIG.quality)
 * @param {number} [options.effort] - AVIF effort level 0-10 (default: DEFAULT_CONFIG.effort)
 * @param {boolean} [options.preserveExif] - Preserve EXIF metadata (default: DEFAULT_CONFIG.preserveExif)
 * @returns {Promise<{buffer: Buffer, width: number, height: number, originalWidth: number, originalHeight: number, originalSize: number, outputSize: number, wasPreprocessed: boolean, resized: boolean, processingTime: number}>} Conversion result with the AVIF buffer
 * @throws {Error} If the input is not a valid image buffer or conversion fails
 * @example
 * const { buffer } = await convertBufferToAvif(uploadBuffer, {
 *   maxDimension: 1600,
 *   quality: 60
 * });
 */
export async function convertBufferToAvif(inputBuffer, options = {}) {
  const overallTimer = createTimer();

  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw createError(
      'Input must be a non-empty Buffer',
      ERROR_TYPES.INVALID_INPUT
    );
  }

  const maxWidth = options.maxWidth ?? options.maxDimension ?? DEFAULT_CONFIG.maxWidth;
  const maxHeight = options.maxHeight ?? options.maxDimension ?? DEFAULT_CONFIG.maxHeight;
  const quality = options.quality ?? DEFAULT_CONFIG.quality;
  const effort = options.effort ?? DEFAULT_CONFIG.effort;
  const preserveExif = options.preserveExif ?? DEFAULT_CONFIG.preserveExif;

  const originalSize = inputBuffer.length;
  let sharpInput = inputBuffer;
  let wasPreprocessed = false;

  // HEIC/HEIF buffers need preprocessing before Sharp can handle them
  if (isHeicBuffer(inputBuffer)) {
    const preprocessResult = await preprocessHeicImage(
      inputBuffer,
      quality / 100 // Convert quality scale
    );

    if (!preprocessResult.success) {
      throw createError(
        `HEIC preprocessing failed: ${preprocessResult.error}`,
        ERROR_TYPES.HEIC_PREPROCESSING_FAILED
      );
    }

    sharpInput = preprocessResult.buffer;
    wasPreprocessed = true;
    verbose('  📱 HEIC/HEIF preprocessing completed');
  }

  // Read metadata (throws for invalid/garbage buffers)
  const metadata = await sharp(sharpInput).metadata();
  const { width: originalWidth, height: originalHeight } = metadata;

  if (!originalWidth || !originalHeight) {
    throw createError(
      'Unable to read image dimensions from buffer',
      ERROR_TYPES.METADATA_ERROR
    );
  }

  // Calculate optimized dimensions (never upscale)
  const { width: targetWidth, height: targetHeight } = getOptimizedDimensions(
    originalWidth,
    originalHeight,
    maxWidth,
    maxHeight
  );

  const sharpInstance = sharp(sharpInput)
    .resize(targetWidth, targetHeight, {
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: true
    });

  // Conditionally preserve EXIF metadata
  if (preserveExif) {
    sharpInstance.keepMetadata();
  }

  const { data: outputBuffer, info } = await sharpInstance
    .avif({
      quality,
      effort,
      chromaSubsampling: '4:2:0'
    })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: outputBuffer,
    width: info.width,
    height: info.height,
    originalWidth,
    originalHeight,
    originalSize,
    outputSize: outputBuffer.length,
    wasPreprocessed,
    resized: info.width !== originalWidth || info.height !== originalHeight,
    processingTime: overallTimer.end()
  };
}

/**
 * Resolve the output path for a converted file.
 * - keepExtension: name output "<name>.<ext>.avif" (e.g. photo.jpg.avif), the sidecar
 *   convention used by WordPress converters and Apache rewrite rules.
 * - baseDir: when set together with outputDir, mirror the input's path relative to
 *   baseDir below outputDir instead of flattening every file into one directory.
 * @param {string} inputPath
 * @param {{outputDir?: ?string, keepExtension?: boolean, baseDir?: ?string}} config
 * @returns {string}
 */
export function resolveOutputPath(inputPath, config = {}) {
  const inputDir = path.dirname(inputPath);
  const inputExt = path.extname(inputPath);
  const fileName = config.keepExtension
    ? `${path.basename(inputPath)}.avif`
    : `${path.basename(inputPath, inputExt)}.avif`;
  let outputDir = config.outputDir || inputDir;
  if (config.outputDir && config.baseDir) {
    const rel = path.relative(path.resolve(config.baseDir), path.resolve(inputDir));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      outputDir = path.join(config.outputDir, rel);
    }
  }
  return path.join(outputDir, fileName);
}

/**
 * Like getOptimizedDimensions, but returns the original size when noResize is set.
 */
function targetDimensions(width, height, config) {
  if (config.noResize) return { width, height };
  return getOptimizedDimensions(width, height, config.maxWidth, config.maxHeight);
}

/**
 * Convert a single image file to AVIF
 * @param {string} inputPath - Path to input image
 * @param {Object} config - Configuration object
 * @param {number} config.quality - AVIF quality (1-100)
 * @param {number} config.effort - AVIF effort level (1-10)
 * @param {number} config.maxWidth - Maximum width in pixels
 * @param {number} config.maxHeight - Maximum height in pixels
 * @param {?string} config.outputDir - Output directory (null = same as input)
 * @param {boolean} config.preserveExif - Whether to preserve EXIF metadata
 * @param {boolean} config.force - Whether to overwrite existing files
 * @param {boolean} [config.noResize] - Keep original dimensions
 * @param {boolean} [config.keepExtension] - Output <file>.<ext>.avif
 * @param {?string} [config.baseDir] - Mirror structure below outputDir relative to this path
 * @returns {Promise<{inputPath: string, outputPath: string, originalSize?: number, outputSize?: number, sizeSavings?: number, originalWidth?: number, originalHeight?: number, newWidth?: number, newHeight?: number, resized?: boolean, preserveExif?: boolean, wasPreprocessed?: boolean, skipped?: boolean, error?: string, errorCode?: string, processingTime?: number, metadataTime?: number, conversionTime?: number}>} Processing result
 * @throws {Error} If preprocessing or conversion fails
 * @example
 * const result = await convertImageToAvif('./photo.jpg', {
 *   quality: 80,
 *   effort: 6,
 *   maxWidth: 1200,
 *   maxHeight: 1200,
 *   preserveExif: true
 * });
 */
export async function convertImageToAvif(inputPath, config) {
  const overallTimer = createTimer();
  
  try {
    const inputDir = path.dirname(inputPath);
    const inputExt = path.extname(inputPath).toLowerCase();
    const inputName = path.basename(inputPath, inputExt);
    const outputPath = resolveOutputPath(inputPath, config);
    const outputDir = path.dirname(outputPath);

    // Skip if output exists and not forcing
    try {
      await fs.access(outputPath);
      if (!config.force) {
        return { 
          inputPath,
          outputPath,
          skipped: true 
        };
      }
    } catch {
      // File doesn't exist, continue processing
    }

    // Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });
    
    // Read input file and handle HEIC preprocessing
    const metadataTimer = createTimer();
    let imageBuffer = await fs.readFile(inputPath);
    /** @type {string|Buffer} */
    let sharpInput = inputPath;
    let wasPreprocessed = false;
    
    // Check if HEIC/HEIF file needs preprocessing
    if (['.heic', '.heif'].includes(inputExt)) {
      const preprocessResult = await preprocessHeicImage(
        imageBuffer, 
        config.quality / 100 // Convert quality scale
      );
      
      if (!preprocessResult.success) {
        throw createError(
          `HEIC preprocessing failed: ${preprocessResult.error}`,
          ERROR_TYPES.HEIC_PREPROCESSING_FAILED
        );
      }
      
      imageBuffer = preprocessResult.buffer;
      sharpInput = imageBuffer;
      wasPreprocessed = true;
      verbose('  📱 HEIC/HEIF preprocessing completed');
    }
    
    // Get image metadata and file size
    const metadata = await sharp(sharpInput).metadata();
    const metadataTime = metadataTimer.end();
    
    const { width: originalWidth, height: originalHeight } = metadata;
    const originalStats = await fs.stat(inputPath);
    const originalSize = originalStats.size;

    verbose(`Processing: ${inputPath}`);
    verbose(`Original dimensions: ${originalWidth}x${originalHeight}`);

    // Calculate optimized dimensions
    const { width: newWidth, height: newHeight } = targetDimensions(originalWidth, originalHeight, config);

    verbose(`Optimized dimensions: ${newWidth}x${newHeight}`);

    // Convert to AVIF with optimization
    const conversionTimer = createTimer();
    // noResize: skip resizing entirely and auto-orient from EXIF, so a WordPress
    // size variant keeps its exact pixel size and the sidecar never shows rotated.
    const sharpInstance = config.noResize
      ? sharp(sharpInput).rotate()
      : sharp(sharpInput)
        .resize(newWidth, newHeight, {
          kernel: sharp.kernel.lanczos3,
          withoutEnlargement: true
        });
    
    // Conditionally preserve EXIF metadata
    if (config.preserveExif) {
      sharpInstance.keepMetadata();
    }
    
    await sharpInstance
      .avif({
        quality: config.quality,
        effort: config.effort,
        chromaSubsampling: '4:2:0'
      })
      .toFile(outputPath);
    const conversionTime = conversionTimer.end();
    
    // Get output file size
    const outputStats = await fs.stat(outputPath);
    const outputSize = outputStats.size;
    
    // Calculate savings and total processing time
    const sizeSavings = ((originalSize - outputSize) / originalSize * 100).toFixed(1);
    const dimensionChange = originalWidth !== newWidth || originalHeight !== newHeight;
    const totalProcessingTime = overallTimer.end();

    return {
      inputPath,
      outputPath,
      originalSize,
      outputSize,
      sizeSavings: parseFloat(sizeSavings),
      originalWidth,
      originalHeight,
      newWidth,
      newHeight,
      resized: dimensionChange,
      preserveExif: config.preserveExif,
      wasPreprocessed: wasPreprocessed,
      skipped: false,
      processingTime: totalProcessingTime,
      metadataTime,
      conversionTime
    };
    
  } catch (error) {
    const totalProcessingTime = overallTimer.end();
    const outputPath = resolveOutputPath(inputPath, config);
    return {
      inputPath,
      outputPath,
      error: error.message,
      errorCode: error.code,
      processingTime: totalProcessingTime
    };
  }
}

/**
 * Analyze a single image file without converting (dry run)
 * @param {string} inputPath - Path to input image
 * @param {Object} config - Configuration object (same as convertImageToAvif)
 * @returns {Promise<{inputPath: string, outputPath: string, originalSize?: number, outputSize?: number, sizeSavings?: number, originalWidth?: number, originalHeight?: number, newWidth?: number, newHeight?: number, resized?: boolean, dimensionChange?: boolean, preserveExif?: boolean, wasPreprocessed?: boolean, processingTime?: number, metadataTime?: number, error?: string, errorCode?: string}>} Analysis result with estimated output size
 * @example
 * // Analyze what would happen without actually converting
 * const analysis = await analyzeImageFile('./photo.jpg', config);
 * console.log(`Would save ${analysis.sizeSavings}% space`);
 */
export async function analyzeImageFile(inputPath, config) {
  const overallTimer = createTimer();
  
  try {
    const inputDir = path.dirname(inputPath);
    const inputExt = path.extname(inputPath).toLowerCase();
    const inputName = path.basename(inputPath, inputExt);
    const outputPath = resolveOutputPath(inputPath, config);
    const outputDir = path.dirname(outputPath);

    // Handle HEIC preprocessing for analysis (dry run)
    const metadataTimer = createTimer();
    /** @type {string|Buffer} */
    let sharpInput = inputPath;
    let wasPreprocessed = false;
    
    // Check if HEIC/HEIF file needs preprocessing for metadata reading
    if (['.heic', '.heif'].includes(inputExt)) {
      let imageBuffer = await fs.readFile(inputPath);
      const preprocessResult = await preprocessHeicImage(
        imageBuffer, 
        config.quality / 100
      );
      
      if (!preprocessResult.success) {
        throw createError(
          `HEIC preprocessing failed: ${preprocessResult.error}`,
          ERROR_TYPES.HEIC_PREPROCESSING_FAILED
        );
      }
      
      sharpInput = preprocessResult.buffer;
      wasPreprocessed = true;
      verbose('  📱 HEIC/HEIF preprocessing completed (dry run)');
    }
    
    const metadata = await sharp(sharpInput).metadata();
    const metadataTime = metadataTimer.end();
    
    const { width: originalWidth, height: originalHeight } = metadata;
    const originalStats = await fs.stat(inputPath);
    const originalSize = originalStats.size;

    const { width: newWidth, height: newHeight } = targetDimensions(originalWidth, originalHeight, config);

    const pixelRatio = (newWidth * newHeight) / (originalWidth * originalHeight);
    const estimatedSize = Math.round(originalSize * pixelRatio * 0.6);
    const sizeSavings = ((originalSize - estimatedSize) / originalSize * 100).toFixed(1);
    const dimensionChange = (originalWidth !== newWidth || originalHeight !== newHeight)
      ? ` (${originalWidth}x${originalHeight} → ${newWidth}x${newHeight})`
      : '';
    
    const totalProcessingTime = overallTimer.end();

    return {
      inputPath,
      outputPath,
      originalSize,
      outputSize: estimatedSize,
      sizeSavings: parseFloat(sizeSavings),
      originalWidth,
      originalHeight,
      newWidth,
      newHeight,
      resized: dimensionChange !== '',
      dimensionChange: dimensionChange !== '',
      preserveExif: config.preserveExif,
      wasPreprocessed: wasPreprocessed,
      processingTime: totalProcessingTime,
      metadataTime
    };
  } catch (error) {
    const totalProcessingTime = overallTimer.end();
    const outputPath = resolveOutputPath(inputPath, config);
    return {
      inputPath,
      outputPath,
      error: error.message,
      errorCode: error.code,
      processingTime: totalProcessingTime
    };
  }
}

/**
 * Check if file exists using async fs operations
 * @param {string} filePath - Path to check
 * @returns {Promise<boolean>} True if file exists, false otherwise
 * @example
 * if (await fileExists('./output.avif')) {
 *   console.log('Output already exists');
 * }
 */
export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file stats using async fs operations
 * @param {string} filePath - Path to file
 * @returns {Promise<import('fs').Stats|null>} File stats or null if error
 * @example
 * const stats = await getFileStats('./image.jpg');
 * if (stats) {
 *   console.log(`File size: ${stats.size} bytes`);
 * }
 */
export async function getFileStats(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}