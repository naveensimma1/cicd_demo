'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const engines = require('./engines');

const major = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(major) || major < 18) {
  console.error('Node.js 18 or newer is required. Current version: ' + process.versions.node);
  process.exit(1);
}

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8088;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

function resolveCredsPath() {
  if (process.env.CONCIERTO_CREDS) return process.env.CONCIERTO_CREDS;
  const candidates = [
    path.join(os.homedir(), 'OneDrive - Trianz', 'Desktop'),
    path.join(os.homedir(), 'OneDrive', 'Desktop'),
    path.join(os.homedir(), 'Desktop')
  ];
  const desktop = candidates.find((item) => fs.existsSync(item)) || path.join(os.homedir(), 'Desktop');
  return path.join(desktop, 'creds.json');
}

const CREDS_PATH = resolveCredsPath();
const HOST_NAME = os.hostname();
const USER_NAME = os.userInfo().username;

function uid(prefix) {
  return prefix + '-' + crypto.randomBytes(4).toString('hex');
}

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function defaultState() {
  const now = Date.now();
  return {
    apps: [],
    pipelines: [],
    environments: [
      { id: 'env-dev', name: 'DEV', appId: '', status: 'Healthy', version: '—', created: now },
      { id: 'env-qa', name: 'QA', appId: '', status: 'Healthy', version: '—', created: now },
      { id: 'env-prod', name: 'PROD', appId: '', status: 'Healthy', version: '—', created: now }
    ],
    releases: [],
    artifacts: [],
    runs: [],
    incidents: [],
    audit: [{ id: 'aud-start', time: now, text: 'Concierto CICD prototype started on ' + HOST_NAME }],
    integrationStatus: {
      jenkins: { ok: false, message: 'Not tested', at: null },
      github: { ok: false, message: 'Not tested', at: null },
      azure: { ok: false, message: 'Not tested', at: null }
    }
  };
}

function loadState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_PATH)) {
    const created = defaultState();
    writeJson(STATE_PATH, created);
    return created;
  }
  try {
    const parsed = readJson(STATE_PATH);
    const base = defaultState();
    return {
      apps: parsed.apps || [],
      pipelines: parsed.pipelines || [],
      environments: parsed.environments || base.environments,
      releases: parsed.releases || [],
      artifacts: parsed.artifacts || [],
      runs: parsed.runs || [],
      incidents: parsed.incidents || [],
      audit: parsed.audit || [],
      integrationStatus: { ...base.integrationStatus, ...(parsed.integrationStatus || {}) }
    };
  } catch (err) {
    const backup = STATE_PATH + '.bak';
    try { fs.copyFileSync(STATE_PATH, backup); } catch { /* keep the broken file where it is */ }
    console.error('data/state.json could not be read and was backed up. ' + err.message);
    const created = defaultState();
    writeJson(STATE_PATH, created);
    return created;
  }
}

function loadCreds() {
  if (!fs.existsSync(CREDS_PATH)) {
    const created = engines.defaultCreds();
    writeJson(CREDS_PATH, created);
    return created;
  }
  return engines.normalizeCreds(readJson(CREDS_PATH));
}

let state = loadState();
let creds;
try {
  creds = loadCreds();
} catch (err) {
  console.error('Could not read ' + CREDS_PATH + ': ' + err.message);
  console.error('The server is using empty credentials until that file is valid JSON.');
  creds = engines.defaultCreds();
}

function saveState() {
  state.runs = state.runs.slice(0, 100);
  state.audit = state.audit.slice(0, 300);
  state.artifacts = state.artifacts.slice(0, 150);
  state.incidents = state.incidents.slice(0, 100);
  writeJson(STATE_PATH, state);
}

function saveCreds() {
  writeJson(CREDS_PATH, creds);
  engines.clearCaches();
}

function audit(text) {
  state.audit.unshift({ id: uid('aud'), time: Date.now(), text });
}

function configured() {
  return {
    jenkins: Boolean(creds.jenkins.url && creds.jenkins.username && creds.jenkins.apiToken),
    github: Boolean(creds.github.token),
    azure: Boolean(creds.azureDevOps.organization && creds.azureDevOps.project && creds.azureDevOps.pat)
  };
}

function publicState() {
  return {
    ...state,
    configured: configured(),
    defaults: {
      githubRepos: creds.github.repos,
      githubBranch: creds.github.branch,
      azureRepository: creds.azureDevOps.repository,
      azureProject: creds.azureDevOps.project,
      azureBranch: creds.azureDevOps.branch,
      jenkinsUrl: creds.jenkins.url
    },
    credsPath: CREDS_PATH,
    host: HOST_NAME,
    user: USER_NAME
  };
}

function scrub(message) {
  let text = String(message || '');
  for (const secret of [creds.jenkins.apiToken, creds.github.token, creds.azureDevOps.pat]) {
    if (secret && secret.length > 3) text = text.split(secret).join('***');
  }
  return text;
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Request body is not valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function findById(list, id) {
  const item = list.find((entry) => entry.id === id);
  if (!item) {
    const err = new Error('Record not found.');
    err.status = 404;
    throw err;
  }
  return item;
}

function pipelineSpec(body, current) {
  const engine = body.engine || (current && current.engine) || '';
  const stages = engines.cleanStages(body.stages && body.stages.length ? body.stages : (current && current.stages));
  const name = String(body.name || (current && current.name) || '').trim();
  if (!name) {
    const err = new Error('Pipeline name is required.');
    err.status = 400;
    throw err;
  }
  if (!['Jenkins', 'GitHub Actions', 'Azure DevOps'].includes(engine)) {
    const err = new Error('Choose Jenkins, GitHub Actions, or Azure DevOps.');
    err.status = 400;
    throw err;
  }
  const approvalRequired = Boolean(body.approvalRequired);
  const repo = engines.normalizeRepo(body.githubRepo || body.repo || (current && current.repo) || '');
  return {
    name,
    appId: body.appId || (current && current.appId) || '',
    newAppName: String(body.newAppName || '').trim(),
    engine,
    branch: String(body.branch || (current && current.branch) || credsBranch(engine)).trim() || 'main',
    stages,
    template: body.template === 'generic' ? 'generic' : 'html-page',
    approvalRequired,
    pushTrigger: Boolean(body.pushTrigger) && !approvalRequired,
    publish: body.publish !== false,
    jenkinsJob: String(body.jenkinsJob || (current && current.engine === 'Jenkins' ? current.externalId : '') || engines.slug(name)).trim(),
    githubRepo: repo,
    repo: engine === 'GitHub Actions' ? repo : String(body.azureRepo || body.repo || (current && current.repo) || creds.azureDevOps.repository || '').trim(),
    workflowPath: String(body.workflowPath || (current && current.workflow) || '').trim(),
    workflow: String(body.workflowPath || (current && current.workflow) || '').trim(),
    azureRepo: String(body.azureRepo || (engine === 'Azure DevOps' ? (body.repo || (current && current.repo)) : '') || creds.azureDevOps.repository || '').trim(),
    yamlPath: String(body.yamlPath || (current && current.engine === 'Azure DevOps' ? current.workflow : '') || '').trim(),
    remoteId: String(body.remoteId || '').trim(),
    externalId: current && current.externalId || '',
    mode: body.mode || 'create'
  };
}

function credsBranch(engine) {
  if (engine === 'GitHub Actions') return creds.github.branch || 'main';
  if (engine === 'Azure DevOps') return creds.azureDevOps.branch || 'main';
  return 'main';
}

function attachNewApp(spec) {
  if (spec.appId) return spec.appId;
  if (!spec.newAppName) return '';
  const repo = spec.engine === 'GitHub Actions' ? spec.githubRepo : spec.repo;
  const app = {
    id: uid('app'),
    name: spec.newAppName,
    repo: repo || '',
    branch: spec.branch || 'main',
    source: spec.engine === 'Azure DevOps' ? 'Azure Repos' : (spec.engine === 'GitHub Actions' ? 'GitHub' : 'Other'),
    image: '',
    created: Date.now()
  };
  state.apps.unshift(app);
  audit('Created application ' + app.name);
  return app.id;
}

function ensureApp(repo, source) {
  if (!repo) return '';
  const found = state.apps.find((app) => String(app.repo || '').toLowerCase() === String(repo).toLowerCase());
  if (found) return found.id;
  const app = {
    id: uid('app'),
    name: String(repo).split('/').pop(),
    repo,
    branch: 'main',
    source,
    image: '',
    created: Date.now()
  };
  state.apps.unshift(app);
  audit('Added application ' + app.name + ' from ' + source);
  return app.id;
}

function applySync(engine, drafts, scopeRepos) {
  let imported = 0;
  let updated = 0;
  const seen = new Set(drafts.map((item) => String(item.externalId)));
  for (const draft of drafts) {
    const existing = state.pipelines.find((item) => item.engine === engine && String(item.externalId) === String(draft.externalId));
    if (existing) {
      existing.status = draft.status || existing.status;
      existing.lastResult = draft.lastResult || existing.lastResult;
      existing.lastRunLabel = draft.lastRunLabel || existing.lastRunLabel;
      existing.lastRunAt = draft.lastRunAt || existing.lastRunAt;
      existing.webUrl = draft.webUrl || existing.webUrl;
      existing.syncedAt = Date.now();
      existing.missing = false;
      if (existing.definitionSource !== 'concierto') {
        existing.name = draft.name || existing.name;
        existing.repo = draft.repo || existing.repo;
        existing.branch = draft.branch || existing.branch;
        existing.workflow = draft.workflow || existing.workflow;
      }
      if (!existing.appId && draft.repo) existing.appId = ensureApp(draft.repo, engine === 'Azure DevOps' ? 'Azure Repos' : 'GitHub');
      updated += 1;
    } else {
      const source = engine === 'Azure DevOps' ? 'Azure Repos' : (engine === 'GitHub Actions' ? 'GitHub' : 'Other');
      state.pipelines.unshift({
        id: uid('pipe'),
        name: draft.name,
        appId: draft.repo ? ensureApp(draft.repo, source) : '',
        engine,
        externalId: String(draft.externalId),
        repo: draft.repo || '',
        branch: draft.branch || '',
        workflow: draft.workflow || '',
        definitionSource: 'synced',
        template: '',
        stages: [],
        approvalRequired: false,
        pushTrigger: false,
        status: draft.status || 'Idle',
        lastResult: draft.lastResult || '',
        lastRunLabel: draft.lastRunLabel || '—',
        lastRunAt: draft.lastRunAt || null,
        webUrl: draft.webUrl || '',
        syncedAt: Date.now(),
        missing: false,
        created: Date.now()
      });
      imported += 1;
    }
  }
  for (const pipeline of state.pipelines) {
    if (pipeline.engine !== engine || !pipeline.externalId) continue;
    if (scopeRepos && pipeline.repo && !scopeRepos.has(String(pipeline.repo).toLowerCase())) continue;
    pipeline.missing = !seen.has(String(pipeline.externalId));
  }
  return { imported, updated };
}

function setIntegration(key, ok, message) {
  state.integrationStatus[key] = { ok: Boolean(ok), message, at: Date.now() };
}

function failed(status) {
  return status === 'Failed' || status === 'Unstable';
}

function finished(status) {
  return status === 'Success' || status === 'Failed' || status === 'Unstable' || status === 'Cancelled';
}

function openIncident(run) {
  if (state.incidents.some((item) => item.runId === run.id)) return;
  state.incidents.unshift({
    id: uid('inc'),
    runId: run.id,
    pipelineId: run.pipelineId,
    title: run.pipelineName + ' failed',
    detail: String(run.error || run.consoleTail || 'The run failed.').slice(0, 500),
    status: 'Open',
    created: Date.now()
  });
  audit('Opened incident for ' + run.pipelineName);
}

function addArtifact(run, pipeline) {
  if (state.artifacts.some((item) => item.runId === run.id)) return;
  state.artifacts.unshift({
    id: uid('art'),
    name: pipeline.name + ' ' + (run.label || run.externalRunId || 'build'),
    appId: pipeline.appId || '',
    registry: pipeline.engine,
    status: 'Available',
    runId: run.id,
    created: Date.now()
  });
}

function applyRun(run, pipeline, next) {
  const before = run.status;
  Object.assign(run, next);
  if (pipeline && next.externalWorkflowId && !pipeline.externalId) pipeline.externalId = String(next.externalWorkflowId);
  if (finished(run.status) && !run.finished) run.finished = Date.now();
  if (!failed(before) && failed(run.status)) openIncident(run);
  if (before !== 'Success' && run.status === 'Success' && pipeline) addArtifact(run, pipeline);
  if (pipeline) {
    pipeline.status = run.status;
    if (run.label) pipeline.lastRunLabel = run.label;
    pipeline.lastRunAt = run.finished || run.started;
    pipeline.lastResult = run.status;
    if (run.webUrl) pipeline.webUrl = pipeline.webUrl || run.webUrl;
  }
}

async function refreshActive() {
  const active = state.runs.filter((run) => run.status === 'Running' || run.status === 'Queued').slice(0, 8);
  await Promise.all(active.map(async (run) => {
    const pipeline = state.pipelines.find((item) => item.id === run.pipelineId);
    if (!pipeline) return;
    try {
      const next = await engines.refreshRun(creds, pipeline, run, false);
      run.refreshErrors = 0;
      applyRun(run, pipeline, next);
    } catch (err) {
      run.refreshErrors = (run.refreshErrors || 0) + 1;
      run.error = scrub(err.message);
    }
  }));
  saveState();
}

async function createRun(pipeline, remote) {
  const run = {
    id: uid('run'),
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    engine: pipeline.engine,
    status: remote.status || 'Queued',
    started: Date.now(),
    finished: null,
    externalRunId: remote.externalRunId || '',
    externalWorkflowId: remote.externalWorkflowId || pipeline.externalId || '',
    queueUrl: remote.queueUrl || '',
    webUrl: remote.webUrl || pipeline.webUrl || '',
    label: remote.label || 'Queued',
    lookupAfter: remote.lookupAfter || Date.now(),
    consoleTail: '',
    error: remote.error || '',
    refreshErrors: 0
  };
  state.runs.unshift(run);
  pipeline.status = run.status;
  pipeline.lastRunLabel = run.label;
  pipeline.lastRunAt = run.started;
  if (run.webUrl) pipeline.webUrl = pipeline.webUrl || run.webUrl;
  if (remote.externalWorkflowId && !pipeline.externalId) pipeline.externalId = String(remote.externalWorkflowId);
  audit((remote.status === 'Failed' ? 'Failed to start ' : 'Started ') + pipeline.name + ' on ' + pipeline.engine);
  saveState();
  return run;
}

async function handle(req, res, url, body) {
  const method = req.method;
  const parts = url.pathname.split('/').filter(Boolean);

  if (method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && url.pathname === '/api/state') {
    if (url.searchParams.get('refresh') === '1') await refreshActive();
    return send(res, 200, publicState());
  }
  if (method === 'GET' && url.pathname === '/api/creds') {
    return send(res, 200, { path: CREDS_PATH, host: HOST_NAME, ...creds });
  }
  if (method === 'PUT' && url.pathname === '/api/creds') {
    creds = engines.normalizeCreds(body || {});
    saveCreds();
    audit('Updated credentials');
    saveState();
    return send(res, 200, { path: CREDS_PATH, host: HOST_NAME, ...creds });
  }
  if (method === 'POST' && url.pathname === '/api/creds/test') {
    const provider = body.provider || 'all';
    const results = {};
    async function one(key, label, fn) {
      try {
        const result = await fn();
        setIntegration(key, true, result.message);
        results[key] = result;
      } catch (err) {
        const message = scrub(err.message);
        setIntegration(key, false, message);
        results[key] = { ok: false, message, detail: scrub(err.detail || '') };
      }
    }
    if (provider === 'jenkins' || provider === 'all') await one('jenkins', 'Jenkins', () => engines.testJenkins(creds.jenkins));
    if (provider === 'github' || provider === 'all') await one('github', 'GitHub', () => engines.testGithub(creds.github));
    if (provider === 'azure' || provider === 'all') await one('azure', 'Azure DevOps', () => engines.testAzure(creds.azureDevOps));
    audit('Tested ' + provider + ' connection');
    saveState();
    const single = results[provider];
    if (provider !== 'all' && single && single.ok === false) {
      return send(res, 400, { error: single.message, detail: single.detail || '', results });
    }
    return send(res, 200, { ok: true, message: single ? single.message : 'Tests finished.', results });
  }
  if (method === 'POST' && url.pathname === '/api/github/repos') {
    const token = String((body && body.token) || creds.github.token || '').trim();
    const repos = await engines.listGithubRepos(token);
    return send(res, 200, { repos });
  }
  if (method === 'POST' && url.pathname === '/api/azure/repos') {
    const cfg = {
      ...creds.azureDevOps,
      organization: (body && body.organization) || creds.azureDevOps.organization,
      project: (body && body.project) || creds.azureDevOps.project,
      pat: (body && body.pat) || creds.azureDevOps.pat,
      repository: (body && body.repository) || creds.azureDevOps.repository,
      branch: (body && body.branch) || creds.azureDevOps.branch
    };
    const repos = await engines.listAzureRepos(cfg);
    return send(res, 200, { repos });
  }
  if (method === 'GET' && url.pathname === '/api/remote/jenkins/jobs') {
    const drafts = await engines.jenkinsDrafts(creds.jenkins);
    return send(res, 200, { items: drafts.map((item) => ({ id: item.externalId, name: item.name, repo: '', url: item.webUrl })) });
  }
  if (method === 'GET' && url.pathname === '/api/remote/github/workflows') {
    const repo = url.searchParams.get('repo') || '';
    const drafts = await engines.githubWorkflowDrafts(creds.github, repo);
    return send(res, 200, { items: drafts.map((item) => ({ id: item.externalId, name: item.name + ' (' + item.workflow + ')', repo: item.repo, url: item.webUrl })) });
  }
  if (method === 'GET' && url.pathname === '/api/remote/azure/pipelines') {
    const drafts = await engines.azureDrafts(creds.azureDevOps);
    return send(res, 200, { items: drafts.map((item) => ({ id: item.externalId, name: item.name, repo: item.repo, url: item.webUrl })) });
  }
  if (method === 'POST' && url.pathname === '/api/preview') {
    const spec = pipelineSpec({ ...body, name: body.name || 'Untitled pipeline', publish: false }, null);
    const file = engines.buildDefinition(spec, creds.jenkins.shell || 'bat');
    return send(res, 200, file);
  }
  if (method === 'POST' && url.pathname === '/api/sync') {
    const provider = (body && body.provider) || 'all';
    const results = [];
    async function runSync(key, label, work) {
      if (provider !== 'all' && provider !== key) return;
      try {
        const outcome = await work();
        setIntegration(key, true, outcome.message);
        results.push({ provider: label, ok: true, ...outcome });
      } catch (err) {
        const message = scrub(err.message);
        setIntegration(key, false, message);
        results.push({ provider: label, ok: false, message, detail: scrub(err.detail || '') });
      }
    }
    await runSync('jenkins', 'Jenkins', async () => {
      const drafts = await engines.jenkinsDrafts(creds.jenkins);
      const counts = applySync('Jenkins', drafts, null);
      const message = counts.imported + ' added, ' + counts.updated + ' updated.';
      audit('Synced Jenkins. ' + message);
      return { ...counts, message };
    });
    await runSync('github', 'GitHub', async () => {
      const collected = await engines.githubDrafts(creds.github);
      if (!collected.drafts.length && collected.errors.length) {
        const err = new Error(collected.errors.join(' | '));
        err.status = 400;
        throw err;
      }
      const counts = applySync('GitHub Actions', collected.drafts, new Set(collected.syncedRepos.map((item) => item.toLowerCase())));
      const message = counts.imported + ' added, ' + counts.updated + ' updated.' + (collected.errors.length ? ' Skipped: ' + collected.errors.join(' | ') : '');
      audit('Synced GitHub Actions. ' + counts.imported + ' added, ' + counts.updated + ' updated.');
      return { ...counts, message };
    });
    await runSync('azure', 'Azure DevOps', async () => {
      const drafts = await engines.azureDrafts(creds.azureDevOps);
      const counts = applySync('Azure DevOps', drafts, null);
      const message = counts.imported + ' added, ' + counts.updated + ' updated.';
      audit('Synced Azure DevOps. ' + message);
      return { ...counts, message };
    });
    saveState();
    return send(res, 200, { results });
  }

  if (parts[0] === 'api' && parts[1] === 'apps') {
    if (method === 'POST' && parts.length === 2) {
      const name = String(body.name || '').trim();
      if (!name) return send(res, 400, { error: 'Application name is required.' });
      const app = {
        id: uid('app'),
        name,
        repo: engines.normalizeRepo(body.repo || ''),
        branch: String(body.branch || 'main').trim() || 'main',
        source: body.source || 'GitHub',
        image: String(body.image || '').trim(),
        created: Date.now()
      };
      state.apps.unshift(app);
      audit('Created application ' + name);
      saveState();
      return send(res, 201, app);
    }
    if (parts.length === 3) {
      const app = findById(state.apps, decodeURIComponent(parts[2]));
      if (method === 'PUT') {
        app.name = String(body.name || app.name).trim();
        app.repo = engines.normalizeRepo(body.repo || '');
        app.branch = String(body.branch || 'main').trim() || 'main';
        app.source = body.source || app.source;
        app.image = String(body.image || '').trim();
        audit('Updated application ' + app.name);
        saveState();
        return send(res, 200, app);
      }
      if (method === 'DELETE') {
        state.apps = state.apps.filter((item) => item.id !== app.id);
        audit('Deleted application ' + app.name);
        saveState();
        return send(res, 200, { ok: true });
      }
    }
  }

  if (parts[0] === 'api' && parts[1] === 'pipelines') {
    if (method === 'POST' && parts.length === 2) {
      const spec = pipelineSpec(body, null);
      spec.appId = attachNewApp(spec);
      let remote = {};
      let definitionSource = 'concierto';
      if (body.mode === 'link') {
        if (!spec.remoteId) return send(res, 400, { error: 'Choose the pipeline to link.' });
        remote = await engines.linkRemote(creds, spec);
        definitionSource = 'linked';
      } else if (spec.publish) {
        remote = await engines.publish(creds, spec, { overwrite: false });
      }
      const pipeline = {
        id: uid('pipe'),
        name: spec.name || remote.name,
        appId: spec.appId,
        engine: spec.engine,
        externalId: remote.externalId || '',
        repo: remote.repo || (spec.engine === 'GitHub Actions' ? spec.githubRepo : spec.azureRepo),
        branch: remote.branch || spec.branch,
        workflow: remote.workflow || spec.workflowPath || spec.yamlPath || spec.jenkinsJob,
        definitionSource,
        template: spec.template,
        stages: spec.stages,
        approvalRequired: spec.approvalRequired,
        pushTrigger: spec.pushTrigger,
        status: remote.status || 'Idle',
        lastResult: '',
        lastRunLabel: remote.lastRunLabel || '—',
        lastRunAt: remote.lastRunAt || null,
        webUrl: remote.webUrl || '',
        syncedAt: null,
        missing: false,
        created: Date.now()
      };
      state.pipelines.unshift(pipeline);
      audit((body.mode === 'link' ? 'Linked ' : 'Created ') + pipeline.name + ' on ' + pipeline.engine);
      saveState();
      return send(res, 201, { pipeline, warning: remote.warning || '' });
    }
    if (parts.length === 3 && method === 'PUT') {
      const existing = findById(state.pipelines, decodeURIComponent(parts[2]));
      const spec = pipelineSpec(body, existing);
      spec.appId = attachNewApp(spec) || existing.appId;
      const engineChanged = existing.engine !== spec.engine;
      let remote = {};
      if (spec.publish) {
        const overwrite = Boolean(!engineChanged && existing.externalId);
        remote = await engines.publish(creds, { ...spec, externalId: overwrite ? existing.externalId : spec.jenkinsJob }, {
          overwrite,
          previous: existing
        });
      }
      const previousEngine = existing.engine;
      existing.name = spec.name;
      existing.appId = spec.appId;
      existing.engine = spec.engine;
      existing.branch = remote.branch || spec.branch;
      existing.template = spec.template;
      existing.stages = spec.stages;
      existing.approvalRequired = spec.approvalRequired;
      existing.pushTrigger = spec.pushTrigger;
      if (remote.externalId) existing.externalId = remote.externalId;
      if (remote.workflow) existing.workflow = remote.workflow;
      if (remote.repo) existing.repo = remote.repo;
      else existing.repo = spec.engine === 'GitHub Actions' ? spec.githubRepo : spec.azureRepo;
      if (remote.webUrl) existing.webUrl = remote.webUrl;
      if (spec.publish) existing.definitionSource = 'concierto';
      existing.missing = false;
      audit(engineChanged
        ? 'Moved ' + existing.name + ' from ' + previousEngine + ' to ' + spec.engine + '. The previous engine definition was left in place.'
        : 'Updated pipeline ' + existing.name);
      saveState();
      return send(res, 200, { pipeline: existing, warning: remote.warning || '' });
    }
    if (parts.length === 4 && parts[3] === 'run' && method === 'POST') {
      const pipeline = findById(state.pipelines, decodeURIComponent(parts[2]));
      if (pipeline.approvalRequired && !body.approved) {
        const run = {
          id: uid('run'),
          pipelineId: pipeline.id,
          pipelineName: pipeline.name,
          engine: pipeline.engine,
          status: 'Pending approval',
          started: Date.now(),
          finished: null,
          externalRunId: '',
          queueUrl: '',
          webUrl: '',
          label: 'Approval',
          consoleTail: '',
          error: '',
          refreshErrors: 0
        };
        state.runs.unshift(run);
        pipeline.status = 'Pending approval';
        pipeline.lastRunLabel = 'Approval';
        pipeline.lastRunAt = run.started;
        audit('Approval requested for ' + pipeline.name);
        saveState();
        return send(res, 202, { run });
      }
      try {
        const remote = await engines.trigger(creds, pipeline);
        const run = await createRun(pipeline, remote);
        return send(res, 201, { run });
      } catch (err) {
        const run = await createRun(pipeline, {
          status: 'Failed',
          error: scrub(err.message),
          label: 'Failed to start',
          webUrl: pipeline.webUrl || ''
        });
        run.finished = Date.now();
        openIncident(run);
        pipeline.status = 'Failed';
        saveState();
        return send(res, err.status || 502, { error: scrub(err.message), detail: scrub(err.detail || ''), run });
      }
    }
    if (parts.length === 4 && parts[3] === 'delete' && method === 'POST') {
      const pipeline = findById(state.pipelines, decodeURIComponent(parts[2]));
      if (body.remote) await engines.deleteRemote(creds, pipeline);
      state.pipelines = state.pipelines.filter((item) => item.id !== pipeline.id);
      audit((body.remote ? 'Deleted on the engine and in Concierto: ' : 'Removed from Concierto: ') + pipeline.name);
      saveState();
      return send(res, 200, { ok: true });
    }
    if (parts.length === 4 && parts[3] === 'definition' && method === 'GET') {
      const pipeline = findById(state.pipelines, decodeURIComponent(parts[2]));
      try {
        const definition = await engines.fetchDefinition(creds, pipeline);
        return send(res, 200, definition);
      } catch (err) {
        const local = engines.buildDefinition(pipeline, creds.jenkins.shell || 'bat');
        return send(res, 200, { text: local.text, source: 'Generated locally. Engine read failed: ' + scrub(err.message) });
      }
    }
  }

  if (parts[0] === 'api' && parts[1] === 'runs' && parts.length === 3) {
    const run = findById(state.runs, decodeURIComponent(parts[2]));
    const pipeline = state.pipelines.find((item) => item.id === run.pipelineId);
    if (method === 'GET') {
      if (url.searchParams.get('log') === '1' && pipeline && (run.status === 'Running' || run.status === 'Queued' || run.status === 'Success' || run.status === 'Failed' || run.status === 'Unstable')) {
        try {
          const next = await engines.refreshRun(creds, pipeline, run, true);
          applyRun(run, pipeline, next);
          saveState();
        } catch (err) {
          run.error = scrub(err.message);
          saveState();
        }
      }
      return send(res, 200, { run, pipeline: pipeline || null });
    }
    if (method === 'POST' && url.pathname.endsWith('/approve')) {
      /* handled below */
    }
  }
  if (parts[0] === 'api' && parts[1] === 'runs' && parts.length === 4 && parts[3] === 'approve' && method === 'POST') {
    const run = findById(state.runs, decodeURIComponent(parts[2]));
    const pipeline = findById(state.pipelines, run.pipelineId);
    if (run.status !== 'Pending approval') return send(res, 400, { error: 'This run is not waiting for approval.' });
    try {
      const remote = await engines.trigger(creds, pipeline);
      applyRun(run, pipeline, { ...remote, started: Date.now(), error: '' });
      run.lookupAfter = remote.lookupAfter || Date.now();
      audit('Approved and started ' + pipeline.name);
      saveState();
      return send(res, 200, { run });
    } catch (err) {
      applyRun(run, pipeline, { status: 'Failed', error: scrub(err.message), finished: Date.now(), label: 'Failed to start' });
      saveState();
      return send(res, err.status || 502, { error: scrub(err.message), detail: scrub(err.detail || ''), run });
    }
  }

  if (parts[0] === 'api' && parts[1] === 'environments') {
    if (method === 'POST' && parts.length === 2) {
      const name = String(body.name || '').trim();
      if (!name) return send(res, 400, { error: 'Environment name is required.' });
      const env = { id: uid('env'), name, appId: body.appId || '', status: body.status || 'Healthy', version: body.version || '—', created: Date.now() };
      state.environments.unshift(env);
      audit('Created environment ' + name);
      saveState();
      return send(res, 201, env);
    }
    if (parts.length === 3) {
      const env = findById(state.environments, decodeURIComponent(parts[2]));
      if (method === 'PUT') {
        env.name = String(body.name || env.name).trim();
        env.appId = body.appId || '';
        env.status = body.status || env.status;
        env.version = body.version || env.version || '—';
        audit('Updated environment ' + env.name);
        saveState();
        return send(res, 200, env);
      }
      if (method === 'DELETE') {
        state.environments = state.environments.filter((item) => item.id !== env.id);
        audit('Deleted environment ' + env.name);
        saveState();
        return send(res, 200, { ok: true });
      }
    }
  }

  if (parts[0] === 'api' && parts[1] === 'releases') {
    if (method === 'POST' && parts.length === 2) {
      const name = String(body.name || '').trim();
      if (!name) return send(res, 400, { error: 'Release name is required.' });
      const release = { id: uid('rel'), name, appId: body.appId || '', environment: body.environment || 'DEV', status: 'Ready', created: Date.now() };
      state.releases.unshift(release);
      audit('Created release ' + name);
      saveState();
      return send(res, 201, release);
    }
    if (parts.length === 3 && method === 'PUT') {
      const release = findById(state.releases, decodeURIComponent(parts[2]));
      release.name = String(body.name || release.name).trim();
      release.appId = body.appId || '';
      release.environment = body.environment || release.environment;
      audit('Updated release ' + release.name);
      saveState();
      return send(res, 200, release);
    }
    if (parts.length === 3 && method === 'DELETE') {
      const release = findById(state.releases, decodeURIComponent(parts[2]));
      state.releases = state.releases.filter((item) => item.id !== release.id);
      audit('Deleted release ' + release.name);
      saveState();
      return send(res, 200, { ok: true });
    }
    if (parts.length === 4 && parts[3] === 'approve' && method === 'POST') {
      const release = findById(state.releases, decodeURIComponent(parts[2]));
      release.status = 'Approved';
      audit('Approved release ' + release.name);
      saveState();
      return send(res, 200, release);
    }
  }

  if (parts[0] === 'api' && parts[1] === 'artifacts') {
    if (method === 'POST' && parts.length === 2) {
      const name = String(body.name || '').trim();
      if (!name) return send(res, 400, { error: 'Artifact name is required.' });
      const artifact = { id: uid('art'), name, appId: body.appId || '', registry: body.registry || 'Local', status: 'Available', runId: '', created: Date.now() };
      state.artifacts.unshift(artifact);
      audit('Added artifact ' + name);
      saveState();
      return send(res, 201, artifact);
    }
    if (parts.length === 3 && method === 'PUT') {
      const artifact = findById(state.artifacts, decodeURIComponent(parts[2]));
      artifact.name = String(body.name || artifact.name).trim();
      artifact.appId = body.appId || '';
      artifact.registry = body.registry || artifact.registry;
      audit('Updated artifact ' + artifact.name);
      saveState();
      return send(res, 200, artifact);
    }
    if (parts.length === 3 && method === 'DELETE') {
      const artifact = findById(state.artifacts, decodeURIComponent(parts[2]));
      state.artifacts = state.artifacts.filter((item) => item.id !== artifact.id);
      audit('Deleted artifact ' + artifact.name);
      saveState();
      return send(res, 200, { ok: true });
    }
  }

  if (parts[0] === 'api' && parts[1] === 'incidents' && parts.length === 4 && parts[3] === 'close' && method === 'POST') {
    const incident = findById(state.incidents, decodeURIComponent(parts[2]));
    incident.status = 'Closed';
    audit('Closed incident ' + incident.title);
    saveState();
    return send(res, 200, incident);
  }

  send(res, 404, { error: 'Not found' });
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function staticFile(urlPath) {
  const clean = (urlPath === '/' ? '/index.html' : urlPath).split('?')[0];
  const full = path.resolve(PUBLIC_DIR, '.' + clean);
  const root = path.resolve(PUBLIC_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

let queue = Promise.resolve();
function enqueue(work) {
  const next = queue.then(work, work);
  queue = next.then(() => undefined, () => undefined);
  return next;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + HOST);
  if (!url.pathname.startsWith('/api/')) {
    const file = staticFile(decodeURIComponent(url.pathname));
    if (!file) return send(res, 404, { error: 'Not found' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': contentType(file), 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }
  readBody(req)
    .then((body) => enqueue(() => handle(req, res, url, body)))
    .catch((err) => {
      if (!res.headersSent) send(res, err.status || 500, { error: scrub(err.message || 'Request failed'), detail: scrub(err.detail || '') });
    });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && PORT === Number(process.env.PORT || 8088) && PORT !== 8090) {
    console.error('Port ' + PORT + ' is in use. Starting on 8090.');
    server.listen(8090, HOST);
    return;
  }
  console.error(err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = address && address.port ? address.port : PORT;
  console.log('');
  console.log('Concierto CICD is running.');
  console.log('Open  http://' + HOST + ':' + port);
  console.log('Credentials file  ' + CREDS_PATH);
  console.log('This machine  ' + HOST_NAME + '  (' + USER_NAME + ')');
  console.log('Press Ctrl+C to stop.');
  console.log('');
});
