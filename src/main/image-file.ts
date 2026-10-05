import { randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { rawPromises as fs } from './rawfs.js';
import { logInfo } from './logger.js';

export class ImageExportError extends Error {}

/** The largest original accepted; generated images are a few megabytes. */
export const MAX_IMAGE_EXPORT_BYTES = 25 * 1024 * 1024;
/** Base64 of the largest original plus the JSON around it. */
export const IMAGE_EXPORT_BODY_BYTES = Math.ceil(MAX_IMAGE_EXPORT_BYTES / 3) * 4 + 64 * 1024;

const FORMATS: Record<string, string> = { png: '.png', jpeg: '.jpg', webp: '.webp' };
const EXTENSIONS: Record<string, string> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' };

export interface ImageExportTarget {
  /** Real destination path, already resolved inside an approved root. */
  real: string;
  /** The same path as the model and the user see it. */
  virtual: string;
}
export interface ImageExportResult { virtual: string; format: string; width: number; height: number; bytes: number }

/** The extension a saved image gets: the one asked for, or the format's own when none was given. */
export function exportFileName(requested: string, format: string): string {
  const own = FORMATS[format];
  if (!own) throw new ImageExportError(`ChatGPT delivered an unsupported image format (${format}).`);
  const extension = path.extname(requested).toLowerCase();
  if (!extension) return requested + own;
  const named = EXTENSIONS[extension];
  if (!named) throw new ImageExportError(`the image is a ${format.toUpperCase()}; name the file with ${own} (or leave the extension out).`);
  if (named !== format) throw new ImageExportError(`the image is a ${format.toUpperCase()}, not ${extension}; name the file with ${own} (or leave the extension out).`);
  return requested;
}

export async function saveImageFile(bytes: Buffer, target: ImageExportTarget): Promise<ImageExportResult> {
  if (bytes.length === 0) throw new ImageExportError('ChatGPT handed out an empty image file.');
  if (bytes.length > MAX_IMAGE_EXPORT_BYTES) throw new ImageExportError('the image is larger than 25 MB.');
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(bytes, { limitInputPixels: 100_000_000 }).metadata();
    // Decoding the pixels, not only the header, proves the file is a whole image.
    await sharp(bytes, { limitInputPixels: 100_000_000 }).stats();
  } catch { throw new ImageExportError('ChatGPT handed out a file that is not a readable image.'); }
  const format = metadata.format ?? 'unknown';
  const file = exportFileName(target.real, format);
  const virtual = exportFileName(target.virtual, format);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Written beside the destination, then linked into place: a link never replaces an existing
  // file, so a name taken meanwhile fails instead of being overwritten, and no half file appears.
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.part`);
  await fs.writeFile(temporary, bytes, { flag: 'wx' });
  try {
    await fs.link(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ImageExportError(`${virtual} already exists. Choose another name.`);
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
  const result = { virtual, format, width: metadata.width ?? 0, height: metadata.height ?? 0, bytes: bytes.length };
  logInfo(`image export saved ${virtual} (${result.width}x${result.height} ${format}, ${bytes.length} bytes)`);
  return result;
}
