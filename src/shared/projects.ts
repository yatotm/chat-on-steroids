/** 用户选择的本机或远程目录；项目关联不授予额外权限。 */
export interface LocalProject {
  id: string;
  name: string;
  /** Authoritative default workspace and project-instruction directory. */
  path: string;
  /** Canonical linked folders; membership never grants access and the primary remains authoritative. */
  additionalPaths?: string[];
  /** 远程目录由指定 MCP 服务解释，不能交给本机文件系统。 */
  remote?: RemoteProjectBinding;
  createdAt: number;
  /** Removed sidebar group; existing conversations and queued work retain their folder. */
  ungrouped?: boolean;
}

export interface RemoteProjectBinding {
  pluginId: string;
  workspaceId: string;
  endpointId: string;
}
