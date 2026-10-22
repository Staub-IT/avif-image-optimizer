#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { program } from 'commander';
import {
  setOutputMode,
  verbose,
  normal,
  quiet,
  error,
  json,
  formatBytes,
  formatTime,
  formatPercentage,
  displayHeader,
  displayFileProgress,
  displaySummary,
  displayFileDiscovery,
  displayNoFilesError,
  displayValidationError,
  COLORS,
  OUTPUT_MODES
} from './output-formatter.js';
import { DEFAULT_CONFIG, SUPPORTED_FORMATS, DEFAULT_EXCLUDED_DIRS, DEFAULT_EXCLUDED_FILES } from './constants.js';
import {
  validateNumericRange,
  validateQuality,
  validateEffort,
  validateInputExists,
  validateOutputDirectory,
  validateDimensions
} from './validation.js';
import {
  convertImageToAvif,
  resolveOutputPath,
  analyzeImageFile,
  getOptimizedDimensions,
  createTimer
} from './image-processor.js';
import { processInParallel, getOptimalConcurrency } from './parallel-processor.js';
import { generateReports } from './report-generator.js';

/**
 * AVIF Image Optimizer
 * Converts JPG, PNG, HEIC, HEIF and other image formats to AVIF with optimization and resizing
 */


/**
 * Find supported image files based on pattern with exclusions
 */
async function findImageFilesWithExclusions(pattern, recursive, excludePatterns = []) {
  // Combine default exclusions with user-provided exclusions
  const allExcludePatterns = [
    ...DEFAULT_EXCLUDED_FILES,
    ...excludePatterns
  ];
  
  // Process exclude patterns to handle both full paths and basenames
  const processedExcludes = [];
  allExcludePatterns.forEach(pattern => {
    processedExcludes.push(pattern);
    // If pattern doesn't contain path separator, also add as a recursive pattern
    if (!pattern.includes('/')) {
      processedExcludes.push(`**/${pattern}`);
    }
  });
  
  const globOptions = { 
    ignore: [...DEFAULT_EXCLUDED_DIRS, ...processedExcludes],
    nodir: true 
  };
  
  let searchPattern = pattern;
  
  // If pattern doesn't contain supported extensions, add them
  const hasExtension = SUPPORTED_FORMATS.some(ext => 
    searchPattern.toLowerCase().includes(ext)
  );
  
  if (!hasExtension) {
    const extensionPattern = `*.{${SUPPORTED_FORMATS.map(ext => ext.slice(1)).join(',')}}`;
    searchPattern = recursive 
      ? path.join(searchPattern, '**', extensionPattern)
      : path.join(searchPattern, extensionPattern);
  }
  
  // Calculate excluded count by comparing with and without exclusions
  let excludedCount = 0;
  // Always calculate excluded count to show default exclusions too
  const minimalIgnoreOptions = { 
    nodir: true 
  };
  const allFiles = await glob(searchPattern, minimalIgnoreOptions);
  const allSupportedFiles = allFiles.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return SUPPORTED_FORMATS.includes(ext);
  });
  
  const files = await glob(searchPattern, globOptions);
  const filteredFiles = files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return SUPPORTED_FORMATS.includes(ext);
  });
  
  excludedCount = allSupportedFiles.length - filteredFiles.length;
  
  return { files: filteredFiles, excludedCount };
}

/**
 * Main conversion function
 */
async function optimizeImages(input, options) {
  const batchTimer = createTimer();
  const config = { ...DEFAULT_CONFIG, ...options };

  setOutputMode(config);
  
  displayHeader({
    ...config,
    supportedFormats: SUPPORTED_FORMATS
  });
  
  // Find image files with exclusions
  const { files: imageFiles, excludedCount } = await findImageFilesWithExclusions(
    input, 
    config.recursive, 
    config.exclude
  );

  if (imageFiles.length === 0) {
    displayNoFilesError(input, SUPPORTED_FORMATS);
    // Return empty results for programmatic use instead of exiting
    return {
      stats: {
        processed: 0,
        skipped: 0,
        resized: 0,
        totalOriginalSize: 0,
        totalOutputSize: 0,
        totalSavingsPercent: 0,
        totalBatchTime: batchTimer.end(),
        totalProcessingTime: 0,
        averageProcessingTime: 0
      },
      results: []
    };
  }

  displayFileDiscovery(imageFiles.length, excludedCount);
  
  // Determine concurrency level
  const concurrency = config.concurrency || getOptimalConcurrency(imageFiles.length);
  if (config.verbose) {
    verbose(`Using concurrency level: ${concurrency}`);
  }
  
  // Process files in parallel
  const processFunction = config.dryRun 
    ? (file) => analyzeImageFile(file, config)
    : (file) => convertImageToAvif(file, config);
  
  let skippedCount = 0;
  const allResults = [];
  
  const { results: processedResults, errors } = await processInParallel(
    imageFiles,
    processFunction,
    {
      concurrency,
      onProgress: ({ result, error }) => {
        if (result) {
          displayFileProgress(result, config);
          if (result.skipped) {
            skippedCount++;
          } else {
            allResults.push(result);
          }
        } else if (error) {
          // Error already displayed by displayFileProgress
        }
      },
      onError: ({ file, error }) => {
        // Create error result for display
        const errorResult = {
          inputPath: file,
          outputPath: resolveOutputPath(file, config),
          error: error.message,
          errorCode: /** @type {Error & {code?: string}} */ (error).code
        };
        displayFileProgress(errorResult, config);
      }
    }
  );

  // Filter out skipped files from results
  const results = allResults.filter(r => !r.skipped);
  
  const totalBatchTime = batchTimer.end();

  // Summary
  if (results.length > 0 || skippedCount > 0) {
    const totalOriginalSize = results.reduce((sum, r) => sum + r.originalSize, 0);
    const totalOutputSize = results.reduce((sum, r) => sum + r.outputSize, 0);
    const totalSavings = totalOriginalSize > 0 
      ? ((totalOriginalSize - totalOutputSize) / totalOriginalSize * 100).toFixed(1)
      : '0';
    const resizedCount = results.filter(r => r.resized || r.dimensionChange).length;
    
    // Calculate timing statistics
    const totalProcessingTime = results.reduce((sum, r) => sum + (r.processingTime || 0), 0);
    const averageProcessingTime = results.length > 0 ? totalProcessingTime / results.length : 0;

    const summary = {
      stats: {
        processed: results.length,
        skipped: skippedCount,
        resized: resizedCount,
        totalOriginalSize,
        totalOutputSize,
        totalSavingsPercent: parseFloat(totalSavings),
        totalBatchTime,
        totalProcessingTime,
        averageProcessingTime,
        concurrency,
        errors: errors.length
      },
      results
    };
    
    displaySummary(summary, config);
    
    // Generate reports if requested
    if (config.generateReport && !config.dryRun && results.length > 0) {
      const reportDir = config.outputDir || process.cwd();
      const reportPaths = generateReports(summary, reportDir);
      
      if (!config.quiet && !config.json) {
        normal(`\n📊 Reports generated:`);
        normal(`  • Markdown: ${reportPaths.markdown}`);
        normal(`  • JSON: ${reportPaths.json}`);
      }
    }
    
    return summary;
  }
}

// CLI Setup
program
  .name('avif-image-optimizer')
  .description('Convert JPG, PNG, HEIC, HEIF and other image formats to AVIF with intelligent optimization')
  .version('1.0.0')
  .argument('<input>', 'Input image file, directory, or glob pattern')
  .option('-w, --max-width <pixels>', 'Maximum width in pixels', (value) => validateNumericRange(value, 1, 50000, 'Max width', ['--max-width 800', '--max-width 1200', '--max-width 1920']), DEFAULT_CONFIG.maxWidth)
  .option('-h, --max-height <pixels>', 'Maximum height in pixels', (value) => validateNumericRange(value, 1, 50000, 'Max height', ['--max-height 600', '--max-height 1200', '--max-height 1080']), DEFAULT_CONFIG.maxHeight)
  .option('-q, --quality <number>', 'AVIF quality (1-100)', validateQuality, DEFAULT_CONFIG.quality)
  .option('-e, --effort <number>', 'Compression effort (1-10)', validateEffort, DEFAULT_CONFIG.effort)
  .option('-o, --output-dir <path>', 'Output directory (default: same as input)')
  .option('--no-resize', 'Keep original dimensions (ignore --max-width/--max-height)')
  .option('--keep-extension', 'Name output <file>.<ext>.avif (e.g. photo.jpg.avif) instead of <file>.avif')
  .option('--base-dir <path>', 'With --output-dir: mirror input paths relative to this directory instead of flattening')
  .option('-r, --recursive', 'Search recursively in subdirectories')
  .option('-f, --force', 'Overwrite existing .avif files without prompting')
  .option('--json', 'Output conversion results as JSON')
  .option('-d, --dry-run', 'Show what files would be processed without converting')
  .option('-x, --exclude <pattern>', 'Glob pattern to exclude (can be used multiple times)', (val, acc) => {
    acc.push(val);
    return acc;
  }, [])
  .option('--no-preserve-original', 'Delete original files after conversion')
  .option('--preserve-exif', 'Preserve EXIF metadata in converted images (increases file size)')
  .option('-c, --concurrency <number>', 'Number of files to process in parallel (default: CPU cores)', (value) => validateNumericRange(value, 1, 32, 'Concurrency', ['--concurrency 4', '--concurrency 8']))
  .option('--generate-report', 'Generate markdown and JSON reports of conversion results')
  .option('--verbose', 'Enable verbose output')
  .option('--quiet', 'Suppress all output except errors and final summary')
  .action(async (input, options) => {
    try {
      // Validate input path existence
      validateInputExists(input);
      
      // Validate output directory if specified
      validateOutputDirectory(options.outputDir);
      
      await optimizeImages(input, {
        maxWidth: options.maxWidth,
        maxHeight: options.maxHeight,
        quality: options.quality,
        effort: options.effort,
        outputDir: options.outputDir,
        noResize: options.resize === false,
        keepExtension: options.keepExtension || false,
        baseDir: options.baseDir || null,
        preserveOriginal: options.preserveOriginal,
        preserveExif: options.preserveExif || DEFAULT_CONFIG.preserveExif,
        recursive: options.recursive,
        force: options.force,
        verbose: options.verbose,
        quiet: options.quiet,
        json: options.json || false,
        dryRun: options.dryRun,
        exclude: options.exclude,
        concurrency: options.concurrency,
        generateReport: options.generateReport || DEFAULT_CONFIG.generateReport
      });
    } catch (err) {
      error('❌ Optimization failed:', err.message);
      process.exit(1);
    }
  });

// Add example usage
program.addHelpText('after', `
Examples:
  $ avif-optimizer image.jpg
  $ avif-optimizer photo.png --quality 80
  $ avif-optimizer ./images --recursive
  $ avif-optimizer "*.{jpg,png}" --max-width 800
  $ avif-optimizer ./photos --output-dir ./optimized
  $ avif-optimizer ./images --force
  $ avif-optimizer image.jpg --quiet
  $ avif-optimizer ./images --dry-run
  $ avif-optimizer ./images --exclude "*.thumb.*"
  $ avif-optimizer ./images --preserve-exif
  $ avif-optimizer ./images --json > report.json
  $ avif-optimizer ./images --concurrency 8
  $ avif-optimizer ./images --generate-report
  $ avif-optimizer wp-content/uploads -r --no-resize --keep-extension \\
      -o wp-content/uploads-webpc/uploads --base-dir wp-content/uploads

Supported formats: ${SUPPORTED_FORMATS.join(', ')}
`);

// Run the program only if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse();
}

export { optimizeImages };