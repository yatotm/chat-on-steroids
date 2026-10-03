import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestRemoteProject } from '../src/renderer/remote-project-dialog.js';

let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/' });
  for (const key of ['window', 'document', 'Node', 'HTMLElement', 'HTMLInputElement', 'Option'] as const)
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });

it('freezes the submitted directory and returns the exact project after remote validation', async () => {
  let finish!: (value: unknown) => void;
  const addRemoteProject = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  window.api = { pluginsSnapshot: async () => ({ ok: true, data: { plugins: [{ id: 'remote', name: 'Linux', source: { kind: 'remote' } }] } }), addRemoteProject } as any;
  const requested = requestRemoteProject();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  const directory = document.querySelector<HTMLInputElement>('input[placeholder="/srv/project"]')!;
  directory.value = '/srv/a';
  document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(addRemoteProject).toHaveBeenCalledWith('remote', '/srv/a'));
  expect(directory.disabled).toBe(true);
  const project = { id: 'accepted', path: '/srv/a' };
  finish({ ok: true, data: project });
  expect(await requested).toBe(project);
  expect(document.querySelector('dialog')).toBeNull();
});

it('keeps a created connection after a directory error and never installs it twice on retry', async () => {
  const plugin = { id: 'remote', name: 'Linux', source: { kind: 'remote', url: 'http://127.0.0.1:8787/mcp' } };
  const pluginsInstall = vi.fn(async () => ({ ok: true, data: { plugins: [plugin] } }));
  const addRemoteProject = vi.fn().mockResolvedValueOnce({ ok: false, error: 'Project not allowed' }).mockResolvedValueOnce({ ok: true, data: { id: 'accepted' } });
  window.api = { pluginsSnapshot: async () => ({ ok: true, data: { plugins: [] } }), pluginsInstall, addRemoteProject } as any;
  const requested = requestRemoteProject();
  await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
  document.querySelector<HTMLInputElement>('input[type="url"]')!.value = plugin.source.url;
  const password = document.querySelector<HTMLInputElement>('input[type="password"]')!; password.value = 'secret-for-connection';
  const directory = document.querySelector<HTMLInputElement>('input[placeholder="/srv/project"]')!; directory.value = '/srv/wrong';
  const submit = () => document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  submit();
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')!.textContent).toBe('Project not allowed'));
  expect(password.value).toBe(''); expect(document.body.textContent).not.toContain('secret-for-connection');
  expect(document.querySelector('select')!.value).toBe('remote');
  directory.value = '/srv/a'; submit();
  expect(await requested).toEqual({ id: 'accepted' });
  expect(pluginsInstall).toHaveBeenCalledTimes(1);
  expect(addRemoteProject).toHaveBeenLastCalledWith('remote', '/srv/a');
});
