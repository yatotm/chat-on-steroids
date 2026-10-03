import type { LocalProject } from '../shared/projects.js';
import { el } from './dom.js';
import { t, ui } from './i18n.js';

export async function requestRemoteProject(): Promise<LocalProject | null> {
  const snapshot = await window.api.pluginsSnapshot();
  if (!snapshot.ok) throw new Error(snapshot.error);
  const existing = snapshot.data.plugins.filter(plugin => plugin.source.kind === 'remote');
  return new Promise(resolve => {
    const dialog = el('dialog', 'remote-project-dialog') as HTMLDialogElement;
    const form = el('form') as HTMLFormElement;
    const title = el('h2', '', () => t('Add remote project')); title.id = 'remoteProjectTitle';
    dialog.setAttribute('aria-labelledby', title.id);
    const hint = el('p', 'meta', () => t('Keep CoS and Chrome on this computer. Files and commands run on your Linux development server through CodexPro.'));
    const field = (label: string, input: HTMLElement) => {
      const row = el('label', 'remote-project-field'); row.append(el('span', '', () => t(label)), input); return row;
    };
    const connection = el('select') as HTMLSelectElement;
    connection.append(new Option(t('New CodexPro connection'), ''));
    for (const plugin of existing) connection.append(new Option(plugin.name, plugin.id));
    if (existing.length === 1) connection.value = existing[0]!.id;
    const server = el('input') as HTMLInputElement;
    server.type = 'url'; server.placeholder = 'http://127.0.0.1:8787/mcp'; server.autocomplete = 'off'; server.maxLength = 2048;
    const token = el('input') as HTMLInputElement;
    token.type = 'password'; token.autocomplete = 'off'; token.maxLength = 8192;
    const directory = el('input') as HTMLInputElement;
    directory.placeholder = '/srv/project'; directory.required = true; directory.maxLength = 4096; directory.autocomplete = 'off';
    const serverField = field('Server MCP URL', server), tokenField = field('Server token', token);
    const explanation = el('p', 'meta', () => t('For SSH forwarding, enter the forwarded localhost URL. Credentials are saved in the system credential store. Connect and refresh Chat On Steroids Plugins in ChatGPT to use these tools.'));
    const status = el('p', 'meta remote-project-status'); status.setAttribute('role', 'status');
    const actions = el('div', 'remote-project-actions');
    const cancel = el('button', 'btn', () => t('Cancel')) as HTMLButtonElement; cancel.type = 'button';
    const submit = el('button', 'btn btn-solid', () => t('Connect and add project')) as HTMLButtonElement; submit.type = 'submit';
    actions.append(cancel, submit);
    form.append(title, hint, field('Connection', connection), serverField, tokenField,
      field('Directory on development server', directory), explanation, status, actions);
    dialog.append(form); document.body.append(dialog);
    let pending = false, installedId = '', settled = false;
    const close = (project: LocalProject | null) => {
      if (settled) return;
      settled = true; token.value = ''; dialog.close(); dialog.remove(); resolve(project);
    };
    const update = () => {
      serverField.hidden = tokenField.hidden = !!connection.value;
      server.required = !connection.value;
    };
    connection.addEventListener('change', () => { installedId = ''; update(); }); update();
    cancel.onclick = () => close(null);
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!pending) close(null); });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (pending || !form.reportValidity()) return;
      const requestedDirectory = directory.value.trim();
      const requestedUrl = server.value.trim(), requestedToken = token.value;
      pending = true; submit.disabled = cancel.disabled = connection.disabled = true;
      server.disabled = token.disabled = directory.disabled = true;
      ui(status, 'textContent', () => t('Connecting to the development server…'));
      try {
        let pluginId = connection.value || installedId;
        if (!pluginId) {
          const url = new URL(requestedUrl).toString();
          if (existing.some(plugin => plugin.source.url === url)) throw new Error(t('This server is already configured. Select its existing connection.'));
          const before = new Set(snapshot.data.plugins.map(plugin => plugin.id));
          const result = await window.api.pluginsInstall({ name: 'CodexPro development server', source: { kind: 'remote', url },
            ...(requestedToken ? { credentials: { token: requestedToken } } : {}) });
          if (!result.ok) throw new Error(result.error);
          token.value = '';
          const added = result.data.plugins.filter(plugin => !before.has(plugin.id) && plugin.source.kind === 'remote' && plugin.source.url === url);
          if (added.length !== 1) throw new Error(t('Select the connection in Plugins and try again.'));
          installedId = pluginId = added[0]!.id;
          existing.push(added[0]!);
          connection.append(new Option(added[0]!.name, pluginId)); connection.value = pluginId; update();
        }
        const project = await window.api.addRemoteProject(pluginId, requestedDirectory);
        if (!project.ok) throw new Error(project.error);
        close(project.data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ui(status, 'textContent', () => t(message));
      } finally { pending = false; submit.disabled = cancel.disabled = connection.disabled = false;
        server.disabled = token.disabled = directory.disabled = false; }
    });
    dialog.showModal(); directory.focus();
  });
}
