const TITLES = {
  overview: 'Overview',
  applications: 'Applications',
  pipelines: 'Pipelines',
  environments: 'Environments',
  releases: 'Releases',
  artifacts: 'Artifacts',
  integrations: 'Integrations',
  credentials: 'Credential Manager',
  audit: 'Audit'
};
const MODULES = {
  ops: 'Ops Dashboard',
  devices: 'Manage Devices',
  catalog: 'Hybrid Cloud Catalog',
  hybrid: 'Hybrid-Cloud Ops',
  health: 'Health Check & Compliance',
  patch: 'Patch Management',
  events: 'Event Management',
  aiops: 'AI-OPS',
  eagle: 'EagleEye',
  eagle2: 'EagleEye 2.0',
  cmdb: 'CMDB',
  discovery: 'Discovery Administration',
  analytics: 'Analytics',
  automation: 'Automation',
  admin: 'Admin',
  support: 'Concierto Support',
  xbase: 'X-Base'
};

let S = null;
let flyoutOpen = false;
let credsCache = null;
let currentView = '';
let query = '';
let page = 1;
let pageSize = 10;
let banner = null;
let onSave = null;
let saving = false;
let toastTimer = 0;
let linkToken = 0;
let previewTimer = 0;
let polling = false;
const definitions = {};

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function api(path, options) {
  const opts = { method: (options && options.method) || 'GET', headers: {} };
  if (options && options.body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(options.body);
  }
  return fetch(path, opts).then(async (res) => {
    const text = await res.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
    }
    if (!res.ok) {
      const err = new Error(data.error || ('Request failed (' + res.status + ')'));
      err.detail = data.detail || '';
      throw err;
    }
    return data;
  });
}
function toast(message, kind) {
  const el = document.getElementById('toast');
  el.hidden = false;
  el.className = 'toast ' + (kind === 'err' ? 'err' : 'ok');
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'err' || kind === 'warn' ? 7000 : 2800);
}
function toastError(err) {
  toast((err && err.message ? err.message : 'Request failed') + (err && err.detail ? ' — ' + String(err.detail).slice(0, 220) : ''), 'err');
}
function formatTime(ts) {
  if (!ts) return '—';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function pill(status) {
  const label = status || 'Idle';
  const kind = {
    Success: 'ok', Approved: 'ok', Healthy: 'ok', Available: 'ok', Connected: 'ok',
    Running: 'run', Queued: 'info', Open: 'info', Ready: 'info',
    'Pending approval': 'warn', Pending: 'warn', Unstable: 'warn', Degraded: 'warn',
    Failed: 'bad', Missing: 'bad', Unavailable: 'bad',
    Cancelled: 'muted', Idle: 'muted', Closed: 'muted'
  }[label] || 'muted';
  return '<span class="pill ' + kind + '">' + esc(label) + '</span>';
}
function isCicd(view) {
  return Boolean(TITLES[view]) || String(view).startsWith('pipeline/');
}
function normalizeView(view) {
  if (TITLES[view] || String(view).startsWith('pipeline/')) return view;
  if (String(view).startsWith('module/') && MODULES[view.slice(7)]) return view;
  return 'overview';
}
function titleFor(view) {
  if (TITLES[view]) return TITLES[view];
  if (String(view).startsWith('pipeline/')) {
    const pipeline = (S.pipelines || []).find((item) => item.id === view.slice(9));
    return pipeline ? pipeline.name : 'Pipeline';
  }
  if (String(view).startsWith('module/')) return MODULES[view.slice(7)] || 'Concierto';
  return 'Overview';
}
function appName(id) {
  const app = (S.apps || []).find((item) => item.id === id);
  return app ? app.name : '—';
}
function sourceLabel(value) {
  if (value === 'concierto') return 'Published';
  if (value === 'linked') return 'Linked';
  return 'Synced';
}
function field(label, control, extra) {
  return '<label class="field ' + (extra || '') + '"><span>' + label + '</span>' + control + '</label>';
}
function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}
function checked(id) {
  const el = document.getElementById(id);
  return Boolean(el && el.checked);
}
function searchBox() {
  return '<div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="q" value="' + esc(query) + '" placeholder="Search"></div>';
}
function pager(total) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(total, page * pageSize);
  return '<div class="pager"><span>' + start + '–' + end + ' of ' + total + '</span><label>Rows <select id="page-size">' + [10, 20, 50].map((n) => '<option ' + (n === pageSize ? 'selected' : '') + '>' + n + '</option>').join('') + '</select></label><button type="button" class="btn btn-ghost small" data-act="page" data-dir="-1" ' + (page <= 1 ? 'disabled' : '') + '>Prev</button><button type="button" class="btn btn-ghost small" data-act="page" data-dir="1" ' + (page >= pages ? 'disabled' : '') + '>Next</button></div>';
}
function pageOf(items, textOf) {
  const q = query.trim().toLowerCase();
  const filtered = q ? items.filter((item) => textOf(item).toLowerCase().includes(q)) : items.slice();
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  if (page > pages) page = pages;
  return { rows: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length };
}
function table(headers, body, cols, empty) {
  return '<div class="table-card"><table><thead><tr>' + headers.map((header) => '<th>' + header + '</th>').join('') + '</tr></thead><tbody>' + (body || '<tr><td class="empty-cell" colspan="' + cols + '">' + empty + '</td></tr>') + '</tbody></table></div>';
}
function pendingBanner() {
  const items = (S.runs || []).filter((run) => run.status === 'Pending approval');
  if (!items.length) return '';
  return '<div class="banner warn-banner">' + items.map((run) => '<div class="pending-row"><span><b>' + esc(run.pipelineName) + '</b> is waiting for approval. The engine will not start until you approve it.</span><button type="button" class="btn btn-primary small" data-act="approve-run" data-id="' + esc(run.id) + '">Approve and run</button></div>').join('') + '</div>';
}
function bannerHtml() {
  if (!banner || !banner.results) return '';
  const lines = banner.results.map((result) => '<div class="' + (result.ok ? 'ok' : 'bad') + '">' + esc(result.provider + ': ' + (result.message || (result.imported || 0) + ' added, ' + (result.updated || 0) + ' updated')) + '</div>').join('');
  return '<div class="banner">' + lines + '<div style="margin-top:8px"><button type="button" class="btn btn-ghost small" data-act="dismiss-banner">Dismiss</button></div></div>';
}
function optionList(values, selected) {
  return values.map((value) => '<option ' + (value === selected ? 'selected' : '') + '>' + esc(value) + '</option>').join('');
}
function appOptions(selected) {
  return '<option value="">No application</option>' + (S.apps || []).map((app) => '<option value="' + esc(app.id) + '" ' + (app.id === selected ? 'selected' : '') + '>' + esc(app.name) + '</option>').join('');
}
function envNames(selected) {
  const names = [...new Set([...(S.environments || []).map((env) => env.name), 'DEV', 'QA', 'PROD'])];
  return names.map((name) => '<option ' + (name === selected ? 'selected' : '') + '>' + esc(name) + '</option>').join('');
}

function syncChrome() {
  const cicd = isCicd(currentView);
  const activeNav = cicd ? 'cicd' : (String(currentView).startsWith('module/') ? currentView.slice(7) : '');
  document.querySelectorAll('[data-nav]').forEach((el) => el.classList.toggle('active', el.dataset.nav === activeNav));
  const fly = document.getElementById('flyout');
  fly.hidden = !flyoutOpen;
  document.getElementById('nav-cicd').classList.toggle('open', flyoutOpen);
  const flyView = String(currentView).startsWith('pipeline/') ? 'pipelines' : currentView;
  document.querySelectorAll('.fly-item').forEach((el) => el.classList.toggle('active', el.dataset.view === flyView));
  const title = titleFor(currentView);
  document.getElementById('title').textContent = title;
  document.getElementById('crumb').textContent = title;
  document.getElementById('crumb-root').textContent = cicd ? 'Concierto / CI/CD' : 'Concierto';
  document.title = title + ' — Concierto CI/CD';
  const live = (S.runs || []).some((run) => run.status === 'Running' || run.status === 'Queued');
  document.getElementById('live').hidden = !live;
  if (flyoutOpen) {
    placeFlyout();
    requestAnimationFrame(placeFlyout);
  }
}
function setFlyout(open) {
  flyoutOpen = Boolean(open);
  const fly = document.getElementById('flyout');
  fly.hidden = !flyoutOpen;
  document.getElementById('nav-cicd').classList.toggle('open', flyoutOpen);
  if (flyoutOpen) {
    placeFlyout();
    requestAnimationFrame(placeFlyout);
  }
}
function placeFlyout() {
  const fly = document.getElementById('flyout');
  const btn = document.getElementById('nav-cicd');
  if (!fly || fly.hidden || !btn) return;
  const rect = btn.getBoundingClientRect();
  const height = fly.offsetHeight || 380;
  let top = rect.top - 8;
  if (top + height > window.innerHeight - 12) top = Math.max(12, window.innerHeight - height - 12);
  fly.style.top = top + 'px';
  fly.style.left = (rect.right + 8) + 'px';
}
function fillWho() {
  const user = S.user || 'local';
  const parts = user.split(/[.\s_-]+/).filter(Boolean);
  document.getElementById('avatar').textContent = ((parts[0] || 'C')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  document.getElementById('who-name').textContent = user;
  document.getElementById('who-sub').textContent = S.host || '';
}
function writeHash() {
  const next = '#' + currentView;
  if (location.hash !== next) history.replaceState(null, '', next);
}
function readHash() {
  return decodeURIComponent((location.hash || '').replace(/^#/, ''));
}
function showView(view) {
  const next = normalizeView(view);
  if (next !== currentView) {
    query = '';
    page = 1;
  }
  const entered = next !== currentView;
  currentView = next;
  writeHash();
  if (next === 'credentials' && entered) {
    render();
    api('/api/creds').then((data) => {
      credsCache = data;
      if (currentView === 'credentials') render();
    }).catch(toastError);
    return;
  }
  render();
  if (entered && next.startsWith('pipeline/')) decoratePipeline(next.slice(9));
}
function render(opts) {
  const focusId = opts && opts.keep && document.activeElement ? document.activeElement.id : '';
  const pos = focusId && document.activeElement ? document.activeElement.selectionStart : null;
  document.getElementById('view').innerHTML = viewHtml();
  syncChrome();
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (typeof pos === 'number') {
        try { el.setSelectionRange(pos, pos); } catch (err) { /* some fields have no caret */ }
      }
    }
  }
}
function viewHtml() {
  if (currentView.startsWith('module/')) return moduleView(MODULES[currentView.slice(7)]);
  if (currentView.startsWith('pipeline/')) return pipelineDetail(currentView.slice(9));
  const views = { overview, applications, pipelines, environments, releases, artifacts, integrations, credentials, audit };
  return (views[currentView] || overview)();
}

function overview() {
  const runs = S.runs || [];
  const running = runs.filter((run) => run.status === 'Running' || run.status === 'Queued').length;
  const done = runs.filter((run) => ['Success', 'Failed', 'Unstable', 'Cancelled'].includes(run.status));
  const rate = done.length ? Math.round(100 * done.filter((run) => run.status === 'Success').length / done.length) + '%' : '—';
  const lonely = (S.apps || []).filter((app) => !(S.pipelines || []).some((pipe) => pipe.appId === app.id));
  const recent = runs.slice(0, 8).map((run) => '<tr><td><b>' + esc(run.pipelineName) + '</b></td><td>' + esc(run.engine) + '</td><td>' + pill(run.status) + '</td><td>' + esc(run.label || '—') + '</td><td>' + formatTime(run.started) + '</td><td>' + (run.webUrl ? '<a href="' + esc(run.webUrl) + '" target="_blank" rel="noopener">Open</a>' : '—') + '</td></tr>').join('');
  const incidents = (S.incidents || []).filter((item) => item.status === 'Open').slice(0, 6);
  const setup = [
    [configuredAny(), 'Save Jenkins, GitHub, or Azure DevOps credentials'],
    [Object.values(S.integrationStatus || {}).some((item) => item.ok), 'Test a connection'],
    [(S.pipelines || []).length > 0, 'Sync or create a pipeline'],
    [runs.length > 0, 'Run a pipeline from Concierto']
  ];
  return pendingBanner() +
    '<div class="kpis">' +
      kpi('orange', 'Pipelines', (S.pipelines || []).length, 'M4 6h16M4 12h10M4 18h16') +
      kpi('blue', 'Running now', running, 'M8 5v14l11-7z') +
      kpi('green', 'Success rate', rate, 'M5 13l4 4L19 7') +
      kpi('amber', 'Apps with no pipeline', lonely.length, 'M12 8v5M12 16h.01M12 3l9 16H3z') +
    '</div>' +
    '<div class="toolbar"><div class="muted">Definitions publish out to Jenkins, GitHub Actions, and Azure DevOps. Sync brings their pipelines and run status back.</div><div class="actions"><button type="button" class="btn" data-act="sync" data-provider="all">Sync from tools</button><button type="button" class="btn btn-primary" data-act="add-pipe">Create pipeline</button></div></div>' +
    '<div class="three">' + engineCard('Jenkins', 'jenkins') + engineCard('GitHub Actions', 'github') + engineCard('Azure DevOps', 'azure') + '</div>' +
    '<p class="hint section-gap">Concierto Managed Runner is planned for a dedicated instance. This prototype triggers and manages Jenkins, GitHub Actions, and Azure DevOps from here.</p>' +
    '<div class="split"><div class="card"><h3>Recent runs</h3>' + table(['Pipeline', 'Engine', 'Status', 'Run', 'Started', ''], recent, 6, 'No runs yet. Sync pipelines, or create one and run it.') + '</div>' +
    '<div class="stack"><div class="card"><h3>Setup</h3><ul class="setup">' + setup.map((item) => '<li><span>' + item[1] + '</span>' + pill(item[0] ? 'Success' : 'Pending') + '</li>').join('') + '</ul></div>' +
    '<div class="card"><h3>Open incidents</h3>' + (incidents.length ? incidents.map((item) => '<div class="pending-row"><div><b>' + esc(item.title) + '</b><div class="hint">' + esc(item.detail || '') + '</div></div><button type="button" class="btn small" data-act="close-incident" data-id="' + esc(item.id) + '">Close</button></div>').join('') : '<p class="hint">A failed run on Jenkins, GitHub, or Azure DevOps opens an incident here.</p>') + '</div></div></div>' +
    '<div class="card section-gap"><h3>Both-way sync</h3><div class="flow"><span class="stage">Concierto UI</span><span class="arrow">→</span><span class="stage">Create or edit</span><span class="arrow">→</span><span class="stage">Publish to the engine</span><span class="arrow">→</span><span class="stage">Jenkins / GitHub / Azure DevOps</span></div><div class="flow"><span class="stage">Engine runs and definitions</span><span class="arrow">→</span><span class="stage">Sync into Concierto</span></div></div>';
}
function kpi(tone, label, value, path) {
  return '<div class="card kpi"><div class="kpi-icon ' + tone + '"><svg viewBox="0 0 24 24"><path d="' + path + '"/></svg></div><div><div class="kpi-label">' + label + '</div><div class="kpi-value">' + esc(value) + '</div></div></div>';
}
function configuredAny() {
  const flags = S.configured || {};
  return Boolean(flags.jenkins || flags.github || flags.azure);
}
function engineCard(label, key) {
  const status = (S.integrationStatus || {})[key] || {};
  const on = S.configured && S.configured[key];
  const count = (S.pipelines || []).filter((pipe) => (key === 'jenkins' && pipe.engine === 'Jenkins') || (key === 'github' && pipe.engine === 'GitHub Actions') || (key === 'azure' && pipe.engine === 'Azure DevOps')).length;
  return '<div class="card engine-card"><h3>' + label + '</h3><p class="hint">' + esc(on ? (status.message || 'Saved') : 'Not configured') + '</p><div>' + pill(status.ok ? 'Connected' : (on ? 'Saved' : 'Idle')) + ' <span class="muted">' + count + ' in Concierto</span></div></div>';
}

function applications() {
  const data = pageOf(S.apps || [], (app) => [app.name, app.repo, app.source, app.branch].join(' '));
  const rows = data.rows.map((app) => {
    const count = (S.pipelines || []).filter((pipe) => pipe.appId === app.id).length;
    return '<tr><td><b>' + esc(app.name) + '</b></td><td>' + esc(app.source || '—') + '</td><td>' + esc(app.repo || '—') + '</td><td>' + esc(app.branch || '—') + '</td><td>' + count + '</td><td class="actions-cell"><button type="button" class="btn btn-ghost small" data-act="edit-app" data-id="' + esc(app.id) + '">Edit</button><button type="button" class="btn btn-danger small" data-act="delete-app" data-id="' + esc(app.id) + '">Delete</button></td></tr>';
  }).join('');
  return toolbarHtml('Register the application, then attach or create its pipeline.', '<button type="button" class="btn btn-primary" data-act="add-app">Add application</button>') +
    table(['Application', 'Source', 'Repository', 'Branch', 'Pipelines', ''], rows, 6, 'No applications yet.') + pager(data.total);
}
function pipelines() {
  const data = pageOf(S.pipelines || [], (pipe) => [pipe.name, pipe.engine, pipe.repo, pipe.workflow, pipe.status, pipe.lastRunLabel].join(' '));
  const rows = data.rows.map((pipe) => '<tr><td><b><button type="button" class="linkish" data-act="open-pipe" data-id="' + esc(pipe.id) + '">' + esc(pipe.name) + '</button></b><div class="hint">' + esc(sourceLabel(pipe.definitionSource)) + (pipe.missing ? ' · missing on engine' : '') + '</div></td><td>' + esc(pipe.engine) + '</td><td>' + esc(appName(pipe.appId)) + '</td><td>' + esc(pipe.repo || pipe.workflow || '—') + '</td><td>' + esc(pipe.lastRunLabel || '—') + '<div class="hint">' + formatTime(pipe.lastRunAt) + '</div></td><td>' + pill(pipe.missing ? 'Missing' : pipe.status) + '</td><td class="actions-cell"><button type="button" class="btn btn-primary small" data-act="run-pipe" data-id="' + esc(pipe.id) + '">Run</button><button type="button" class="btn btn-ghost small" data-act="edit-pipe" data-id="' + esc(pipe.id) + '">Edit</button><button type="button" class="btn btn-ghost small" data-act="open-url" data-id="' + esc(pipe.id) + '">Open</button><button type="button" class="btn btn-danger small" data-act="delete-pipe" data-id="' + esc(pipe.id) + '">Delete</button></td></tr>').join('');
  return pendingBanner() + bannerHtml() + toolbarHtml('One list for Jenkins jobs, GitHub workflows, and Azure Pipelines.', '<button type="button" class="btn" data-act="refresh">Refresh status</button><button type="button" class="btn" data-act="sync" data-provider="all">Sync from tools</button><button type="button" class="btn btn-primary" data-act="add-pipe">Create pipeline</button>') +
    table(['Pipeline', 'Engine', 'Application', 'Repository / job', 'Last run', 'Status', ''], rows, 7, 'No pipelines yet. Sync from a tool, or create one in Concierto.') + pager(data.total);
}
function environments() {
  const data = pageOf(S.environments || [], (env) => [env.name, env.status, env.version, appName(env.appId)].join(' '));
  const rows = data.rows.map((env) => '<tr><td><b>' + esc(env.name) + '</b></td><td>' + esc(appName(env.appId)) + '</td><td>' + pill(env.status) + '</td><td>' + esc(env.version || '—') + '</td><td class="actions-cell"><button type="button" class="btn btn-ghost small" data-act="edit-env" data-id="' + esc(env.id) + '">Edit</button><button type="button" class="btn btn-danger small" data-act="delete-env" data-id="' + esc(env.id) + '">Delete</button></td></tr>').join('');
  return toolbarHtml('Promotion targets used by releases and approval gates.', '<button type="button" class="btn btn-primary" data-act="add-env">Add environment</button>') +
    table(['Environment', 'Application', 'Status', 'Version', ''], rows, 5, 'No environments yet.') + pager(data.total);
}
function releases() {
  const data = pageOf(S.releases || [], (rel) => [rel.name, rel.environment, rel.status, appName(rel.appId)].join(' '));
  const rows = data.rows.map((rel) => '<tr><td><b>' + esc(rel.name) + '</b></td><td>' + esc(appName(rel.appId)) + '</td><td>' + esc(rel.environment) + '</td><td>' + pill(rel.status) + '</td><td>' + formatTime(rel.created) + '</td><td class="actions-cell">' + (rel.status === 'Approved' ? '' : '<button type="button" class="btn btn-primary small" data-act="approve-rel" data-id="' + esc(rel.id) + '">Approve</button> ') + '<button type="button" class="btn btn-ghost small" data-act="edit-rel" data-id="' + esc(rel.id) + '">Edit</button><button type="button" class="btn btn-danger small" data-act="delete-rel" data-id="' + esc(rel.id) + '">Delete</button></td></tr>').join('');
  return toolbarHtml('Track a version and approve it before it is treated as released.', '<button type="button" class="btn btn-primary" data-act="add-rel">Create release</button>') +
    table(['Release', 'Application', 'Target', 'Status', 'Created', ''], rows, 6, 'No releases yet.') + pager(data.total);
}
function artifacts() {
  const data = pageOf(S.artifacts || [], (art) => [art.name, art.registry, appName(art.appId)].join(' '));
  const rows = data.rows.map((art) => '<tr><td><b>' + esc(art.name) + '</b></td><td>' + esc(appName(art.appId)) + '</td><td>' + esc(art.registry || '—') + '</td><td>' + pill(art.status || 'Available') + '</td><td>' + formatTime(art.created) + '</td><td class="actions-cell"><button type="button" class="btn btn-ghost small" data-act="edit-art" data-id="' + esc(art.id) + '">Edit</button><button type="button" class="btn btn-danger small" data-act="delete-art" data-id="' + esc(art.id) + '">Delete</button></td></tr>').join('');
  return toolbarHtml('Successful runs add an artifact record. You can also add one by hand.', '<button type="button" class="btn btn-primary" data-act="add-art">Add artifact</button>') +
    table(['Artifact', 'Application', 'Location', 'Status', 'Created', ''], rows, 6, 'No artifacts yet.') + pager(data.total);
}
function integrations() {
  return bannerHtml() + '<div class="toolbar"><div class="muted">Test the saved credentials, then pull pipelines into Concierto.</div><div class="actions"><button type="button" class="btn btn-primary" data-act="sync" data-provider="all">Sync all</button><button type="button" class="btn" data-view="credentials">Credential Manager</button></div></div><div class="three">' +
    integrationCard('Jenkins', 'jenkins', 'Jobs already on this machine, including the HTML page pipeline.') +
    integrationCard('GitHub Actions', 'github', 'Workflows from the repositories saved in Credential Manager.') +
    integrationCard('Azure DevOps', 'azure', 'YAML pipelines in the saved organization and project.') +
    '</div>';
}
function integrationCard(label, key, text) {
  const status = (S.integrationStatus || {})[key] || {};
  const on = S.configured && S.configured[key];
  return '<div class="card"><h3>' + label + '</h3><p class="hint">' + text + '</p><p>' + pill(status.ok ? 'Connected' : (on ? 'Saved' : 'Idle')) + '</p><p class="hint">' + esc(status.message || 'Not tested') + (status.at ? ' · ' + formatTime(status.at) : '') + '</p><div class="actions"><button type="button" class="btn small" data-act="test-saved" data-provider="' + key + '">Test</button><button type="button" class="btn btn-primary small" data-act="sync" data-provider="' + key + '">Sync</button></div></div>';
}
function credentials() {
  if (!credsCache) return '<div class="card">Loading credentials…</div>';
  const j = credsCache.jenkins || {};
  const g = credsCache.github || {};
  const a = credsCache.azureDevOps || {};
  return '<div class="card" style="margin-bottom:14px"><h3>Where secrets are stored</h3><p class="hint">This file is on the machine running the server (' + esc(S.host) + '). Run the server on WinTest_DND so the file is created on that desktop.</p><div class="path">' + esc(credsCache.path || S.credsPath) + '</div></div>' +
    '<form id="cred-form" class="stack">' +
    '<div class="card"><h2>Jenkins</h2><p class="hint">On WinTest_DND: sign in to Jenkins, open your name at the top right, then Security, then Add new token. Paste the API token, not the login password. Default URL is this machine on port 8080.</p>' +
      '<div class="form-grid">' +
      field('Jenkins URL', '<input id="j-url" value="' + esc(j.url || '') + '">') +
      field('Username', '<input id="j-user" value="' + esc(j.username || '') + '">') +
      secretField('API token', 'j-token', j.apiToken || '') +
      field('Agent shell', '<select id="j-shell"><option value="bat" ' + (j.shell !== 'sh' ? 'selected' : '') + '>bat (Windows)</option><option value="sh" ' + (j.shell === 'sh' ? 'selected' : '') + '>sh (Linux agent)</option></select>') +
      '</div><button type="button" class="btn" data-act="test-cred" data-provider="jenkins">Save and test Jenkins</button> ' + statusLine('jenkins') + '</div>' +
    '<div class="card"><h2>GitHub</h2><p class="hint">GitHub, Settings, Developer settings, Personal access tokens. Classic token: repo and workflow. Fine-grained token: Contents read and write, Actions read and write, Metadata read. Sync only the repositories listed here.</p>' +
      secretField('Personal access token', 'gh-token', g.token || '') +
      field('Repositories, one owner/name per line', '<textarea id="gh-repos">' + esc((g.repos || []).join('\n')) + '</textarea>') +
      field('Branch', '<input id="gh-branch" value="' + esc(g.branch || 'main') + '">') +
      '<div class="actions"><button type="button" class="btn" data-act="load-github">Load my repositories</button><button type="button" class="btn" data-act="test-cred" data-provider="github">Save and test GitHub</button></div>' + statusLine('github') + '</div>' +
    '<div class="card"><h2>Azure DevOps</h2><p class="hint">User settings, Personal access tokens. Scopes: Code read and write, and Build read and execute. Organization is the name in https://dev.azure.com/your-org. Creating a pipeline pushes YAML into an Azure Repos Git repository.</p>' +
      '<div class="form-grid">' +
      field('Organization', '<input id="az-org" value="' + esc(a.organization || '') + '" placeholder="your-org">') +
      field('Project', '<input id="az-project" value="' + esc(a.project || '') + '">') +
      secretField('Personal access token', 'az-pat', a.pat || '') +
      field('Repository', '<input id="az-repo" value="' + esc(a.repository || '') + '" placeholder="repository name">') +
      field('Branch', '<input id="az-branch" value="' + esc(a.branch || 'main') + '">') +
      '</div><div class="actions"><button type="button" class="btn" data-act="load-azure">Load repositories</button><button type="button" class="btn" data-act="test-cred" data-provider="azure">Save and test Azure DevOps</button></div>' + statusLine('azure') + '</div>' +
    '<div><button type="submit" class="btn btn-primary">Save credentials</button></div></form>';
}
function secretField(label, id, value) {
  return '<label class="field"><span class="secret-line">' + label + '<button type="button" class="linkish" data-act="toggle-secret" data-target="' + id + '">Show</button></span><input id="' + id + '" type="password" value="' + esc(value) + '" autocomplete="off"></label>';
}
function statusLine(key) {
  const status = (S.integrationStatus || {})[key];
  if (!status || !status.at) return '';
  return '<p class="hint">' + esc(status.message || '') + ' · ' + formatTime(status.at) + '</p>';
}
function audit() {
  const data = pageOf(S.audit || [], (item) => item.text || '');
  const rows = data.rows.map((item) => '<tr><td>' + formatTime(item.time) + '</td><td>' + esc(item.text) + '</td></tr>').join('');
  return toolbarHtml('Create, sync, run, approval, and credential changes on this machine.', '') +
    table(['Time', 'Activity'], rows, 2, 'No activity yet.') + pager(data.total);
}
function moduleView(name) {
  return '<div class="placeholder"><h2>' + esc(name) + '</h2><p class="hint">This menu is part of the Concierto shell. The working module in this prototype is CI/CD.</p><button type="button" class="btn btn-primary" data-nav="cicd">Open CI/CD</button></div>';
}
function toolbarHtml(text, actions) {
  return '<div class="toolbar"><div>' + searchBox() + '<div class="hint">' + text + '</div></div><div class="actions">' + actions + '</div></div>';
}
function pipelineDetail(id) {
  const pipeline = (S.pipelines || []).find((item) => item.id === id);
  if (!pipeline) return '<div class="card">This pipeline is no longer in Concierto. <button type="button" class="btn" data-view="pipelines">Back to pipelines</button></div>';
  const runs = (S.runs || []).filter((run) => run.pipelineId === id);
  const definition = definitions[id];
  const stages = (pipeline.stages && pipeline.stages.length ? pipeline.stages : ['Source', 'Build', 'Test', 'Package']);
  const runRows = runs.slice(0, 8).map((run) => '<tr><td>' + esc(run.label || '—') + '</td><td>' + pill(run.status) + '</td><td>' + formatTime(run.started) + '</td><td>' + (run.webUrl ? '<a href="' + esc(run.webUrl) + '" target="_blank" rel="noopener">Open</a>' : '—') + '</td><td>' + (run.status === 'Pending approval' ? '<button type="button" class="btn btn-primary small" data-act="approve-run" data-id="' + esc(run.id) + '">Approve and run</button>' : '') + '</td></tr>').join('');
  const latest = runs[0];
  return '<div class="detail-top"><div><button type="button" class="btn btn-ghost small" data-view="pipelines">Back</button><p class="hint">' + esc(pipeline.engine) + ' · ' + esc(sourceLabel(pipeline.definitionSource)) + (pipeline.repo ? ' · ' + esc(pipeline.repo) : '') + '</p></div><div class="actions"><button type="button" class="btn btn-primary" data-act="run-pipe" data-id="' + esc(pipeline.id) + '">Run</button><button type="button" class="btn" data-act="edit-pipe" data-id="' + esc(pipeline.id) + '">Edit</button><button type="button" class="btn" data-act="open-url" data-id="' + esc(pipeline.id) + '">Open in engine</button></div></div>' +
    '<div class="card"><div class="flow">' + stages.map((stage, index) => '<span class="stage">' + esc(stage) + '</span>' + (index < stages.length - 1 ? '<span class="arrow">→</span>' : '')).join('') + '</div>' + (pipeline.approvalRequired ? '<p class="hint">Approval is required in Concierto before this pipeline can start. Push triggers are left off so a direct push cannot skip the gate.</p>' : '') + '</div>' +
    '<div class="split"><div class="card"><h3>Definition</h3><p class="hint">' + esc(definition ? definition.source : 'Loading the definition…') + '</p><pre>' + esc(definition ? definition.text : '') + '</pre></div><div class="card"><h3>Runs</h3>' + table(['Run', 'Status', 'Started', '', ''], runRows, 5, 'No Concierto runs yet.') + (latest && latest.consoleTail ? '<h3 style="margin-top:14px">Latest log</h3><pre>' + esc(latest.consoleTail) + '</pre>' : '') + (latest && latest.error ? '<p class="hint">' + esc(latest.error) + '</p>' : '') + '</div></div>';
}

function openModal(title, body, save, label, wide) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-save').textContent = label || 'Save';
  document.getElementById('modal-save').disabled = false;
  document.getElementById('modal-card').classList.toggle('wide', !!wide);
  onSave = save;
  document.getElementById('modal').hidden = false;
  const first = document.querySelector('#modal-body input, #modal-body select, #modal-body textarea');
  if (first) first.focus();
}
function closeModal() {
  document.getElementById('modal').hidden = true;
  onSave = null;
}
function appForm(app) {
  const item = app || { name: '', source: 'GitHub', repo: '', branch: 'main', image: '' };
  return '<div class="form-grid">' +
    field('Application name', '<input id="a-name" value="' + esc(item.name) + '">') +
    field('Source', '<select id="a-source">' + optionList(['GitHub', 'Azure Repos', 'Other'], item.source || 'GitHub') + '</select>') +
    field('Repository', '<input id="a-repo" value="' + esc(item.repo || '') + '" placeholder="owner/name">', 'full') +
    field('Branch', '<input id="a-branch" value="' + esc(item.branch || 'main') + '">') +
    field('Existing image, optional', '<input id="a-image" value="' + esc(item.image || '') + '">') +
    '</div>';
}
function envForm(env) {
  const item = env || { name: 'DEV', appId: '', status: 'Healthy', version: '—' };
  return '<div class="form-grid">' +
    field('Name', '<input id="e-name" value="' + esc(item.name) + '">') +
    field('Application', '<select id="e-app">' + appOptions(item.appId || '') + '</select>') +
    field('Status', '<select id="e-status">' + optionList(['Healthy', 'Degraded', 'Unavailable'], item.status || 'Healthy') + '</select>') +
    field('Version', '<input id="e-version" value="' + esc(item.version || '—') + '">') +
    '</div>';
}
function releaseForm(rel) {
  const item = rel || { name: '', appId: '', environment: 'DEV' };
  return '<div class="form-grid">' +
    field('Release name', '<input id="r-name" value="' + esc(item.name) + '">') +
    field('Application', '<select id="r-app">' + appOptions(item.appId || '') + '</select>') +
    field('Environment', '<select id="r-env">' + envNames(item.environment || 'DEV') + '</select>') +
    '</div>';
}
function artifactForm(art) {
  const item = art || { name: '', appId: '', registry: 'Jenkins' };
  return '<div class="form-grid">' +
    field('Artifact', '<input id="art-name" value="' + esc(item.name) + '">') +
    field('Application', '<select id="art-app">' + appOptions(item.appId || '') + '</select>') +
    field('Location', '<input id="art-reg" value="' + esc(item.registry || '') + '">') +
    '</div>';
}
function pipelineForm(existing) {
  const item = existing || {};
  const defaults = S.defaults || {};
  const stages = (item.stages && item.stages.length ? item.stages : ['Checkout', 'Build', 'Test', 'Package']);
  const publishChecked = existing ? item.definitionSource === 'concierto' : true;
  const mode = existing ? '' : '<div class="field full"><span>How to add it</span><label class="check"><input type="radio" name="p-mode" value="create" checked> Create the definition in Concierto and publish it to the engine</label><label class="check"><input type="radio" name="p-mode" value="link"> Link a pipeline that already exists</label></div>';
  return '<div class="pipe-form"><div>' + mode +
    '<div class="form-grid">' +
    field('Pipeline name', '<input id="p-name" value="' + esc(item.name || '') + '">') +
    field('Engine', '<select id="p-engine">' + optionList(['Jenkins', 'GitHub Actions', 'Azure DevOps'], item.engine || 'Jenkins') + '</select>') +
    field('Application', '<select id="p-app">' + appOptions(item.appId || '') + '</select>') +
    field('Or create an application', '<input id="p-new-app" placeholder="New application name">') +
    field('Branch', '<input id="p-branch" value="' + esc(item.branch || defaults.githubBranch || 'main') + '">') +
    '<div class="mode-create">' + field('Template', '<select id="p-template"><option value="html-page" ' + (item.template !== 'generic' ? 'selected' : '') + '>HTML page</option><option value="generic" ' + (item.template === 'generic' ? 'selected' : '') + '>Generic stages</option></select>') + '</div>' +
    '</div>' +
    '<div class="engine-fields" data-engine="Jenkins"><div class="mode-create">' + field('Jenkins job name', '<input id="p-job" value="' + esc(item.engine === 'Jenkins' ? (item.externalId || '') : '') + '" placeholder="html-page">') + '</div></div>' +
    '<div class="engine-fields" data-engine="GitHub Actions">' + field('GitHub repository', '<input id="p-gh-repo" value="' + esc(item.engine === 'GitHub Actions' ? (item.repo || '') : ((defaults.githubRepos || [])[0] || '')) + '" placeholder="owner/name">') + '<div class="mode-create">' + field('Workflow file', '<input id="p-workflow" value="' + esc(item.engine === 'GitHub Actions' ? (item.workflow || '') : '') + '" placeholder=".github/workflows/html-page.yml">') + '</div></div>' +
    '<div class="engine-fields" data-engine="Azure DevOps">' + field('Azure Repos repository', '<input id="p-az-repo" value="' + esc(item.engine === 'Azure DevOps' ? (item.repo || '') : (defaults.azureRepository || '')) + '">') + '<div class="mode-create">' + field('YAML path', '<input id="p-yaml" value="' + esc(item.engine === 'Azure DevOps' ? (item.workflow || '') : '') + '" placeholder="/concierto/html-page.yml">') + '</div></div>' +
    '<div class="mode-link field"><span>Existing pipeline</span><select id="p-remote"><option value="">Choose after the list loads</option></select></div>' +
    '<div class="mode-create field full"><span>Stages</span><div id="stage-editor">' + stages.map((stage) => '<div class="stage-row"><input value="' + esc(stage) + '"><button type="button" data-act="remove-stage" aria-label="Remove stage">×</button></div>').join('') + '</div><button type="button" class="btn" data-act="add-stage">Add stage</button></div>' +
    '<label class="check"><input id="p-approval" type="checkbox" ' + (item.approvalRequired ? 'checked' : '') + '> Require approval in Concierto before the run starts</label>' +
    '<label class="check mode-create"><input id="p-push" type="checkbox" ' + (item.pushTrigger ? 'checked' : '') + '> Also run on push to the branch</label>' +
    '<label class="check mode-create"><input id="p-publish" type="checkbox" ' + (publishChecked ? 'checked' : '') + '> ' + (existing ? 'Replace the definition on the engine with the stages above' : 'Publish the definition to the engine') + '</label>' +
    (existing ? '<p class="hint">Changing the engine creates the definition on the new engine and leaves the previous one in place.</p>' : '<p class="hint">Save credentials before publishing. Windows Jenkins uses bat. The HTML template writes dist/index.html on the agent.</p>') +
    '</div><div><div class="field"><span>Definition preview</span><pre id="p-preview">Generating…</pre></div></div></div>';
}
function readPipelineForm() {
  const modeEl = document.querySelector('input[name="p-mode"]:checked');
  return {
    mode: modeEl ? modeEl.value : 'edit',
    name: val('p-name'),
    appId: val('p-app'),
    newAppName: val('p-new-app'),
    engine: val('p-engine') || 'Jenkins',
    template: val('p-template') || 'html-page',
    branch: val('p-branch') || 'main',
    stages: [...document.querySelectorAll('#stage-editor input')].map((input) => input.value.trim()).filter(Boolean),
    approvalRequired: checked('p-approval'),
    pushTrigger: checked('p-push'),
    publish: checked('p-publish'),
    jenkinsJob: val('p-job'),
    githubRepo: val('p-gh-repo'),
    workflowPath: val('p-workflow'),
    azureRepo: val('p-az-repo'),
    yamlPath: val('p-yaml'),
    remoteId: val('p-remote')
  };
}
function applyPipeFormVisibility() {
  const engine = val('p-engine') || 'Jenkins';
  const modeEl = document.querySelector('input[name="p-mode"]:checked');
  const mode = modeEl ? modeEl.value : 'create';
  document.querySelectorAll('.engine-fields').forEach((el) => { el.hidden = el.dataset.engine !== engine; });
  document.querySelectorAll('.mode-create').forEach((el) => { el.hidden = mode === 'link'; });
  document.querySelectorAll('.mode-link').forEach((el) => { el.hidden = mode !== 'link'; });
  const push = document.getElementById('p-push');
  if (push && checked('p-approval')) {
    push.checked = false;
    push.disabled = true;
  } else if (push) push.disabled = false;
}
async function refreshPreview() {
  const pre = document.getElementById('p-preview');
  if (!pre) return;
  const modeEl = document.querySelector('input[name="p-mode"]:checked');
  if (modeEl && modeEl.value === 'link') {
    pre.textContent = 'Linking keeps the definition that already exists on the engine.';
    return;
  }
  try {
    const data = await api('/api/preview', { method: 'POST', body: readPipelineForm() });
    const slot = document.getElementById('p-preview');
    if (slot) slot.textContent = data.filename + '\n\n' + data.text;
  } catch (err) {
    const slot = document.getElementById('p-preview');
    if (slot) slot.textContent = err.message;
  }
}
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 300);
}
async function loadLinkOptions() {
  const token = ++linkToken;
  const sel = document.getElementById('p-remote');
  if (!sel || sel.closest('.mode-link').hidden) return;
  sel.innerHTML = '<option value="">Loading…</option>';
  try {
    const engine = val('p-engine');
    let data;
    if (engine === 'Jenkins') data = await api('/api/remote/jenkins/jobs');
    else if (engine === 'GitHub Actions') {
      const repo = val('p-gh-repo');
      if (!repo) {
        sel.innerHTML = '<option value="">Enter owner/name first</option>';
        return;
      }
      data = await api('/api/remote/github/workflows?repo=' + encodeURIComponent(repo));
    } else data = await api('/api/remote/azure/pipelines');
    if (token !== linkToken || !document.getElementById('p-remote')) return;
    const items = data.items || [];
    document.getElementById('p-remote').innerHTML = items.length
      ? items.map((item) => '<option value="' + esc(item.id) + '">' + esc(item.name) + '</option>').join('')
      : '<option value="">Nothing found. Sync credentials and try again.</option>';
  } catch (err) {
    if (document.getElementById('p-remote')) document.getElementById('p-remote').innerHTML = '<option value="">' + esc(err.message) + '</option>';
  }
}
function readCredForm() {
  return {
    jenkins: { url: val('j-url'), username: val('j-user'), apiToken: val('j-token'), shell: val('j-shell') || 'bat' },
    github: { token: val('gh-token'), repos: val('gh-repos').split(/\n/).map((line) => line.trim()).filter(Boolean), branch: val('gh-branch') || 'main' },
    azureDevOps: { organization: val('az-org'), project: val('az-project'), pat: val('az-pat'), repository: val('az-repo'), branch: val('az-branch') || 'main' }
  };
}
async function persistCreds() {
  if (!document.getElementById('j-url')) throw new Error('Open Credential Manager before saving.');
  credsCache = await api('/api/creds', { method: 'PUT', body: readCredForm() });
  S = await api('/api/state');
}
async function reload() {
  S = await api('/api/state');
  render();
}

async function savePipeline(id) {
  const body = readPipelineForm();
  if (body.mode === 'link') {
    if (!body.remoteId) throw new Error('Choose the pipeline to link.');
    body.publish = false;
    if (!body.name) {
      const sel = document.getElementById('p-remote');
      const option = sel && sel.selectedOptions ? sel.selectedOptions[0] : null;
      body.name = option ? option.textContent : body.remoteId;
    }
  }
  const data = id
    ? await api('/api/pipelines/' + encodeURIComponent(id), { method: 'PUT', body })
    : await api('/api/pipelines', { method: 'POST', body });
  closeModal();
  S = await api('/api/state');
  showView('pipelines');
  toast(data.warning || (id ? 'Pipeline updated' : 'Pipeline saved'));
}
async function runPipeline(id) {
  try {
    const data = await api('/api/pipelines/' + encodeURIComponent(id) + '/run', { method: 'POST', body: {} });
    S = await api('/api/state');
    toast(data.run && data.run.status === 'Pending approval' ? 'Waiting for approval. The engine has not started.' : 'Run requested.');
    render();
  } catch (err) {
    try { S = await api('/api/state'); } catch (ignore) { /* keep the last screen */ }
    toastError(err);
    render();
  }
}
async function decoratePipeline(id) {
  try {
    definitions[id] = await api('/api/pipelines/' + encodeURIComponent(id) + '/definition');
  } catch (err) {
    definitions[id] = { text: err.message, source: 'Could not read the engine definition' };
  }
  const run = (S.runs || []).find((item) => item.pipelineId === id && item.status !== 'Pending approval');
  if (run) {
    try {
      const data = await api('/api/runs/' + encodeURIComponent(run.id) + '?log=1');
      const index = S.runs.findIndex((item) => item.id === run.id);
      if (index >= 0) S.runs[index] = data.run;
    } catch (err) { /* definition is still useful without the log */ }
  }
  if (currentView === 'pipeline/' + id) render();
}
async function tick() {
  if (!S || polling || document.hidden) return;
  if (!document.getElementById('modal').hidden) return;
  const activeEl = document.activeElement;
  if (activeEl && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName)) return;
  const active = (S.runs || []).some((run) => run.status === 'Running' || run.status === 'Queued');
  if (!active) return;
  const detailId = currentView.startsWith('pipeline/') ? currentView.slice(9) : '';
  polling = true;
  try {
    S = await api('/api/state?refresh=1');
    if (detailId) {
      const run = (S.runs || []).find((item) => item.pipelineId === detailId && (item.status === 'Running' || item.status === 'Queued' || item.status === 'Success' || item.status === 'Failed'));
      if (run) {
        const logged = await api('/api/runs/' + encodeURIComponent(run.id) + '?log=1');
        const index = S.runs.findIndex((item) => item.id === run.id);
        if (index >= 0) S.runs[index] = logged.run;
      }
    }
    if (currentView !== 'credentials') render();
  } catch (err) { /* leave the current screen up */ }
  finally { polling = false; }
}

document.addEventListener('click', async (event) => {
  const actEl = event.target.closest('[data-act]');
  if (actEl) {
    if (!actEl.closest('#flyout') && !actEl.closest('#nav-cicd')) setFlyout(false);
    const act = actEl.dataset.act;
    const id = actEl.dataset.id;
    try {
      if (act === 'modal-close') return closeModal();
      if (act === 'dismiss-banner') { banner = null; return render(); }
      if (act === 'page') { page += Number(actEl.dataset.dir || 0); return render(); }
      if (act === 'toggle-secret') {
        const input = document.getElementById(actEl.dataset.target);
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
        actEl.textContent = input.type === 'password' ? 'Show' : 'Hide';
        return;
      }
      if (act === 'add-stage') {
        const editor = document.getElementById('stage-editor');
        if (!editor) return;
        const row = document.createElement('div');
        row.className = 'stage-row';
        row.innerHTML = '<input value="New stage"><button type="button" data-act="remove-stage" aria-label="Remove stage">×</button>';
        editor.appendChild(row);
        return schedulePreview();
      }
      if (act === 'remove-stage') {
        const rows = document.querySelectorAll('#stage-editor .stage-row');
        if (rows.length < 2) return toast('Keep at least one stage.', 'err');
        actEl.closest('.stage-row').remove();
        return schedulePreview();
      }
      if (act === 'add-app') return openModal('Add application', appForm(null), () => saveApp(null), 'Add');
      if (act === 'edit-app') return openModal('Edit application', appForm((S.apps || []).find((item) => item.id === id)), () => saveApp(id), 'Save');
      if (act === 'delete-app') return openModal('Delete application', '<p>Remove <b>' + esc(appName(id)) + '</b> from Concierto. Pipelines stay in the list.</p>', () => removeRecord('/api/apps/' + encodeURIComponent(id), 'Application removed', 'applications'), 'Delete');
      if (act === 'add-env') return openModal('Add environment', envForm(null), () => saveEnv(null), 'Add');
      if (act === 'edit-env') return openModal('Edit environment', envForm((S.environments || []).find((item) => item.id === id)), () => saveEnv(id), 'Save');
      if (act === 'delete-env') return openModal('Delete environment', '<p>Remove this environment from Concierto.</p>', () => removeRecord('/api/environments/' + encodeURIComponent(id), 'Environment removed', 'environments'), 'Delete');
      if (act === 'add-rel') return openModal('Create release', releaseForm(null), () => saveRelease(null), 'Create');
      if (act === 'edit-rel') return openModal('Edit release', releaseForm((S.releases || []).find((item) => item.id === id)), () => saveRelease(id), 'Save');
      if (act === 'delete-rel') return openModal('Delete release', '<p>Remove this release from Concierto.</p>', () => removeRecord('/api/releases/' + encodeURIComponent(id), 'Release removed', 'releases'), 'Delete');
      if (act === 'approve-rel') {
        await api('/api/releases/' + encodeURIComponent(id) + '/approve', { method: 'POST', body: {} });
        toast('Release approved');
        return reload();
      }
      if (act === 'add-art') return openModal('Add artifact', artifactForm(null), () => saveArtifact(null), 'Add');
      if (act === 'edit-art') return openModal('Edit artifact', artifactForm((S.artifacts || []).find((item) => item.id === id)), () => saveArtifact(id), 'Save');
      if (act === 'delete-art') return openModal('Delete artifact', '<p>Remove this artifact from Concierto.</p>', () => removeRecord('/api/artifacts/' + encodeURIComponent(id), 'Artifact removed', 'artifacts'), 'Delete');
      if (act === 'add-pipe') {
        openModal('Create pipeline', pipelineForm(null), () => savePipeline(null), 'Create', true);
        applyPipeFormVisibility();
        return schedulePreview();
      }
      if (act === 'edit-pipe') {
        openModal('Edit pipeline', pipelineForm((S.pipelines || []).find((item) => item.id === id)), () => savePipeline(id), 'Save', true);
        applyPipeFormVisibility();
        return schedulePreview();
      }
      if (act === 'delete-pipe') {
        const pipeline = (S.pipelines || []).find((item) => item.id === id);
        if (!pipeline) return;
        const note = pipeline.engine === 'GitHub Actions'
          ? 'Also delete the workflow file in the GitHub repository.'
          : pipeline.engine === 'Azure DevOps'
            ? 'Also delete the Azure DevOps pipeline. The YAML file stays in the repo.'
            : 'Also delete the Jenkins job. This cannot be undone.';
        return openModal('Remove pipeline', '<p>Remove <b>' + esc(pipeline.name) + '</b> from Concierto.</p><label class="check"><input id="del-remote" type="checkbox"> ' + esc(note) + '</label>', async () => {
          const remote = document.getElementById('del-remote').checked;
          await api('/api/pipelines/' + encodeURIComponent(id) + '/delete', { method: 'POST', body: { remote } });
          closeModal();
          S = await api('/api/state');
          showView(currentView === 'pipeline/' + id ? 'pipelines' : currentView);
          toast(remote ? 'Deleted in Concierto and on the engine' : 'Removed from Concierto');
        }, 'Remove');
      }
      if (act === 'run-pipe') return runPipeline(id);
      if (act === 'open-pipe') return showView('pipeline/' + id);
      if (act === 'open-url') {
        const pipeline = (S.pipelines || []).find((item) => item.id === id);
        if (!pipeline || !pipeline.webUrl) return toast('This pipeline has no engine URL yet.', 'err');
        window.open(pipeline.webUrl, '_blank', 'noopener');
        return;
      }
      if (act === 'approve-run') {
        await api('/api/runs/' + encodeURIComponent(id) + '/approve', { method: 'POST', body: {} });
        toast('Approved. The engine run was requested.');
        return reload();
      }
      if (act === 'close-incident') {
        await api('/api/incidents/' + encodeURIComponent(id) + '/close', { method: 'POST', body: {} });
        return reload();
      }
      if (act === 'refresh') {
        actEl.disabled = true;
        S = await api('/api/state?refresh=1');
        toast('Status refreshed');
        return render();
      }
      if (act === 'sync') {
        actEl.disabled = true;
        const original = actEl.textContent;
        actEl.textContent = 'Syncing…';
        banner = await api('/api/sync', { method: 'POST', body: { provider: actEl.dataset.provider || 'all' } });
        S = await api('/api/state');
        toast('Sync finished');
        render();
        return;
      }
      if (act === 'test-saved' || act === 'test-cred') {
        if (act === 'test-cred') await persistCreds();
        const provider = actEl.dataset.provider;
        try {
          const result = await api('/api/creds/test', { method: 'POST', body: { provider } });
          toast(result.message || 'Connected');
        } catch (err) {
          toastError(err);
        }
        S = await api('/api/state');
        if (currentView === 'credentials') credsCache = await api('/api/creds');
        return render();
      }
      if (act === 'load-github') {
        const data = await api('/api/github/repos', { method: 'POST', body: { token: val('gh-token') } });
        const selected = new Set(val('gh-repos').split(/\n/).map((line) => line.trim()).filter(Boolean));
        const boxes = (data.repos || []).map((repo) => '<label class="check"><input type="checkbox" value="' + esc(repo.fullName) + '" ' + (selected.has(repo.fullName) ? 'checked' : '') + '> ' + esc(repo.fullName) + (repo.private ? ' <span class="muted">private</span>' : '') + '</label>').join('');
        return openModal('Choose GitHub repositories', '<p class="hint">Only selected repositories are synced. Save credentials afterward.</p><div class="check-list">' + (boxes || '<p>No repositories were returned for this token.</p>') + '</div>', () => {
          const chosen = [...document.querySelectorAll('#modal-body input[type="checkbox"]:checked')].map((input) => input.value);
          const area = document.getElementById('gh-repos');
          if (area) area.value = chosen.join('\n');
          closeModal();
          toast(chosen.length ? chosen.length + ' repositories selected. Save credentials to keep them.' : 'No repositories selected.');
        }, 'Use selected', true);
      }
      if (act === 'load-azure') {
        const data = await api('/api/azure/repos', { method: 'POST', body: { organization: val('az-org'), project: val('az-project'), pat: val('az-pat'), repository: val('az-repo'), branch: val('az-branch') } });
        const boxes = (data.repos || []).map((repo) => '<label class="check"><input type="radio" name="az-pick" value="' + esc(repo.name) + '"> ' + esc(repo.name) + '</label>').join('');
        return openModal('Choose an Azure Repos repository', '<div class="check-list">' + (boxes || '<p>No repositories were returned.</p>') + '</div>', () => {
          const picked = document.querySelector('#modal-body input[type="radio"]:checked');
          const input = document.getElementById('az-repo');
          if (picked && input) input.value = picked.value;
          closeModal();
          if (picked) toast('Repository selected. Save credentials to keep it.');
        }, 'Use repository', true);
      }
    } catch (err) {
      toastError(err);
      if (actEl) actEl.disabled = false;
    }
    return;
  }
  const viewEl = event.target.closest('[data-view]');
  if (viewEl) {
    setFlyout(false);
    showView(viewEl.dataset.view);
    return;
  }
  const navEl = event.target.closest('[data-nav]');
  if (navEl) {
    const id = navEl.dataset.nav;
    if (id === 'cicd') {
      setFlyout(!flyoutOpen);
      return;
    }
    setFlyout(false);
    showView('module/' + id);
    return;
  }
  if (flyoutOpen && !event.target.closest('#flyout')) setFlyout(false);
});
document.addEventListener('input', onField);
document.addEventListener('change', onField);
function onField(event) {
  if (event.target.id === 'q') {
    query = event.target.value;
    page = 1;
    render({ keep: true });
    return;
  }
  if (event.target.id === 'page-size') {
    pageSize = Number(event.target.value) || 10;
    page = 1;
    render({ keep: true });
    return;
  }
  if (!event.target.closest('#modal-body')) return;
  if (event.target.id === 'p-engine' || event.target.name === 'p-mode' || event.target.id === 'p-approval') {
    applyPipeFormVisibility();
    const mode = document.querySelector('input[name="p-mode"]:checked');
    if (mode && mode.value === 'link') loadLinkOptions();
  }
  if (event.target.id === 'p-gh-repo') {
    const mode = document.querySelector('input[name="p-mode"]:checked');
    if (mode && mode.value === 'link') loadLinkOptions();
  }
  if (document.getElementById('p-preview')) schedulePreview();
}
document.getElementById('modal-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!onSave || saving) return;
  saving = true;
  document.getElementById('modal-save').disabled = true;
  try { await onSave(); }
  catch (err) {
    toastError(err);
    const button = document.getElementById('modal-save');
    if (button) button.disabled = false;
  }
  finally { saving = false; }
});
document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'cred-form') return;
  event.preventDefault();
  try {
    await persistCreds();
    credsCache = await api('/api/creds');
    toast('Credentials saved to ' + (credsCache.path || 'the desktop file'));
    if (currentView === 'credentials') render();
  } catch (err) { toastError(err); }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !document.getElementById('modal').hidden) closeModal();
});
window.addEventListener('resize', placeFlyout);
window.addEventListener('hashchange', () => {
  const next = normalizeView(readHash());
  if (next !== currentView) showView(next);
});

async function saveApp(id) {
  const body = { name: val('a-name'), source: val('a-source'), repo: val('a-repo'), branch: val('a-branch') || 'main', image: val('a-image') };
  if (!body.name) throw new Error('Application name is required.');
  if (id) await api('/api/apps/' + encodeURIComponent(id), { method: 'PUT', body });
  else await api('/api/apps', { method: 'POST', body });
  closeModal();
  toast(id ? 'Application updated' : 'Application added');
  S = await api('/api/state');
  showView('applications');
}
async function saveEnv(id) {
  const body = { name: val('e-name'), appId: val('e-app'), status: val('e-status'), version: val('e-version') || '—' };
  if (!body.name) throw new Error('Environment name is required.');
  if (id) await api('/api/environments/' + encodeURIComponent(id), { method: 'PUT', body });
  else await api('/api/environments', { method: 'POST', body });
  closeModal();
  toast('Environment saved');
  S = await api('/api/state');
  showView('environments');
}
async function saveRelease(id) {
  const body = { name: val('r-name'), appId: val('r-app'), environment: val('r-env') };
  if (!body.name) throw new Error('Release name is required.');
  if (id) await api('/api/releases/' + encodeURIComponent(id), { method: 'PUT', body });
  else await api('/api/releases', { method: 'POST', body });
  closeModal();
  toast('Release saved');
  S = await api('/api/state');
  showView('releases');
}
async function saveArtifact(id) {
  const body = { name: val('art-name'), appId: val('art-app'), registry: val('art-reg') };
  if (!body.name) throw new Error('Artifact name is required.');
  if (id) await api('/api/artifacts/' + encodeURIComponent(id), { method: 'PUT', body });
  else await api('/api/artifacts', { method: 'POST', body });
  closeModal();
  toast('Artifact saved');
  S = await api('/api/state');
  showView('artifacts');
}
async function removeRecord(path, message, view) {
  await api(path, { method: 'DELETE' });
  closeModal();
  toast(message);
  S = await api('/api/state');
  showView(view);
}

async function boot() {
  try {
    S = await api('/api/state');
  } catch (err) {
    document.getElementById('view').innerHTML = '<div class="placeholder"><h2>Server is not running</h2><p>On the machine where Jenkins is installed, open the cicd folder and run start-concierto-cicd.bat. Then open http://127.0.0.1:8088 in a browser on that same machine.</p></div>';
    return;
  }
  fillWho();
  showView(readHash() || 'overview');
  setInterval(tick, 5000);
}
boot();
