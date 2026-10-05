import { isCoreRemote, isManagedRemote, type LocalProject } from '../shared/projects.js';
import type { RemoteHostView, RemoteHostState, SaveRemoteHost } from '../shared/remote-hosts.js';
import { el } from './dom.js';
import { t, ui } from './i18n.js';

export function remoteHostStateLabel(state: RemoteHostState): string {
  return t(({ connected: 'Execution service connected', connecting: 'Connecting…', disconnected: 'Disconnected',
    error: 'Connection unavailable', suspended: 'Suspended' } as const)[state]);
}
interface DialogOptions { hostId?: string; legacyProjectId?: string; manageOnly?: boolean }

/** 开发机拥有连接和授权目录；新增项目只指定其主工作目录。 */
export async function requestRemoteProject(options: DialogOptions = {}): Promise<LocalProject | null> {
  const [catalog, connections, discovery] = await Promise.all([window.api.listProjects(), window.api.listRemoteHosts(), window.api.listSshHosts()]);
  if (!catalog.ok) throw new Error(catalog.error);
  if (!connections.ok) throw new Error(connections.error);
  if (!discovery.ok) throw new Error(discovery.error);
  if (!discovery.data.supported) throw new Error(t('Managed SSH requires macOS or Linux.'));
  const hosts = [...connections.data];
  const legacy = catalog.data.filter(project => project.remote && !isManagedRemote(project.remote));
  const known = (id: string) => hosts.find(host => host.id === id);
  if (options.hostId && !known(options.hostId)) throw new Error(t('This development server connection is unavailable.'));
  const oldProject = (id: string) => legacy.find(project => project.id === id);
  const sameOldConnection = (left: LocalProject, right: LocalProject) => left.id === right.id || left.remote && right.remote &&
    isCoreRemote(left.remote) && isCoreRemote(right.remote) && !isManagedRemote(left.remote) && !isManagedRemote(right.remote) &&
    left.remote.serverId === right.remote.serverId && left.remote.url === right.remote.url;
  const oldGroups = legacy.filter((project, index) => !legacy.slice(0, index).some(other => sameOldConnection(project, other)));
  return new Promise(resolve => {
    const dialog = el('dialog', 'remote-project-dialog') as HTMLDialogElement;
    const form = el('form') as HTMLFormElement;
    const title = el('h2', '', () => t(options.manageOnly ? 'Development server settings' : 'Connect development server'));
    title.id = 'remoteProjectTitle'; dialog.setAttribute('aria-labelledby', title.id);
    const field = (label: string, input: HTMLElement) => {
      const row = el('label', 'remote-project-field'); row.append(el('span', '', () => t(label)), input); return row;
    };
    const choice = el('select') as HTMLSelectElement;
    choice.required = true; choice.append(new Option(t('Choose a development server'), ''));
    const appendHost = (host: RemoteHostView) => choice.append(new Option(host.sshHost, 'host:' + host.id));
    hosts.forEach(appendHost);
    for (const project of oldGroups) choice.append(new Option(t('Migrate saved connection · {0}', [project.name]), 'legacy:' + project.id));
    for (const alias of discovery.data.hosts.filter(alias => !hosts.some(host => host.sshHost === alias)))
      choice.append(new Option(t('New SSH connection · {0}', [alias]), 'ssh:' + alias));
    const ssh = el('select') as HTMLSelectElement;
    ssh.append(new Option(t('Choose an SSH host'), ''));
    for (const alias of discovery.data.hosts) ssh.append(new Option(alias, alias));
    const sshField = field('SSH host', ssh);
    const hint = el('p', 'meta', () => t('Hosts come from your SSH configuration. Projects on the same development server share one SSH connection.'));
    const port = el('input') as HTMLInputElement;
    port.type = 'number'; port.min = '1'; port.max = '65535'; port.value = '18787'; port.required = true;
    const token = el('input') as HTMLInputElement;
    token.type = 'password'; token.autocomplete = 'off'; token.maxLength = 8192;
    const tokenField = field('Execution service token', token);
    const serviceSettings = el('details', 'remote-service-settings') as HTMLDetailsElement;
    const serviceFields = el('div', 'remote-service-fields');
    serviceFields.append(field('Execution service port', port), tokenField);
    serviceSettings.append(el('summary', '', () => t('Execution service settings')), serviceFields);
    const credentialHint = el('p', 'meta');
    const rootSection = el('fieldset', 'remote-root-fields');
    rootSection.append(el('legend', '', () => t('Approved directories on this development server')));
    const rootRows = el('div', 'remote-root-rows');
    const addRoot = el('button', 'btn', () => t('Add directory')) as HTMLButtonElement; addRoot.type = 'button';
    const appendRoot = (value = '') => {
      const row = el('div', 'remote-root-row');
      const input = el('input') as HTMLInputElement;
      input.type = 'text'; input.value = value; input.placeholder = '/srv/projects'; input.required = true; input.maxLength = 4096;
      input.setAttribute('aria-label', t('Approved remote directory'));
      const remove = el('button', 'btn', () => t('Remove')) as HTMLButtonElement; remove.type = 'button';
      const nameRemove = () => remove.setAttribute('aria-label', t('Remove approved directory {0}', [input.value || t('Empty directory')]));
      nameRemove(); input.addEventListener('input', nameRemove);
      remove.onclick = () => { if (rootRows.children.length > 1) row.remove(); else input.value = ''; };
      row.append(input, remove); rootRows.append(row);
    };
    addRoot.onclick = () => { if (rootRows.children.length < 64) appendRoot(); };
    rootSection.append(rootRows, addRoot, el('p', 'meta', () => t('These directories are shared by this server’s projects. The primary project directory sets where work starts.')),
      el('p', 'meta', () => t('Directory permissions cover file tools and the starting command directory. Shell commands run with the development server account’s system permissions.')));
    const directory = el('input') as HTMLInputElement;
    directory.placeholder = '/srv/projects/my-project'; directory.required = !options.manageOnly; directory.maxLength = 4096;
    directory.autocomplete = 'off';
    const projectField = field('Primary project directory', directory); projectField.hidden = !!options.manageOnly;
    const create = el('input') as HTMLInputElement; create.type = 'checkbox';
    const createField = el('label', 'inline'); createField.append(create, el('span', '', () => t('Create this directory if it does not exist')));
    createField.hidden = !!options.manageOnly;
    const status = el('p', 'meta remote-project-status'); status.setAttribute('role', 'status');
    const actions = el('div', 'remote-project-actions');
    const body = el('div', 'remote-project-body'), footer = el('div', 'remote-project-footer');
    const cancel = el('button', 'btn', () => t('Cancel')) as HTMLButtonElement; cancel.type = 'button';
    const submit = el('button', 'btn btn-solid', () => t(options.manageOnly ? 'Save connection' : 'Connect and add project')) as HTMLButtonElement;
    submit.type = 'submit'; actions.append(cancel, submit);
    body.append(field('Development server', choice), hint, sshField,
      credentialHint, serviceSettings, rootSection, projectField, createField,
      el('p', 'meta', () => t('CoS opens and closes its own SSH mapping. Closing the CoS window quits the app and disconnects these mappings. Core remains the only required ChatGPT connector.')));
    footer.append(status, actions); form.append(title, body, footer);
    dialog.append(form); document.body.append(dialog);
    let pending = false, settled = false;
    const close = (project: LocalProject | null) => {
      if (settled) return;
      settled = true; token.value = ''; dialog.close(); dialog.remove(); resolve(project);
    };
    const selectedHost = () => choice.value.startsWith('host:') ? known(choice.value.slice(5)) : undefined;
    const selectedOld = () => choice.value.startsWith('legacy:') ? oldProject(choice.value.slice(7)) : undefined;
    const paintChoice = () => {
      const host = selectedHost(), previous = selectedOld();
      const reusable = !!previous?.remote && isCoreRemote(previous.remote);
      const alias = choice.value.startsWith('ssh:') ? choice.value.slice(4) : host?.sshHost ?? '';
      if (alias && ![...ssh.options].some(option => option.value === alias)) ssh.append(new Option(alias, alias));
      ssh.value = alias; ssh.required = !!choice.value; sshField.hidden = !previous && !options.manageOnly;
      port.value = String(host?.remotePort ?? 18787);
      token.value = ''; token.required = !host && !reusable;
      serviceSettings.open = token.required;
      token.minLength = token.required ? 32 : 0;
      token.placeholder = host || reusable ? t('Stored token — leave blank to reuse') : '';
      ui(credentialHint, 'textContent', () => host || reusable
        ? t('The saved execution token will be reused. Enter a token only to replace it.')
        : t('Enter this server’s CoS execution token once. It will be stored securely and reused for its projects.'));
      const roots = host?.roots ?? (previous ? legacy.filter(row => sameOldConnection(previous, row)).map(row => row.path) : ['']);
      rootRows.replaceChildren(); [...new Set(roots)].forEach(appendRoot);
      if (!directory.value && previous) directory.value = previous.path;
      status.textContent = host ? remoteHostStateLabel(host.state) : '';
    };
    choice.addEventListener('change', paintChoice);
    const requestedOld = options.legacyProjectId ? oldProject(options.legacyProjectId) : undefined;
    const representative = requestedOld && oldGroups.find(project => sameOldConnection(project, requestedOld));
    choice.value = options.hostId ? 'host:' + options.hostId : representative ? 'legacy:' + representative.id : '';
    if (requestedOld) directory.value = requestedOld.path;
    if (options.manageOnly) choice.disabled = true;
    paintChoice();
    cancel.onclick = () => close(null);
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!pending) close(null); });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (pending) return;
      if (!port.checkValidity() || !token.checkValidity()) serviceSettings.open = true;
      if (!form.reportValidity()) return;
      const host = selectedHost(), previous = selectedOld();
      const roots = [...rootRows.querySelectorAll('input')].map(input => input.value.trim());
      const requestedDirectory = directory.value.trim(), createDirectory = create.checked;
      const request: SaveRemoteHost = { sshHost: ssh.value, remotePort: Number(port.value), roots,
        ...(host ? { id: host.id, revision: host.revision } : {}), ...(previous ? { reuseProjectId: previous.id } : {}),
        ...(token.value.trim() ? { token: token.value.trim() } : {}) };
      const dirtyHost = !host || host.sshHost !== request.sshHost || host.remotePort !== request.remotePort ||
        JSON.stringify(host.roots) !== JSON.stringify(roots) || !!request.token;
      pending = true;
      for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) control.disabled = true;
      ui(status, 'textContent', () => t('Connecting to the development server…'));
      let saved: RemoteHostView | undefined = host;
      try {
        if (dirtyHost) {
          const response = await window.api.saveRemoteHost(request);
          if (!response.ok) throw new Error(response.error);
          saved = response.data;
          const index = hosts.findIndex(row => row.id === saved!.id);
          if (index < 0) { hosts.push(saved); appendHost(saved); } else hosts[index] = saved;
          choice.value = 'host:' + saved.id; paintChoice();
          for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) control.disabled = true;
        }
        if (!dirtyHost && saved && !saved.enabled) {
          const connected = await window.api.reconnectRemoteHost(saved.id);
          if (!connected.ok) throw new Error(connected.error);
          saved = connected.data;
          if (saved.state !== 'connected') throw new Error(saved.detail || t('Connection unavailable'));
        }
        if (options.manageOnly) { close(null); return; }
        const result = await window.api.addManagedRemoteProject({ hostId: saved!.id, directory: requestedDirectory, createDirectory });
        if (!result.ok) throw new Error(result.error);
        close(result.data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status.textContent = saved && dirtyHost ? t('Connection saved. Project setup failed: {0}', [t(message)]) : t(message);
      } finally {
        pending = false;
        for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) control.disabled = false;
        choice.disabled = !!options.manageOnly;
      }
    });
    dialog.showModal(); choice.focus();
  });
}
