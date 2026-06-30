const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const pinyin = require('tiny-pinyin');

const app = express();
const PORT = Number(process.env.PORT || 13000);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Tracked config.json is a safe defaults file. Secrets are saved locally only.
const CONFIG_DEFAULT_FILE = path.join(__dirname, 'config.json');
const CONFIG_FILE = process.env.GFLOW_CONFIG_FILE || path.join(__dirname, 'config.local.json');
const SENSITIVE_CONFIG_KEYS = new Set(['githubToken', 'aiApiKey']);

// Memory logs of executed git commands
let gitCommandLogs = [];

function readJsonFile(filePath) {
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

// Helper to load config
function loadConfig() {
  return {
    ...readJsonFile(CONFIG_DEFAULT_FILE),
    ...readJsonFile(CONFIG_FILE)
  };
}

function publicConfig(config) {
  const safeConfig = { ...config };
  for (const key of SENSITIVE_CONFIG_KEYS) {
    safeConfig[key] = '';
  }
  safeConfig.hasGithubToken = !!config.githubToken;
  safeConfig.hasAiApiKey = !!config.aiApiKey;
  return safeConfig;
}

// Helper to save config
function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

// Helper to mask Git URLs containing Token
function maskToken(str, token) {
  if (!token) return str;
  // Replace token occurrences
  let masked = str.split(token).join('******');
  // Also mask standard basic auth formats
  masked = masked.replace(/https:\/\/oauth2:[^@]+@/g, 'https://oauth2:******@');
  masked = masked.replace(/https:\/\/[^:]+:[^@]+@/g, 'https://******:******@');
  return masked;
}

function maskSensitiveLog(str, token = '') {
  if (!str) return '';
  let masked = maskToken(str, token);
  masked = masked.replace(/\bghp_[A-Za-z0-9_]{20,}\b/g, 'ghp_******');
  masked = masked.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_******');
  masked = masked.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-******');
  masked = masked.replace(/(BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY)[\s\S]*?(END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY)/g, '$1 ****** $2');
  masked = masked.replace(/\b(apiKey|api_key|aiApiKey|githubToken|token|password|secret)\b(["']?\s*[:=]\s*["'])([^"'\s,;]{12,})(["'])/gi, '$1$2******$4');
  return masked;
}

function buildGitEnv(token = '') {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never'
  };

  if (token) {
    const basicAuth = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basicAuth}`;
  }

  return env;
}

function resolveExistingDirectory(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return null;
  const absolute = path.resolve(dirPath.trim());
  try {
    return fs.existsSync(absolute) && fs.lstatSync(absolute).isDirectory() ? absolute : null;
  } catch (err) {
    return null;
  }
}

function isSafeRelativePathspec(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) return false;
  if (path.isAbsolute(filePath)) return false;
  return !filePath.split(/[\\/]+/).includes('..');
}

function normalizeRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || !remoteUrl.trim()) return '';
  let cleanRemoteUrl = remoteUrl.trim();
  while (cleanRemoteUrl.endsWith('/')) {
    cleanRemoteUrl = cleanRemoteUrl.slice(0, -1);
  }
  if (!cleanRemoteUrl.endsWith('.git')) {
    cleanRemoteUrl += '.git';
  }
  return cleanRemoteUrl;
}

async function isGitRepository(cwd, token = '') {
  const result = await runCommand(cwd, ['rev-parse', '--is-inside-work-tree'], token);
  return result.success && result.stdout.trim() === 'true';
}

function remoteListHasOrigin(remoteOutput) {
  return remoteOutput.split('\n').map(remote => remote.trim()).includes('origin');
}

function parseGitStatusPorcelainZ(output) {
  if (!output) return [];

  const parts = output.split('\0');
  const changes = [];

  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i];
    if (!record) continue;

    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!filePath) continue;

    const change = {
      status,
      indexStatus: status[0],
      worktreeStatus: status[1],
      path: filePath
    };

    if (status[0] === 'R' || status[0] === 'C') {
      i += 1;
      if (parts[i]) {
        change.oldPath = parts[i];
      }
    }

    changes.push(change);
  }

  return changes;
}

async function localBranchExists(cwd, branch, token = '') {
  const result = await runCommand(cwd, ['show-ref', '--verify', `refs/heads/${branch}`], token);
  return result.success;
}

async function remoteBranchExists(cwd, branch, token = '') {
  const result = await runCommand(cwd, ['show-ref', '--verify', `refs/remotes/origin/${branch}`], token);
  return result.success;
}

async function checkoutBranchPreservingLocal(cwd, branch, token = '') {
  if (await localBranchExists(cwd, branch, token)) {
    return runCommand(cwd, ['checkout', branch], token);
  }

  if (await remoteBranchExists(cwd, branch, token)) {
    return runCommand(cwd, ['checkout', '--track', '-b', branch, `origin/${branch}`], token);
  }

  return { success: false, error: 'Branch not found locally or on origin.' };
}

async function checkoutOrCreateLocalBranch(cwd, branch, token = '') {
  if (await localBranchExists(cwd, branch, token)) {
    return runCommand(cwd, ['checkout', branch], token);
  }

  const hasHeadRes = await runCommand(cwd, ['rev-parse', '--verify', 'HEAD'], token);
  if (hasHeadRes.success) {
    return runCommand(cwd, ['checkout', '-b', branch], token);
  }

  return runCommand(cwd, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], token);
}

async function validateBranchName(cwd, branch, token = '') {
  if (typeof branch !== 'string' || !branch.trim() || branch !== branch.trim() || branch.startsWith('-')) {
    return { success: false, error: 'Invalid branch name.' };
  }
  const result = await runCommand(cwd, ['check-ref-format', '--branch', branch], token);
  if (!result.success) {
    return { success: false, error: `Invalid branch name: ${branch}` };
  }
  return { success: true };
}

async function validateCommitRef(cwd, ref, token = '') {
  if (typeof ref !== 'string' || !ref.trim() || ref !== ref.trim() || ref.startsWith('-')) {
    return { success: false, error: 'Invalid commit reference.' };
  }
  const result = await runCommand(cwd, ['cat-file', '-e', `${ref}^{commit}`], token);
  if (!result.success) {
    return { success: false, error: `Commit reference was not found: ${ref}` };
  }
  return { success: true };
}

async function getDiffIncludingUntracked(cwd, token = '', maxChars = 20000, options = {}) {
  const diffCommandOptions = {
    logOutput: false,
    ...options
  };
  const hasHeadRes = await runCommand(cwd, ['rev-parse', '--verify', 'HEAD'], token);
  const diffArgs = hasHeadRes.success
    ? ['diff', 'HEAD', '--no-ext-diff']
    : ['diff', '4b825dc642cb6eb9a0ff3e07f4618d9157b46363', '--no-ext-diff'];

  const diffRes = await runCommand(cwd, diffArgs, token, diffCommandOptions);
  const diffParts = [];
  if (diffRes.stdout) {
    diffParts.push(diffRes.stdout);
  }

  const untrackedRes = await runCommand(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], token, { trimOutput: false });
  const untrackedFiles = untrackedRes.success
    ? untrackedRes.stdout.split('\0').filter(Boolean)
    : [];

  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  for (const file of untrackedFiles) {
    if (!isSafeRelativePathspec(file)) continue;
    const fileDiffRes = await runCommand(cwd, ['diff', '--no-index', '--', nullDevice, file], token, diffCommandOptions);
    const fileDiff = fileDiffRes.stdout || fileDiffRes.stderr || '';
    if (fileDiff) {
      diffParts.push(fileDiff);
    }
    if (diffParts.join('\n').length >= maxChars) break;
  }

  const combinedDiff = diffParts.join('\n');
  return combinedDiff.length > maxChars ? combinedDiff.slice(0, maxChars) : combinedDiff;
}

// Helper to run shell commands in cwd safely
function runCommand(cwd, args, token = '', options = {}) {
  return new Promise((resolve) => {
    const timestamp = new Date().toLocaleTimeString();
    const logCommand = options.logCommand !== false;
    const logOutput = options.logOutput !== false;
    const returnRawOutput = options.returnRawOutput === true;
    
    // Format command line for logging
    const commandLine = 'git ' + args.map(arg => {
      const value = String(arg);
      if (value.includes(' ') || value.includes('"') || value.includes("'")) {
        return `"${value.replace(/"/g, '\\"')}"`;
      }
      return value;
    }).join(' ');

    const cmdForLog = maskSensitiveLog(commandLine, token);
    
    if (logCommand) {
      gitCommandLogs.push({
        type: 'command',
        text: `$ ${cmdForLog}`,
        timestamp
      });

      // Cap in-memory logs to prevent memory leaks (Max 500 entries)
      if (gitCommandLogs.length > 500) {
        gitCommandLogs.shift();
      }
    }

    execFile('git', args, {
      cwd,
      env: buildGitEnv(token),
      maxBuffer: options.maxBuffer || 1024 * 1024 * 10,
      timeout: 60000,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      const trimOutput = options.trimOutput !== false;
      const outText = stdout ? (trimOutput ? stdout.trim() : stdout) : '';
      const errText = stderr ? (trimOutput ? stderr.trim() : stderr) : '';
      
      const maskedOut = maskSensitiveLog(outText, token);
      const maskedErr = maskSensitiveLog(errText, token);

      if (logOutput && maskedOut) {
        gitCommandLogs.push({ type: 'stdout', text: maskedOut, timestamp });
        if (gitCommandLogs.length > 500) gitCommandLogs.shift();
      }
      if (logOutput && maskedErr) {
        gitCommandLogs.push({ type: 'stderr', text: maskedErr, timestamp });
        if (gitCommandLogs.length > 500) gitCommandLogs.shift();
      }

      const returnedStdout = returnRawOutput ? outText : maskedOut;
      const returnedStderr = returnRawOutput ? errText : maskedErr;

      if (error) {
        resolve({
          success: false,
          error: error.message,
          stdout: returnedStdout,
          stderr: returnedStderr
        });
      } else {
        resolve({
          success: true,
          stdout: returnedStdout,
          stderr: returnedStderr
        });
      }
    });
  });
}

// Native Node fetch Helper for GitHub API Calls (Supported natively in Node.js v24)
async function callGithubApi(method, apiPath, body, token) {
  try {
    const url = `https://api.github.com${apiPath}`;
    const options = {
      method: method,
      headers: {
        'User-Agent': 'GFlow-Codex-App',
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    let jsonRes;
    try {
      const dataText = await res.text();
      jsonRes = dataText ? JSON.parse(dataText) : {};
    } catch (e) {
      jsonRes = {};
    }

    if (res.ok) {
      return { success: true, statusCode: res.status, data: jsonRes };
    } else {
      return { success: false, statusCode: res.status, error: jsonRes.message || 'GitHub API 发生错误' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function normalizeChatCompletionsUrl(rawUrl) {
  const defaultUrl = 'http://localhost:11434/v1/chat/completions';
  const value = typeof rawUrl === 'string' && rawUrl.trim() ? rawUrl.trim() : defaultUrl;
  const trimmed = value.replace(/\/+$/, '');
  const lower = trimmed.toLowerCase();

  if (lower.endsWith('/chat/completions')) {
    return trimmed;
  }
  if (lower.endsWith('/v1')) {
    return `${trimmed}/chat/completions`;
  }
  if (lower.includes('/v1/')) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

// Get config
app.get('/api/config', (req, res) => {
  res.json(publicConfig(loadConfig()));
});

// Update config
app.post('/api/config', (req, res) => {
  const current = loadConfig();
  const incoming = req.body || {};
  const updated = { ...current };
  const allowedFields = [
    'githubToken',
    'username',
    'avatarUrl',
    'aiApiUrl',
    'aiApiKey',
    'aiModelName',
    'lastProjectPath',
    'recentPaths'
  ];

  for (const field of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field)) continue;
    const value = incoming[field];
    if (SENSITIVE_CONFIG_KEYS.has(field) && typeof value === 'string' && value.includes('*')) {
      continue;
    }
    updated[field] = value;
  }

  saveConfig(updated);
  res.json({ success: true, config: publicConfig(updated) });
});

// Get Git commands logs (supporting incremental polling with offset)
app.get('/api/git-logs', (req, res) => {
  const offset = parseInt(req.query.offset, 10) || 0;
  const slicedLogs = gitCommandLogs.slice(offset);
  res.json({
    success: true,
    logs: slicedLogs,
    nextOffset: gitCommandLogs.length
  });
});

// Clear Git commands logs
app.post('/api/git-logs/clear', (req, res) => {
  gitCommandLogs = [];
  res.json({ success: true });
});

// Verify git installation & Check if directory is git repo
app.post('/api/repo/status', async (req, res) => {
  const { dirPath } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';
  const isRepo = await isGitRepository(safeDir, token);

  if (!isRepo) {
    return res.json({ success: true, isRepo: false });
  }

  // Get current remote URL
  const remoteResult = await runCommand(safeDir, ['remote', 'get-url', 'origin'], token);
  let remoteUrl = '';
  if (remoteResult.success) {
    remoteUrl = remoteResult.stdout;
  }

  // Get current branch
  const branchResult = await runCommand(safeDir, ['branch', '--show-current'], token);
  let currentBranch = '';
  if (branchResult.success) {
    currentBranch = branchResult.stdout;
  }

  // Check status of changes
  const statusResult = await runCommand(safeDir, ['status', '--porcelain=v1', '-z'], token, { trimOutput: false });
  const changesList = statusResult.success ? parseGitStatusPorcelainZ(statusResult.stdout) : [];
  const hasChanges = changesList.length > 0;

  res.json({
    success: true,
    isRepo: true,
    remoteUrl,
    currentBranch,
    hasChanges,
    changesList
  });
});

// Initialize Git Repository & Link remote
app.post('/api/repo/init', async (req, res) => {
  const { dirPath, remoteUrl } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';
  
  if (!remoteUrl) {
    return res.status(400).json({ success: false, error: 'Remote URL is required.' });
  }

  const cleanRemoteUrl = normalizeRemoteUrl(remoteUrl);

  const isRepo = await isGitRepository(safeDir, token);

  if (!isRepo) {
    const initRes = await runCommand(safeDir, ['init'], token);
    if (!initRes.success) {
      return res.json({ success: false, error: 'Failed to init Git repo: ' + initRes.error });
    }
  }

  const checkRemote = await runCommand(safeDir, ['remote'], token);
  let setRemoteRes;
  if (remoteListHasOrigin(checkRemote.stdout)) {
    setRemoteRes = await runCommand(safeDir, ['remote', 'set-url', 'origin', cleanRemoteUrl], token);
  } else {
    setRemoteRes = await runCommand(safeDir, ['remote', 'add', 'origin', cleanRemoteUrl], token);
  }

  if (!setRemoteRes.success) {
    return res.json({ success: false, error: 'Failed to configure remote: ' + setRemoteRes.error });
  }

  await runCommand(safeDir, ['config', 'user.name', 'GitHub Auto Tool'], token);
  await runCommand(safeDir, ['config', 'user.email', 'autotool@github.com'], token);

  res.json({ success: true });
});

// Fetch and list remote branches (via git ls-remote)
app.post('/api/repo/branches', async (req, res) => {
  const { dirPath } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';

  const lsRes = await runCommand(safeDir, ['ls-remote', '--heads', 'origin'], token);
  if (!lsRes.success) {
    await runCommand(safeDir, ['fetch', 'origin'], token);
    const localTrackingRes = await runCommand(safeDir, ['branch', '-r'], token);
    if (!localTrackingRes.success) {
      return res.json({ success: false, error: 'Failed to retrieve branches: ' + lsRes.error });
    }
    const branches = localTrackingRes.stdout.split('\n')
      .map(b => b.trim().replace(/^origin\//, ''))
      .filter(b => b && !b.includes('HEAD ->'));
    return res.json({ success: true, branches });
  }

  const branches = lsRes.stdout.split('\n')
    .map(line => {
      const match = line.match(/refs\/heads\/(.+)$/);
      return match ? match[1] : null;
    })
    .filter(Boolean);

  res.json({ success: true, branches });
});

// Fetch commit history of a branch with --graph
app.post('/api/repo/history', async (req, res) => {
  const { dirPath, branch } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';
  const branchValidation = await validateBranchName(safeDir, branch, token);
  if (!branchValidation.success) {
    return res.status(400).json({ success: false, error: branchValidation.error });
  }

  await runCommand(safeDir, ['fetch', 'origin', branch], token);

  const logRes = await runCommand(
    safeDir,
    ['log', `origin/${branch}`, '--graph', '--pretty=format:%h|%an|%ar|%s', '-n', '50'],
    token
  );

  if (!logRes.success) {
    return res.json({ success: true, commits: [] });
  }

  const commits = logRes.stdout.split('\n')
    .filter(Boolean)
    .map(line => {
      // Matches standard graph + commit lines, e.g. "* 1a2b3c4|author|date|message" or "* | 1a2b3c4|author|date|message"
      const match = line.match(/^([*|/\\_\s-]*)\s*([a-f0-9]{7,40})\|([^|]+)\|([^|]+)\|(.+)$/i);
      if (match) {
        const [, graphSymbols, hash, author, date, message] = match;
        return { hash, author, date, message, graphSymbols };
      } else {
        // Line represents graph structure only (e.g. "| /")
        return { hash: '', author: '', date: '', message: '', graphSymbols: line };
      }
    });

  res.json({ success: true, commits });
});

// Commit and Force Push
app.post('/api/repo/commit', async (req, res) => {
  const { dirPath, branch, description } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';

  if (!branch) {
    return res.status(400).json({ success: false, error: 'Branch is required.' });
  }
  if (typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ success: false, error: 'Commit description is required.' });
  }

  const branchValidation = await validateBranchName(safeDir, branch, token);
  if (!branchValidation.success) {
    return res.status(400).json({ success: false, error: branchValidation.error });
  }

  const currentBranchRes = await runCommand(safeDir, ['branch', '--show-current'], token);
  if (!currentBranchRes.success || !currentBranchRes.stdout.trim()) {
    return res.json({ success: false, error: '无法确认当前分支，请刷新仓库状态后重试。' });
  }
  if (currentBranchRes.stdout.trim() !== branch) {
    return res.json({ success: false, error: `当前工作区分支是 [${currentBranchRes.stdout.trim()}]，不是页面选中的 [${branch}]。请刷新后重试。` });
  }

  const addRes = await runCommand(safeDir, ['add', '-A'], token);
  if (!addRes.success) {
    return res.json({ success: false, error: 'Failed to stage changes: ' + addRes.error });
  }

  const commitRes = await runCommand(safeDir, ['commit', '-m', description], token);
  if (!commitRes.success && !commitRes.stdout.includes('nothing to commit')) {
    return res.json({ success: false, error: 'Failed to commit: ' + commitRes.error });
  }

  const pushRes = await runCommand(safeDir, ['push', '--force-with-lease', 'origin', branch], token);
  if (!pushRes.success) {
    return res.json({ success: false, error: 'Failed to push: ' + pushRes.error });
  }

  res.json({ success: true });
});

// Switch branch
app.post('/api/repo/switch', async (req, res) => {
  const { dirPath, branch, force } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';
  const branchValidation = await validateBranchName(safeDir, branch, token);
  if (!branchValidation.success) {
    return res.status(400).json({ success: false, error: branchValidation.error });
  }

  const statusRes = await runCommand(safeDir, ['status', '--porcelain'], token);
  const hasChanges = statusRes.success && statusRes.stdout.length > 0;

  if (hasChanges && !force) {
    return res.json({
      success: false,
      hasChanges: true,
      error: 'Uncommitted changes present. Please commit or discard changes before switching.'
    });
  }

  if (force && hasChanges) {
    const hasHeadRes = await runCommand(safeDir, ['rev-parse', '--verify', 'HEAD'], token);
    if (!hasHeadRes.success) {
      return res.json({
        success: false,
        error: 'Cannot safely switch branches in an empty repository with uncommitted changes.'
      });
    }
    const stashRes = await runCommand(safeDir, ['stash', 'push', '-u', '-m', `GFlow backup before switching to ${branch}`], token);
    if (!stashRes.success) {
      return res.json({ success: false, error: 'Failed to back up local changes before switching: ' + stashRes.error });
    }
  }

  await runCommand(safeDir, ['fetch', 'origin', branch], token);

  const checkoutRes = await checkoutBranchPreservingLocal(safeDir, branch, token);
  if (!checkoutRes.success) {
    return res.json({ success: false, error: 'Failed to switch branch: ' + checkoutRes.error });
  }

  res.json({ success: true });
});

// Create branch
app.post('/api/repo/create-branch', async (req, res) => {
  const { dirPath, newBranchName, fromHash } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';

  if (!newBranchName) {
    return res.status(400).json({ success: false, error: 'New branch name is required.' });
  }

  const branchValidation = await validateBranchName(safeDir, newBranchName, token);
  if (!branchValidation.success) {
    return res.status(400).json({ success: false, error: branchValidation.error });
  }

  // Check if HEAD exists (i.e. has commits)
  const revParseRes = await runCommand(safeDir, ['rev-parse', 'HEAD'], token);
  const hasCommits = revParseRes.success;

  if (hasCommits) {
    if (fromHash) {
      const commitValidation = await validateCommitRef(safeDir, fromHash, token);
      if (!commitValidation.success) {
        return res.status(400).json({ success: false, error: commitValidation.error });
      }
    }
    const checkoutArgs = fromHash 
      ? ['checkout', '-b', newBranchName, fromHash] 
      : ['checkout', '-b', newBranchName];

    // 1. Checkout new branch locally
    const checkoutRes = await runCommand(safeDir, checkoutArgs, token);
    if (!checkoutRes.success) {
      return res.json({ success: false, error: 'Failed to create branch locally: ' + checkoutRes.error });
    }
  } else {
    // Empty repository with no commits
    if (fromHash) {
      return res.json({ success: false, error: 'Cannot create branch from a commit hash in an empty repository.' });
    }
    // Rename current orphan branch reference to the new branch name
    const symRefRes = await runCommand(safeDir, ['symbolic-ref', 'HEAD', `refs/heads/${newBranchName}`], token);
    if (!symRefRes.success) {
      return res.json({ success: false, error: 'Failed to set branch name in empty repo: ' + symRefRes.error });
    }
  }

  // 2. Stage all modifications
  await runCommand(safeDir, ['add', '-A'], token);

  // 3. Commit staged changes (allowing empty commit so it never errors)
  await runCommand(safeDir, ['commit', '--allow-empty', '-m', `Initial commit on branch ${newBranchName}`], token);

  // 4. Push branch to remote
  const pushRes = await runCommand(safeDir, ['push', '-u', 'origin', newBranchName], token);
  if (!pushRes.success) {
    return res.json({ success: false, error: 'Failed to push branch to remote: ' + pushRes.error });
  }

  res.json({ success: true });
});

// Delete remote branch
app.post('/api/repo/delete-branch', async (req, res) => {
  const { dirPath, branchToDelete } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';

  if (!branchToDelete) {
    return res.status(400).json({ success: false, error: 'Branch name is required.' });
  }

  const branchValidation = await validateBranchName(safeDir, branchToDelete, token);
  if (!branchValidation.success) {
    return res.status(400).json({ success: false, error: branchValidation.error });
  }

  const currentBranchRes = await runCommand(safeDir, ['branch', '--show-current'], token);
  if (currentBranchRes.success && currentBranchRes.stdout.trim() === branchToDelete) {
    const branchesRes = await runCommand(safeDir, ['branch', '-r'], token);
    const alternative = branchesRes.stdout.split('\n')
      .map(b => b.trim().replace(/^origin\//, ''))
      .find(b => b && b !== branchToDelete && !b.includes('HEAD'));
    
    if (alternative) {
      const checkoutAlternativeRes = await runCommand(safeDir, ['checkout', alternative], token);
      if (!checkoutAlternativeRes.success) {
        return res.json({ success: false, error: 'Failed to switch away from branch before deletion: ' + checkoutAlternativeRes.error });
      }
    } else {
      return res.json({ success: false, error: 'Cannot delete the currently checked out branch because no alternative branch exists.' });
    }
  }

  const deleteRemoteRes = await runCommand(safeDir, ['push', 'origin', '--delete', branchToDelete], token);
  if (!deleteRemoteRes.success) {
    return res.json({ success: false, error: 'Failed to delete remote branch: ' + deleteRemoteRes.error });
  }

  const deleteLocalRes = await runCommand(safeDir, ['branch', '-D', branchToDelete], token);
  if (!deleteLocalRes.success && !deleteLocalRes.stderr.includes('not found')) {
    return res.json({ success: false, error: 'Failed to delete local branch after remote deletion: ' + deleteLocalRes.error });
  }
  res.json({ success: true });
});

// Reset branch to commit hash
app.post('/api/repo/reset', async (req, res) => {
  const { dirPath, branch, hash } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';

  if (!branch || !hash) {
    return res.status(400).json({ success: false, error: 'Branch and hash are required.' });
  }

  const branchValidation = await validateBranchName(safeDir, branch, token);
  if (!branchValidation.success) {
    return res.status(400).json({ success: false, error: branchValidation.error });
  }
  const commitValidation = await validateCommitRef(safeDir, hash, token);
  if (!commitValidation.success) {
    return res.status(400).json({ success: false, error: commitValidation.error });
  }

  const checkoutRes = await runCommand(safeDir, ['checkout', branch], token);
  if (!checkoutRes.success) {
    return res.json({ success: false, error: 'Failed to checkout branch before reset: ' + checkoutRes.error });
  }

  const resetRes = await runCommand(safeDir, ['reset', '--hard', hash], token);
  if (!resetRes.success) {
    return res.json({ success: false, error: 'Failed to reset local repository: ' + resetRes.error });
  }

  const pushRes = await runCommand(safeDir, ['push', '--force-with-lease', 'origin', branch], token);
  if (!pushRes.success) {
    return res.json({ success: false, error: 'Failed to push reset state to remote: ' + pushRes.error });
  }

  res.json({ success: true });
});

// --- NEW GITHUB API PROXY ENDPOINTS ---

// Fetch user repositories
app.get('/api/github/repos', async (req, res) => {
  const config = loadConfig();
  const token = config.githubToken;
  if (!token) {
    return res.json({ success: false, error: 'GitHub 账号未登录，请先在右上角配置 Token' });
  }

  // Fetch up to 100 repositories, sorted by last updated
  const apiRes = await callGithubApi('GET', '/user/repos?sort=updated&per_page=100', null, token);
  if (apiRes.success) {
    const repos = apiRes.data.map(repo => ({
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner.login,
      private: repo.private,
      htmlUrl: repo.html_url,
      defaultBranch: repo.default_branch,
      description: repo.description // Return description
    }));
    res.json({ success: true, repos });
  } else {
    res.json({ success: false, error: apiRes.error });
  }
});

function pinyinize(str) {
  if (pinyin.isSupported()) {
    return pinyin.convertToPinyin(str, '-', true)
      .toLowerCase()
      .replace(/[^a-zA-Z0-9_\-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }
  // Fallback if not supported
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (/[a-zA-Z0-9_\-]/.test(char)) {
      result += char;
    } else if (char.trim() === '') {
      result += '-';
    } else {
      const hex = char.charCodeAt(0).toString(16);
      result += (result ? '-' : '') + 'u' + hex;
    }
  }
  return result.toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// Create repository
app.post('/api/github/repos/create', async (req, res) => {
  const config = loadConfig();
  const token = config.githubToken;
  if (!token) {
    return res.json({ success: false, error: 'GitHub 账号未登录，请先在右上角配置 Token' });
  }

  const { name, isPrivate, autoInit } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, error: '仓库名称不能为空' });
  }

  const safeName = pinyinize(name);

  const body = {
    name: safeName,
    private: !!isPrivate,
    auto_init: !!autoInit,
    description: name // Store original Chinese name in description
  };

  const apiRes = await callGithubApi('POST', '/user/repos', body, token);
  if (apiRes.success) {
    res.json({
      success: true,
      repo: {
        name: apiRes.data.name,
        fullName: apiRes.data.full_name,
        htmlUrl: apiRes.data.html_url,
        defaultBranch: apiRes.data.default_branch,
        description: apiRes.data.description
      }
    });
  } else {
    res.json({ success: false, error: apiRes.error });
  }
});

// Delete repository
app.post('/api/github/repos/delete', async (req, res) => {
  const config = loadConfig();
  const token = config.githubToken;
  if (!token) {
    return res.json({ success: false, error: 'GitHub 账号未登录，请先在右上角配置 Token' });
  }

  const { owner, repo } = req.body;
  if (!owner || !repo) {
    return res.status(400).json({ success: false, error: '参数所有者和仓库名均不能为空' });
  }

  const apiRes = await callGithubApi('DELETE', `/repos/${owner}/${repo}`, null, token);
  if (apiRes.success) {
    res.json({ success: true });
  } else {
    res.json({ success: false, error: apiRes.error });
  }
});

// Get branches for a specific repository from GitHub API
app.post('/api/github/repos/branches', async (req, res) => {
  const config = loadConfig();
  const token = config.githubToken;
  if (!token) {
    return res.json({ success: false, error: 'GitHub 账号未登录' });
  }

  const { owner, repo } = req.body;
  if (!owner || !repo) {
    return res.status(400).json({ success: false, error: '所有者 and 仓库名必填' });
  }

  const apiRes = await callGithubApi('GET', `/repos/${owner}/${repo}/branches?per_page=100`, null, token);
  if (apiRes.success) {
    const branches = apiRes.data.map(b => b.name);
    res.json({ success: true, branches });
  } else {
    res.json({ success: false, statusCode: apiRes.statusCode, error: apiRes.error });
  }
});

// Bind physical directory to repository and checkout/push target branch
app.post('/api/repo/bind', async (req, res) => {
  const { dirPath, remoteUrl, branch } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return res.status(400).json({ success: false, error: '本地物理路径不存在' });
  }
  if (!remoteUrl || !branch) {
    return res.status(400).json({ success: false, error: '远程仓库地址和分支必填' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';
  const branchValidation = await validateBranchName(safeDir, branch, token);
  if (!branchValidation.success) {
    return res.status(400).json({ success: false, error: branchValidation.error });
  }

  const cleanRemoteUrl = normalizeRemoteUrl(remoteUrl);

  const isRepo = await isGitRepository(safeDir, token);

  // 1. If not a repo, init it
  if (!isRepo) {
    const initRes = await runCommand(safeDir, ['init'], token);
    if (!initRes.success) {
      return res.json({ success: false, error: '初始化 Git 失败: ' + initRes.error });
    }
  }

  // Configure user details
  await runCommand(safeDir, ['config', 'user.name', 'GitHub Auto Tool'], token);
  await runCommand(safeDir, ['config', 'user.email', 'autotool@github.com'], token);

  // 2. Set/update remote URL
  const checkRemote = await runCommand(safeDir, ['remote'], token);
  let setRemoteRes;
  if (remoteListHasOrigin(checkRemote.stdout)) {
    setRemoteRes = await runCommand(safeDir, ['remote', 'set-url', 'origin', cleanRemoteUrl], token);
  } else {
    setRemoteRes = await runCommand(safeDir, ['remote', 'add', 'origin', cleanRemoteUrl], token);
  }

  if (!setRemoteRes.success) {
    return res.json({ success: false, error: '配置 Remote 关联失败: ' + setRemoteRes.error });
  }

  // 3. Fetch from remote
  const fetchRes = await runCommand(safeDir, ['fetch', 'origin', branch], token);

  // 4. Try checking out the target branch
  if (fetchRes.success && await remoteBranchExists(safeDir, branch, token)) {
    // Branch exists remotely. Checkout to it without resetting an existing local branch.
    const checkoutRes = await checkoutBranchPreservingLocal(safeDir, branch, token);
    if (!checkoutRes.success) {
      return res.json({ success: false, error: '切换分支失败: ' + checkoutRes.error });
    }
  } else if (!fetchRes.success && !fetchRes.error.includes('couldn\'t find remote ref')) {
    return res.json({ success: false, error: '拉取远程分支失败: ' + fetchRes.error });
  } else {
    // Branch does NOT exist remotely. Let's create it locally and push to remote.
    // Check if we already have files in the folder. If so, stage & commit them.
    // If not, commit an empty commit.
    const checkoutNewRes = await checkoutOrCreateLocalBranch(safeDir, branch, token);
    if (!checkoutNewRes.success) {
      return res.json({ success: false, error: '本地新建分支失败: ' + checkoutNewRes.error });
    }

    // Check status
    const statusRes = await runCommand(safeDir, ['status', '--porcelain'], token);
    if (statusRes.stdout.length > 0) {
      // Stage & Commit
      await runCommand(safeDir, ['add', '-A'], token);
      await runCommand(safeDir, ['commit', '-m', `Initial commit on new branch ${branch}`], token);
    } else {
      // Empty commit so there's a HEAD history to push
      await runCommand(safeDir, ['commit', '--allow-empty', '-m', `Initial commit on new branch ${branch}`], token);
    }

    // Push it
    const pushNewRes = await runCommand(safeDir, ['push', '-u', 'origin', branch], token);
    if (!pushNewRes.success) {
      return res.json({ success: false, error: '推送新分支到远程失败: ' + pushNewRes.error });
    }
  }

  res.json({ success: true });
});

// FS path validator
app.post('/api/fs/validate-path', (req, res) => {
  const { dirPath } = req.body;
  if (!dirPath) {
    return res.json({ success: false, error: 'Path is required' });
  }
  const absolute = resolveExistingDirectory(dirPath);
  if (!absolute) {
    return res.json({ success: false, error: 'Directory does not exist' });
  }
  res.json({ success: true, absolutePath: absolute });
});

// Get Git Diff for a specific file (tracked or untracked)
app.post('/api/repo/diff', async (req, res) => {
  const { dirPath, filePath, oldPath } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir || !filePath) {
    return res.status(400).json({ success: false, error: 'Workspace path and file path are required.' });
  }
  if (!isSafeRelativePathspec(filePath)) {
    return res.status(400).json({ success: false, error: 'File path must be a repository-relative path.' });
  }
  if (oldPath && !isSafeRelativePathspec(oldPath)) {
    return res.status(400).json({ success: false, error: 'Old file path must be a repository-relative path.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';

  // Check if file is untracked
  const statusRes = await runCommand(safeDir, ['status', '--porcelain=v1', '-z', '--', filePath], token, { trimOutput: false });
  const statusEntries = statusRes.success ? parseGitStatusPorcelainZ(statusRes.stdout) : [];
  const statusEntry = statusEntries.find(entry => entry.path === filePath || entry.oldPath === filePath);
  const isUntracked = statusEntry && statusEntry.status === '??';
  const diffPaths = oldPath ? [oldPath, filePath] : [filePath];

  let diffRes;
  if (isUntracked) {
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    // git diff --no-index NUL filePath represents the entire untracked file as addition
    diffRes = await runCommand(safeDir, ['diff', '--no-index', '--', nullDevice, filePath], token, { logOutput: false });
  } else {
    const hasHeadRes = await runCommand(safeDir, ['rev-parse', '--verify', 'HEAD'], token);
    const diffBase = hasHeadRes.success ? 'HEAD' : '4b825dc642cb6eb9a0ff3e07f4618d9157b46363';
    diffRes = await runCommand(safeDir, ['diff', diffBase, '--no-ext-diff', '--', ...diffPaths], token, { logOutput: false });
  }

  res.json({
    success: true,
    diff: diffRes.stdout || diffRes.stderr || ''
  });
});

// Generate AI commit message from git diff
app.post('/api/ai/generate-commit', async (req, res) => {
  const { dirPath } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return res.status(400).json({ success: false, error: 'Workspace directory does not exist.' });
  }

  const config = loadConfig();
  const aiUrl = normalizeChatCompletionsUrl(config.aiApiUrl);

  const aiKey = config.aiApiKey || '';
  const aiModel = config.aiModelName || 'deepseek-chat';
  const token = config.githubToken || '';

  const diffText = await getDiffIncludingUntracked(safeDir, token);

  if (!diffText.trim()) {
    // If no tracked modifications, check for untracked/unstaged changes
    const statusRes = await runCommand(safeDir, ['status', '--porcelain=v1', '-z'], token, { trimOutput: false });
    if (parseGitStatusPorcelainZ(statusRes.stdout).length === 0) {
      return res.json({ success: false, error: '工作区完全干净，没有任何改动需要提交。' });
    } else {
      return res.json({ success: false, error: '检测到改动，但未能生成有效 diff。请手动输入描述。' });
    }
  }

  // Construct chat body
  const requestBody = {
    model: aiModel,
    messages: [
      {
        role: 'system',
        content: '你是一个专业的 Git 助手。请根据提供的 Git diff，用中文写一行简明扼要的提交说明。不要使用 feat、fix、chore 等英文前缀，不要使用英文标题。请仅返回最终的中文提交说明文本，不要包含 markdown、额外解释或引号。'
      },
      {
        role: 'user',
        content: diffText.substring(0, 20000) // limit to avoid token limits
      }
    ],
    temperature: 0.2
  };

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (aiKey) {
      headers['Authorization'] = `Bearer ${aiKey}`;
    }

    const response = await fetch(aiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.json({ success: false, error: `AI 服务返回错误 (${response.status}): ${maskSensitiveLog(errText, token)}` });
    }

    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      const lastBraceIndex = rawText.lastIndexOf('}');
      if (lastBraceIndex !== -1) {
        try {
          data = JSON.parse(rawText.substring(0, lastBraceIndex + 1));
        } catch (innerErr) {
          return res.json({ success: false, error: `解析 AI 响应失败: ${e.message}。原始响应: ${maskSensitiveLog(rawText, token)}` });
        }
      } else {
        return res.json({ success: false, error: `解析 AI 响应失败: ${e.message}。原始响应: ${maskSensitiveLog(rawText, token)}` });
      }
    }
    const aiMessage = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content.trim()
      : '';

    if (!aiMessage) {
      return res.json({ success: false, error: 'AI 服务未返回有效的描述内容，请检查接口配置。' });
    }

    // Clean up typical AI wrappers if present
    const cleanMessage = aiMessage.replace(/^["'`\s]+|["'`\s]+$/g, '');
    res.json({ success: true, commitMessage: cleanMessage });
  } catch (err) {
    let errMsg = `AI 服务请求异常: ${err.message}`;
    if (err.message && err.message.includes('fetch failed')) {
      if (aiUrl.includes('localhost') || aiUrl.includes('127.0.0.1')) {
        errMsg = `AI 服务请求异常 (fetch failed): 无法连接到本地 AI 服务。请确保您的 Ollama 已经在本地启动（默认端口 11434），或者在右上角「设置」中配置您使用的云端 AI 服务（例如 DeepSeek、SiliconFlow 等）的 API 地址、API Key 和模型名称。`;
      } else {
        errMsg = `AI 服务请求异常 (fetch failed): 无法连接到 AI 服务地址 (${aiUrl})。请检查右上角「设置」中的 API Endpoint URL 是否填写正确，并确保您的网络连接或代理设置正常。`;
      }
    }
    res.json({ success: false, error: errMsg });
  }
});

// Fetch latest GitHub Actions workflow runs for repository
app.post('/api/github/actions/runs', async (req, res) => {
  const config = loadConfig();
  const token = config.githubToken;
  if (!token) {
    return res.json({ success: false, error: 'GitHub Token 未关联，请在设置中配置' });
  }

  const { owner, repo } = req.body;
  if (!owner || !repo) {
    return res.status(400).json({ success: false, error: '所有者和仓库名必填' });
  }

  const apiRes = await callGithubApi('GET', `/repos/${owner}/${repo}/actions/runs?per_page=20`, null, token);
  if (apiRes.success) {
    res.json({ success: true, runs: apiRes.data.workflow_runs || [] });
  } else {
    res.json({ success: false, error: apiRes.error });
  }
});

// Start server
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`GitHub Auto Tool Server listening at http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，服务未启动。`);
    console.error(`请先关闭已有服务，或使用其他端口启动，例如：$env:PORT=13001; npm start`);
    process.exit(1);
  }

  throw err;
});


