/**
 * What the Files tab does with a file, decided by its name: which editor language, whether
 * it can be previewed as an image, whether it is an archive it can extract.
 */

export type EditorLanguage =
  | 'php'
  | 'javascript'
  | 'typescript'
  | 'jsx'
  | 'css'
  | 'html'
  | 'json'
  | 'xml'
  | 'markdown'
  | 'yaml'
  | 'sql'
  | 'ini'
  | 'shell'
  | 'plain';

const LANGUAGES: Record<string, EditorLanguage> = {
  php: 'php',
  phtml: 'php',
  inc: 'php',
  module: 'php',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  jsx: 'jsx',
  tsx: 'jsx',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  twig: 'html',
  json: 'json',
  webmanifest: 'json',
  xml: 'xml',
  svg: 'xml',
  xsl: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  ini: 'ini',
  conf: 'ini',
  env: 'ini',
  htaccess: 'ini',
  sh: 'shell',
  bash: 'shell',
};

const extensionOf = (name: string): string => {
  const lower = name.toLowerCase();
  // `.htaccess`, `.env`: the whole name is the "extension".
  if (lower.startsWith('.') && lower.indexOf('.', 1) === -1) return lower.slice(1);
  const dot = lower.lastIndexOf('.');
  return dot <= 0 ? '' : lower.slice(dot + 1);
};

export function languageFor(name: string): EditorLanguage {
  return LANGUAGES[extensionOf(name)] ?? 'plain';
}

export const isPhp = (name: string): boolean => languageFor(name) === 'php';

/**
 * Images shown by the preview, and the type they are shown as. The type comes from this
 * list, never from the server or the file: an SVG is only ever an `<img>`, where its
 * scripts do not run.
 */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

export function imageTypeFor(name: string): string | null {
  return IMAGE_TYPES[extensionOf(name)] ?? null;
}

export const isZip = (name: string): boolean => extensionOf(name) === 'zip';

/** Files that are never text, so opening one goes straight to its download or preview. */
const BINARY = new Set([
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'pdf', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'ogg',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'psd', 'ai', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'so', 'mo',
]);

export const isKnownBinary = (name: string): boolean => BINARY.has(extensionOf(name));
