import { expect, it } from 'vitest';
import type { SurfaceStatus, TunnelSettings } from '../src/shared/types.js';
import { connectorConfigured, connectorCreated, connectorSelectedForSetup, withConnectorEvidence } from '../src/shared/connector-setup.js';

const surface = (id: SurfaceStatus['id'], patch: Partial<SurfaceStatus> = {}): SurfaceStatus => ({
  id, optional: id !== 'core', available: true, connectorName: id, description: '', cardSummary: '',
  state: 'off', detail: '', localUrl: null, publicUrl: null, tools: ['read'], lastRequestAt: null, lastToolCallAt: null, ...patch
});
const tunnel = { kind: 'openai', tunnelId: 'core', pluginsTunnelId: '' } as TunnelSettings;

it('keeps optional publication separate from a working Core and cached third-party tools', () => {
  const core = surface('core', { state: 'live', lastToolCallAt: 50 });
  const plugins = surface('plugins', { tools: ['cached'], detail: 'unpublished' });
  expect(connectorCreated(core)).toBe(true);
  expect(connectorSelectedForSetup(core, tunnel)).toBe(true);
  expect(connectorConfigured(plugins, tunnel)).toBe(false);
  expect(connectorSelectedForSetup(plugins, tunnel)).toBe(false);
  expect(connectorCreated(plugins)).toBe(false);
});

it('keeps configured connector failures visible and preserves exact historical evidence', () => {
  const plugins = surface('plugins', { state: 'error', proof: { requestAt: 20, toolCallAt: 30 } });
  const configured = { ...tunnel, pluginsTunnelId: 'plugins' };
  expect(connectorConfigured(plugins, configured)).toBe(true);
  expect(connectorSelectedForSetup(plugins, configured)).toBe(true);
  expect(connectorCreated(plugins)).toBe(true);
  expect(withConnectorEvidence(plugins)).toMatchObject({ state: 'error', lastRequestAt: 20, lastToolCallAt: 30 });
  expect(connectorCreated(surface('desktop'))).toBe(false);
});
