/**
 * @fileoverview AVIF Image Optimizer - Shared Constants
 * 
 * Central location for all configuration defaults and constants
 * shared between CLI and programmatic interfaces.
 * 
 * @module constants
 */

/**
 * Default configuration for image optimization
 * @typedef {Object} DefaultConfig
 * @property {number} maxWidth - Maximum width in pixels (default: 1200)
 * @property {number} maxHeight - Maximum height in pixels (default: 1200)
 * @property {number} quality - AVIF quality 1-100 (default: 60)
 * @property {number} effort - AVIF effort level 0-10 (default: 6)
 * @property {?string} outputDir - Output directory path (null = same as input)
 * @property {boolean} preserveOriginal - Keep original files (default: true)
 * @property {boolean} preserveExif - Preserve EXIF metadata (default: false)
 * @property {boolean} recursive - Process directories recursively (default: false)
 * @property {boolean} force - Overwrite existing AVIF files (default: false)
 * @property {boolean} verbose - Show detailed output (default: false)
 * @property {boolean} quiet - Suppress all output except errors (default: false)
 * @property {boolean} json - Output results as JSON (default: false)
 * @property {boolean} dryRun - Preview without processing (default: false)
 * @property {string[]} exclude - Glob patterns to exclude (default: [])
 * @property {boolean} generateReport - Generate markdown and JSON reports (default: false)
 * @constant {DefaultConfig}
 */
export const DEFAULT_CONFIG = {
  maxWidth: 1200,
  maxHeight: 1200,
  quality: 60,
  effort: 6,
  outputDir: null, // Same directory as input by default
  noResize: false, // Keep original dimensions when true
  keepExtension: false, // Output photo.jpg.avif instead of photo.avif
  baseDir: null, // Mirror directory structure below outputDir relative to this path
  preserveOriginal: true,
  preserveExif: false, // Strip metadata by default for smaller files
  recursive: false,
  force: false,
  verbose: false,
  quiet: false,
  json: false,
  dryRun: false,
  exclude: [],
  generateReport: false
};

/**
 * Supported input image formats
 * Includes common formats and iPhone/modern camera formats (HEIC/HEIF)
 * @constant {string[]}
 * @example
 * // Check if a file is supported
 * const isSupported = SUPPORTED_FORMATS.includes(path.extname(filename).toLowerCase());
 */
export const SUPPORTED_FORMATS = [
  '.jpg', 
  '.jpeg', 
  '.png', 
  '.webp', 
  '.tiff', 
  '.tif', 
  '.heic', 
  '.heif'
];

/**
 * Default directories to exclude from image processing
 * @constant {string[]}
 */
export const DEFAULT_EXCLUDED_DIRS = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  '.cache/**',
  '.next/**',
  'out/**',
  'coverage/**',
  '.nuxt/**',
  '.output/**',
  'vendor/**',
  'bower_components/**'
];

/**
 * Default file patterns to exclude from image processing
 * Common web assets that shouldn't be converted to AVIF
 * @constant {string[]}
 */
export const DEFAULT_EXCLUDED_FILES = [
  // Favicons
  'favicon.ico',
  'favicon*.png',
  'favicon-*.png',
  
  // Apple touch icons
  'apple-touch-icon*.png',
  'apple-touch-icon-*.png',
  
  // PWA and app icons
  'icon-*.png',
  'icons-*.png',
  'maskable-icon*.png',
  'pwa-*.png',
  'manifest-icon-*.png',
  'android-chrome-*.png',
  'mstile-*.png',
  
  // Social media and Open Graph images
  'og-image.png',
  'og-image.jpg',
  'twitter-image.png',
  'twitter-image.jpg',
  'opengraph-image.png',
  'opengraph-image.jpg',
  'social-*.png',
  'social-*.jpg',
  
  // Browser config icons
  'browserconfig.xml',
  'safari-pinned-tab.svg',
  
  // Splash screens
  'splash-*.png',
  'launch-*.png',
  'apple-splash-*.png',
  
  // Other common patterns
  'logo.svg',
  'sprite.svg',
  'sprites.svg'
];