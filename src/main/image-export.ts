import { ImageExportError, MAX_IMAGE_EXPORT_BYTES, saveImageFile, type ImageExportTarget, type ImageExportResult } from './image-file.js';
export { ImageExportError, MAX_IMAGE_EXPORT_BYTES, IMAGE_EXPORT_BODY_BYTES, exportFileName, type ImageExportTarget, type ImageExportResult } from './image-file.js';
/**
 * Saves the original of an image ChatGPT generated in a chat into an approved folder (#889).
 *
 * The recording keeps only a bounded preview of a generated image (WebP, at most 1600 px), so the
 * original has to come from ChatGPT itself. The page that shows the image already holds it: its
 * `<img>` loads ChatGPT's own same-origin URL (or a page `blob:`), and the page script fetches
 * exactly that, with the page's own session. No signed URL, cookie or file credential reaches this
 * app or the model, and the app never contacts ChatGPT for it.
 *
 * Flow: the tool call registers one export here; `/status` hands it to the browser, which routes
 * it to the tab showing that chat; the page posts the bytes to `/image-export`; this module checks
 * them (size, a real PNG/JPEG/WebP that decodes) and writes them without ever replacing a file.
 */
import { randomUUID } from 'node:crypto';
import { wakeBrowserWork } from './browser-wake.js';
import { logInfo } from './logger.js';

export const IMAGE_EXPORT_TIMEOUT_MS = 60_000;
export type ImageExportSink = (bytes: Buffer) => Promise<ImageExportResult>;

/** Page-side refusals, in words a person can act on. */
const PAGE_ERRORS: Record<string, string> = {
  not_open: 'the chat is not open in the browser. Open it in ChatGPT and try again.',
  not_rendered: 'the image is not shown on the chat\'s page right now. Scroll it into view in ChatGPT and try again.',
  fetch_failed: 'ChatGPT did not hand out the image file.',
  not_image: 'ChatGPT answered with something that is not an image.',
  too_large: `the image is larger than ${MAX_IMAGE_EXPORT_BYTES / 1024 / 1024} MB.`,
  unsupported: 'this browser companion cannot save images yet. Update the browser extension and try again.'
};

interface Pending {
  nonce: string;
  conversationId: string;
  messageId: string;
  assetId: string;
  target: ImageExportTarget | ImageExportSink;
  claimed: boolean;
  timer: ReturnType<typeof setTimeout>;
  expiresAt: number;
  settle: (result: ImageExportResult | Error) => void;
}
const pending = new Map<string, Pending>();


/** Exports waiting for the browser, without their destinations: those never leave the app. */
export function pendingImageExports(now = Date.now()): Array<{ nonce: string; conversationId: string; messageId: string; assetId: string }> {
  for (const entry of [...pending.values()]) if (!entry.claimed && now >= entry.expiresAt) entry.settle(new ImageExportError('the browser did not deliver the image in time. Make sure the chat is open in ChatGPT and try again.'));
  return [...pending.values()].filter(entry => !entry.claimed).map(({ nonce, conversationId, messageId, assetId }) => ({ nonce, conversationId, messageId, assetId }));
}

/** Asks the browser for one image and resolves once it is saved, or rejects with a readable reason. */
export function exportImage(
  image: { conversationId: string; messageId: string; assetId: string },
  target: ImageExportTarget | ImageExportSink,
  timeoutMs = IMAGE_EXPORT_TIMEOUT_MS
): Promise<ImageExportResult> {
  return new Promise((resolve, reject) => {
    const nonce = randomUUID();
    const timer = setTimeout(() => entry.settle(new ImageExportError('the browser did not deliver the image in time. Make sure the chat is open in ChatGPT and try again.')), timeoutMs);
    timer.unref?.();
    const entry: Pending = {
      nonce, ...image, target, claimed: false, timer, expiresAt: Date.now() + timeoutMs,
      settle: (result) => {
        if (pending.get(nonce) !== entry) return;
        pending.delete(nonce);
        clearTimeout(timer);
        if (result instanceof Error) reject(result); else resolve(result);
      }
    };
    pending.set(nonce, entry);
    logInfo(`image export requested id=${nonce} conversation=${image.conversationId}`);
    wakeBrowserWork();
  });
}

/**
 * The page's answer for one export: base64 bytes, or a refusal code. Returns false for an unknown
 * or settled nonce, so a late or repeated delivery changes nothing.
 */
export async function completeImageExport(raw: unknown): Promise<boolean> {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const entry = typeof body.nonce === 'string' ? pending.get(body.nonce) : undefined;
  if (!entry || entry.claimed) return false;
  if (Date.now() >= entry.expiresAt) { entry.settle(new ImageExportError('the browser did not deliver the image in time.')); return false; }
  if (typeof body.error === 'string') {
    entry.settle(new ImageExportError(PAGE_ERRORS[body.error] ?? 'the browser could not read the image.'));
    return true;
  }
  if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) {
    entry.settle(new ImageExportError('the browser sent the image in an unreadable form.'));
    return true;
  }
  // 已收到原图后，一次交付只领取一次写入；取图超时不再截断正在进行的保存。
  entry.claimed = true; clearTimeout(entry.timer);
  try {
    const bytes = Buffer.from(body.data, 'base64');
    entry.settle(await (typeof entry.target === 'function' ? entry.target(bytes) : saveImageFile(bytes, entry.target)));
  } catch (error) {
    entry.settle(error instanceof ImageExportError ? error : new ImageExportError(`the image could not be saved: ${(error as Error).message}`));
  }
  return true;
}

export function resetImageExportsForTests(): void {
  for (const entry of [...pending.values()]) entry.settle(new ImageExportError('reset'));
}
