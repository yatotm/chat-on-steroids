import { z } from 'zod';
import { remoteDirectorySchema, executionTokenSchema } from './remote-execution.js';

export const sshAliasSchema = z.string().min(1).max(128).regex(/^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u);
export const remoteRootsSchema = z.array(remoteDirectorySchema).min(1).max(64)
  .refine(paths => new Set(paths).size === paths.length, 'Remove duplicate approved directories.');
export const remoteHostSchema = z.object({
  id: z.string().uuid(), sshHost: sshAliasSchema, targetKey: z.string().regex(/^[a-f0-9]{64}$/),
  serverId: z.string().uuid(), credentialId: z.string().uuid(), remotePort: z.number().int().min(1).max(65535),
  roots: remoteRootsSchema, enabled: z.boolean(), revision: z.number().int().positive()
}).strict();
export type RemoteHost = z.infer<typeof remoteHostSchema>;
export const saveRemoteHostSchema = z.object({
  id: z.string().uuid().optional(), revision: z.number().int().positive().optional(),
  sshHost: sshAliasSchema, remotePort: z.number().int().min(1).max(65535).default(18787),
  roots: remoteRootsSchema, token: executionTokenSchema.optional(), reuseProjectId: z.string().uuid().optional()
}).strict();
export type SaveRemoteHost = z.infer<typeof saveRemoteHostSchema>;
export type RemoteHostState = 'disconnected' | 'connecting' | 'connected' | 'error' | 'suspended';
export interface RemoteHostView {
  id: string; sshHost: string; serverId: string; remotePort: number; roots: string[]; revision: number; enabled: boolean;
  state: RemoteHostState; checkedAt: number | null; detail: string; localPort: number | null;
}
export interface SshHostChoices { supported: boolean; hosts: string[] }
export const managedRemoteProjectSchema = z.object({
  hostId: z.string().uuid(), directory: remoteDirectorySchema, createDirectory: z.boolean().default(false)
}).strict();
export type ManagedRemoteProject = z.infer<typeof managedRemoteProjectSchema>;

export function insideRemoteRoot(roots: readonly string[], directory: string): boolean {
  return roots.some(root => directory === root || directory.startsWith(root + '/'));
}
