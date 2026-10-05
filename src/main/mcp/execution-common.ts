import { z } from 'zod';
import { formatBytes, type FileInfo } from '../fsops.js';
import type { ToolResult } from './kernel.js';

export const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
export const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
export const pathArg = z.string().min(1).max(4096);
export const lineNumberArg = z.number().int().min(1).max(100_000_000);

export function formatFileInfo(info: FileInfo): string {
  const lines = [
    `path: ${info.virtualPath}`,
    `type: ${info.type}`,
    `size: ${formatBytes(info.bytes)}`,
    `modified: ${info.modified}`,
    `created: ${info.created}`
  ];
  if (info.readOnly) lines.push('readonly: true');
  if (info.binary !== null) lines.push(`binary: ${info.binary}`);
  if (info.lines !== null) lines.push(`lines: ${info.lines}`);
  if (info.sha256) lines.push(`sha256: ${info.sha256}`);
  return lines.join('\n');
}
