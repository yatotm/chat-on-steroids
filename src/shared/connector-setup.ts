import type { SurfaceStatus, TunnelSettings } from './types.js';

/** 配置选择与运行状态分开；Core 的调用证据不能借给另一个连接器。 */
export function connectorConfigured(surface: Pick<SurfaceStatus, 'id' | 'state'>, tunnel: TunnelSettings): boolean {
  if (tunnel.kind === 'openai') {
    const id = surface.id === 'core' ? tunnel.tunnelId : surface.id === 'desktop' ? tunnel.desktopTunnelId : tunnel.pluginsTunnelId;
    return !!id?.trim();
  }
  return surface.state !== 'off';
}

/** 设置页和插件页共用同一份已验证证据，重启不能把已创建的连接器说成首次使用。 */
export function withConnectorEvidence(surface: SurfaceStatus): SurfaceStatus {
  return { ...surface, lastRequestAt: surface.lastRequestAt ?? surface.proof?.requestAt ?? null,
    lastToolCallAt: surface.lastToolCallAt ?? surface.proof?.toolCallAt ?? null };
}
export function connectorCreated(surface: SurfaceStatus): boolean {
  const evidence = withConnectorEvidence(surface);
  return evidence.lastRequestAt !== null || evidence.lastToolCallAt !== null || (surface.proof?.installedAt ?? null) !== null;
}

/** 可用能力不等于用户选择发布；未启用的可选连接器不能阻挡 Core 设置完成。 */
export function connectorSelectedForSetup(surface: SurfaceStatus, tunnel: TunnelSettings): boolean {
  if (!surface.available) return false;
  if (!surface.optional) return true;
  return connectorConfigured(surface, tunnel) && (tunnel.kind === 'openai' || surface.tools.length > 0);
}
