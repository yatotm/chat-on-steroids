export type PluginSource = {
  kind: 'npm' | 'python' | 'command' | 'remote' | 'mcpb' | 'github';
  package?: string;
  version?: string;
  /** Reviewed exact Python dependency pins, resolved together with the server package. */
  dependencies?: { package: string; version: string }[];
  command?: string;
  args?: string[];
  url?: string;
  /** Remote OAuth is explicit; omitted sources keep their existing static headers. */
  auth?: 'oauth';
  path?: string;
};

/** 插件安装源决定执行宿主，不继承当前项目的 Core 文件执行位置。启动与展示共用此判定。 */
export function pluginExecutionHost(source: PluginSource): 'local' | 'endpoint' {
  return source.kind === 'remote' ? 'endpoint' : 'local';
}
export interface PluginConfigPatch {
  config?: Record<string, string>;
  credentials?: Record<string, string>;
  source?: PluginSource;
  name?: string;
}
export interface PluginInstallRequest extends PluginConfigPatch {
  catalogId?: string;
}
export interface PluginField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}
export interface PluginCatalogEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  source: PluginSource;
  homepage: string;
  license: string;
  instructions: string[];
  fields: PluginField[];
  /** Representative tool names or documented action labels; live discovery determines actual tools. */
  tools?: string[];
}
export interface PluginToolView {
  name: string;
  exposedName: string;
  description?: string;
  enabled: boolean;
  published?: boolean;
  exposureError?: string;
}
export interface PluginView {
  id: string;
  name: string;
  catalogId?: string;
  source: PluginSource;
  config: Record<string, string>;
  credentialKeys: string[];
  fields?: PluginField[];
  version: string;
  license: string;
  homepage?: string;
  enabled: boolean;
  status: 'installed' | 'connecting' | 'ready' | 'disabled' | 'error' | 'needs-auth' | 'authenticating';
  error?: string;
  tools: PluginToolView[];
  installedAt: number;
}
export interface PluginSnapshot {
  plugins: PluginView[];
  catalog: PluginCatalogEntry[];
  schemaRevision: number;
}
