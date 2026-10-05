import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestRemoteProject } from '../src/renderer/remote-project-dialog.js';
import type { RemoteHostView } from '../src/shared/remote-hosts.js';

let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/' });
  for (const key of ['window', 'document', 'Node', 'HTMLElement', 'HTMLInputElement', 'Option'] as const)
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
const token = 'fixture-execution-token-12345678901234567890';
const host: RemoteHostView = { id: '11111111-1111-4111-8111-111111111111', sshHost: 'dev',
  serverId: '22222222-2222-4222-8222-222222222222', remotePort: 18787, roots: ['/srv'], revision: 1, enabled: true,
  state: 'connected', checkedAt: 1, detail: '', localPort: 54321 };
function configure(overrides: Record<string, unknown> = {}) {
  const saveRemoteHost = vi.fn(async () => ({ ok: true, data: host }));
  const addManagedRemoteProject = vi.fn(async (request: any) => ({ ok: true, data: { id: 'accepted', path: request.directory } }));
  window.api = { listProjects: async () => ({ ok: true, data: [] }),
    listRemoteHosts: async () => ({ ok: true, data: [] }),
    listSshHosts: async () => ({ ok: true, data: { supported: true, hosts: ['dev'] } }),
    saveRemoteHost, addManagedRemoteProject, ...overrides } as any;
  return { saveRemoteHost, addManagedRemoteProject };
}
const waitForDialog = () => vi.waitFor(() => expect(document.querySelector('dialog[open]')).not.toBeNull());
function choose(value: string) {
  const select = document.querySelector('select')!;
  select.value = value; select.dispatchEvent(new dom.window.Event('change'));
}
function fill(directory = '/srv/a') {
  document.querySelector<HTMLInputElement>('input[type="password"]')!.value = token;
  document.querySelector<HTMLInputElement>('.remote-root-row input')!.value = '/srv';
  document.querySelector<HTMLInputElement>('input[placeholder="/srv/projects/my-project"]')!.value = directory;
}
function submit() {
  document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
}

it('freezes a selected SSH host and project while connection and directory validation complete', async () => {
  let finish!: (value: unknown) => void;
  const addManagedRemoteProject = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const { saveRemoteHost } = configure({ addManagedRemoteProject });
  const requested = requestRemoteProject(); await waitForDialog();
  choose('ssh:dev'); fill(); submit();
  await vi.waitFor(() => expect(addManagedRemoteProject).toHaveBeenCalledWith({ hostId: host.id, directory: '/srv/a', createDirectory: false }));
  expect(saveRemoteHost).toHaveBeenCalledWith({ sshHost: 'dev', remotePort: 18787, roots: ['/srv'], token });
  expect(document.querySelector<HTMLInputElement>('.remote-root-row input')!.disabled).toBe(true);
  expect(document.querySelector<HTMLInputElement>('input[type=password]')!.value).toBe('');
  expect(document.body.textContent).not.toContain(token);
  finish({ ok: true, data: { id: 'accepted', path: '/srv/a' } });
  expect(await requested).toMatchObject({ id: 'accepted' });
});

it('adds another project through a saved host without asking for or resending its token', async () => {
  const { saveRemoteHost, addManagedRemoteProject } = configure({ listRemoteHosts: async () => ({ ok: true, data: [host] }) });
  const requested = requestRemoteProject({ hostId: host.id }); await waitForDialog();
  expect(document.querySelector<HTMLInputElement>('input[type=password]')!.required).toBe(false);
  document.querySelector<HTMLInputElement>('input[placeholder="/srv/projects/my-project"]')!.value = '/srv/second';
  document.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked = true;
  submit(); await requested;
  expect(saveRemoteHost).not.toHaveBeenCalled();
  expect(addManagedRemoteProject).toHaveBeenCalledWith({ hostId: host.id, directory: '/srv/second', createDirectory: true });
});

it('keeps a saved connection after a refused project and retries only the project step', async () => {
  const addManagedRemoteProject = vi.fn().mockResolvedValueOnce({ ok: false, error: 'Project not allowed' })
    .mockResolvedValueOnce({ ok: true, data: { id: 'accepted' } });
  const { saveRemoteHost } = configure({ addManagedRemoteProject });
  const requested = requestRemoteProject(); await waitForDialog();
  choose('ssh:dev'); fill('/srv/wrong'); submit();
  await vi.waitFor(() => expect(document.querySelector('[role=status]')!.textContent).toContain('Project not allowed'));
  document.querySelector<HTMLInputElement>('input[placeholder="/srv/projects/my-project"]')!.value = '/srv/right';
  submit(); await requested;
  expect(saveRemoteHost).toHaveBeenCalledTimes(1);
  expect(addManagedRemoteProject).toHaveBeenLastCalledWith({ hostId: host.id, directory: '/srv/right', createDirectory: false });
});

it('migrates an explicitly chosen manual connection using its saved credential reference', async () => {
  const project = { id: '33333333-3333-4333-8333-333333333333', name: 'Existing', path: '/srv/existing', createdAt: 1,
    remote: { kind: 'core', serverId: host.serverId, url: 'http://127.0.0.1:18787/mcp', credentialId: '44444444-4444-4444-8444-444444444444' } };
  const { saveRemoteHost } = configure({ listProjects: async () => ({ ok: true, data: [project] }) });
  const requested = requestRemoteProject({ legacyProjectId: project.id }); await waitForDialog();
  const ssh = document.querySelectorAll('select')[1]!;
  ssh.value = 'dev';
  expect(document.querySelector<HTMLInputElement>('input[type=password]')!.required).toBe(false);
  submit(); await requested;
  expect(saveRemoteHost).toHaveBeenCalledWith({ sshHost: 'dev', remotePort: 18787, roots: ['/srv/existing'], reuseProjectId: project.id });
});
