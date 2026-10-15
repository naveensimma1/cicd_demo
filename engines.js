'use strict';

const zlib = require('zlib');
const DEFAULT_STAGES = ['Checkout', 'Build', 'Test', 'Package'];
const PAGE_HTML = '<!DOCTYPE html><html><body><h1>Built by Concierto CICD</h1></body></html>';
const crumbCache = new Map();

function fail(status, message, detail) {
  const err = new Error(message || 'Request failed');
  err.status = status || 500;
  err.detail = detail ? String(detail).replace(/\s+/g, ' ').trim().slice(0, 800) : '';
  throw err;
}

function snippet(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(text, lines) {
  const parts = String(text || '').replace(/\r/g, '').slice(-120000).split('\n');
  return parts.slice(-lines).join('\n').trim();
}

function joinUrl(base, rel) {
  return String(base || '').replace(/\/+$/, '') + '/' + String(rel || '').replace(/^\/+/, '');
}

function slug(value) {
  const out = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return out || 'pipeline';
}

function cleanStages(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const stage = String(item || '')
      .replace(/[\r\n']/g, ' ')
      .replace(/[\\<>]/g, ' ')
      .replace(/&/g, ' and ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    if (stage) out.push(stage);
  }
  return out.length ? out : DEFAULT_STAGES.slice();
}

function yamlQuote(value) {
  return '"' + String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function shQuote(value) {
  return String(value || '').replace(/'/g, "'\\''");
}

function psQuote(value) {
  return String(value || '').replace(/'/g, "''");
}

function normalizeRepo(value) {
  let v = String(value || '').trim();
  v = v.replace(/^https?:\/\/github\.com\//i, '');
  v = v.replace(/\.git$/i, '').replace(/\/+$/, '');
  const parts = v.split('/').filter(Boolean);
  if (parts.length >= 2) return parts[0] + '/' + parts[1];
  return v;
}

function normalizeOrg(value) {
  let v = String(value || '').trim();
  v = v.replace(/^https?:\/\/dev\.azure\.com\//i, '');
  v = v.replace(/^https?:\/\//i, '');
  v = v.split(/[/?#]/)[0];
  return v.replace(/\/+$/, '');
}

function splitRepo(value) {
  const full = normalizeRepo(value);
  const parts = full.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    fail(400, 'Repository must look like owner/name.');
  }
  return { owner: parts[0], name: parts[1], full };
}

function assertHttpUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    fail(400, label + ' must be a full URL, for example http://127.0.0.1:8080.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(400, label + ' must start with http:// or https://.');
  }
  const pathName = url.pathname.replace(/\/+$/, '');
  return url.origin + (pathName === '/' ? '' : pathName);
}

function defaultCreds() {
  return {
    _comment: 'Concierto CICD credentials for this machine. Tokens are secrets. Do not share this file.',
    jenkins: { url: 'http://127.0.0.1:8080', username: 'admin', apiToken: '', shell: 'bat' },
    github: { token: '', repos: [], branch: 'main' },
    azureDevOps: { organization: '', project: '', pat: '', repository: '', branch: 'main' }
  };
}

function normalizeCreds(raw) {
  const base = defaultCreds();
  const src = raw || {};
  const jenkins = { ...base.jenkins, ...(src.jenkins || {}) };
  const github = { ...base.github, ...(src.github || {}) };
  const azure = { ...base.azureDevOps, ...(src.azureDevOps || src.azure || {}) };
  const repoLines = Array.isArray(github.repos) ? github.repos : String(github.repos || '').split(/[\n,]/);
  const repos = [];
  for (const line of repoLines) {
    const repo = normalizeRepo(line);
    if (repo && !repos.includes(repo)) repos.push(repo);
  }
  return {
    _comment: src._comment || base._comment,
    jenkins: {
      url: String(jenkins.url || '').trim() ? assertHttpUrl(jenkins.url, 'Jenkins URL') : '',
      username: String(jenkins.username || '').trim(),
      apiToken: String(jenkins.apiToken || '').trim(),
      shell: jenkins.shell === 'sh' ? 'sh' : 'bat'
    },
    github: {
      token: String(github.token || '').trim(),
      repos,
      branch: String(github.branch || 'main').trim() || 'main'
    },
    azureDevOps: {
      organization: normalizeOrg(azure.organization || ''),
      project: String(azure.project || '').trim(),
      pat: String(azure.pat || '').trim(),
      repository: String(azure.repository || '').trim(),
      branch: String(azure.branch || 'main').trim() || 'main'
    }
  };
}

function clearCaches() {
  crumbCache.clear();
}

function requireJenkins(cfg) {
  if (!cfg || !cfg.url || !cfg.username || !cfg.apiToken) {
    fail(400, 'Add the Jenkins URL, username, and API token in Credential Manager.');
  }
}

function requireGithub(cfg) {
  if (!cfg || !cfg.token) fail(400, 'Add a GitHub personal access token in Credential Manager.');
}

function requireAzure(cfg) {
  if (!cfg || !cfg.organization || !cfg.project || !cfg.pat) {
    fail(400, 'Add the Azure DevOps organization, project, and personal access token in Credential Manager.');
  }
}

async function httpCall(label, url, options) {
  let res;
  try {
    res = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      redirect: options.redirect || 'follow',
      signal: AbortSignal.timeout(options.timeout || 20000)
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      fail(504, label + ' did not respond within 20 seconds.');
    }
    const cause = err.cause && (err.cause.code || err.cause.message);
    fail(502, 'Cannot reach ' + label + '.', cause || err.message);
  }
  const text = await res.text();
  return { res, text };
}

function readCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') {
    return res.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
  }
  const raw = res.headers.get('set-cookie') || '';
  if (!raw) return '';
  return raw.split(/,(?=[^;,]+=)/).map((item) => item.split(';')[0].trim()).join('; ');
}

function authHeader(user, secret) {
  return 'Basic ' + Buffer.from(user + ':' + secret).toString('base64');
}

async function getCrumb(cfg) {
  const key = cfg.url + '|' + cfg.username + '|' + cfg.apiToken.slice(-8);
  const cached = crumbCache.get(key);
  if (cached && cached.exp > Date.now()) return cached;
  const { res, text } = await httpCall('Jenkins', joinUrl(cfg.url, '/crumbIssuer/api/json'), {
    headers: { Authorization: authHeader(cfg.username, cfg.apiToken) }
  });
  if (res.status === 404) return null;
  if (!res.ok) fail(res.status, 'Jenkins rejected the username or API token.', snippet(text));
  let data;
  try { data = JSON.parse(text); } catch { fail(502, 'Jenkins did not return a CSRF crumb.', snippet(text)); }
  const crumb = {
    field: data.crumbRequestField,
    value: data.crumb,
    cookie: readCookies(res),
    exp: Date.now() + 10 * 60 * 1000
  };
  crumbCache.set(key, crumb);
  return crumb;
}

async function jenkinsSend(cfg, method, target, options = {}) {
  requireJenkins(cfg);
  const headers = { Authorization: authHeader(cfg.username, cfg.apiToken) };
  if (method !== 'GET' && method !== 'HEAD') {
    const crumb = await getCrumb(cfg);
    if (crumb) {
      headers[crumb.field] = crumb.value;
      if (crumb.cookie) headers.Cookie = crumb.cookie;
    }
  }
  if (options.contentType) headers['Content-Type'] = options.contentType;
  const url = /^https?:/i.test(target) ? target : joinUrl(cfg.url, target);
  const { res, text } = await httpCall('Jenkins', url, {
    method,
    headers,
    body: options.body,
    redirect: method === 'GET' || method === 'HEAD' ? 'follow' : 'manual'
  });
  if (res.status >= 400) fail(res.status, 'Jenkins returned ' + res.status + '.', snippet(text));
  let data = null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { data = JSON.parse(trimmed); } catch { data = null; }
  }
  return { status: res.status, text, data, location: res.headers.get('location') || '' };
}

function jobApiPath(fullName) {
  return String(fullName || '').split('/').filter(Boolean).map((part) => 'job/' + encodeURIComponent(part)).join('/');
}

function flattenJobs(jobs, prefix, out) {
  for (const job of jobs || []) {
    const fullName = prefix ? prefix + '/' + job.name : job.name;
    if (Array.isArray(job.jobs)) flattenJobs(job.jobs, fullName, out);
    else out.push({ ...job, fullName });
  }
  return out;
}

function jenkinsStatus(color) {
  const value = String(color || '');
  if (value.includes('anime')) return 'Running';
  if (value.startsWith('blue')) return 'Success';
  if (value.startsWith('red')) return 'Failed';
  if (value.startsWith('yellow')) return 'Unstable';
  return 'Idle';
}

function mapJenkinsBuild(build) {
  if (!build) return 'Idle';
  if (build.building || build.result == null) return 'Running';
  if (build.result === 'SUCCESS') return 'Success';
  if (build.result === 'UNSTABLE') return 'Unstable';
  if (build.result === 'ABORTED' || build.result === 'NOT_BUILT') return 'Cancelled';
  return 'Failed';
}

const JOB_TREE = 'jobs[name,url,color,description,lastBuild[number,result,timestamp,url,building],jobs[name,url,color,description,lastBuild[number,result,timestamp,url,building],jobs[name,url,color,description,lastBuild[number,result,timestamp,url,building]]]]';

async function jenkinsDrafts(cfg) {
  requireJenkins(cfg);
  let data;
  try {
    const first = await jenkinsSend(cfg, 'GET', '/api/json?tree=' + encodeURIComponent(JOB_TREE));
    data = first.data;
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw err;
    const second = await jenkinsSend(cfg, 'GET', '/api/json?tree=' + encodeURIComponent('jobs[name,url,color,lastBuild[number,result,timestamp,url]]'));
    data = second.data;
  }
  return flattenJobs((data && data.jobs) || [], '', []).map((job) => {
    const build = job.lastBuild || null;
    return {
      engine: 'Jenkins',
      name: job.fullName,
      externalId: job.fullName,
      repo: '',
      branch: '',
      workflow: job.fullName,
      webUrl: job.url || '',
      status: jenkinsStatus(job.color),
      lastResult: (build && build.result) || '',
      lastRunLabel: build ? '#' + build.number : '—',
      lastRunAt: build ? build.timestamp : null,
      externalRunId: build ? String(build.number) : ''
    };
  });
}

function shBuild() {
  return "mkdir -p dist\nprintf '%s\\n' '" + PAGE_HTML + "' > dist/index.html";
}

function psBuild() {
  return 'powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path dist | Out-Null; Set-Content -Path dist/index.html -Encoding ascii -Value \'' + psQuote(PAGE_HTML) + '\'"';
}

function stageCommand(stage, template, kind) {
  const key = stage.toLowerCase();
  const html = template === 'html-page';
  if (html && key === 'build') return kind === 'bat' ? psBuild() : shBuild();
  if (html && key === 'test') {
    if (kind === 'bat') {
      return 'powershell -NoProfile -Command "if (-not (Test-Path dist/index.html)) { exit 1 } else { Write-Output \'HTML page ok\' }"';
    }
    return "test -f dist/index.html && echo 'HTML page ok'";
  }
  if (html && key === 'package') {
    if (kind === 'bat') return 'powershell -NoProfile -Command "Write-Output \'HTML artifact ready at dist/index.html\'"';
    return "echo 'HTML artifact ready at dist/index.html'";
  }
  if (kind === 'bat') return 'powershell -NoProfile -Command "Write-Output \'' + psQuote(stage) + '\'"';
  return "echo '" + shQuote(stage) + "'";
}

function jenkinsScript(pipeline, shell) {
  const useShell = shell === 'sh' ? 'sh' : 'bat';
  const blocks = cleanStages(pipeline.stages).map((stage) => {
    const command = stageCommand(stage, pipeline.template, useShell);
    const step = useShell + " '''\n" + command + "\n'''";
    const indented = step.split('\n').map((line) => '        ' + line).join('\n');
    return "    stage('" + stage + "') {\n      steps {\n" + indented + "\n      }\n    }";
  }).join('\n');
  return [
    'pipeline {',
    '  agent any',
    '  options {',
    '    skipDefaultCheckout(true)',
    '  }',
    '  stages {',
    blocks,
    '  }',
    '}',
    ''
  ].join('\n');
}

function jenkinsXml(script, description) {
  const safeScript = script.replace(/]]>/g, ']]]]><![CDATA[>');
  return [
    "<?xml version='1.1' encoding='UTF-8'?>",
    '<flow-definition>',
    '  <description>' + String(description || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</description>',
    '  <keepDependencies>false</keepDependencies>',
    '  <properties/>',
    '  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition">',
    '    <script><![CDATA[' + safeScript + ']]></script>',
    '    <sandbox>true</sandbox>',
    '  </definition>',
    '  <triggers/>',
    '  <disabled>false</disabled>',
    '</flow-definition>',
    ''
  ].join('\n');
}

function githubYaml(pipeline) {
  const stages = cleanStages(pipeline.stages);
  const steps = ['      - uses: actions/checkout@v4'];
  for (const stage of stages) {
    if (stage.toLowerCase() === 'checkout') continue;
    const command = stageCommand(stage, pipeline.template, 'sh').split('\n').join('\n          ');
    steps.push('      - name: ' + yamlQuote(stage));
    steps.push('        run: |');
    steps.push('          ' + command);
  }
  const lines = ['name: ' + yamlQuote(pipeline.name || 'Concierto pipeline'), 'on:', '  workflow_dispatch:'];
  if (pipeline.pushTrigger && !pipeline.approvalRequired) {
    lines.push('  push:', '    branches:', '      - ' + yamlQuote(pipeline.branch || 'main'));
  }
  lines.push('jobs:', '  build:', '    runs-on: ubuntu-latest', '    steps:');
  lines.push(steps.join('\n'));
  return lines.join('\n') + '\n';
}

function azureYaml(pipeline) {
  const stages = cleanStages(pipeline.stages).filter((stage) => stage.toLowerCase() !== 'checkout');
  const steps = ['- checkout: self'];
  for (const stage of stages) {
    const command = stageCommand(stage, pipeline.template, 'sh').split('\n').join('\n    ');
    steps.push('- bash: |');
    steps.push('    ' + command);
    steps.push('  displayName: ' + yamlQuote(stage));
  }
  const trigger = pipeline.pushTrigger && !pipeline.approvalRequired
    ? 'trigger:\n  branches:\n    include:\n      - ' + (pipeline.branch || 'main') + '\n'
    : 'trigger: none\n';
  return trigger + 'pr: none\npool:\n  vmImage: ubuntu-latest\nsteps:\n' + steps.join('\n') + '\n';
}

function buildDefinition(pipeline, shell) {
  const engine = pipeline.engine;
  if (engine === 'Jenkins') {
    const name = pipeline.jenkinsJob || pipeline.externalId || slug(pipeline.name);
    return { engine, filename: name, text: jenkinsScript(pipeline, shell || 'bat') };
  }
  if (engine === 'GitHub Actions') {
    const filename = pipeline.workflow || pipeline.workflowPath || ('.github/workflows/' + slug(pipeline.name) + '.yml');
    return { engine, filename, text: githubYaml(pipeline) };
  }
  if (engine === 'Azure DevOps') {
    const filename = pipeline.yamlPath || pipeline.workflow || ('/concierto/' + slug(pipeline.name) + '.yml');
    return { engine, filename, text: azureYaml(pipeline) };
  }
  fail(400, 'Choose Jenkins, GitHub Actions, or Azure DevOps.');
}

async function testJenkins(cfg) {
  const drafts = await jenkinsDrafts(cfg);
  const noun = drafts.length === 1 ? 'job' : 'jobs';
  let message = 'Connected to Jenkins. ' + drafts.length + ' ' + noun + ' visible.';
  if (!drafts.length) message += ' If jobs exist, this user needs Overall/Read and Job/Read.';
  return { ok: true, message };
}

async function githubRaw(token, method, apiPath, body) {
  requireGithub({ token });
  const url = /^https?:/i.test(apiPath) ? apiPath : 'https://api.github.com' + apiPath;
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Concierto-CICD',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const { res, text } = await httpCall('GitHub', url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 204) return { status: 204, data: {}, headers: res.headers };
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { message: snippet(text) }; }
  }
  if (!res.ok) fail(res.status, (data && data.message) || ('GitHub returned ' + res.status + '.'), snippet(text));
  return { status: res.status, data, headers: res.headers };
}

async function listGithubRepos(token) {
  const repos = [];
  let next = '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member';
  for (let page = 0; page < 3 && next; page++) {
    const { data, headers } = await githubRaw(token, 'GET', next);
    for (const repo of data || []) {
      repos.push({ fullName: repo.full_name, private: !!repo.private, defaultBranch: repo.default_branch || 'main' });
    }
    const link = headers.get('link') || '';
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    next = match ? match[1] : '';
  }
  return repos;
}

async function testGithub(cfg) {
  requireGithub(cfg);
  const { data } = await githubRaw(cfg.token, 'GET', '/user');
  const count = (cfg.repos || []).length;
  return { ok: true, message: 'Signed in to GitHub as ' + data.login + '. ' + count + ' repository selection' + (count === 1 ? '' : 's') + ' saved.' };
}

async function githubWorkflowDrafts(cfg, repo) {
  const { owner, name, full } = splitRepo(repo);
  const { data } = await githubRaw(cfg.token, 'GET', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/actions/workflows?per_page=100');
  const workflows = data.workflows || [];
  const drafts = [];
  for (const workflow of workflows) {
    if (!keepGithubWorkflow(workflow)) continue;
    let status = workflow.state === 'disabled_manually' || workflow.state === 'disabled_inactivity' ? 'Idle' : 'Idle';
    let lastResult = '';
    let lastRunLabel = '—';
    let lastRunAt = null;
    let externalRunId = '';
    let webUrl = 'https://github.com/' + full + '/actions/workflows/' + encodeURIComponent(workflow.path.split('/').pop());
    try {
      const runs = await githubRaw(cfg.token, 'GET', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/actions/workflows/' + workflow.id + '/runs?per_page=1');
      const run = (runs.data.workflow_runs || [])[0];
      if (run) {
        status = mapGithub(run);
        lastResult = run.conclusion || run.status || '';
        lastRunLabel = '#' + run.run_number;
        lastRunAt = Date.parse(run.created_at) || null;
        externalRunId = String(run.id);
        webUrl = run.html_url || webUrl;
      }
    } catch (err) {
      lastResult = err.message;
    }
    drafts.push({
      engine: 'GitHub Actions',
      name: workflow.name || workflow.path,
      externalId: String(workflow.id),
      repo: full,
      branch: cfg.branch || 'main',
      workflow: workflow.path,
      webUrl,
      status,
      lastResult,
      lastRunLabel,
      lastRunAt,
      externalRunId
    });
  }
  return drafts;
}

function mapGithub(run) {
  if (!run) return 'Idle';
  if (run.status !== 'completed') return run.status === 'queued' || run.status === 'waiting' || run.status === 'pending' ? 'Queued' : 'Running';
  if (run.conclusion === 'success') return 'Success';
  if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') return 'Cancelled';
  if (run.conclusion === 'neutral') return 'Unstable';
  return 'Failed';
}

async function githubDrafts(cfg) {
  requireGithub(cfg);
  const repos = cfg.repos || [];
  if (!repos.length) fail(400, 'Add at least one GitHub repository (owner/name) in Credential Manager, then sync again.');
  const drafts = [];
  const errors = [];
  const syncedRepos = [];
  for (const repo of repos) {
    try {
      drafts.push(...await githubWorkflowDrafts(cfg, repo));
      syncedRepos.push(normalizeRepo(repo));
    } catch (err) {
      errors.push(normalizeRepo(repo) + ': ' + err.message);
    }
  }
  return { drafts, errors, syncedRepos };
}

function azureUrl(cfg, pathAfterOrg) {
  return 'https://dev.azure.com/' + encodeURIComponent(normalizeOrg(cfg.organization)) + '/' + pathAfterOrg;
}

async function azureSend(cfg, method, pathAfterOrg, body) {
  requireAzure(cfg);
  const headers = { Authorization: authHeader('', cfg.pat), Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const { res, text } = await httpCall('Azure DevOps', azureUrl(cfg, pathAfterOrg), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 204) return { status: 204, data: {} };
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { message: snippet(text) }; }
  }
  if (!res.ok) fail(res.status, (data && data.message) || ('Azure DevOps returned ' + res.status + '.'), snippet(text));
  return { status: res.status, data };
}

function projectPath(cfg, rel) {
  const sep = rel.includes('?') ? '&' : '?';
  return encodeURIComponent(cfg.project) + '/_apis/' + rel + sep + 'api-version=7.1';
}

async function listAzureRepos(cfg) {
  const { data } = await azureSend(cfg, 'GET', projectPath(cfg, 'git/repositories'));
  return (data.value || []).map((repo) => ({
    id: repo.id,
    name: repo.name,
    defaultBranch: String(repo.defaultBranch || 'refs/heads/main').replace('refs/heads/', '')
  }));
}

async function testAzure(cfg) {
  const project = await azureSend(cfg, 'GET', '_apis/projects/' + encodeURIComponent(cfg.project) + '?api-version=7.1');
  const pipes = await azureSend(cfg, 'GET', projectPath(cfg, 'pipelines'));
  const count = (pipes.data.value || []).length;
  return { ok: true, message: 'Connected to Azure DevOps project ' + (project.data.name || cfg.project) + '. ' + count + ' pipeline' + (count === 1 ? '' : 's') + '.' };
}

function mapAzure(run) {
  const state = String(run && run.state || '').toLowerCase();
  const result = String(run && run.result || '').toLowerCase();
  if (state === 'completed') {
    if (result === 'succeeded' || result === 'partiallysucceeded') return result === 'succeeded' ? 'Success' : 'Unstable';
    if (result === 'canceled' || result === 'cancelled') return 'Cancelled';
    return 'Failed';
  }
  if (state === 'inprogress' || state === 'canceling') return 'Running';
  return 'Queued';
}

async function azureDrafts(cfg) {
  const { data } = await azureSend(cfg, 'GET', projectPath(cfg, 'pipelines'));
  const items = (data.value || []).slice(0, 60);
  const drafts = [];
  for (const item of items) {
    let detail = item;
    try {
      const full = await azureSend(cfg, 'GET', projectPath(cfg, 'pipelines/' + item.id));
      detail = full.data || item;
    } catch { /* the list record is enough to link the pipeline */ }
    let status = 'Idle';
    let lastResult = '';
    let lastRunLabel = '—';
    let lastRunAt = null;
    let externalRunId = '';
    let webUrl = (detail._links && detail._links.web && detail._links.web.href) || '';
    try {
      const runs = await azureSend(cfg, 'GET', projectPath(cfg, 'pipelines/' + item.id + '/runs?$top=1'));
      const run = (runs.data.value || [])[0];
      if (run) {
        status = mapAzure(run);
        lastResult = run.result || run.state || '';
        lastRunLabel = run.name ? String(run.name) : '#' + run.id;
        lastRunAt = Date.parse(run.createdDate || run.finishedDate || '') || null;
        externalRunId = String(run.id);
        webUrl = (run._links && run._links.web && run._links.web.href) || webUrl;
      }
    } catch (err) {
      lastResult = err.message;
    }
    const repoName = detail.configuration && detail.configuration.repository && detail.configuration.repository.name || cfg.repository || '';
    const yamlPath = detail.configuration && detail.configuration.path || '';
    drafts.push({
      engine: 'Azure DevOps',
      name: detail.name || item.name,
      externalId: String(item.id),
      repo: repoName,
      branch: cfg.branch || 'main',
      workflow: yamlPath,
      webUrl,
      status,
      lastResult,
      lastRunLabel,
      lastRunAt,
      externalRunId
    });
  }
  return drafts;
}

async function jenkinsJobExists(cfg, jobName) {
  try {
    await jenkinsSend(cfg, 'GET', jobApiPath(jobName) + '/api/json?tree=name');
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

async function publishJenkins(cfg, pipeline, overwrite) {
  const jobName = String(pipeline.jenkinsJob || pipeline.externalId || slug(pipeline.name)).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,80}$/.test(jobName) || jobName.includes('/') || jobName.includes('\\')) {
    fail(400, 'Jenkins job name can use letters, numbers, spaces, dots, underscores, and hyphens. Create folders in Jenkins itself.');
  }
  const script = String(pipeline.definitionText || '').trim() || jenkinsScript(pipeline, cfg.shell);
  let xml = jenkinsXml(script, 'Managed by Concierto CICD');
  if (Array.isArray(pipeline.parameterDefs) && pipeline.parameterDefs.length) xml = upsertParameterProperty(xml, pipeline.parameterDefs);
  const exists = await jenkinsJobExists(cfg, jobName);
  if (exists && !overwrite) {
    fail(409, 'Jenkins already has a job named "' + jobName + '". Link that job, or choose another name.');
  }
  if (exists) {
    await jenkinsSend(cfg, 'POST', jobApiPath(jobName) + '/config.xml', { body: xml, contentType: 'application/xml; charset=utf-8' });
  } else {
    await jenkinsSend(cfg, 'POST', '/createItem?name=' + encodeURIComponent(jobName), { body: xml, contentType: 'application/xml; charset=utf-8' });
  }
  const base = cfg.url.replace(/\/+$/, '');
  return {
    externalId: jobName,
    workflow: jobName,
    webUrl: base + '/' + jobApiPath(jobName) + '/',
    branch: pipeline.branch || '',
    repo: pipeline.repo || ''
  };
}

async function githubFile(cfg, repo, filePath, branch) {
  const { owner, name } = splitRepo(repo);
  const path = String(filePath || '').replace(/^\/+/, '');
  try {
    const { data } = await githubRaw(cfg.token, 'GET', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/contents/' + encodeURI(path) + '?ref=' + encodeURIComponent(branch));
    return data;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function githubDefaultBranch(cfg, repo) {
  const { owner, name } = splitRepo(repo);
  const { data } = await githubRaw(cfg.token, 'GET', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name));
  return data.default_branch || 'main';
}

async function findWorkflow(cfg, repo, filePath) {
  const { owner, name } = splitRepo(repo);
  const wanted = String(filePath || '').replace(/^\/+/, '');
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data } = await githubRaw(cfg.token, 'GET', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/actions/workflows?per_page=100');
    const hit = (data.workflows || []).find((item) => item.path === wanted);
    if (hit) return hit;
    await sleep(1500);
  }
  return null;
}

async function publishGithub(cfg, pipeline, overwrite, previous) {
  const repo = normalizeRepo(pipeline.repo || pipeline.githubRepo || '');
  splitRepo(repo);
  let branch = pipeline.branch || cfg.branch || 'main';
  try { branch = pipeline.branch || await githubDefaultBranch(cfg, repo); } catch { /* keep the branch the user typed */ }
  const filePath = String(pipeline.workflowPath || pipeline.workflow || ('.github/workflows/' + slug(pipeline.name) + '.yml')).replace(/^\/+/, '');
  if (!/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(filePath)) {
    fail(400, 'GitHub workflow path must look like .github/workflows/name.yml.');
  }
  const existing = await githubFile(cfg, repo, filePath, branch);
  if (existing && !overwrite) fail(409, 'That workflow file already exists. Link it, or choose another file name.');
  const text = String(pipeline.definitionText || '').trim() || githubYaml({ ...pipeline, branch, pushTrigger: pipeline.pushTrigger && !pipeline.approvalRequired });
  const body = {
    message: (existing ? 'Update' : 'Add') + ' pipeline from Concierto CICD',
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch
  };
  if (existing && existing.sha) body.sha = existing.sha;
  const { owner, name } = splitRepo(repo);
  await githubRaw(cfg.token, 'PUT', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/contents/' + encodeURI(filePath), body);
  if (previous && previous.workflow && previous.workflow !== filePath && previous.definitionSource === 'concierto') {
    try { await deleteGithubFile(cfg, previous.repo || repo, previous.workflow, previous.branch || branch); } catch { /* the new file is already saved */ }
  }
  const workflow = await findWorkflow(cfg, repo, filePath);
  let warning = workflow ? '' : 'GitHub has the workflow file. It can take a minute before GitHub lists it for a manual run.';
  try {
    const defaultBranch = await githubDefaultBranch(cfg, repo);
    if (branch !== defaultBranch) {
      warning = (warning ? warning + ' ' : '') + 'Manual runs work when the workflow file is on the default branch (' + defaultBranch + ').';
    }
  } catch (err) { /* the file is already saved */ }
  return {
    externalId: workflow ? String(workflow.id) : '',
    workflow: filePath,
    repo,
    branch,
    webUrl: 'https://github.com/' + repo + '/actions/workflows/' + encodeURIComponent(filePath.split('/').pop()),
    warning
  };
}

async function deleteGithubFile(cfg, repo, filePath, branch) {
  const current = await githubFile(cfg, repo, filePath, branch || 'main');
  if (!current || !current.sha) return;
  const { owner, name } = splitRepo(repo);
  await githubRaw(cfg.token, 'DELETE', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/contents/' + encodeURI(String(filePath).replace(/^\/+/, '')), {
    message: 'Remove pipeline from Concierto CICD',
    sha: current.sha,
    branch: branch || 'main'
  });
}

async function findAzureRepo(cfg, repositoryName) {
  const repos = await listAzureRepos(cfg);
  const wanted = String(repositoryName || cfg.repository || '').trim().toLowerCase();
  if (!wanted) fail(400, 'Enter the Azure Repos repository name. Load repositories in Credential Manager if you need the exact name.');
  const hit = repos.find((repo) => repo.name.toLowerCase() === wanted || repo.id.toLowerCase() === wanted);
  if (!hit) {
    const sample = repos.slice(0, 12).map((repo) => repo.name).join(', ');
    fail(404, 'Azure Repos repository "' + repositoryName + '" was not found in project ' + cfg.project + '.', sample ? 'Repositories: ' + sample : '');
  }
  return hit;
}

async function publishAzure(cfg, pipeline, overwrite, previous) {
  const repo = await findAzureRepo(cfg, pipeline.azureRepo || pipeline.repo || cfg.repository);
  const branch = pipeline.branch || repo.defaultBranch || cfg.branch || 'main';
  let yamlPath = String(pipeline.yamlPath || pipeline.workflow || ('/concierto/' + slug(pipeline.name) + '.yml'));
  if (!yamlPath.startsWith('/')) yamlPath = '/' + yamlPath;
  if (yamlPath.includes('..') || !/^\/[A-Za-z0-9._/-]+\.ya?ml$/.test(yamlPath)) {
    fail(400, 'Azure YAML path must look like /concierto/name.yml.');
  }
  const refs = await azureSend(cfg, 'GET', projectPath(cfg, 'git/repositories/' + repo.id + '/refs?filter=' + encodeURIComponent('heads/' + branch)));
  const ref = (refs.data.value || []).find((item) => item.name === 'refs/heads/' + branch);
  const oldObjectId = ref ? ref.objectId : '0000000000000000000000000000000000000000';
  let exists = false;
  try {
    await azureSend(cfg, 'GET', projectPath(cfg, 'git/repositories/' + repo.id + '/items?path=' + encodeURIComponent(yamlPath) + '&versionDescriptor.version=' + encodeURIComponent(branch) + '&versionDescriptor.versionType=branch'));
    exists = true;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  if (exists && !overwrite) fail(409, 'That YAML file already exists in ' + repo.name + '. Link the pipeline, or choose another path.');
  const content = String(pipeline.definitionText || '').trim() || azureYaml({ ...pipeline, branch, pushTrigger: pipeline.pushTrigger && !pipeline.approvalRequired });
  await azureSend(cfg, 'POST', projectPath(cfg, 'git/repositories/' + repo.id + '/pushes'), {
    refUpdates: [{ name: 'refs/heads/' + branch, oldObjectId }],
    commits: [{
      comment: (exists ? 'Update' : 'Add') + ' pipeline from Concierto CICD',
      changes: [{
        changeType: exists ? 'edit' : 'add',
        item: { path: yamlPath },
        newContent: { content, contentType: 'rawtext' }
      }]
    }]
  });
  const name = pipeline.name;
  const listed = await azureSend(cfg, 'GET', projectPath(cfg, 'pipelines'));
  let remote = (listed.data.value || []).find((item) => String(item.name).toLowerCase() === String(name).toLowerCase());
  if (!remote) {
    const created = await azureSend(cfg, 'POST', projectPath(cfg, 'pipelines'), {
      name,
      folder: '\\Concierto',
      configuration: {
        type: 'yaml',
        path: yamlPath,
        repository: { id: repo.id, name: repo.name, type: 'azureReposGit' }
      }
    });
    remote = created.data;
  }
  if (previous && previous.workflow && previous.workflow !== yamlPath && previous.definitionSource === 'concierto' && String(previous.workflow).startsWith('/concierto/')) {
    try { await deleteAzureYaml(cfg, previous.repo, previous.workflow, previous.branch || branch); } catch { /* the new pipeline is already registered */ }
  }
  return {
    externalId: String(remote.id),
    workflow: yamlPath,
    repo: repo.name,
    branch,
    webUrl: (remote._links && remote._links.web && remote._links.web.href) || ''
  };
}

async function deleteAzureYaml(cfg, repositoryName, yamlPath, branch) {
  const repo = await findAzureRepo(cfg, repositoryName);
  const refs = await azureSend(cfg, 'GET', projectPath(cfg, 'git/repositories/' + repo.id + '/refs?filter=' + encodeURIComponent('heads/' + (branch || 'main'))));
  const ref = (refs.data.value || [])[0];
  if (!ref) return;
  await azureSend(cfg, 'POST', projectPath(cfg, 'git/repositories/' + repo.id + '/pushes'), {
    refUpdates: [{ name: ref.name, oldObjectId: ref.objectId }],
    commits: [{
      comment: 'Remove pipeline file from Concierto CICD',
      changes: [{ changeType: 'delete', item: { path: yamlPath } }]
    }]
  });
}

async function publish(creds, pipeline, options = {}) {
  if (pipeline.engine === 'Jenkins') return publishJenkins(creds.jenkins, pipeline, !!options.overwrite);
  if (pipeline.engine === 'GitHub Actions') return publishGithub(creds.github, pipeline, !!options.overwrite, options.previous);
  if (pipeline.engine === 'Azure DevOps') return publishAzure(creds.azureDevOps, pipeline, !!options.overwrite, options.previous);
  fail(400, 'Choose Jenkins, GitHub Actions, or Azure DevOps.');
}

async function linkJenkins(cfg, remoteId) {
  const { data } = await jenkinsSend(cfg, 'GET', jobApiPath(remoteId) + '/api/json?tree=name,url,color,lastBuild[number,result,timestamp,url]');
  return {
    name: remoteId,
    externalId: remoteId,
    workflow: remoteId,
    webUrl: data.url || '',
    status: jenkinsStatusFromBuild(data.lastBuild, data.color),
    lastRunLabel: data.lastBuild ? '#' + data.lastBuild.number : '—',
    lastRunAt: data.lastBuild ? data.lastBuild.timestamp : null
  };
}

function jenkinsStatusFromBuild(build, color) {
  if (build) return mapJenkinsBuild(build);
  return jenkinsStatus(color);
}

async function linkGithub(cfg, repo, remoteId) {
  const { owner, name, full } = splitRepo(repo);
  const { data } = await githubRaw(cfg.token, 'GET', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/actions/workflows/' + encodeURIComponent(remoteId));
  return {
    externalId: String(data.id),
    workflow: data.path,
    repo: full,
    webUrl: 'https://github.com/' + full + '/actions/workflows/' + encodeURIComponent(String(data.path || '').split('/').pop()),
    name: data.name || data.path
  };
}

async function linkAzure(cfg, remoteId) {
  const { data } = await azureSend(cfg, 'GET', projectPath(cfg, 'pipelines/' + encodeURIComponent(remoteId)));
  return {
    externalId: String(data.id),
    name: data.name,
    workflow: (data.configuration && data.configuration.path) || '',
    repo: (data.configuration && data.configuration.repository && data.configuration.repository.name) || '',
    webUrl: (data._links && data._links.web && data._links.web.href) || ''
  };
}

async function linkRemote(creds, pipeline) {
  if (pipeline.engine === 'Jenkins') return linkJenkins(creds.jenkins, pipeline.remoteId);
  if (pipeline.engine === 'GitHub Actions') return linkGithub(creds.github, pipeline.repo || pipeline.githubRepo, pipeline.remoteId);
  if (pipeline.engine === 'Azure DevOps') return linkAzure(creds.azureDevOps, pipeline.remoteId);
  fail(400, 'Choose Jenkins, GitHub Actions, or Azure DevOps.');
}

async function triggerJenkins(cfg, pipeline, parameters) {
  if (!pipeline.externalId) fail(400, 'Publish or link this pipeline to a Jenkins job before running it.');
  const defs = await jenkinsParameters(cfg, pipeline.externalId);
  let sent;
  if (defs.length) {
    const form = new URLSearchParams();
    for (const def of defs) {
      let value = parameters && Object.prototype.hasOwnProperty.call(parameters, def.name) ? parameters[def.name] : def.defaultValue;
      if (value === undefined || value === null) value = '';
      if (typeof value === 'boolean') value = value ? 'true' : 'false';
      form.append(def.name, String(value));
    }
    sent = await jenkinsSend(cfg, 'POST', jobApiPath(pipeline.externalId) + '/buildWithParameters', {
      body: form.toString(),
      contentType: 'application/x-www-form-urlencoded'
    });
  } else {
    sent = await jenkinsSend(cfg, 'POST', jobApiPath(pipeline.externalId) + '/build');
  }
  let queueUrl = sent.location || '';
  if (queueUrl && !/^https?:/i.test(queueUrl)) queueUrl = joinUrl(cfg.url, queueUrl);
  if (queueUrl && !queueUrl.endsWith('/')) queueUrl += '/';
  return {
    status: 'Queued',
    externalRunId: '',
    queueUrl,
    webUrl: cfg.url.replace(/\/+$/, '') + '/' + jobApiPath(pipeline.externalId) + '/',
    label: 'Queued',
    lookupAfter: Date.now()
  };
}

async function triggerGithub(cfg, pipeline, parameters) {
  const repo = pipeline.repo;
  const { owner, name } = splitRepo(repo);
  let workflowId = pipeline.externalId;
  if (!workflowId && pipeline.workflow) {
    const found = await findWorkflow(cfg, repo, pipeline.workflow);
    if (found) workflowId = String(found.id);
  }
  if (!workflowId) fail(400, 'GitHub has not listed this workflow yet. Wait a minute and run it again.');
  const branch = pipeline.branch || cfg.branch || 'main';
  const dispatch = { ref: branch };
  if (parameters && Object.keys(parameters).length) dispatch.inputs = parameters;
  await githubRaw(cfg.token, 'POST', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/actions/workflows/' + encodeURIComponent(workflowId) + '/dispatches', dispatch);
  return {
    status: 'Queued',
    externalRunId: '',
    externalWorkflowId: String(workflowId),
    webUrl: 'https://github.com/' + normalizeRepo(repo) + '/actions',
    label: 'Queued',
    lookupAfter: Date.now(),
    queueUrl: ''
  };
}

async function triggerAzure(cfg, pipeline, parameters) {
  if (!pipeline.externalId) fail(400, 'Publish or link this pipeline to Azure DevOps before running it.');
  const branch = pipeline.branch || cfg.branch || 'main';
  const payload = { resources: { repositories: { self: { refName: 'refs/heads/' + branch } } } };
  if (parameters && Object.keys(parameters).length) payload.templateParameters = parameters;
  const { data } = await azureSend(cfg, 'POST', projectPath(cfg, 'pipelines/' + encodeURIComponent(pipeline.externalId) + '/runs'), payload);
  return {
    status: mapAzure(data),
    externalRunId: String(data.id || ''),
    webUrl: (data._links && data._links.web && data._links.web.href) || '',
    label: data.name ? String(data.name) : ('#' + data.id),
    lookupAfter: Date.now(),
    queueUrl: ''
  };
}

async function trigger(creds, pipeline, parameters) {
  if (pipeline.engine === 'Jenkins') return triggerJenkins(creds.jenkins, pipeline, parameters);
  if (pipeline.engine === 'GitHub Actions') return triggerGithub(creds.github, pipeline, parameters);
  if (pipeline.engine === 'Azure DevOps') return triggerAzure(creds.azureDevOps, pipeline, parameters);
  fail(400, 'This engine cannot be triggered from the prototype.');
}

async function refreshJenkins(cfg, pipeline, run, withLog) {
  const job = jobApiPath(pipeline.externalId);
  if (run.externalRunId) {
    const { data } = await jenkinsSend(cfg, 'GET', job + '/' + encodeURIComponent(run.externalRunId) + '/api/json');
    const status = mapJenkinsBuild(data);
    const next = {
      status,
      webUrl: data.url || run.webUrl,
      label: '#' + data.number,
      error: ''
    };
    if (status === 'Success' || status === 'Failed' || status === 'Unstable' || status === 'Cancelled') {
      next.finished = (data.timestamp || Date.now()) + (data.duration || 0);
    }
    if (withLog) {
      const log = await jenkinsSend(cfg, 'GET', job + '/' + encodeURIComponent(run.externalRunId) + '/consoleText');
      next.consoleTail = tail(log.text, 80);
    }
    return next;
  }
  if (run.queueUrl) {
    const queued = await jenkinsSend(cfg, 'GET', run.queueUrl.replace(/\/?$/, '/') + 'api/json');
    if (queued.data && queued.data.cancelled) {
      return { status: 'Cancelled', finished: Date.now(), error: queued.data.why || 'Cancelled in the Jenkins queue.' };
    }
    if (queued.data && queued.data.executable && queued.data.executable.number) {
      return {
        status: 'Running',
        externalRunId: String(queued.data.executable.number),
        label: '#' + queued.data.executable.number,
        webUrl: queued.data.executable.url || run.webUrl,
        error: ''
      };
    }
    return { status: 'Queued', error: (queued.data && queued.data.why) || '' };
  }
  const info = await jenkinsSend(cfg, 'GET', job + '/api/json?tree=' + encodeURIComponent('lastBuild[number,result,timestamp,duration,url,building]'));
  const build = info.data && info.data.lastBuild;
  if (build && build.timestamp && run.started && build.timestamp + 20000 >= run.started) {
    return { status: mapJenkinsBuild(build), externalRunId: String(build.number), label: '#' + build.number, webUrl: build.url || run.webUrl, error: '' };
  }
  return { status: run.status || 'Queued' };
}

async function refreshGithub(cfg, pipeline, run, withLog) {
  const repo = pipeline.repo;
  const { owner, name } = splitRepo(repo);
  let workflowId = run.externalWorkflowId || pipeline.externalId;
  if (!workflowId && pipeline.workflow) {
    const found = await findWorkflow(cfg, repo, pipeline.workflow);
    if (found) workflowId = String(found.id);
  }
  if (!workflowId) return { status: 'Queued', error: 'Waiting for GitHub to list the workflow.' };
  let remote = null;
  if (run.externalRunId) {
    const { data } = await githubRaw(cfg.token, 'GET', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/actions/runs/' + encodeURIComponent(run.externalRunId));
    remote = data;
  } else {
    const { data } = await githubRaw(cfg.token, 'GET', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/actions/workflows/' + encodeURIComponent(workflowId) + '/runs?per_page=10');
    const after = (run.lookupAfter || run.started || 0) - 20000;
    remote = (data.workflow_runs || []).find((item) => Date.parse(item.created_at) >= after && item.event === 'workflow_dispatch') || null;
  }
  if (!remote) return { status: 'Queued', externalWorkflowId: String(workflowId) };
  const status = mapGithub(remote);
  const next = {
    status,
    externalRunId: String(remote.id),
    externalWorkflowId: String(workflowId),
    label: '#' + remote.run_number,
    webUrl: remote.html_url || run.webUrl,
    error: ''
  };
  if (status === 'Success' || status === 'Failed' || status === 'Cancelled' || status === 'Unstable') {
    next.finished = Date.parse(remote.updated_at) || Date.now();
  }
  if (withLog) {
    try {
      const jobs = await githubRaw(cfg.token, 'GET', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/actions/runs/' + remote.id + '/jobs');
      const lines = [];
      for (const job of jobs.data.jobs || []) {
        lines.push(job.name + ' — ' + (job.conclusion || job.status));
        for (const step of job.steps || []) lines.push('  ' + step.number + '. ' + step.name + ' — ' + (step.conclusion || step.status));
      }
      next.consoleTail = lines.join('\n');
    } catch (err) {
      next.consoleTail = err.message;
    }
  }
  return next;
}

async function refreshAzure(cfg, pipeline, run, withLog) {
  let remote = null;
  if (run.externalRunId) {
    const { data } = await azureSend(cfg, 'GET', projectPath(cfg, 'pipelines/' + encodeURIComponent(pipeline.externalId) + '/runs/' + encodeURIComponent(run.externalRunId)));
    remote = data;
  } else {
    const { data } = await azureSend(cfg, 'GET', projectPath(cfg, 'pipelines/' + encodeURIComponent(pipeline.externalId) + '/runs?$top=5'));
    const after = (run.lookupAfter || run.started || 0) - 20000;
    remote = (data.value || []).find((item) => Date.parse(item.createdDate || '') >= after) || null;
  }
  if (!remote) return { status: 'Queued' };
  const status = mapAzure(remote);
  const next = {
    status,
    externalRunId: String(remote.id),
    label: remote.name ? String(remote.name) : ('#' + remote.id),
    webUrl: (remote._links && remote._links.web && remote._links.web.href) || run.webUrl,
    error: ''
  };
  if (status === 'Success' || status === 'Failed' || status === 'Cancelled' || status === 'Unstable') {
    next.finished = Date.parse(remote.finishedDate || '') || Date.now();
  }
  if (withLog) {
    try {
      const timeline = await azureSend(cfg, 'GET', projectPath(cfg, 'build/builds/' + encodeURIComponent(remote.id) + '/timeline'));
      next.consoleTail = (timeline.data.records || [])
        .filter((record) => ['Stage', 'Phase', 'Job', 'Task'].includes(record.type))
        .slice(0, 80)
        .map((record) => record.type + ': ' + record.name + ' — ' + (record.result || record.state || ''))
        .join('\n');
    } catch (err) {
      next.consoleTail = err.message;
    }
  }
  return next;
}

async function refreshRun(creds, pipeline, run, withLog) {
  if (!pipeline.externalId && pipeline.engine !== 'GitHub Actions') {
    return { status: run.status || 'Failed', error: 'This pipeline is not linked to an engine job.' };
  }
  if (pipeline.engine === 'Jenkins') return refreshJenkins(creds.jenkins, pipeline, run, withLog);
  if (pipeline.engine === 'GitHub Actions') return refreshGithub(creds.github, pipeline, run, withLog);
  if (pipeline.engine === 'Azure DevOps') return refreshAzure(creds.azureDevOps, pipeline, run, withLog);
  return { status: run.status };
}

function decodeXml(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function fetchDefinition(creds, pipeline) {
  if (pipeline.engine === 'Jenkins' && pipeline.externalId) {
    const { text } = await jenkinsSend(creds.jenkins, 'GET', jobApiPath(pipeline.externalId) + '/config.xml');
    const match = text.match(/<script>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/script>/);
    const script = decodeXml(match ? match[1].trim() : text);
    return { text: script, source: 'Jenkins job ' + pipeline.externalId };
  }
  if (pipeline.engine === 'GitHub Actions' && pipeline.repo && pipeline.workflow) {
    const file = await githubFile(creds.github, pipeline.repo, pipeline.workflow, pipeline.branch || creds.github.branch || 'main');
    if (!file || !file.content) return { text: 'The workflow file is not on this branch yet.', source: pipeline.workflow };
    const body = Buffer.from(String(file.content).replace(/\n/g, ''), 'base64').toString('utf8');
    return { text: body, source: pipeline.repo + ' / ' + pipeline.workflow };
  }
  if (pipeline.engine === 'Azure DevOps' && pipeline.repo && pipeline.workflow) {
    const repo = await findAzureRepo(creds.azureDevOps, pipeline.repo);
    const branch = pipeline.branch || creds.azureDevOps.branch || 'main';
    const { data } = await azureSend(creds.azureDevOps, 'GET', projectPath(creds.azureDevOps, 'git/repositories/' + repo.id + '/items?path=' + encodeURIComponent(pipeline.workflow) + '&includeContent=true&versionDescriptor.version=' + encodeURIComponent(branch) + '&versionDescriptor.versionType=branch'));
    return { text: data.content || '', source: repo.name + ' ' + pipeline.workflow };
  }
  const local = buildDefinition(pipeline, creds.jenkins.shell || 'bat');
  return { text: local.text, source: 'Generated by Concierto. Not on the engine until you publish it.' };
}

async function deleteRemote(creds, pipeline) {
  if (pipeline.engine === 'Jenkins') {
    if (!pipeline.externalId) fail(400, 'This pipeline is not linked to a Jenkins job.');
    await jenkinsSend(creds.jenkins, 'POST', jobApiPath(pipeline.externalId) + '/doDelete');
    return;
  }
  if (pipeline.engine === 'GitHub Actions') {
    if (pipeline.repo && pipeline.workflow) {
      await deleteGithubFile(creds.github, pipeline.repo, pipeline.workflow, pipeline.branch || creds.github.branch || 'main');
      return;
    }
    fail(400, 'This GitHub workflow has no file path to delete.');
  }
  if (pipeline.engine === 'Azure DevOps') {
    if (!pipeline.externalId) fail(400, 'This pipeline is not linked to Azure DevOps.');
    await azureSend(creds.azureDevOps, 'DELETE', projectPath(creds.azureDevOps, 'pipelines/' + encodeURIComponent(pipeline.externalId)));
    return;
  }
  fail(400, 'Nothing to delete on the engine.');
}

function keepGithubWorkflow(workflow) {
  const path = String(workflow.path || '').replace(/\\/g, '/');
  const name = String(workflow.name || '');
  if (/pages-build-deployment/i.test(path) || /pages-build-deployment/i.test(name)) return false;
  if (path.startsWith('dynamic/')) return false;
  if (path && !path.startsWith('.github/workflows/')) return false;
  return true;
}

function asList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function collectJenkinsParameters(data) {
  const defs = [];
  const props = asList(data && data.property).concat(asList(data && data.actions));
  for (const prop of props) {
    for (const def of asList(prop && prop.parameterDefinitions)) {
      if (!def || !def.name || defs.some((item) => item.name === def.name)) continue;
      defs.push({
        name: def.name,
        type: String(def.type || '').split('.').pop(),
        description: def.description || '',
        defaultValue: def.defaultParameterValue ? def.defaultParameterValue.value : '',
        choices: asList(def.choices).map((item) => String(item))
      });
    }
  }
  return defs;
}

async function jenkinsParameters(cfg, jobName) {
  const queried = await jenkinsSend(cfg, 'GET', jobApiPath(jobName) + '/api/json?tree=' + encodeURIComponent('property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]],actions[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]]'));
  const defs = collectJenkinsParameters(queried.data);
  if (defs.length) return defs;
  const full = await jenkinsSend(cfg, 'GET', jobApiPath(jobName) + '/api/json');
  return collectJenkinsParameters(full.data);
}

function githubDispatchInputs(text) {
  const lines = String(text || '').split(/\r?\n/);
  const inputs = [];
  let inDispatch = false;
  let inInputs = false;
  let inputsIndent = 0;
  let current = null;
  for (const line of lines) {
    if (/^\s*workflow_dispatch:\s*$/.test(line)) { inDispatch = true; inInputs = false; current = null; continue; }
    if (inDispatch && !inInputs && /^\S/.test(line)) { inDispatch = false; continue; }
    if (inDispatch && /^\s*inputs:\s*$/.test(line)) {
      inInputs = true;
      inputsIndent = line.match(/^\s*/)[0].length;
      continue;
    }
    if (!inInputs) continue;
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= inputsIndent) break;
    const key = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (key && key[1].length === inputsIndent + 2) {
      current = { name: key[2], type: 'string', description: '', defaultValue: unquote(key[3]), choices: [] };
      inputs.push(current);
      continue;
    }
    if (!current) continue;
    const desc = line.match(/description:\s*(.*)$/);
    const def = line.match(/\bdefault:\s*(.*)$/);
    const type = line.match(/\btype:\s*(.*)$/);
    if (desc) current.description = unquote(desc[1]);
    if (def) current.defaultValue = unquote(def[1]);
    if (type) current.type = unquote(type[1]);
  }
  return inputs;
}

function azureYamlParameters(text) {
  const lines = String(text || '').split(/\r?\n/);
  const params = [];
  let inParams = false;
  let current = null;
  for (const line of lines) {
    if (/^parameters:\s*$/.test(line)) { inParams = true; current = null; continue; }
    if (!inParams) continue;
    if (/^\S/.test(line)) break;
    const named = line.match(/^\s*-\s*name:\s*(.*)$/);
    if (named) {
      current = { name: unquote(named[1]), type: 'string', description: '', defaultValue: '', choices: [] };
      params.push(current);
      continue;
    }
    if (!current) continue;
    const display = line.match(/displayName:\s*(.*)$/);
    const type = line.match(/\btype:\s*(.*)$/);
    const def = line.match(/\bdefault:\s*(.*)$/);
    if (display) current.description = unquote(display[1]);
    if (type) current.type = unquote(type[1]);
    if (def) current.defaultValue = unquote(def[1]);
  }
  return params;
}

function unquote(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

async function readParameters(creds, pipeline) {
  if (pipeline.engine === 'Jenkins') {
    if (!pipeline.externalId) return [];
    return jenkinsParameters(creds.jenkins, pipeline.externalId);
  }
  if (pipeline.engine === 'GitHub Actions' || pipeline.engine === 'Azure DevOps') {
    try {
      const definition = await fetchDefinition(creds, pipeline);
      if (pipeline.engine === 'GitHub Actions') return githubDispatchInputs(definition.text);
      return azureYamlParameters(definition.text);
    } catch {
      return [];
    }
  }
  return [];
}

async function renameJenkins(cfg, fromName, toName) {
  if (!fromName || fromName === toName) return;
  if (String(fromName).includes('/') || String(fromName).includes('\\')) {
    fail(400, 'This job is inside a Jenkins folder. Rename it in Jenkins, then sync again.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,80}$/.test(toName)) {
    fail(400, 'Jenkins job name can use letters, numbers, spaces, dots, underscores, and hyphens.');
  }
  await jenkinsSend(cfg, 'POST', jobApiPath(fromName) + '/doRename?newName=' + encodeURIComponent(toName));
}

async function saveJenkinsScript(cfg, jobName, script, parameterDefs) {
  const { text } = await jenkinsSend(cfg, 'GET', jobApiPath(jobName) + '/config.xml');
  if (!/<script[\s>]/.test(text)) {
    fail(400, 'This Jenkins job is not a Pipeline job, so its script cannot be edited from Concierto.');
  }
  const safe = String(script || '').replace(/]]>/g, ']]]]><![CDATA[>');
  let xml = text.replace(/<script>[\s\S]*?<\/script>/, '<script><![CDATA[' + safe + ']]></script>');
  if (Array.isArray(parameterDefs)) xml = upsertParameterProperty(xml, parameterDefs);
  await jenkinsSend(cfg, 'POST', jobApiPath(jobName) + '/config.xml', { body: xml, contentType: 'application/xml; charset=utf-8' });
  const base = cfg.url.replace(/\/+$/, '');
  return { externalId: jobName, workflow: jobName, webUrl: base + '/' + jobApiPath(jobName) + '/' };
}

async function writeGithubFile(cfg, repo, filePath, branch, text) {
  const path = String(filePath || '').replace(/^\/+/, '');
  if (!path.startsWith('.github/workflows/') || path.includes('..')) {
    fail(400, 'Only files under .github/workflows can be saved from Concierto.');
  }
  const existing = await githubFile(cfg, repo, path, branch);
  const body = {
    message: (existing ? 'Update ' : 'Add ') + path + ' from Concierto CICD',
    content: Buffer.from(String(text || ''), 'utf8').toString('base64'),
    branch: branch || 'main'
  };
  if (existing && existing.sha) body.sha = existing.sha;
  const { owner, name } = splitRepo(repo);
  await githubRaw(cfg.token, 'PUT', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/contents/' + encodeURI(path), body);
  let externalId = '';
  if (/\.ya?ml$/i.test(path)) {
    const { data } = await githubRaw(cfg.token, 'GET', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/actions/workflows?per_page=100');
    const hit = (data.workflows || []).find((item) => item.path === path);
    if (hit) externalId = String(hit.id);
  }
  return {
    workflow: path,
    repo: normalizeRepo(repo),
    branch: branch || 'main',
    externalId,
    webUrl: 'https://github.com/' + normalizeRepo(repo) + '/blob/' + encodeURIComponent(branch || 'main') + '/' + path.split('/').map(encodeURIComponent).join('/')
  };
}

async function writeAzureFile(cfg, repositoryName, yamlPath, branch, text) {
  const repo = await findAzureRepo(cfg, repositoryName);
  const target = branch || repo.defaultBranch || cfg.branch || 'main';
  let path = String(yamlPath || '');
  if (!path.startsWith('/')) path = '/' + path;
  if (path.includes('..') || !/^\/[A-Za-z0-9._/-]+\.ya?ml$/.test(path)) {
    fail(400, 'Azure YAML path must look like /concierto/name.yml.');
  }
  const refs = await azureSend(cfg, 'GET', projectPath(cfg, 'git/repositories/' + repo.id + '/refs?filter=' + encodeURIComponent('heads/' + target)));
  const ref = (refs.data.value || []).find((item) => item.name === 'refs/heads/' + target);
  const oldObjectId = ref ? ref.objectId : '0000000000000000000000000000000000000000';
  let exists = false;
  try {
    await azureSend(cfg, 'GET', projectPath(cfg, 'git/repositories/' + repo.id + '/items?path=' + encodeURIComponent(path) + '&versionDescriptor.version=' + encodeURIComponent(target) + '&versionDescriptor.versionType=branch'));
    exists = true;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  await azureSend(cfg, 'POST', projectPath(cfg, 'git/repositories/' + repo.id + '/pushes'), {
    refUpdates: [{ name: 'refs/heads/' + target, oldObjectId }],
    commits: [{
      comment: (exists ? 'Update' : 'Add') + ' pipeline from Concierto CICD',
      changes: [{ changeType: exists ? 'edit' : 'add', item: { path }, newContent: { content: String(text || ''), contentType: 'rawtext' } }]
    }]
  });
  return { workflow: path, repo: repo.name, branch: target };
}

async function saveDefinition(creds, pipeline, text, filePath) {
  if (pipeline.engine === 'Jenkins') {
    const jobName = pipeline.externalId || pipeline.jenkinsJob || pipeline.name;
    let script = text;
    if (Array.isArray(pipeline.parameterDefs)) script = writeJenkinsParameterBlock(script, pipeline.parameterDefs);
    return saveJenkinsScript(creds.jenkins, jobName, script, pipeline.parameterDefs);
  }
  if (pipeline.engine === 'GitHub Actions') {
    const repo = pipeline.repo || pipeline.githubRepo;
    const branch = pipeline.branch || creds.github.branch || 'main';
    const path = filePath || pipeline.workflow;
    return writeGithubFile(creds.github, repo, path, branch, text);
  }
  if (pipeline.engine === 'Azure DevOps') {
    const path = filePath || pipeline.workflow || pipeline.yamlPath;
    return writeAzureFile(creds.azureDevOps, pipeline.repo || pipeline.azureRepo, path, pipeline.branch, text);
  }
  fail(400, 'Choose Jenkins, GitHub Actions, or Azure DevOps.');
}

async function listGithubDir(cfg, repo, dir, branch) {
  const { owner, name } = splitRepo(repo);
  try {
    const { data } = await githubRaw(cfg.token, 'GET', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/contents/' + encodeURI(dir) + '?ref=' + encodeURIComponent(branch || 'main'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

async function listWorkflowFiles(creds, pipeline) {
  if (pipeline.engine === 'Jenkins') {
    const name = pipeline.externalId || pipeline.name || 'Jenkinsfile';
    return [{ path: name, name, folder: '' }];
  }
  if (pipeline.engine === 'Azure DevOps') {
    const path = pipeline.workflow || pipeline.yamlPath || '';
    if (!path) return [];
    return [{ path, name: path.split('/').pop(), folder: path.split('/').slice(0, -1).join('/') }];
  }
  const repo = pipeline.repo || pipeline.githubRepo;
  if (!repo) return [];
  const branch = pipeline.branch || creds.github.branch || 'main';
  const root = await listGithubDir(creds.github, repo, '.github/workflows', branch);
  const files = [];
  for (const item of root) {
    if (item.type === 'dir') {
      const children = await listGithubDir(creds.github, repo, item.path, branch);
      for (const child of children) {
        if (child.type === 'file') files.push({ path: child.path, name: child.name, folder: item.name });
      }
    } else if (item.type === 'file') {
      files.push({ path: item.path, name: item.name, folder: '' });
    }
  }
  return files;
}

async function readWorkflowFile(creds, pipeline, filePath) {
  if (pipeline.engine === 'GitHub Actions') {
    const repo = pipeline.repo || pipeline.githubRepo;
    const branch = pipeline.branch || creds.github.branch || 'main';
    const file = await githubFile(creds.github, repo, filePath, branch);
    if (!file || !file.content) fail(404, 'That file is not on this branch.');
    const text = Buffer.from(String(file.content).replace(/\n/g, ''), 'base64').toString('utf8');
    return { path: filePath, text };
  }
  if (pipeline.engine === 'Azure DevOps') {
    const definition = await fetchDefinition(creds, { ...pipeline, workflow: filePath });
    return { path: filePath, text: definition.text };
  }
  const definition = await fetchDefinition(creds, pipeline);
  return { path: pipeline.externalId || pipeline.name, text: definition.text };
}

function jenkinsStageSpans(text) {
  const spans = [];
  const re = /stage\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/g;
  let match;
  while ((match = re.exec(text))) {
    const braceAt = text.indexOf('{', match.index + match[0].length);
    if (braceAt < 0) continue;
    let depth = 0;
    let end = braceAt;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth += 1;
      else if (text[end] === '}') {
        depth -= 1;
        if (depth === 0) { end += 1; break; }
      }
    }
    spans.push({ name: match[2], start: match.index, end });
    re.lastIndex = end;
  }
  return spans;
}

function filterJenkinsStages(text, keep) {
  const spans = jenkinsStageSpans(text);
  if (!spans.length) return { text, names: [] };
  const names = spans.map((span) => span.name);
  let next = '';
  let cursor = 0;
  for (const span of spans) {
    next += text.slice(cursor, span.start);
    if (keep.includes(span.name)) next += text.slice(span.start, span.end);
    cursor = span.end;
  }
  next += text.slice(cursor);
  const present = new Set(names);
  const missing = keep.filter((name) => !present.has(name));
  if (missing.length) {
    const stubs = missing.map((name) => "    stage('" + name.replace(/'/g, "\\'") + "') {\n      steps {\n        echo '" + name.replace(/'/g, "\\'") + "'\n      }\n    }\n").join('');
    const close = next.lastIndexOf('}');
    next = close >= 0 ? next.slice(0, close) + '\n' + stubs + next.slice(close) : next + '\n' + stubs;
  }
  return { text: next, names: listUnits(next, 'Jenkins') };
}

function stepBlocks(lines, nameKey) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const steps = lines[i].match(/^(\s*)steps:\s*$/);
    if (!steps) { i += 1; continue; }
    const stepsIndent = steps[1].length;
    i += 1;
    while (i < lines.length) {
      const cur = lines[i];
      if (!cur.trim()) { i += 1; continue; }
      const indent = cur.match(/^\s*/)[0].length;
      if (indent <= stepsIndent) break;
      const step = cur.match(/^(\s*)-\s*(.*)$/);
      if (!step || step[1].length <= stepsIndent) { i += 1; continue; }
      const stepIndent = step[1].length;
      const start = i;
      const chunk = [cur];
      i += 1;
      while (i < lines.length) {
        const nxt = lines[i];
        if (!nxt.trim()) { chunk.push(nxt); i += 1; continue; }
        if (nxt.match(/^\s*/)[0].length <= stepIndent) break;
        chunk.push(nxt);
        i += 1;
      }
      const nameLine = chunk.map((line) => line.match(new RegExp('\\b' + nameKey + ':\\s*[\\\'"]?(.+?)[\\\'"]?\\s*$'))).find(Boolean);
      blocks.push({ start, end: i, name: nameLine ? unquote(nameLine[1]) : '', indent: stepIndent });
    }
  }
  return blocks;
}

function filterNamedSteps(text, keep, nameKey, stub) {
  const lines = String(text || '').split(/\r?\n/);
  const blocks = stepBlocks(lines, nameKey);
  const names = blocks.map((block) => block.name).filter(Boolean);
  if (!blocks.length) return { text, names };
  const drop = new Set(blocks.filter((block) => block.name && !keep.includes(block.name)).map((block) => block.start + ':' + block.end));
  const out = [];
  let cursor = 0;
  for (const block of blocks) {
    if (!drop.has(block.start + ':' + block.end)) continue;
    out.push(...lines.slice(cursor, block.start));
    cursor = block.end;
  }
  out.push(...lines.slice(cursor));
  const present = new Set(names);
  const missing = keep.filter((name) => !present.has(name));
  if (missing.length) {
    const stepsAt = out.findIndex((line) => /^(\s*)steps:\s*$/.test(line));
    const indent = stepsAt >= 0 ? out[stepsAt].match(/^\s*/)[0] + '  ' : '      ';
    const extra = missing.map((name) => stub(indent, name));
    if (stepsAt >= 0) out.splice(stepsAt + 1, 0, ...extra);
    else out.push(...extra);
  }
  return { text: out.join('\n'), names: listUnits(out.join('\n'), nameKey === 'displayName' ? 'Azure DevOps' : 'GitHub Actions') };
}

function listUnits(text, engine) {
  if (engine === 'Jenkins') return jenkinsStageSpans(decodeXml(text)).map((span) => span.name);
  const key = engine === 'Azure DevOps' ? 'displayName' : 'name';
  return stepBlocks(String(text || '').split(/\r?\n/), key).map((block) => block.name).filter(Boolean);
}

function keepSelected(text, engine, stages) {
  const keep = (stages || []).map((item) => String(item || '').trim()).filter(Boolean);
  const source = engine === 'Jenkins' ? decodeXml(text) : String(text || '');
  if (!keep.length || !source.trim()) return { text: source, names: listUnits(source, engine) };
  if (engine === 'Jenkins') return filterJenkinsStages(source, keep);
  if (engine === 'Azure DevOps') {
    return filterNamedSteps(source, keep, 'displayName', (indent, name) => indent + '- bash: echo \'' + name.replace(/'/g, '') + '\'\n' + indent + '  displayName: ' + name);
  }
  return filterNamedSteps(source, keep, 'name', (indent, name) => indent + '- name: ' + name + '\n' + indent + '  run: echo \'' + name.replace(/'/g, '') + '\'');
}

async function listBuilds(creds, pipeline) {
  if (pipeline.engine === 'Jenkins') {
    if (!pipeline.externalId) return [];
    const { data } = await jenkinsSend(creds.jenkins, 'GET', jobApiPath(pipeline.externalId) + '/api/json?tree=' + encodeURIComponent('builds[number,result,timestamp,duration,url,building]{0,20}'));
    return asList(data && data.builds).map((build) => ({
      id: String(build.number),
      label: '#' + build.number,
      status: mapJenkinsBuild(build),
      started: build.timestamp || null,
      webUrl: build.url || ''
    }));
  }
  if (pipeline.engine === 'GitHub Actions') {
    const repo = pipeline.repo;
    const { owner, name } = splitRepo(repo);
    const workflowId = pipeline.externalId;
    if (!workflowId) return [];
    const { data } = await githubRaw(creds.github.token, 'GET', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/actions/workflows/' + encodeURIComponent(workflowId) + '/runs?per_page=15');
    return (data.workflow_runs || []).map((run) => ({
      id: String(run.id),
      label: '#' + run.run_number,
      status: mapGithub(run),
      started: Date.parse(run.created_at) || null,
      webUrl: run.html_url || ''
    }));
  }
  if (pipeline.engine === 'Azure DevOps') {
    if (!pipeline.externalId) return [];
    const { data } = await azureSend(creds.azureDevOps, 'GET', projectPath(creds.azureDevOps, 'pipelines/' + encodeURIComponent(pipeline.externalId) + '/runs?$top=15'));
    return (data.value || []).map((run) => ({
      id: String(run.id),
      label: run.name ? String(run.name) : ('#' + run.id),
      status: mapAzure(run),
      started: Date.parse(run.createdDate || '') || null,
      webUrl: (run._links && run._links.web && run._links.web.href) || ''
    }));
  }
  return [];
}

function unzipTexts(buffer) {
  const parts = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.slice(nameStart, nameStart + nameLen).toString('utf8');
    const dataStart = nameStart + nameLen + extraLen;
    const data = buffer.slice(dataStart, dataStart + compSize);
    let text = '';
    try {
      if (method === 0) text = data.toString('utf8');
      else if (method === 8) text = zlib.inflateRawSync(data).toString('utf8');
    } catch { text = ''; }
    if (text && !name.endsWith('/')) parts.push(name + '\n' + text.trim());
    offset = dataStart + compSize;
    if (parts.join('\n').length > 100000) break;
  }
  return parts.join('\n\n');
}

async function githubLog(token, owner, repo, runId) {
  const url = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/actions/runs/' + encodeURIComponent(runId) + '/logs';
  const res = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Concierto-CICD',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000)
  });
  let unpacked = '';
  if (res.ok) unpacked = unzipTexts(Buffer.from(await res.arrayBuffer()));
  if (unpacked) return unpacked;
  const jobs = await githubRaw(token, 'GET', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/actions/runs/' + encodeURIComponent(runId) + '/jobs');
  return jobStepLog(jobs.data);
}

function jobStepLog(data) {
  const lines = [];
  for (const job of (data && data.jobs) || []) {
    lines.push(job.name + ' — ' + (job.conclusion || job.status));
    for (const step of job.steps || []) lines.push('  ' + step.number + '. ' + step.name + ' — ' + (step.conclusion || step.status));
  }
  return lines.join('\n') || 'No log text yet.';
}

async function buildLog(creds, pipeline, buildId) {
  if (pipeline.engine === 'Jenkins') {
    const log = await jenkinsSend(creds.jenkins, 'GET', jobApiPath(pipeline.externalId) + '/' + encodeURIComponent(buildId) + '/consoleText');
    return tail(log.text, 200);
  }
  if (pipeline.engine === 'GitHub Actions') {
    const { owner, name } = splitRepo(pipeline.repo);
    return tail(await githubLog(creds.github.token, owner, name, buildId), 200);
  }
  if (pipeline.engine === 'Azure DevOps') {
    const timeline = await azureSend(creds.azureDevOps, 'GET', projectPath(creds.azureDevOps, 'build/builds/' + encodeURIComponent(buildId) + '/timeline'));
    const lines = (timeline.data.records || [])
      .filter((record) => ['Stage', 'Phase', 'Job', 'Task'].includes(record.type))
      .map((record) => record.type + ': ' + record.name + ' — ' + (record.result || record.state || ''));
    try {
      const logs = await azureSend(creds.azureDevOps, 'GET', projectPath(creds.azureDevOps, 'build/builds/' + encodeURIComponent(buildId) + '/logs'));
      const last = (logs.data.value || []).slice(-1)[0];
      if (last && last.id) {
        const body = await azureSend(creds.azureDevOps, 'GET', projectPath(creds.azureDevOps, 'build/builds/' + encodeURIComponent(buildId) + '/logs/' + last.id));
        const text = typeof body.data === 'string' ? body.data : (body.data.value || body.data.message || JSON.stringify(body.data));
        if (text) lines.push(String(text));
      }
    } catch { /* timeline is still useful */ }
    return lines.join('\n');
  }
  return '';
}

async function abortBuild(creds, pipeline, buildId) {
  if (pipeline.engine === 'Jenkins') {
    await jenkinsSend(creds.jenkins, 'POST', jobApiPath(pipeline.externalId) + '/' + encodeURIComponent(buildId) + '/stop');
    return { ok: true };
  }
  if (pipeline.engine === 'GitHub Actions') {
    const { owner, name } = splitRepo(pipeline.repo);
    await githubRaw(creds.github.token, 'POST', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/actions/runs/' + encodeURIComponent(buildId) + '/cancel');
    return { ok: true };
  }
  if (pipeline.engine === 'Azure DevOps') {
    await azureSend(creds.azureDevOps, 'PATCH', projectPath(creds.azureDevOps, 'build/builds/' + encodeURIComponent(buildId)), { status: 'cancelling' });
    return { ok: true };
  }
  fail(400, 'This engine cannot be stopped from the prototype.');
}

function xmlEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parametersBlockSpan(text) {
  const match = String(text || '').match(/parameters\s*\{/);
  if (!match) return null;
  const brace = text.indexOf('{', match.index);
  let depth = 0;
  let end = brace;
  for (; end < text.length; end++) {
    if (text[end] === '{') depth += 1;
    else if (text[end] === '}') {
      depth -= 1;
      if (depth === 0) { end += 1; break; }
    }
  }
  return { start: match.index, end, body: text.slice(brace + 1, end - 1) };
}

function argValue(args, key) {
  const re = new RegExp(key + "\\s*:\\s*(?:'([^']*)'|\"([^\"]*)\"|(true|false)|([^,\\n]+))", 'i');
  const match = String(args || '').match(re);
  if (!match) return '';
  return String(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim();
}

function argList(args, key) {
  const match = String(args || '').match(new RegExp(key + '\\s*:\\s*\\[([^\\]]*)\\]', 'i'));
  if (!match) return '';
  return match[1].split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).join('\n');
}

function parseJenkinsParameters(text) {
  const decoded = decodeXml(text);
  const span = parametersBlockSpan(decoded);
  if (!span) return [];
  const params = [];
  const re = /(string|text|booleanParam|choice)\s*\(/g;
  let match;
  while ((match = re.exec(span.body))) {
    let depth = 1;
    let index = match.index + match[0].length;
    for (; index < span.body.length && depth; index++) {
      if (span.body[index] === '(') depth += 1;
      else if (span.body[index] === ')') depth -= 1;
    }
    const args = span.body.slice(match.index + match[0].length, index - 1);
    const name = argValue(args, 'name');
    if (!name) continue;
    const type = match[1] === 'booleanParam' ? 'boolean' : match[1] === 'choice' ? 'choice' : match[1] === 'text' ? 'text' : 'string';
    params.push({
      name,
      type,
      defaultValue: type === 'choice' ? '' : argValue(args, 'defaultValue'),
      description: argValue(args, 'description'),
      choices: type === 'choice' ? argList(args, 'choices') : ''
    });
    re.lastIndex = index;
  }
  return params;
}

function writeJenkinsParameterBlock(script, params) {
  const decoded = decodeXml(script);
  const lines = (params || []).filter((item) => item && String(item.name || '').trim()).map((item) => {
    const name = String(item.name).replace(/'/g, "\\'");
    const description = String(item.description || '').replace(/'/g, "\\'");
    const fallback = String(item.defaultValue ?? '').replace(/'/g, "\\'");
    if (item.type === 'boolean') {
      const on = item.defaultValue === true || String(item.defaultValue) === 'true';
      return "    booleanParam(name: '" + name + "', defaultValue: " + on + ", description: '" + description + "')";
    }
    if (item.type === 'choice') {
      const choices = String(item.choices || item.defaultValue || '').split(/\n|,/).map((part) => part.trim()).filter(Boolean);
      const list = choices.map((choice) => "'" + choice.replace(/'/g, "\\'") + "'").join(', ');
      return "    choice(name: '" + name + "', choices: [" + list + "], description: '" + description + "')";
    }
    const call = item.type === 'text' ? 'text' : 'string';
    return "    " + call + "(name: '" + name + "', defaultValue: '" + fallback + "', description: '" + description + "')";
  });
  const block = lines.length ? 'parameters {\n' + lines.join('\n') + '\n  }' : '';
  const span = parametersBlockSpan(decoded);
  if (span) {
    const next = decoded.slice(0, span.start) + block + decoded.slice(span.end);
    return next.replace(/\n{3,}/g, '\n\n');
  }
  if (!block) return decoded;
  const agent = decoded.match(/agent\s+[^\n{]+\{|agent\s+\w+/);
  if (agent) {
    const at = agent.index + agent[0].length;
    return decoded.slice(0, at) + '\n  ' + block + decoded.slice(at);
  }
  const open = decoded.indexOf('{');
  if (open >= 0) return decoded.slice(0, open + 1) + '\n  ' + block + decoded.slice(open + 1);
  return block + '\n' + decoded;
}

function jenkinsParameterProperty(params) {
  const items = (params || []).filter((item) => item && item.name).map((item) => {
    const name = xmlEscape(item.name);
    const description = xmlEscape(item.description || '');
    if (item.type === 'boolean') {
      const on = item.defaultValue === true || String(item.defaultValue) === 'true';
      return '<hudson.model.BooleanParameterDefinition><name>' + name + '</name><description>' + description + '</description><defaultValue>' + on + '</defaultValue></hudson.model.BooleanParameterDefinition>';
    }
    if (item.type === 'text') {
      return '<hudson.model.TextParameterDefinition><name>' + name + '</name><description>' + description + '</description><defaultValue>' + xmlEscape(item.defaultValue || '') + '</defaultValue><trim>false</trim></hudson.model.TextParameterDefinition>';
    }
    if (item.type === 'choice') {
      const choices = String(item.choices || item.defaultValue || '').split(/\n|,/).map((part) => part.trim()).filter(Boolean);
      const strings = choices.map((choice) => '<string>' + xmlEscape(choice) + '</string>').join('');
      return '<hudson.model.ChoiceParameterDefinition><name>' + name + '</name><description>' + description + '</description><choices class="java.util.Arrays$ArrayList"><a class="string-array">' + strings + '</a></choices></hudson.model.ChoiceParameterDefinition>';
    }
    return '<hudson.model.StringParameterDefinition><name>' + name + '</name><description>' + description + '</description><defaultValue>' + xmlEscape(item.defaultValue || '') + '</defaultValue><trim>false</trim></hudson.model.StringParameterDefinition>';
  }).join('');
  if (!items) return '';
  return '<hudson.model.ParametersDefinitionProperty><parameterDefinitions>' + items + '</parameterDefinitions></hudson.model.ParametersDefinitionProperty>';
}

function upsertParameterProperty(xml, params) {
  const block = jenkinsParameterProperty(params);
  const existing = /<hudson\.model\.ParametersDefinitionProperty>[\s\S]*?<\/hudson\.model\.ParametersDefinitionProperty>/;
  if (existing.test(xml)) return xml.replace(existing, block);
  if (!block) return xml;
  if (/<properties\s*\/>/.test(xml)) return xml.replace(/<properties\s*\/>/, '<properties>' + block + '</properties>');
  if (/<properties>/.test(xml)) return xml.replace(/<properties>/, '<properties>' + block);
  return xml;
}

function ensureImagePublish(text, engine, image, shell) {
  const name = String(image || '').trim();
  if (!name) return text;
  const source = String(text || '');
  if (source.includes('docker push') && source.includes(name)) return source;
  if (engine === 'Jenkins') {
    const command = shell === 'sh'
      ? "sh '''\ndocker build -t " + name + ":${BUILD_NUMBER} .\ndocker push " + name + ":${BUILD_NUMBER}\n'''"
      : "bat '''\ndocker build -t " + name + ":%BUILD_NUMBER% .\ndocker push " + name + ":%BUILD_NUMBER%\n'''";
    const stage = "\n    stage('Push image') {\n      steps {\n        " + command + "\n      }\n    }\n";
    const close = source.lastIndexOf('}');
    return close >= 0 ? source.slice(0, close) + stage + source.slice(close) : source + stage;
  }
  if (engine === 'GitHub Actions') {
    return source.replace(/\s*$/, '') + "\n      - name: Build and push image\n        run: |\n          docker build -t " + name + ":${{ github.run_number }} .\n          docker push " + name + ":${{ github.run_number }}\n";
  }
  return source.replace(/\s*$/, '') + "\n- bash: |\n    docker build -t " + name + ":$(Build.BuildId) .\n    docker push " + name + ":$(Build.BuildId)\n  displayName: Build and push image\n";
}

async function publishedArtifacts(creds, pipeline) {
  const out = [];
  try {
    if (pipeline.engine === 'Jenkins' && pipeline.externalId) {
      const { data } = await jenkinsSend(creds.jenkins, 'GET', jobApiPath(pipeline.externalId) + '/api/json?tree=' + encodeURIComponent('builds[number,url,artifacts[fileName,relativePath]]{0,15}'));
      for (const build of asList(data && data.builds)) {
        for (const art of asList(build.artifacts)) {
          out.push({
            key: 'jenkins:' + pipeline.externalId + ':' + build.number + ':' + (art.relativePath || art.fileName),
            name: art.fileName || art.relativePath,
            location: (build.url || '') + 'artifact/' + (art.relativePath || ''),
            build: '#' + build.number,
            kind: 'File',
            pipelineName: pipeline.name,
            engine: 'Jenkins'
          });
        }
      }
    } else if (pipeline.engine === 'GitHub Actions' && pipeline.repo) {
      const { owner, name } = splitRepo(pipeline.repo);
      const { data } = await githubRaw(creds.github.token, 'GET', '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/actions/artifacts?per_page=30');
      for (const art of data.artifacts || []) {
        if (art.expired) continue;
        const runId = art.workflow_run && art.workflow_run.id;
        out.push({
          key: 'github:' + art.id,
          name: art.name,
          location: 'https://github.com/' + normalizeRepo(pipeline.repo) + (runId ? '/actions/runs/' + runId : '/actions'),
          build: art.workflow_run && art.workflow_run.run_number ? '#' + art.workflow_run.run_number : '',
          kind: 'File',
          pipelineName: pipeline.name,
          engine: 'GitHub Actions'
        });
      }
    } else if (pipeline.engine === 'Azure DevOps' && pipeline.externalId) {
      const runs = await azureSend(creds.azureDevOps, 'GET', projectPath(creds.azureDevOps, 'pipelines/' + encodeURIComponent(pipeline.externalId) + '/runs?$top=8'));
      for (const run of (runs.data.value || []).slice(0, 8)) {
        try {
          const arts = await azureSend(creds.azureDevOps, 'GET', projectPath(creds.azureDevOps, 'build/builds/' + encodeURIComponent(run.id) + '/artifacts'));
          for (const art of arts.data.value || []) {
            out.push({
              key: 'azure:' + pipeline.externalId + ':' + run.id + ':' + art.name,
              name: art.name,
              location: (art.resource && art.resource.downloadUrl) || (run._links && run._links.web && run._links.web.href) || '',
              build: '#' + run.id,
              kind: 'File',
              pipelineName: pipeline.name,
              engine: 'Azure DevOps'
            });
          }
        } catch { /* this run has no artifact list */ }
      }
    }
  } catch { /* one pipeline should not block the rest */ }
  return out;
}

module.exports = {
  DEFAULT_STAGES,
  cleanStages,
  slug,
  normalizeRepo,
  normalizeCreds,
  defaultCreds,
  clearCaches,
  buildDefinition,
  testJenkins,
  testGithub,
  testAzure,
  listGithubRepos,
  listAzureRepos,
  jenkinsDrafts,
  githubDrafts,
  githubWorkflowDrafts,
  azureDrafts,
  publish,
  linkRemote,
  trigger,
  refreshRun,
  fetchDefinition,
  deleteRemote,
  readParameters,
  renameJenkins,
  saveDefinition,
  listWorkflowFiles,
  readWorkflowFile,
  listUnits,
  keepSelected,
  listBuilds,
  buildLog,
  abortBuild,
  decodeXml,
  parseJenkinsParameters,
  writeJenkinsParameterBlock,
  ensureImagePublish,
  publishedArtifacts,
  isPagesWorkflow: (name, path) => /pages-build-deployment/i.test(String(name || '') + ' ' + String(path || ''))
};
