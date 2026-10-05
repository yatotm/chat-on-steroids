import type { RemoteBinding, CoreRemoteBinding, ManagedCoreRemoteBinding } from './remote-execution.js';
export const PROJECT_COLORS = ['blue', 'green', 'amber', 'purple', 'rose', 'teal'] as const;
export type ProjectColor = typeof PROJECT_COLORS[number];

/** Explicit local folder selection. The project grants no filesystem permission. */
export interface LocalProject {
  id: string;
  name: string;
  path: string;
  /** 远程目录由指定 MCP 服务解释，不能交给本机文件系统。 */
  remote?: RemoteProjectBinding;
  /** Optional presentation-only sidebar accent. Never changes workspace or permission semantics. */
  color?: ProjectColor;
  createdAt: number;
  /** Removed sidebar group; existing conversations and queued work retain their folder. */
  ungrouped?: boolean;
}

export type RemoteProjectBinding = RemoteBinding;

export function isCoreRemote(binding: RemoteBinding): binding is CoreRemoteBinding {
  return 'kind' in binding && binding.kind === 'core';
}

export function isManagedRemote(binding: RemoteBinding): binding is ManagedCoreRemoteBinding {
  return isCoreRemote(binding) && 'hostId' in binding;
}
