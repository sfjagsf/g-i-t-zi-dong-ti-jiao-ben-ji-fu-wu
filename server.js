const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const pinyin = require('tiny-pinyin');

const app = express();
const PORT = 13000;

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

// Helper to run shell commands in cwd safely
function runCommand(cwd, args, token = '') {
  return new Promise((resolve) => {
    const timestamp = new Date().toLocaleTimeString();
    
    // Format command line for logging
    const commandLine = 'git ' + args.map(arg => {
      if (arg.includes(' ') || arg.includes('"') || arg.includes("'")) {
        return `"${arg.replace(/"/g, '\\"')}"`;
      }
      return arg;
    }).join(' ');

    const cmdForLog = maskToken(commandLine, token);
    
    gitCommandLogs.push({
      type: 'command',
      text: `$ ${cmdForLog}`,
      timestamp
    });

    // Cap in-memory logs to prevent memory leaks (Max 500 entries)
    if (gitCommandLogs.length > 500) {
      gitCommandLogs.shift();
    }

    execFile('git', args, { cwd, maxBuffer: 1024 * 1024 * 10, encoding: 'utf8' }, (error, stdout, stderr) => {
      const outText = stdout ? stdout.trim() : '';
      const errText = stderr ? stderr.trim() : '';
      
      const maskedOut = maskToken(outText, token);
      const maskedErr = maskToken(errText, token);

      if (maskedOut) {
        gitCommandLogs.push({ type: 'stdout', text: maskedOut, timestamp });
        if (gitCommandLogs.length > 500) gitCommandLogs.shift();
      }
      if (maskedErr) {
        gitCommandLogs.push({ type: 'stderr', text: maskedErr, timestamp });
        if (gitCommandLogs.length > 500) gitCommandLogs.shift();
      }

      if (error) {
        resolve({
          success: false,
          error: error.message,
          stdout: maskedOut,
          stderr: maskedErr
        });
      } else {
        resolve({
          success: true,
          stdout: maskedOut,
          stderr: maskedErr
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
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  // Check if .git folder exists
  const gitDir = path.join(dirPath, '.git');
  const isRepo = fs.existsSync(gitDir) && fs.lstatSync(gitDir).isDirectory();

  if (!isRepo) {
    return res.json({ success: true, isRepo: false });
  }

  // Get current remote URL
  const config = loadConfig();
  const token = config.githubToken || '';
  
  const remoteResult = await runCommand(dirPath, ['remote', 'get-url', 'origin'], token);
  let remoteUrl = '';
  if (remoteResult.success) {
    remoteUrl = remoteResult.stdout;
  }

  // Get current branch
  const branchResult = await runCommand(dirPath, ['branch', '--show-current'], token);
  let currentBranch = '';
  if (branchResult.success) {
    currentBranch = branchResult.stdout;
  }

  // Check status of changes
  const statusResult = await runCommand(dirPath, ['status', '--porcelain'], token);
  const hasChanges = statusResult.success && statusResult.stdout.length > 0;
  const changesList = statusResult.success ? statusResult.stdout.split('\n').filter(Boolean) : [];

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
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';
  
  if (!remoteUrl) {
    return res.status(400).json({ success: false, error: 'Remote URL is required.' });
  }

  // Clean remoteUrl by removing trailing slashes and adding .git suffix if missing
  let cleanRemoteUrl = remoteUrl.trim();
  while (cleanRemoteUrl.endsWith('/')) {
    cleanRemoteUrl = cleanRemoteUrl.slice(0, -1);
  }
  if (!cleanRemoteUrl.endsWith('.git')) {
    cleanRemoteUrl += '.git';
  }

  // Inject token into Git remote URL if present
  let authRemoteUrl = cleanRemoteUrl;
  if (token) {
    authRemoteUrl = cleanRemoteUrl.replace(/https:\/\/github\.com\//, `https://oauth2:${token}@github.com/`);
  }

  const gitDir = path.join(dirPath, '.git');
  const isRepo = fs.existsSync(gitDir);

  if (!isRepo) {
    const initRes = await runCommand(dirPath, ['init'], token);
    if (!initRes.success) {
      return res.json({ success: false, error: 'Failed to init Git repo: ' + initRes.error });
    }
  }

  const checkRemote = await runCommand(dirPath, ['remote'], token);
  let setRemoteRes;
  if (checkRemote.stdout.includes('origin')) {
    setRemoteRes = await runCommand(dirPath, ['remote', 'set-url', 'origin', authRemoteUrl], token);
  } else {
    setRemoteRes = await runCommand(dirPath, ['remote', 'add', 'origin', authRemoteUrl], token);
  }

  if (!setRemoteRes.success) {
    return res.json({ success: false, error: 'Failed to configure remote: ' + setRemoteRes.error });
  }

  await runCommand(dirPath, ['config', 'user.name', 'GitHub Auto Tool'], token);
  await runCommand(dirPath, ['config', 'user.email', 'autotool@github.com'], token);

  res.json({ success: true });
});

// Fetch and list remote branches (via git ls-remote)
app.post('/api/repo/branches', async (req, res) => {
  const { dirPath } = req.body;
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';

  const lsRes = await runCommand(dirPath, ['ls-remote', '--heads', 'origin'], token);
  if (!lsRes.success) {
    await runCommand(dirPath, ['fetch', 'origin'], token);
    const localTrackingRes = await runCommand(dirPath, ['branch', '-r'], token);
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
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';

  await runCommand(dirPath, ['fetch', 'origin', branch], token);

  const logRes = await runCommand(
    dirPath,
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
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';

  if (!branch) {
    return res.status(400).json({ success: false, error: 'Branch is required.' });
  }
  if (!description) {
    return res.status(400).json({ success: false, error: 'Commit description is required.' });
  }

  const checkBranch = await runCommand(dirPath, ['checkout', '-B', branch], token);
  if (!checkBranch.success) {
    await runCommand(dirPath, ['checkout', branch], token);
  }

  const addRes = await runCommand(dirPath, ['add', '-A'], token);
  if (!addRes.success) {
    return res.json({ success: false, error: 'Failed to stage changes: ' + addRes.error });
  }

  const commitRes = await runCommand(dirPath, ['commit', '-m', description], token);
  if (!commitRes.success && !commitRes.stdout.includes('nothing to commit')) {
    return res.json({ success: false, error: 'Failed to commit: ' + commitRes.error });
  }

  const pushRes = await runCommand(dirPath, ['push', '-f', 'origin', branch], token);
  if (!pushRes.success) {
    return res.json({ success: false, error: 'Failed to push: ' + pushRes.error });
  }

  res.json({ success: true });
});

// Switch branch
app.post('/api/repo/switch', async (req, res) => {
  const { dirPath, branch, force } = req.body;
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';

  const statusRes = await runCommand(dirPath, ['status', '--porcelain'], token);
  const hasChanges = statusRes.success && statusRes.stdout.length > 0;

  if (hasChanges && !force) {
    return res.json({
      success: false,
      hasChanges: true,
      error: 'Uncommitted changes present. Please commit or discard changes before switching.'
    });
  }

  if (force && hasChanges) {
    const hasHeadRes = await runCommand(dirPath, ['rev-parse', '--verify', 'HEAD'], token);
    if (hasHeadRes.success) {
      await runCommand(dirPath, ['reset', '--hard', 'HEAD'], token);
    } else {
      await runCommand(dirPath, ['rm', '-rf', '--cached', '.'], token);
    }
    await runCommand(dirPath, ['clean', '-df'], token);
  }

  await runCommand(dirPath, ['fetch', 'origin', branch], token);

  const checkoutRes = await runCommand(dirPath, ['checkout', '-B', branch, `origin/${branch}`], token);
  if (!checkoutRes.success) {
    const checkoutLocalRes = await runCommand(dirPath, ['checkout', '-B', branch], token);
    if (!checkoutLocalRes.success) {
      return res.json({ success: false, error: 'Failed to switch branch: ' + checkoutRes.error });
    }
  }

  res.json({ success: true });
});

// Create branch
app.post('/api/repo/create-branch', async (req, res) => {
  const { dirPath, newBranchName, fromHash } = req.body;
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';

  if (!newBranchName) {
    return res.status(400).json({ success: false, error: 'New branch name is required.' });
  }

  // Check if HEAD exists (i.e. has commits)
  const revParseRes = await runCommand(dirPath, ['rev-parse', 'HEAD'], token);
  const hasCommits = revParseRes.success;

  if (hasCommits) {
    const checkoutArgs = fromHash 
      ? ['checkout', '-b', newBranchName, fromHash] 
      : ['checkout', '-b', newBranchName];

    // 1. Checkout new branch locally
    const checkoutRes = await runCommand(dirPath, checkoutArgs, token);
    if (!checkoutRes.success) {
      return res.json({ success: false, error: 'Failed to create branch locally: ' + checkoutRes.error });
    }
  } else {
    // Empty repository with no commits
    if (fromHash) {
      return res.json({ success: false, error: 'Cannot create branch from a commit hash in an empty repository.' });
    }
    // Rename current orphan branch reference to the new branch name
    const symRefRes = await runCommand(dirPath, ['symbolic-ref', 'HEAD', `refs/heads/${newBranchName}`], token);
    if (!symRefRes.success) {
      return res.json({ success: false, error: 'Failed to set branch name in empty repo: ' + symRefRes.error });
    }
  }

  // 2. Stage all modifications
  await runCommand(dirPath, ['add', '-A'], token);

  // 3. Commit staged changes (allowing empty commit so it never errors)
  await runCommand(dirPath, ['commit', '--allow-empty', '-m', `Initial commit on branch ${newBranchName}`], token);

  // 4. Push branch to remote
  const pushRes = await runCommand(dirPath, ['push', '-u', 'origin', newBranchName], token);
  if (!pushRes.success) {
    return res.json({ success: false, error: 'Failed to push branch to remote: ' + pushRes.error });
  }

  res.json({ success: true });
});

// Delete remote branch
app.post('/api/repo/delete-branch', async (req, res) => {
  const { dirPath, branchToDelete } = req.body;
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';

  if (!branchToDelete) {
    return res.status(400).json({ success: false, error: 'Branch name is required.' });
  }

  const currentBranchRes = await runCommand(dirPath, ['branch', '--show-current'], token);
  if (currentBranchRes.success && currentBranchRes.stdout.trim() === branchToDelete) {
    const branchesRes = await runCommand(dirPath, ['branch', '-r'], token);
    const alternative = branchesRes.stdout.split('\n')
      .map(b => b.trim().replace(/^origin\//, ''))
      .find(b => b && b !== branchToDelete && !b.includes('HEAD'));
    
    if (alternative) {
      await runCommand(dirPath, ['checkout', alternative], token);
    }
  }

  const deleteRemoteRes = await runCommand(dirPath, ['push', 'origin', '--delete', branchToDelete], token);
  if (!deleteRemoteRes.success) {
    return res.json({ success: false, error: 'Failed to delete remote branch: ' + deleteRemoteRes.error });
  }

  await runCommand(dirPath, ['branch', '-D', branchToDelete], token);
  res.json({ success: true });
});

// Reset branch to commit hash
app.post('/api/repo/reset', async (req, res) => {
  const { dirPath, branch, hash } = req.body;
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';

  if (!branch || !hash) {
    return res.status(400).json({ success: false, error: 'Branch and hash are required.' });
  }

  await runCommand(dirPath, ['checkout', branch], token);

  const resetRes = await runCommand(dirPath, ['reset', '--hard', hash], token);
  if (!resetRes.success) {
    return res.json({ success: false, error: 'Failed to reset local repository: ' + resetRes.error });
  }

  const pushRes = await runCommand(dirPath, ['push', '-f', 'origin', branch], token);
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
    res.json({ success: false, error: apiRes.error });
  }
});

// Bind physical directory to repository and checkout/push target branch
app.post('/api/repo/bind', async (req, res) => {
  const { dirPath, remoteUrl, branch } = req.body;
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ success: false, error: '本地物理路径不存在' });
  }
  if (!remoteUrl || !branch) {
    return res.status(400).json({ success: false, error: '远程仓库地址和分支必填' });
  }

  const config = loadConfig();
  const token = config.githubToken || '';

  // Clean remoteUrl by removing trailing slashes and adding .git suffix if missing
  let cleanRemoteUrl = remoteUrl.trim();
  while (cleanRemoteUrl.endsWith('/')) {
    cleanRemoteUrl = cleanRemoteUrl.slice(0, -1);
  }
  if (!cleanRemoteUrl.endsWith('.git')) {
    cleanRemoteUrl += '.git';
  }

  // Inject token
  let authRemoteUrl = cleanRemoteUrl;
  if (token) {
    authRemoteUrl = cleanRemoteUrl.replace(/https:\/\/github\.com\//, `https://oauth2:${token}@github.com/`);
  }

  const gitDir = path.join(dirPath, '.git');
  const isRepo = fs.existsSync(gitDir) && fs.lstatSync(gitDir).isDirectory();

  // 1. If not a repo, init it
  if (!isRepo) {
    const initRes = await runCommand(dirPath, ['init'], token);
    if (!initRes.success) {
      return res.json({ success: false, error: '初始化 Git 失败: ' + initRes.error });
    }
  }

  // Configure user details
  await runCommand(dirPath, ['config', 'user.name', 'GitHub Auto Tool'], token);
  await runCommand(dirPath, ['config', 'user.email', 'autotool@github.com'], token);

  // 2. Set/update remote URL
  const checkRemote = await runCommand(dirPath, ['remote'], token);
  let setRemoteRes;
  if (checkRemote.stdout.includes('origin')) {
    setRemoteRes = await runCommand(dirPath, ['remote', 'set-url', 'origin', authRemoteUrl], token);
  } else {
    setRemoteRes = await runCommand(dirPath, ['remote', 'add', 'origin', authRemoteUrl], token);
  }

  if (!setRemoteRes.success) {
    return res.json({ success: false, error: '配置 Remote 关联失败: ' + setRemoteRes.error });
  }

  // 3. Fetch from remote
  const fetchRes = await runCommand(dirPath, ['fetch', 'origin', branch], token);

  // 4. Try checking out the target branch
  if (fetchRes.success) {
    // Branch exists remotely. Checkout to it.
    const checkoutRes = await runCommand(dirPath, ['checkout', '-B', branch, `origin/${branch}`], token);
    if (!checkoutRes.success) {
      return res.json({ success: false, error: '切换分支失败: ' + checkoutRes.error });
    }
  } else {
    // Branch does NOT exist remotely. Let's create it locally and push to remote.
    // Check if we already have files in the folder. If so, stage & commit them.
    // If not, commit an empty commit.
    const checkoutNewRes = await runCommand(dirPath, ['checkout', '-B', branch], token);
    if (!checkoutNewRes.success) {
      return res.json({ success: false, error: '本地新建分支失败: ' + checkoutNewRes.error });
    }

    // Check status
    const statusRes = await runCommand(dirPath, ['status', '--porcelain'], token);
    if (statusRes.stdout.length > 0) {
      // Stage & Commit
      await runCommand(dirPath, ['add', '-A'], token);
      await runCommand(dirPath, ['commit', '-m', `Initial commit on new branch ${branch}`], token);
    } else {
      // Empty commit so there's a HEAD history to push
      await runCommand(dirPath, ['commit', '--allow-empty', '-m', `Initial commit on new branch ${branch}`], token);
    }

    // Push it
    const pushNewRes = await runCommand(dirPath, ['push', '-u', 'origin', branch], token);
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
  const absolute = path.resolve(dirPath);
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isDirectory()) {
    return res.json({ success: true, absolutePath: absolute });
  }
  res.json({ success: false, error: 'Directory does not exist' });
});

// Get Git Diff for a specific file (tracked or untracked)
app.post('/api/repo/diff', async (req, res) => {
  const { dirPath, filePath } = req.body;
  if (!dirPath || !filePath) {
    return res.status(400).json({ success: false, error: 'Workspace path and file path are required.' });
  }

  // Check if file is untracked
  const statusRes = await runCommand(dirPath, ['status', '--porcelain', filePath]);
  const statusLine = statusRes.success ? statusRes.stdout.trim() : '';
  const isUntracked = statusLine.startsWith('??');

  let diffRes;
  if (isUntracked) {
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    // git diff --no-index NUL filePath represents the entire untracked file as addition
    diffRes = await runCommand(dirPath, ['diff', '--no-index', nullDevice, filePath]);
  } else {
    const hasHeadRes = await runCommand(dirPath, ['rev-parse', '--verify', 'HEAD']);
    const diffBase = hasHeadRes.success ? 'HEAD' : '4b825dc642cb6eb9a0ff3e07f4618d9157b46363';
    diffRes = await runCommand(dirPath, ['diff', diffBase, '--no-ext-diff', '--', filePath]);
  }

  res.json({
    success: true,
    diff: diffRes.stdout || diffRes.stderr || ''
  });
});

// Generate AI commit message from git diff
app.post('/api/ai/generate-commit', async (req, res) => {
  const { dirPath } = req.body;
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ success: false, error: 'Workspace directory does not exist.' });
  }

  const config = loadConfig();
  let aiUrl = config.aiApiUrl ? config.aiApiUrl.trim() : 'http://localhost:11434/v1/chat/completions';
  
  if (aiUrl && !aiUrl.endsWith('/chat/completions')) {
    aiUrl = aiUrl.replace(/\/+$/, '');
    if (aiUrl.endsWith('/v1')) {
      aiUrl += '/chat/completions';
    } else {
      if (aiUrl.includes('/v1')) {
        aiUrl += '/chat/completions';
      } else {
        aiUrl += '/v1/chat/completions';
      }
    }
  }

  const aiKey = config.aiApiKey || '';
  const aiModel = config.aiModelName || 'deepseek-chat';

  // Check if HEAD exists (handling empty repositories with no initial commits)
  const hasHeadRes = await runCommand(dirPath, ['rev-parse', '--verify', 'HEAD']);
  const diffArgs = hasHeadRes.success
    ? ['diff', 'HEAD', '--no-ext-diff']
    : ['diff', '4b825dc642cb6eb9a0ff3e07f4618d9157b46363', '--no-ext-diff'];

  const diffRes = await runCommand(dirPath, diffArgs);
  const diffText = diffRes.stdout || '';

  if (!diffText.trim()) {
    // If no tracked modifications, check for untracked/unstaged changes
    const statusRes = await runCommand(dirPath, ['status', '--porcelain']);
    if (statusRes.stdout.trim().length === 0) {
      return res.json({ success: false, error: '工作区完全干净，没有任何改动需要提交。' });
    } else {
      return res.json({ success: false, error: '检测到未追踪的全新文件，请先点击文件关联或手动输入描述。' });
    }
  }

  // Construct chat body
  const requestBody = {
    model: aiModel,
    messages: [
      {
        role: 'system',
        content: '你是一个专业的 Git 助手。请根据提供的 Git diff，用中文写一行简明扼要的 Conventional Commits 格式提交说明（例如 "feat: 新增用户登录接口" 或 "fix: 修复日志轮询中的内存泄漏"）。请保持简练，仅返回最终的提交说明文本，不要包含任何 markdown 包裹（如代码块）、额外解释或引号。'
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
      return res.json({ success: false, error: `AI 服务返回错误 (${response.status}): ${errText}` });
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
          return res.json({ success: false, error: `解析 AI 响应失败: ${e.message}。原始响应: ${rawText}` });
        }
      } else {
        return res.json({ success: false, error: `解析 AI 响应失败: ${e.message}。原始响应: ${rawText}` });
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
app.listen(PORT, () => {
  console.log(`GitHub Auto Tool Server listening at http://localhost:${PORT}`);
});
