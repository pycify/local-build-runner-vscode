const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

let currentProcess = null;
let cancellationRequested = false;
let outputChannel;
let statusPanel;
let interactivePanel;
let interactiveState;
let statusState = {
  running: false,
  command: '',
  cwd: '',
  steps: [],
  log: '',
};

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('Local Build Runner');

  context.subscriptions.push(
    vscode.commands.registerCommand('localBuildRunner.run', () => runInteractive()),
    vscode.commands.registerCommand('localBuildRunner.runBuild', () => runPreset('build')),
    vscode.commands.registerCommand('localBuildRunner.runPatch', () => runPreset('patch')),
    vscode.commands.registerCommand('localBuildRunner.dryRun', () => runPreset(undefined, true)),
    vscode.commands.registerCommand('localBuildRunner.cancel', cancelRunningBuild),
    vscode.commands.registerCommand('localBuildRunner.openConfig', openConfig),
    outputChannel
  );
}

function deactivate() {
  cancelRunningBuild();
}

async function runInteractive() {
  const workspace = getWorkspace();
  if (!workspace) return;

  const config = await loadConfig(workspace);
  if (!config) return;

  showInteractivePanel(workspace, config);
}

async function runPreset(mode, forceDryRun = false) {
  const workspace = getWorkspace();
  if (!workspace) return;

  const config = await loadConfig(workspace);
  if (!config) return;

  showInteractivePanel(workspace, config);
  if (!interactiveState) return;

  if (mode) {
    interactiveState.selections.mode = mode;
  }
  if (forceDryRun) {
    interactiveState.booleanFlags.add('dry-run');
  }
  renderInteractivePanel();
}

async function collectValueFlags(config) {
  const values = {};
  const flags = config.valueFlags || [];
  const credentialDefaults = config.credentials || {};

  const selected = await vscode.window.showQuickPick(
    flags.map((flag) => ({ label: flag, picked: Boolean(getDefault(config, flag) || credentialDefaults[flag]) })),
    {
      title: 'Optional value flags',
      canPickMany: true,
      placeHolder: 'Select value flags to include',
    }
  );

  if (!selected) return values;

  for (const item of selected) {
    const flag = item.label;
    const defaultValue = getDefault(config, flag) || credentialDefaults[flag] || '';
    const entered = await vscode.window.showInputBox({
      title: `--${flag}`,
      value: String(defaultValue),
      prompt: `Value for --${flag}`,
    });
    if (entered === undefined) return values;
    if (entered.trim()) values[flag] = entered.trim();
  }

  return values;
}

async function collectBooleanFlags(config) {
  const flags = config.booleanFlags || [];
  const defaults = config.defaultBooleanFlags || [];
  const selected = await vscode.window.showQuickPick(
    flags.map((flag) => ({ label: flag, picked: defaults.includes(flag) })),
    {
      title: 'Boolean flags',
      canPickMany: true,
      placeHolder: 'Select boolean flags to include',
    }
  );

  return new Set((selected || []).map((item) => item.label));
}

async function runBuild({ workspace, config, selections, valueFlags, booleanFlags }) {
  if (currentProcess) {
    vscode.window.showWarningMessage('A local build is already running.');
    return;
  }

  const command = buildCommand(config, selections, valueFlags, booleanFlags);
  const cwd = workspace.uri.fsPath;
  cancellationRequested = false;

  statusState = {
    running: true,
    command,
    cwd,
    steps: makeSteps(config),
    log: '',
  };
  showStatusPanel(config);
  renderStatusPanel();

  outputChannel.clear();
  outputChannel.show(true);
  appendLog(`$ ${command}\n`);

  currentProcess = cp.spawn(command, {
    cwd,
    shell: true,
    env: { ...process.env },
    detached: process.platform !== 'win32',
  });
  renderInteractivePanel();

  currentProcess.stdout.on('data', (data) => handleOutput(data.toString()));
  currentProcess.stderr.on('data', (data) => handleOutput(data.toString()));
  currentProcess.on('error', (error) => {
    appendLog(`\n[extension error] ${error.message}\n`);
  });
  currentProcess.on('close', (code) => {
    const wasCancelled = cancellationRequested;
    const success = code === 0 && !wasCancelled;
    statusState.running = false;
    statusState.steps = statusState.steps.map((step) => {
      if (step.status === 'running') return { ...step, status: success ? 'done' : 'failed' };
      return step;
    });
    appendLog(`\nProcess exited with code ${code}\n`);
    renderStatusPanel();
    currentProcess = null;
    cancellationRequested = false;
    renderInteractivePanel();

    if (wasCancelled) {
      vscode.window.showInformationMessage('Local build cancelled.');
    } else if (success) {
      vscode.window.showInformationMessage('Local build completed.');
    } else {
      vscode.window.showErrorMessage(`Local build failed with exit code ${code}.`);
    }
  });
}

function showInteractivePanel(workspace, config) {
  interactiveState = {
    workspace,
    config,
    selections: defaultSelections(config),
    valueFlags: defaultValueFlags(config),
    booleanFlags: new Set(config.defaultBooleanFlags || []),
  };

  if (interactivePanel) {
    interactivePanel.reveal(vscode.ViewColumn.Two);
  } else {
    interactivePanel = vscode.window.createWebviewPanel(
      'localBuildRunnerInteractive',
      `${config.name || 'Local Build'} Build`,
      vscode.ViewColumn.Two,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    interactivePanel.webview.onDidReceiveMessage(handleInteractiveMessage);
    interactivePanel.onDidDispose(() => {
      interactivePanel = undefined;
      interactiveState = undefined;
    });
  }

  renderInteractivePanel();
}

function defaultSelections(config) {
  const selections = {};
  for (const [key, values] of Object.entries(config.options || {})) {
    if (!Array.isArray(values) || values.length === 0) continue;
    const defaultValue = getDefault(config, key);
    selections[key] = values.includes(defaultValue) ? defaultValue : values[0];
  }
  return selections;
}

function defaultValueFlags(config) {
  const values = {};
  const credentialDefaults = config.credentials || {};
  for (const flag of config.valueFlags || []) {
    const defaultValue = getDefault(config, flag) || credentialDefaults[flag];
    if (defaultValue) values[flag] = String(defaultValue);
  }
  return values;
}

async function handleInteractiveMessage(message) {
  if (!interactiveState) return;

  if (message.type === 'update') {
    interactiveState.selections = message.selections || {};
    interactiveState.valueFlags = cleanValues(message.valueFlags || {});
    interactiveState.booleanFlags = new Set(message.booleanFlags || []);
    renderInteractivePanel();
    return;
  }

  if (message.type === 'cancel') {
    cancelRunningBuild();
    renderInteractivePanel();
    return;
  }

  if (message.type === 'run') {
    interactiveState.selections = message.selections || {};
    interactiveState.valueFlags = cleanValues(message.valueFlags || {});
    interactiveState.booleanFlags = new Set(message.booleanFlags || []);

    if (message.mode) {
      interactiveState.selections.mode = message.mode;
    }
    if (message.dryRun) {
      interactiveState.booleanFlags.add('dry-run');
    }

    await runBuild({
      workspace: interactiveState.workspace,
      config: interactiveState.config,
      selections: interactiveState.selections,
      valueFlags: interactiveState.valueFlags,
      booleanFlags: interactiveState.booleanFlags,
    });
  }
}

function cleanValues(values) {
  const cleaned = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      cleaned[key] = String(value).trim();
    }
  }
  return cleaned;
}

function renderInteractivePanel() {
  if (!interactivePanel || !interactiveState) return;

  const { workspace, config, selections, valueFlags, booleanFlags } = interactiveState;
  const command = buildCommand(config, selections, valueFlags, booleanFlags);
  const options = Object.entries(config.options || {})
    .map(([key, values]) => renderSelect(key, values, selections[key]))
    .join('');
  const valueInputs = (config.valueFlags || [])
    .map((flag) => renderTextInput(flag, valueFlags[flag] || ''))
    .join('');
  const booleanInputs = (config.booleanFlags || [])
    .map((flag) => renderCheckbox(flag, booleanFlags.has(flag)))
    .join('');

  interactivePanel.webview.html = `<!doctype html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
    h2 { margin-top: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    label { display: flex; flex-direction: column; gap: 6px; font-weight: 600; }
    select, input[type="text"] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 7px; border-radius: 3px; }
    .checkboxes { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px 12px; }
    .checkboxes label { flex-direction: row; align-items: center; font-weight: 400; }
    .section { margin: 18px 0; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin: 18px 0; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 8px 12px; border-radius: 3px; cursor: pointer; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.danger { background: var(--vscode-testing-iconFailed); color: var(--vscode-button-foreground); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    code { display: block; white-space: pre-wrap; background: var(--vscode-editor-background); padding: 10px; border-radius: 4px; font-family: var(--vscode-editor-font-family); }
    small { opacity: .75; }
  </style>
</head>
<body>
  <h2>${escapeHtml(config.name || 'Local Build')}</h2>
  <small>${escapeHtml(workspace.uri.fsPath)}</small>

  <div class="section">
    <h3>Options</h3>
    <div class="grid">${options}</div>
  </div>

  <div class="section">
    <h3>Value Flags</h3>
    <div class="grid">${valueInputs}</div>
  </div>

  <div class="section">
    <h3>Boolean Flags</h3>
    <div class="checkboxes">${booleanInputs}</div>
  </div>

  <div class="section">
    <h3>Command Preview</h3>
    <code>${escapeHtml(command)}</code>
  </div>

  <div class="actions">
    <button data-run="current">Start Build</button>
    <button data-run="build">Build</button>
    <button data-run="patch">Patch</button>
    <button data-dry-run="true" class="secondary">Dry Run</button>
    <button data-refresh="true" class="secondary">Refresh Preview</button>
    <button data-cancel="true" class="danger"${currentProcess ? '' : ' disabled'}>Cancel Running Build</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function collect() {
      const selections = {};
      document.querySelectorAll('[data-select]').forEach((el) => selections[el.dataset.select] = el.value);

      const valueFlags = {};
      document.querySelectorAll('[data-value]').forEach((el) => {
        if (el.value.trim()) valueFlags[el.dataset.value] = el.value.trim();
      });

      const booleanFlags = [];
      document.querySelectorAll('[data-bool]').forEach((el) => {
        if (el.checked) booleanFlags.push(el.dataset.bool);
      });

      return { selections, valueFlags, booleanFlags };
    }

    function post(type, extra = {}) {
      vscode.postMessage({ type, ...collect(), ...extra });
    }

    document.querySelectorAll('select, input').forEach((el) => {
      el.addEventListener('change', () => post('update'));
    });

    document.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        if (button.dataset.cancel) return vscode.postMessage({ type: 'cancel' });
        if (button.dataset.refresh) return post('update');
        if (button.dataset.dryRun) return post('run', { dryRun: true });
        const mode = button.dataset.run === 'current' ? undefined : button.dataset.run;
        post('run', { mode });
      });
    });
  </script>
</body>
</html>`;
}

function renderSelect(key, values, selected) {
  const options = values
    .map((value) => `<option value="${escapeAttribute(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(value)}</option>`)
    .join('');
  return `<label>${escapeHtml(toTitle(key))}<select data-select="${escapeAttribute(key)}">${options}</select></label>`;
}

function renderTextInput(flag, value) {
  return `<label>--${escapeHtml(flag)}<input data-value="${escapeAttribute(flag)}" type="text" value="${escapeAttribute(value)}" /></label>`;
}

function renderCheckbox(flag, checked) {
  return `<label><input data-bool="${escapeAttribute(flag)}" type="checkbox"${checked ? ' checked' : ''} /> --${escapeHtml(flag)}</label>`;
}

function buildCommand(config, selections, valueFlags, booleanFlags) {
  const runner = config.runner || 'dart run';
  const script = config.script;
  if (!script) {
    throw new Error('Missing "script" in local build config.');
  }

  const parts = [...runner.split(/\s+/).filter(Boolean), script];
  const aliases = config.flagAliases || {};

  for (const [key, value] of Object.entries(selections || {})) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`--${aliases[key] || key}`, shellEscape(String(value)));
  }

  for (const [key, value] of Object.entries(valueFlags || {})) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`--${aliases[key] || key}`, shellEscape(String(value)));
  }

  for (const flag of booleanFlags || []) {
    parts.push(`--${aliases[flag] || flag}`);
  }

  return parts.join(' ');
}

function shellEscape(value) {
  if (/^[A-Za-z0-9_./:=,+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function handleOutput(text) {
  appendLog(text);
  updateStepStatus(text);
}

function appendLog(text) {
  outputChannel.append(text);
  statusState.log += text;
  if (statusState.log.length > 50000) {
    statusState.log = statusState.log.slice(statusState.log.length - 50000);
  }
  renderStatusPanel();
}

function updateStepStatus(text) {
  const lower = text.toLowerCase();
  let changed = false;

  statusState.steps = statusState.steps.map((step) => {
    if (step.status === 'pending' && lower.includes(step.match.toLowerCase())) {
      changed = true;
      return { ...step, status: 'running' };
    }
    if (step.status === 'running' && /done|success|completed|finished|built|uploaded/i.test(text)) {
      changed = true;
      return { ...step, status: 'done' };
    }
    return step;
  });

  if (changed) renderStatusPanel();
}

function makeSteps(config) {
  const steps = config.steps || [
    { name: 'Resolve dependencies', match: 'pub get' },
    { name: 'Generate code', match: 'build_runner' },
    { name: 'Install pods', match: 'pod install' },
    { name: 'Build Android', match: 'android' },
    { name: 'Build iOS', match: 'ios' },
    { name: 'Upload', match: 'upload' },
  ];

  return steps.map((step) => ({
    name: step.name,
    match: step.match || step.name,
    status: 'pending',
  }));
}

function showStatusPanel(config) {
  if (statusPanel) {
    statusPanel.reveal(vscode.ViewColumn.Two);
    return;
  }

  statusPanel = vscode.window.createWebviewPanel(
    'localBuildRunnerStatus',
    `${config.name || 'Local Build'} Status`,
    vscode.ViewColumn.Two,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  statusPanel.webview.onDidReceiveMessage((message) => {
    if (message.type === 'cancel') {
      cancelRunningBuild();
      renderStatusPanel();
      renderInteractivePanel();
    }
  });

  statusPanel.onDidDispose(() => {
    statusPanel = undefined;
  });
}

function renderStatusPanel() {
  if (!statusPanel) return;

  const steps = statusState.steps
    .map((step) => `<li class="${step.status}"><span>${escapeHtml(step.name)}</span><em>${step.status}</em></li>`)
    .join('');

  statusPanel.webview.html = `<!doctype html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
    code, pre { font-family: var(--vscode-editor-font-family); }
    .meta { margin-bottom: 16px; }
    .meta code { display: block; white-space: pre-wrap; background: var(--vscode-editor-background); padding: 10px; border-radius: 4px; }
    ul { list-style: none; padding: 0; margin: 0 0 16px; }
    li { display: flex; justify-content: space-between; border: 1px solid var(--vscode-panel-border); padding: 8px 10px; margin-bottom: 6px; border-radius: 4px; }
    li.running { border-color: var(--vscode-progressBar-background); }
    li.done { border-color: var(--vscode-testing-iconPassed); }
    li.failed { border-color: var(--vscode-testing-iconFailed); }
    em { font-style: normal; opacity: .8; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin: 0 0 16px; }
    button { background: var(--vscode-testing-iconFailed); color: var(--vscode-button-foreground); border: 0; padding: 8px 12px; border-radius: 3px; cursor: pointer; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    pre { background: var(--vscode-editor-background); padding: 12px; white-space: pre-wrap; max-height: 55vh; overflow: auto; }
  </style>
</head>
<body>
  <h2>${statusState.running ? 'Running' : 'Finished'}</h2>
  <div class="actions">
    <button data-cancel="true"${statusState.running ? '' : ' disabled'}>Cancel Running Build</button>
  </div>
  <div class="meta">
    <strong>Working directory</strong>
    <code>${escapeHtml(statusState.cwd)}</code>
    <strong>Command</strong>
    <code>${escapeHtml(statusState.command)}</code>
  </div>
  <h3>Steps</h3>
  <ul>${steps}</ul>
  <h3>Log</h3>
  <pre>${escapeHtml(statusState.log)}</pre>
  <script>
    const vscode = acquireVsCodeApi();
    const cancelButton = document.querySelector('[data-cancel]');
    if (cancelButton) {
      cancelButton.addEventListener('click', () => {
        if (!cancelButton.disabled) vscode.postMessage({ type: 'cancel' });
      });
    }
  </script>
</body>
</html>`;
}

async function openConfig() {
  const workspace = getWorkspace();
  if (!workspace) return;

  const configPath = getConfigPath(workspace);
  const uri = vscode.Uri.file(configPath);

  if (!fs.existsSync(configPath)) {
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, JSON.stringify(defaultConfig(), null, 2));
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
}

function cancelRunningBuild() {
  if (!currentProcess) return;
  cancellationRequested = true;
  appendLog('\n[extension] Cancellation requested.\n');
  killProcessTree(currentProcess);
}

function killProcessTree(processToKill) {
  if (process.platform === 'win32') {
    cp.spawn('taskkill', ['/pid', String(processToKill.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }

  try {
    process.kill(-processToKill.pid, 'SIGTERM');
  } catch (error) {
    processToKill.kill('SIGTERM');
  }

  setTimeout(() => {
    if (!currentProcess || currentProcess.pid !== processToKill.pid) return;
    try {
      process.kill(-processToKill.pid, 'SIGKILL');
    } catch (error) {
      processToKill.kill('SIGKILL');
    }
  }, 5000).unref();
}

function getWorkspace() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('Open a workspace before running Local Build Runner.');
    return null;
  }

  if (folders.length === 1) return folders[0];

  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (active) {
    const match = folders.find((folder) => active.startsWith(folder.uri.fsPath));
    if (match) return match;
  }

  return folders[0];
}

async function loadConfig(workspace) {
  const configPath = getConfigPath(workspace);
  if (!fs.existsSync(configPath)) {
    const action = await vscode.window.showWarningMessage(
      `Local Build Runner config not found at ${path.relative(workspace.uri.fsPath, configPath)}.`,
      'Create Config'
    );
    if (action === 'Create Config') {
      await openConfig();
    }
    return null;
  }

  try {
    return JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
  } catch (error) {
    vscode.window.showErrorMessage(`Invalid Local Build Runner config: ${error.message}`);
    return null;
  }
}

function getConfigPath(workspace) {
  const configured = vscode.workspace
    .getConfiguration('localBuildRunner')
    .get('configFile', '.vscode/local-build.json');
  return path.join(workspace.uri.fsPath, configured);
}

function getDefault(config, key) {
  return config.defaults ? config.defaults[key] : undefined;
}

function defaultConfig() {
  return {
    name: 'Local Build',
    script: 'tools/deploy/bin/local_build.dart',
    runner: 'fvm dart run',
    defaults: {
      mode: 'build',
      env: 'dev',
      platform: 'all',
    },
    options: {
      mode: ['build', 'patch'],
      env: ['dev', 'prod'],
      platform: ['all', 'android', 'ios'],
    },
    valueFlags: ['build-name', 'build-number', 'release-version'],
    booleanFlags: ['no-upload', 'dry-run', 'can-clean'],
  };
}

function toTitle(value) {
  return value
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

module.exports = {
  activate,
  deactivate,
};
