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
const APP_ROOT = path.resolve(__dirname);
const SENSITIVE_CONFIG_KEYS = new Set(['githubToken', 'aiApiKey']);
const PROTECTED_PROJECT_PATH_ERROR = '已阻止操作工具自身目录。请链接真实项目目录，不要把 GFlow 工具安装目录作为目标仓库。';

// Memory logs of executed git commands
const MAX_GIT_COMMAND_LOGS = 500;
const MAX_GIT_LOG_ENTRY_CHARS = 32 * 1024;
const GITHUB_API_TIMEOUT_MS = 8000;
// History is read from the already-fetched origin/<branch> ref on a normal
// page reload. Refreshing that ref more often adds several seconds to startup
// on large repositories without helping most users.
const REMOTE_HISTORY_FETCH_TTL_MS = 5 * 60 * 1000;
const GITHUB_REPO_LIST_CACHE_TTL_MS = 2 * 60 * 1000;
const AI_REQUEST_TIMEOUT_MS = 60000;
const AI_REQUEST_MAX_ATTEMPTS = 2;
const AI_EMPTY_RESPONSE_MAX_ATTEMPTS = 2;
const MAX_AI_STATUS_ITEMS = 200;
const MAX_AI_TRACKED_DIFF_FILES = 40;
const MAX_AI_UNTRACKED_DIFF_FILES = 10;
let gitCommandLogs = [];
let gitCommandLogSeq = 0;
let gitCommandRunSeq = 0;
const remoteHistoryFetches = new Map();
const activeRepositoryMutations = new Map();
let githubRepoListCache = { token: '', repos: [], updatedAt: 0 };
const REPOSITORY_MUTATION_ROUTES = new Set([
  '/api/repo/init',
  '/api/repo/commit',
  '/api/repo/switch',
  '/api/repo/create-branch',
  '/api/repo/delete-branch',
  '/api/repo/reset',
  '/api/repo/bind'
]);

// Git serializes index and ref updates per repository. Keep that serialization
// visible at the API boundary so concurrent UI clicks cannot race each other.
app.use((req, res, next) => {
  if (req.method !== 'POST' || !REPOSITORY_MUTATION_ROUTES.has(req.path)) return next();
  const safeDir = resolveExistingDirectory(req.body && req.body.dirPath);
  if (!safeDir) return next();

  const key = repositoryOperationKey(safeDir);
  const existing = activeRepositoryMutations.get(key);
  if (existing) {
    return res.status(409).json({
      success: false,
      busy: true,
      operation: existing.operation,
      error: `仓库正在执行 ${existing.operation} 操作，请等待完成后再继续。`
    });
  }

  const marker = { operation: req.path.replace('/api/repo/', ''), startedAt: Date.now() };
  activeRepositoryMutations.set(key, marker);
  req.repositoryMutation = { key, marker };
  res.once('finish', () => {
    if (activeRepositoryMutations.get(key) === marker) {
      activeRepositoryMutations.delete(key);
    }
  });
  next();
});

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
  safeConfig.lastProjectPath = sanitizeConfiguredProjectPath(config.lastProjectPath);
  safeConfig.recentPaths = sanitizeConfiguredRecentPaths(config.recentPaths);
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
    GCM_INTERACTIVE: 'never'
  };

  const gitConfig = [
    // Keep backend git commands non-interactive; otherwise Git Credential Manager
    // may open a GitHub account picker from the local browser session.
    ['credential.helper', '']
  ];

  if (token) {
    const basicAuth = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    gitConfig.push(['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basicAuth}`]);
  }

  env.GIT_CONFIG_COUNT = String(gitConfig.length);
  gitConfig.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });

  return env;
}

function appendGitCommandLog(type, text, timestamp) {
  const rawText = String(text || '');
  const boundedText = rawText.length > MAX_GIT_LOG_ENTRY_CHARS
    ? `${rawText.slice(0, 20 * 1024)}\n... [日志过长，已省略 ${rawText.length - MAX_GIT_LOG_ENTRY_CHARS} 个字符] ...\n${rawText.slice(-12 * 1024)}`
    : rawText;

  gitCommandLogs.push({
    id: ++gitCommandLogSeq,
    type,
    text: boundedText,
    timestamp
  });

  while (gitCommandLogs.length > MAX_GIT_COMMAND_LOGS) {
    gitCommandLogs.shift();
  }
}

function prefixGitLogOutput(commandId, text) {
  return String(text)
    .split(/\r?\n/)
    .map(line => `[git:${commandId}] ${line}`)
    .join('\n');
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

function sameDirectory(left, right) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/, '');
  const leftPath = normalize(left);
  const rightPath = normalize(right);
  return process.platform === 'win32'
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

function isSameOrInsideDirectory(candidate, parent) {
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const candidatePath = normalize(candidate);
  const parentPath = normalize(parent);
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function isProtectedProjectDirectory(dirPath) {
  return isSameOrInsideDirectory(dirPath, APP_ROOT);
}

function protectedProjectStatus(safeDir) {
  return {
    success: true,
    isRepo: false,
    protectedPath: true,
    protectedRoot: APP_ROOT,
    selectedPath: safeDir,
    error: PROTECTED_PROJECT_PATH_ERROR
  };
}

function rejectProtectedProjectDirectory(res, safeDir) {
  if (!isProtectedProjectDirectory(safeDir)) return false;
  res.status(400).json({
    success: false,
    protectedPath: true,
    protectedRoot: APP_ROOT,
    selectedPath: safeDir,
    error: PROTECTED_PROJECT_PATH_ERROR
  });
  return true;
}

function sanitizeConfiguredProjectPath(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const safeDir = resolveExistingDirectory(value);
  if (safeDir && isProtectedProjectDirectory(safeDir)) return '';
  return value;
}

function sanitizeConfiguredRecentPaths(paths) {
  if (!Array.isArray(paths)) return [];
  const seen = new Set();
  const cleanPaths = [];
  for (const entry of paths) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const safeDir = resolveExistingDirectory(entry);
    if (safeDir && isProtectedProjectDirectory(safeDir)) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    cleanPaths.push(entry);
  }
  return cleanPaths.slice(0, 10);
}

function hasOwnGitMarker(cwd) {
  return fs.existsSync(path.join(cwd, '.git'));
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

function parseGithubFullName(fullName) {
  if (typeof fullName !== 'string' || !fullName.trim()) return null;
  const match = fullName.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    fullName: `${match[1]}/${match[2]}`
  };
}

function parseGithubRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || !remoteUrl.trim()) return null;
  const raw = remoteUrl.trim().replace(/[?#].*$/, '').replace(/[\\/]+$/, '');
  const sshMatch = raw.match(/^(?:[^@\s]+@)?github\.com:([^\/\s]+)\/([^\/\s]+?)(?:\.git)?$/i);

  if (sshMatch) {
    return parseGithubFullName(`${sshMatch[1]}/${sshMatch[2]}`);
  }

  try {
    const parsedUrl = new URL(raw);
    if (parsedUrl.hostname.toLowerCase() !== 'github.com') return null;

    const parts = parsedUrl.pathname
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean);

    if (parts.length !== 2) return null;
    const owner = decodeURIComponent(parts[0]);
    const repo = decodeURIComponent(parts[1]).replace(/\.git$/i, '');
    return parseGithubFullName(`${owner}/${repo}`);
  } catch (err) {
    return null;
  }
}

function sameGithubRepository(left, right) {
  return !!left && !!right && left.fullName.toLowerCase() === right.fullName.toLowerCase();
}

async function getGitRepositoryRoot(cwd, token = '') {
  const result = await runCommand(cwd, ['rev-parse', '--show-toplevel'], token);
  return result.success ? path.resolve(result.stdout.trim()) : '';
}

async function isGitRepository(cwd, token = '') {
  if (!hasOwnGitMarker(cwd)) {
    return false;
  }

  const repoRoot = await getGitRepositoryRoot(cwd, token);
  return !!repoRoot && sameDirectory(repoRoot, cwd);
}

async function resolveOwnGitRepository(dirPath, token = '') {
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return { success: false, statusCode: 400, error: 'Directory does not exist.' };
  }

  if (isProtectedProjectDirectory(safeDir)) {
    return {
      success: false,
      statusCode: 400,
      error: PROTECTED_PROJECT_PATH_ERROR,
      protectedPath: true,
      protectedRoot: APP_ROOT
    };
  }

  if (await isGitRepository(safeDir, token)) {
    return { success: true, safeDir };
  }

  const parentRepoRoot = await getGitRepositoryRoot(safeDir, token);
  if (parentRepoRoot && !sameDirectory(parentRepoRoot, safeDir)) {
    return {
      success: false,
      statusCode: 400,
      error: `Selected directory is inside another Git repository (${parentRepoRoot}). Please initialize or select the exact repository root.`
    };
  }

  return {
    success: false,
    statusCode: 400,
    error: 'Selected directory is not an initialized Git repository.'
  };
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

const STM32_BUILD_OUTPUT_IGNORE_RULES = [
  '# GFlow: STM32/CubeIDE generated build output',
  '/Debug/',
  '/Release/',
  '*.elf',
  '*.hex',
  '*.bin',
  '*.map',
  '*.list',
  '*.o',
  '*.d',
  '*.su',
  '*.cyclo'
];

function isStm32CubeIdeProject(cwd) {
  if (
    fs.existsSync(path.join(cwd, '.cproject')) ||
    fs.existsSync(path.join(cwd, 'Debug')) ||
    fs.existsSync(path.join(cwd, 'Release'))
  ) return true;

  try {
    return fs.readdirSync(cwd, { withFileTypes: true })
      .some(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.ioc'));
  } catch (err) {
    return false;
  }
}

function ensureGitignoreRules(cwd, rules) {
  const gitignorePath = path.join(cwd, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const existingLines = new Set(existing.split(/\r?\n/).map(line => line.trim()));
  const missingRules = rules.filter(rule => !existingLines.has(rule));

  if (missingRules.length === 0) return false;

  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  const separator = existing ? '\n' : '';
  fs.writeFileSync(gitignorePath, `${existing}${prefix}${separator}${missingRules.join('\n')}\n`, 'utf8');
  return true;
}

async function prepareStm32BuildOutputsForCommit(cwd, token = '') {
  if (!isStm32CubeIdeProject(cwd)) {
    return { success: true, applied: false, gitignoreUpdated: false, removedTrackedBuildFiles: 0 };
  }

  const gitignoreUpdated = ensureGitignoreRules(cwd, STM32_BUILD_OUTPUT_IGNORE_RULES);
  const trackedRes = await runCommand(cwd, ['ls-files', '-z', '--', 'Debug', 'Release'], token, {
    logOutput: false,
    trimOutput: false
  });
  const trackedBuildFiles = trackedRes.success
    ? trackedRes.stdout.split('\0').filter(Boolean)
    : [];

  if (trackedBuildFiles.length > 0) {
    const untrackRes = await runCommand(cwd, ['rm', '-r', '--cached', '--ignore-unmatch', '--', 'Debug', 'Release'], token);
    if (!untrackRes.success) {
      return { success: false, error: 'Failed to remove tracked build output: ' + untrackRes.error };
    }
  }

  return {
    success: true,
    applied: true,
    gitignoreUpdated,
    removedTrackedBuildFiles: trackedBuildFiles.length
  };
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

/**
 * Check if a file should be ignored when generating AI diffs (to save tokens)
 */
function shouldIgnoreFileForAi(filePath) {
  if (!filePath || typeof filePath !== 'string') return true;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const filename = normalized.split('/').pop();

  if (isSensitiveFileForAi(filePath)) return true;

  // 1. Lock files
  const lockFiles = [
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    'cargo.lock',
    'composer.lock',
    'gemfile.lock',
    'poetry.lock'
  ];
  if (lockFiles.includes(filename)) return true;

  // 2. Build & dist directories
  const buildDirs = [
    'dist/',
    'build/',
    'out/',
    'node_modules/',
    '.next/',
    '.nuxt/',
    'target/',
    'bin/',
    'obj/',
    '.vuepress/dist/',
    'public/build/'
  ];
  if (buildDirs.some(dir => normalized.includes(dir))) return true;

  // 3. Ext / Pattern ignores (logs, maps, minified files, binary & media assets)
  const ignoredExts = [
    '.log', '.map', '.min.js', '.min.css',
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.avif',
    '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z',
    '.mp3', '.mp4', '.avi', '.mov', '.webm',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.exe', '.dll', '.so', '.dylib', '.pyc', '.class'
  ];
  if (ignoredExts.some(ext => filename.endsWith(ext))) return true;

  return false;
}

function isSensitiveFileForAi(filePath) {
  if (!filePath || typeof filePath !== 'string') return true;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const filename = normalized.split('/').pop() || '';
  const sensitiveNames = [
    'config.local.json', 'credentials.json', 'credential.json', 'secrets.json',
    'secret.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'
  ];
  const sensitiveExtensions = ['.pem', '.key', '.p12', '.pfx', '.crt', '.cer', '.der', '.jks', '.kdb'];
  const sensitiveDirectory = /(^|\/)(?:\.ssh|\.aws|\.gnupg|private|secrets?)(?:\/|$)/.test(normalized);
  const environmentFile = filename === '.env' || filename.startsWith('.env.');
  const credentialLikeName = /(?:^|[._-])(api[_-]?key|token|password|passwd|secret|credential)(?:[._-]|$)/.test(filename);

  return sensitiveDirectory || environmentFile || sensitiveNames.includes(filename) ||
    sensitiveExtensions.some(ext => filename.endsWith(ext)) || credentialLikeName;
}

/**
 * Generates a token-optimized condensed git diff summary for AI commit message generation.
 * Structure:
 * 1. [文件变更清单概览] (git status summary)
 * 2. [核心代码变更] (Filtered diff with only +/- change lines, limited per file and total)
 */
async function getCondensedDiffForAi(cwd, token = '', maxTotalChars = 4000) {
  const diffCommandOptions = {
    logOutput: false,
    maxBuffer: 512 * 1024,
    timeoutMs: 15000
  };

  // 1. Get status list
  const statusRes = await runCommand(cwd, ['status', '--porcelain=v1', '-z'], token, {
    trimOutput: false,
    logOutput: false,
    timeoutMs: 20000
  });
  if (!statusRes.success) {
    return {
      success: false,
      error: statusRes.error && statusRes.error.includes('timed out')
        ? '扫描改动超过 20 秒，请检查是否存在大量未忽略文件。'
        : `读取 Git 改动失败: ${statusRes.error}`
    };
  }
  const statusItems = parseGitStatusPorcelainZ(statusRes.stdout);
  
  if (statusItems.length === 0) {
    return { success: false, empty: true, error: '工作区完全干净，没有任何改动需要提交。' };
  }

  // Filter out ignored files for detailed diff, but note them in summary
  const validFiles = [];
  const ignoredFiles = [];

  for (const item of statusItems) {
    const filePath = item.path || item.oldPath;
    if (filePath) {
      if (shouldIgnoreFileForAi(filePath)) {
        ignoredFiles.push(filePath);
      } else {
        validFiles.push(item);
      }
    }
  }

  // Build Summary Header
  const summaryLines = ['【文件变更清单概览】'];
  for (const item of statusItems.slice(0, MAX_AI_STATUS_ITEMS)) {
    const isSensitive = isSensitiveFileForAi(item.path);
    const isIgnored = shouldIgnoreFileForAi(item.path);
    const tag = isSensitive
      ? ' (敏感文件，名称和内容均未发送)'
      : (isIgnored ? ' (依赖/大文件/构建产物，已自动忽略增删细节)' : '');
    const displayStatus = (item.status || '  ').trim() || 'modified';
    summaryLines.push(`- [${displayStatus}] ${isSensitive ? '[已隐藏敏感文件]' : item.path}${tag}`);
  }
  if (statusItems.length > MAX_AI_STATUS_ITEMS) {
    summaryLines.push(`- ... 另有 ${statusItems.length - MAX_AI_STATUS_ITEMS} 个文件未展开`);
  }

  // Fetch diff for tracked files
  const hasHeadRes = await runCommand(cwd, ['rev-parse', '--verify', 'HEAD'], token, diffCommandOptions);
  const diffBase = hasHeadRes.success ? 'HEAD' : '4b825dc642cb6eb9a0ff3e07f4618d9157b46363';
  
  const trackedPaths = validFiles
    .filter(item => item.status !== '??')
    .flatMap(item => [item.oldPath, item.path])
    .filter(isSafeRelativePathspec)
    .slice(0, MAX_AI_TRACKED_DIFF_FILES);
  const trackedDiffRes = trackedPaths.length > 0
    ? await runCommand(
        cwd,
        ['diff', diffBase, '--no-ext-diff', '-U1', '--', ...trackedPaths],
        token,
        diffCommandOptions
      )
    : { stdout: '' };
  const rawDiff = trackedDiffRes.stdout || '';

  // Also process untracked non-ignored files
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const untrackedDiffParts = [];
  let untrackedFileCount = 0;
  let collectedUntrackedChars = 0;
  for (const item of validFiles) {
    if (item.status === '??' && isSafeRelativePathspec(item.path)) {
      if (untrackedFileCount >= MAX_AI_UNTRACKED_DIFF_FILES || collectedUntrackedChars >= maxTotalChars * 2) {
        break;
      }
      untrackedFileCount += 1;
      const fileDiffRes = await runCommand(cwd, ['diff', '--no-index', '-U1', '--', nullDevice, item.path], token, diffCommandOptions);
      if (fileDiffRes.stdout) {
        const boundedDiff = fileDiffRes.stdout.slice(0, maxTotalChars);
        untrackedDiffParts.push(boundedDiff);
        collectedUntrackedChars += boundedDiff.length;
      }
    }
  }

  const allRawDiffs = [rawDiff, ...untrackedDiffParts].filter(Boolean).join('\n');

  // Parse diff into condensed per-file blocks
  const condensedDiffBlocks = [];
  let currentFile = '';
  let currentFileLines = [];
  const MAX_FILE_CHARS = 800; // max chars per single file diff

  const flushFileBlock = () => {
    if (currentFile && currentFileLines.length > 0) {
      const blockText = `--- File: ${currentFile} ---\n` + currentFileLines.join('\n');
      condensedDiffBlocks.push(blockText.length > MAX_FILE_CHARS ? blockText.slice(0, MAX_FILE_CHARS) + '\n... (较长变更已截断)' : blockText);
    }
  };

  const diffLines = allRawDiffs.split('\n');
  for (const line of diffLines) {
    if (line.startsWith('diff --git')) {
      flushFileBlock();
      currentFile = '';
      currentFileLines = [];
      const match = line.match(/b\/(.+)$/);
      if (match) {
        currentFile = match[1];
      }
    } else if (line.startsWith('--- a/') || line.startsWith('+++ b/')) {
      if (!currentFile) {
        const match = line.match(/\/[b|a]\/(.+)$/);
        if (match) currentFile = match[1];
      }
    } else if (line.startsWith('+') || line.startsWith('-')) {
      // Ignore header indicators like +++ or ---
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      
      // If the current file should be ignored, skip lines
      if (currentFile && shouldIgnoreFileForAi(currentFile)) continue;
      
      // Keep modified line
      currentFileLines.push(line);
    }
  }
  flushFileBlock();

  // Combine summary + condensed diffs
  let outputText = summaryLines.join('\n');
  if (condensedDiffBlocks.length > 0) {
    outputText += '\n\n【核心代码变更】\n' + condensedDiffBlocks.join('\n\n');
  } else if (ignoredFiles.length > 0) {
    outputText += '\n\n注意：变动文件均为依赖锁或构建文件，变动细节已被精简。';
  }

  // Overall truncation limit
  if (outputText.length > maxTotalChars) {
    outputText = outputText.slice(0, maxTotalChars) + '\n... (超出字符限制已智能截断)';
  }

  return { success: true, empty: false, diffText: outputText };
}

// Helper to run shell commands in cwd safely
function runCommand(cwd, args, token = '', options = {}) {
  return new Promise((resolve) => {
    const timestamp = new Date().toLocaleTimeString();
    const commandId = ++gitCommandRunSeq;
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
      appendGitCommandLog('command', `$ [git:${commandId}] ${cmdForLog}`, timestamp);
    }

    execFile('git', args, {
      cwd,
      env: buildGitEnv(token),
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 10,
      timeout: options.timeoutMs ?? 60000,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      const trimOutput = options.trimOutput !== false;
      const outText = stdout ? (trimOutput ? stdout.trim() : stdout) : '';
      const errText = stderr ? (trimOutput ? stderr.trim() : stderr) : '';
      
      const maskedOut = maskSensitiveLog(outText, token);
      const maskedErr = maskSensitiveLog(errText, token);

      if (logOutput && maskedOut) {
        appendGitCommandLog('stdout', prefixGitLogOutput(commandId, maskedOut), timestamp);
      }
      if (logOutput && maskedErr) {
        appendGitCommandLog('stderr', prefixGitLogOutput(commandId, maskedErr), timestamp);
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

function repositoryOperationKey(dirPath) {
  const resolved = path.resolve(dirPath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function fetchRemoteHistory(cwd, branch, token = '') {
  const pathKey = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  const cacheKey = `${pathKey}\0${branch}`;
  const cached = remoteHistoryFetches.get(cacheKey);

  if (cached && cached.promise) {
    return cached.promise;
  }
  if (cached && Date.now() - cached.updatedAt < REMOTE_HISTORY_FETCH_TTL_MS) {
    return { success: true, cached: true };
  }

  const promise = runCommand(
    cwd,
    ['fetch', '--quiet', '--no-tags', 'origin', branch],
    token,
    { logOutput: false, timeoutMs: 30000 }
  );
  remoteHistoryFetches.set(cacheKey, { updatedAt: cached?.updatedAt || 0, promise });

  const result = await promise;
  if (result.success) {
    remoteHistoryFetches.set(cacheKey, { updatedAt: Date.now(), promise: null });
  } else {
    remoteHistoryFetches.delete(cacheKey);
  }
  return result;
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
      },
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS)
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
    let error;
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      error = `GitHub API 请求超过 ${GITHUB_API_TIMEOUT_MS / 1000} 秒，已取消`;
    } else if (err && err.message && err.message.includes('fetch failed')) {
      error = '无法连接 GitHub API（fetch failed）。请检查网络、代理或 VPN；本地 Git 远程可用不代表 Node.js API 请求已走同一代理。';
    } else {
      error = err && err.message ? err.message : 'GitHub API 请求失败';
    }
    return { success: false, error };
  }
}

async function getAuthenticatedGithubLogin(token) {
  if (!token) {
    return { success: false, statusCode: 401, error: 'GitHub Token 未关联，请先在右上角配置 Token。' };
  }

  const apiRes = await callGithubApi('GET', '/user', null, token);
  if (!apiRes.success) {
    return {
      success: false,
      statusCode: apiRes.statusCode || 502,
      error: `无法确认当前 GitHub Token 所属账号: ${apiRes.error}`
    };
  }

  const login = apiRes.data && apiRes.data.login;
  if (typeof login !== 'string' || !login.trim()) {
    return { success: false, statusCode: 502, error: 'GitHub API 未返回当前 Token 所属账号。' };
  }

  return { success: true, login: login.trim() };
}

async function validateGithubWriteTarget({ cwd, remoteUrl, expectedFullName = '', token }) {
  let targetRemoteUrl = remoteUrl;

  if (!targetRemoteUrl && cwd) {
    const remoteResult = await runCommand(cwd, ['remote', 'get-url', 'origin'], token);
    if (!remoteResult.success) {
      return {
        success: false,
        statusCode: 400,
        error: '无法读取当前仓库 origin，已阻止远程写入。请先绑定自己的 GitHub 仓库。'
      };
    }
    targetRemoteUrl = remoteResult.stdout;
  }

  const targetRepo = parseGithubRemoteUrl(targetRemoteUrl);
  if (!targetRepo) {
    return {
      success: false,
      statusCode: 400,
      error: `origin 不是有效的 GitHub 仓库地址，已阻止远程写入: ${maskSensitiveLog(targetRemoteUrl || '', token)}`
    };
  }

  if (expectedFullName) {
    const expectedRepo = parseGithubFullName(expectedFullName);
    if (!expectedRepo) {
      return { success: false, statusCode: 400, error: '页面传入的目标仓库标识无效，已阻止远程写入。' };
    }
    if (!sameGithubRepository(targetRepo, expectedRepo)) {
      return {
        success: false,
        statusCode: 409,
        error: `当前 origin 指向 [${targetRepo.fullName}]，但页面选中的仓库是 [${expectedRepo.fullName}]。请刷新状态或重新绑定后再提交。`
      };
    }
  }

  const loginResult = await getAuthenticatedGithubLogin(token);
  if (!loginResult.success) return loginResult;

  if (targetRepo.owner.toLowerCase() !== loginResult.login.toLowerCase()) {
    return {
      success: false,
      statusCode: 403,
      error: `已阻止写入仓库 [${targetRepo.fullName}]：当前 GitHub Token 属于 [${loginResult.login}]，目标仓库 owner 是 [${targetRepo.owner}]。为避免误提交到他人或组织仓库，只允许写入当前 Token 用户自己的仓库。`
    };
  }

  return { success: true, repo: targetRepo, login: loginResult.login };
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

function getExternalAiHost(aiUrl) {
  try {
    const hostname = new URL(aiUrl).hostname.toLowerCase();
    return hostname && hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1'
      ? hostname
      : '';
  } catch (err) {
    return '';
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableAiStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function requestAiCompletion(aiUrl, options) {
  let lastError = null;

  for (let attempt = 1; attempt <= AI_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(aiUrl, {
        ...options,
        signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS)
      });
      const rawText = await response.text();

      if (response.ok) {
        return { success: true, rawText, attempt };
      }

      if (attempt < AI_REQUEST_MAX_ATTEMPTS && isRetryableAiStatus(response.status)) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const retryDelayMs = Number.isFinite(retryAfter)
          ? Math.min(Math.max(retryAfter * 1000, 300), 3000)
          : 800;
        await delay(retryDelayMs);
        continue;
      }

      return { success: false, status: response.status, rawText, attempt };
    } catch (err) {
      lastError = err;
      const retryable = err && (
        err.name === 'TimeoutError' ||
        err.name === 'AbortError' ||
        (err.message && err.message.includes('fetch failed'))
      );
      if (!retryable || attempt >= AI_REQUEST_MAX_ATTEMPTS) {
        throw err;
      }
      await delay(800);
    }
  }

  throw lastError || new Error('AI 请求失败');
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(contentToText)
      .filter(Boolean)
      .join('');
  }
  if (content && typeof content === 'object') {
    return contentToText(content.text || content.content || content.output_text || content.value || '');
  }
  return '';
}

function extractAiMessage(data) {
  if (!data || typeof data !== 'object') return '';
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const candidates = [
    ...choices.flatMap(choice => [
      choice && choice.message && choice.message.content,
      choice && choice.message && choice.message.text,
      choice && choice.delta && choice.delta.content,
      choice && choice.text
    ]),
    data.output_text,
    data.response,
    data.message && data.message.content,
    data.message,
    data.output
  ];

  for (const candidate of candidates) {
    const text = contentToText(candidate).trim();
    if (text) return text;
  }
  return '';
}

function getAiEmptyResponseReason(rawText) {
  try {
    const data = JSON.parse(rawText);
    const error = data && data.error;
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (error && typeof error.message === 'string' && error.message.trim()) return error.message.trim();
    if (typeof data.detail === 'string' && data.detail.trim()) return data.detail.trim();

    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (choice && choice.finish_reason) return `模型结束原因: ${choice.finish_reason}`;
  } catch (err) {
    return '返回内容不是可识别的 JSON/SSE 格式';
  }
  return '服务成功响应，但未包含可用的文本字段';
}

function parseAiResponse(rawText) {
  try {
    const data = JSON.parse(rawText);
    return { data, message: extractAiMessage(data) };
  } catch (jsonError) {
    const streamedParts = [];
    for (const line of String(rawText).split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const event = JSON.parse(payload);
        const choice = Array.isArray(event.choices) ? event.choices[0] : null;
        const part = contentToText(
          (choice && choice.delta && choice.delta.content) ||
          (choice && choice.message && choice.message.content) ||
          (choice && choice.text)
        );
        if (part) streamedParts.push(part);
      } catch (err) {
        // Ignore non-JSON keepalive/event lines.
      }
    }
    if (streamedParts.length > 0) {
      return { data: null, message: streamedParts.join('').trim() };
    }

    const firstBraceIndex = rawText.indexOf('{');
    const lastBraceIndex = rawText.lastIndexOf('}');
    if (firstBraceIndex !== -1 && lastBraceIndex > firstBraceIndex) {
      const data = JSON.parse(rawText.slice(firstBraceIndex, lastBraceIndex + 1));
      return { data, message: extractAiMessage(data) };
    }
    throw jsonError;
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
    if (field === 'lastProjectPath') {
      updated[field] = sanitizeConfiguredProjectPath(value);
    } else if (field === 'recentPaths') {
      updated[field] = sanitizeConfiguredRecentPaths(value);
    } else {
      updated[field] = value;
    }
  }

  saveConfig(updated);
  res.json({ success: true, config: publicConfig(updated) });
});

// Get Git commands logs (supporting incremental polling with stable log ids)
app.get('/api/git-logs', (req, res) => {
  const afterId = parseInt(req.query.afterId ?? req.query.offset, 10) || 0;
  const slicedLogs = gitCommandLogs.filter(log => log.id > afterId);
  res.json({
    success: true,
    logs: slicedLogs,
    nextId: gitCommandLogSeq,
    nextOffset: gitCommandLogSeq
  });
});

// Clear Git commands logs
app.post('/api/git-logs/clear', (req, res) => {
  gitCommandLogs = [];
  gitCommandLogSeq = 0;
  gitCommandRunSeq = 0;
  res.json({ success: true });
});

// Verify git installation & Check if directory is git repo
app.post('/api/repo/status', async (req, res) => {
  const { dirPath } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }

  if (isProtectedProjectDirectory(safeDir)) {
    return res.json(protectedProjectStatus(safeDir));
  }

  const activeMutation = activeRepositoryMutations.get(repositoryOperationKey(safeDir));
  if (activeMutation) {
    return res.status(409).json({
      success: false,
      busy: true,
      operation: activeMutation.operation,
      error: '仓库正在提交或推送，已暂缓状态扫描，避免多个 Git 进程互相争用。'
    });
  }

  const config = loadConfig();
  const token = config.githubToken || '';
  const isRepo = await isGitRepository(safeDir, token);

  if (!isRepo) {
    const parentRepoRoot = await getGitRepositoryRoot(safeDir, token);
    return res.json({
      success: true,
      isRepo: false,
      parentRepoRoot: parentRepoRoot && !sameDirectory(parentRepoRoot, safeDir) ? parentRepoRoot : ''
    });
  }

  // These are independent reads. Running them together makes refresh noticeably
  // faster on large repositories and avoids writing huge status output to UI logs.
  const [remoteResult, branchResult, statusResult] = await Promise.all([
    runCommand(safeDir, ['remote', 'get-url', 'origin'], token, { logOutput: false }),
    runCommand(safeDir, ['branch', '--show-current'], token, { logOutput: false }),
    runCommand(safeDir, ['status', '--porcelain=v1', '-z'], token, {
      trimOutput: false,
      logOutput: false,
      timeoutMs: 30000
    })
  ]);

  let remoteUrl = '';
  if (remoteResult.success) {
    remoteUrl = remoteResult.stdout;
  }

  let currentBranch = '';
  if (branchResult.success) {
    currentBranch = branchResult.stdout;
  }

  if (!statusResult.success) {
    return res.status(503).json({
      success: false,
      error: statusResult.error && statusResult.error.includes('timed out')
        ? '工作区扫描超过 30 秒，已停止。本地目录可能包含过多未忽略文件，请完善 .gitignore 后重试。'
        : `读取工作区改动失败: ${statusResult.error}`
    });
  }

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
  const { dirPath, remoteUrl, expectedRepoFullName } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return res.status(400).json({ success: false, error: 'Directory does not exist.' });
  }
  if (rejectProtectedProjectDirectory(res, safeDir)) return;

  const config = loadConfig();
  const token = config.githubToken || '';
  
  if (!remoteUrl) {
    return res.status(400).json({ success: false, error: 'Remote URL is required.' });
  }

  const cleanRemoteUrl = normalizeRemoteUrl(remoteUrl);
  const targetValidation = await validateGithubWriteTarget({
    remoteUrl: cleanRemoteUrl,
    expectedFullName: expectedRepoFullName,
    token
  });
  if (!targetValidation.success) {
    return res.status(targetValidation.statusCode || 400).json({ success: false, error: targetValidation.error });
  }

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

  // Changing origin does not remove old origin/* refs. Prune them against the new remote
  // so stale history from the previous repository cannot be displayed as current history.
  await runCommand(safeDir, ['remote', 'prune', 'origin'], token);

  await runCommand(safeDir, ['config', 'user.name', 'GitHub Auto Tool'], token);
  await runCommand(safeDir, ['config', 'user.email', 'autotool@github.com'], token);

  res.json({ success: true });
});

// Fetch and list remote branches (via git ls-remote)
app.post('/api/repo/branches', async (req, res) => {
  const { dirPath } = req.body;
  const config = loadConfig();
  const token = config.githubToken || '';
  const repoCheck = await resolveOwnGitRepository(dirPath, token);
  if (!repoCheck.success) {
    return res.status(repoCheck.statusCode).json({ success: false, error: repoCheck.error });
  }
  const { safeDir } = repoCheck;

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
  const config = loadConfig();
  const token = config.githubToken || '';
  const repoCheck = await resolveOwnGitRepository(dirPath, token);
  if (!repoCheck.success) {
    return res.status(repoCheck.statusCode).json({ success: false, error: repoCheck.error });
  }
  const { safeDir } = repoCheck;
  const branchValidation = await validateBranchName(safeDir, branch, token);
  if (!branchValidation.success) {
    return res.status(400).json({ success: false, error: branchValidation.error });
  }

  const fetchRes = await fetchRemoteHistory(safeDir, branch, token);
  if (!fetchRes.success) {
    if (fetchRes.error.includes("couldn't find remote ref")) {
      return res.json({ success: true, commits: [], remoteBranchExists: false });
    }
    return res.json({ success: false, error: 'Failed to fetch remote history: ' + fetchRes.error });
  }

  // Never fall back to an old local origin/<branch> reference after a remote URL changes.
  if (!await remoteBranchExists(safeDir, branch, token)) {
    return res.json({ success: true, commits: [], remoteBranchExists: false });
  }

  const logRes = await runCommand(
    safeDir,
    ['log', `origin/${branch}`, '--graph', '--pretty=format:%h|%an|%ar|%s', '-n', '50'],
    token
  );

  if (!logRes.success) {
    return res.json({ success: true, commits: [], remoteBranchExists: true });
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

  res.json({ success: true, commits, remoteBranchExists: true });
});

// Commit and Force Push
app.post('/api/repo/commit', async (req, res) => {
  const { dirPath, branch, description, expectedRepoFullName } = req.body;
  const operationStartedAt = Date.now();
  const config = loadConfig();
  const token = config.githubToken || '';
  const repoCheck = await resolveOwnGitRepository(dirPath, token);
  if (!repoCheck.success) {
    return res.status(repoCheck.statusCode).json({ success: false, error: repoCheck.error });
  }
  const { safeDir } = repoCheck;
  const operationKey = repositoryOperationKey(safeDir);
  const requestMutation = req.repositoryMutation;
  if (!requestMutation && activeRepositoryMutations.has(operationKey)) {
    return res.status(409).json({
      success: false,
      busy: true,
      error: '该仓库已有提交推送任务正在执行，请勿重复提交。'
    });
  }
  const operationMarker = requestMutation?.marker || { operation: 'commit', startedAt: Date.now() };
  const ownsOperationLock = !requestMutation;
  if (ownsOperationLock) activeRepositoryMutations.set(operationKey, operationMarker);

  try {
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

  const targetValidation = await validateGithubWriteTarget({
    cwd: safeDir,
    expectedFullName: expectedRepoFullName,
    token
  });
  if (!targetValidation.success) {
    return res.status(targetValidation.statusCode || 400).json({ success: false, error: targetValidation.error });
  }

  const currentBranchRes = await runCommand(safeDir, ['branch', '--show-current'], token);
  if (!currentBranchRes.success || !currentBranchRes.stdout.trim()) {
    return res.json({ success: false, error: '无法确认当前分支，请刷新仓库状态后重试。' });
  }
  if (currentBranchRes.stdout.trim() !== branch) {
    return res.json({ success: false, error: `当前工作区分支是 [${currentBranchRes.stdout.trim()}]，不是页面选中的 [${branch}]。请刷新后重试。` });
  }

  const buildOutputResult = await prepareStm32BuildOutputsForCommit(safeDir, token);
  if (!buildOutputResult.success) {
    return res.json({ success: false, error: buildOutputResult.error });
  }

  const addRes = await runCommand(safeDir, ['add', '-A'], token);
  if (!addRes.success) {
    return res.json({ success: false, error: 'Failed to stage changes: ' + addRes.error });
  }

  const commitRes = await runCommand(safeDir, ['commit', '-m', description], token);
  if (!commitRes.success && !commitRes.stdout.includes('nothing to commit')) {
    return res.json({ success: false, error: 'Failed to commit: ' + commitRes.error });
  }

  const pushStartedAt = Date.now();
  const pushRes = await runCommand(
    safeDir,
    ['push', '--force-with-lease', 'origin', branch],
    token,
    { timeoutMs: 5 * 60 * 1000 }
  );
  const pushDurationMs = Date.now() - pushStartedAt;
  if (!pushRes.success) {
    return res.json({ success: false, error: 'Failed to push: ' + pushRes.error });
  }

  const headRes = await runCommand(safeDir, ['rev-parse', '--short', 'HEAD'], token, { logOutput: false });
  res.json({
    success: true,
    commitHash: headRes.success ? headRes.stdout : '',
    ignoredBuildOutputs: buildOutputResult,
    pushDurationMs,
    totalDurationMs: Date.now() - operationStartedAt
  });
  } finally {
    if (ownsOperationLock && activeRepositoryMutations.get(operationKey) === operationMarker) {
      activeRepositoryMutations.delete(operationKey);
    }
  }
});

// Switch branch
app.post('/api/repo/switch', async (req, res) => {
  const { dirPath, branch, force } = req.body;
  const config = loadConfig();
  const token = config.githubToken || '';
  const repoCheck = await resolveOwnGitRepository(dirPath, token);
  if (!repoCheck.success) {
    return res.status(repoCheck.statusCode).json({ success: false, error: repoCheck.error });
  }
  const { safeDir } = repoCheck;
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
  const { dirPath, newBranchName, fromHash, expectedRepoFullName } = req.body;
  const config = loadConfig();
  const token = config.githubToken || '';
  const repoCheck = await resolveOwnGitRepository(dirPath, token);
  if (!repoCheck.success) {
    return res.status(repoCheck.statusCode).json({ success: false, error: repoCheck.error });
  }
  const { safeDir } = repoCheck;

  if (!newBranchName) {
    return res.status(400).json({ success: false, error: 'New branch name is required.' });
  }

  const branchValidation = await validateBranchName(safeDir, newBranchName, token);
  if (!branchValidation.success) {
    return res.status(400).json({ success: false, error: branchValidation.error });
  }

  const targetValidation = await validateGithubWriteTarget({
    cwd: safeDir,
    expectedFullName: expectedRepoFullName,
    token
  });
  if (!targetValidation.success) {
    return res.status(targetValidation.statusCode || 400).json({ success: false, error: targetValidation.error });
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

  // Creating a branch must never stage, commit, or alter unrelated working-tree
  // changes. A first commit remains an explicit user action through /commit.
  if (!hasCommits) {
    return res.json({ success: true, pendingPush: true });
  }

  // Push only the branch reference and its existing commits.
  const pushRes = await runCommand(safeDir, ['push', '-u', 'origin', newBranchName], token);
  if (!pushRes.success) {
    return res.json({ success: false, error: 'Failed to push branch to remote: ' + pushRes.error });
  }

  res.json({ success: true });
});

// Delete remote branch
app.post('/api/repo/delete-branch', async (req, res) => {
  const { dirPath, branchToDelete, expectedRepoFullName } = req.body;
  const config = loadConfig();
  const token = config.githubToken || '';
  const repoCheck = await resolveOwnGitRepository(dirPath, token);
  if (!repoCheck.success) {
    return res.status(repoCheck.statusCode).json({ success: false, error: repoCheck.error });
  }
  const { safeDir } = repoCheck;

  if (!branchToDelete) {
    return res.status(400).json({ success: false, error: 'Branch name is required.' });
  }

  const branchValidation = await validateBranchName(safeDir, branchToDelete, token);
  if (!branchValidation.success) {
    return res.status(400).json({ success: false, error: branchValidation.error });
  }

  const targetValidation = await validateGithubWriteTarget({
    cwd: safeDir,
    expectedFullName: expectedRepoFullName,
    token
  });
  if (!targetValidation.success) {
    return res.status(targetValidation.statusCode || 400).json({ success: false, error: targetValidation.error });
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
  const { dirPath, branch, hash, expectedRepoFullName } = req.body;
  const config = loadConfig();
  const token = config.githubToken || '';
  const repoCheck = await resolveOwnGitRepository(dirPath, token);
  if (!repoCheck.success) {
    return res.status(repoCheck.statusCode).json({ success: false, error: repoCheck.error });
  }
  const { safeDir } = repoCheck;

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

  const targetValidation = await validateGithubWriteTarget({
    cwd: safeDir,
    expectedFullName: expectedRepoFullName,
    token
  });
  if (!targetValidation.success) {
    return res.status(targetValidation.statusCode || 400).json({ success: false, error: targetValidation.error });
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

  const cached = githubRepoListCache;
  if (cached.token === token && cached.repos.length > 0 && Date.now() - cached.updatedAt < GITHUB_REPO_LIST_CACHE_TTL_MS) {
    return res.json({ success: true, repos: cached.repos, cached: true });
  }

  // `affiliation=owner` avoids a separate /user request. That removes one
  // network round trip on every page load while write endpoints still verify
  // the token owner immediately before any remote mutation.
  const apiRes = await callGithubApi('GET', '/user/repos?affiliation=owner&sort=updated&per_page=100', null, token);
  if (apiRes.success) {
    const repos = apiRes.data
      .filter(repo => repo && repo.owner && repo.owner.login)
      .map(repo => ({
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner.login,
        private: repo.private,
        htmlUrl: repo.html_url,
        defaultBranch: repo.default_branch,
        description: repo.description // Return description
      }));
    githubRepoListCache = { token, repos, updatedAt: Date.now() };
    res.json({ success: true, repos });
  } else {
    if (cached.token === token && cached.repos.length > 0) {
      return res.json({ success: true, repos: cached.repos, cached: true, stale: true });
    }
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

  const loginResult = await getAuthenticatedGithubLogin(token);
  if (!loginResult.success) {
    return res.status(loginResult.statusCode || 400).json({ success: false, error: loginResult.error });
  }
  if (owner.toLowerCase() !== loginResult.login.toLowerCase()) {
    return res.status(403).json({
      success: false,
      error: `已阻止删除仓库 [${owner}/${repo}]：当前 GitHub Token 属于 [${loginResult.login}]，目标仓库 owner 是 [${owner}]。`
    });
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
  const { dirPath, remoteUrl, branch, expectedRepoFullName } = req.body;
  const safeDir = resolveExistingDirectory(dirPath);
  if (!safeDir) {
    return res.status(400).json({ success: false, error: '本地物理路径不存在' });
  }
  if (rejectProtectedProjectDirectory(res, safeDir)) return;
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
  const targetValidation = await validateGithubWriteTarget({
    remoteUrl: cleanRemoteUrl,
    expectedFullName: expectedRepoFullName,
    token
  });
  if (!targetValidation.success) {
    return res.status(targetValidation.statusCode || 400).json({ success: false, error: targetValidation.error });
  }

  const isRepo = await isGitRepository(safeDir, token);

  // Never replace a working tree while binding it to another remote. The
  // browser warning is helpful, but this server-side guard is authoritative.
  if (isRepo) {
    const statusRes = await runCommand(safeDir, ['status', '--porcelain'], token, { logOutput: false });
    if (!statusRes.success) {
      return res.json({ success: false, error: '读取本地改动失败，已取消绑定以保护工作区。' });
    }
    if (statusRes.stdout) {
      return res.status(409).json({
        success: false,
        hasChanges: true,
        error: '本地存在未提交改动。请先提交、暂存或手动备份后再绑定远程仓库。'
      });
    }
  }

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
  const hadOrigin = remoteListHasOrigin(checkRemote.stdout);
  const originalRemoteRes = hadOrigin
    ? await runCommand(safeDir, ['remote', 'get-url', 'origin'], token, { logOutput: false })
    : null;
  if (hadOrigin && !originalRemoteRes.success) {
    return res.json({ success: false, error: '读取原 origin 地址失败，已取消重新绑定以防误改远程。' });
  }
  const restoreOriginalRemote = async () => {
    if (hadOrigin) {
      await runCommand(safeDir, ['remote', 'set-url', 'origin', originalRemoteRes.stdout], token, { logOutput: false });
    } else {
      await runCommand(safeDir, ['remote', 'remove', 'origin'], token, { logOutput: false });
    }
  };
  let setRemoteRes;
  if (hadOrigin) {
    setRemoteRes = await runCommand(safeDir, ['remote', 'set-url', 'origin', cleanRemoteUrl], token);
  } else {
    setRemoteRes = await runCommand(safeDir, ['remote', 'add', 'origin', cleanRemoteUrl], token);
  }

  if (!setRemoteRes.success) {
    return res.json({ success: false, error: '配置 Remote 关联失败: ' + setRemoteRes.error });
  }

  // A repository may have been connected to another origin before this binding.
  // Remove stale origin/* references before inspecting branches from the new repository.
  await runCommand(safeDir, ['remote', 'prune', 'origin'], token);

  // 3. Fetch from remote
  const fetchRes = await runCommand(safeDir, ['fetch', 'origin', branch], token);

  // 4. Try checking out the target branch
  if (fetchRes.success && await remoteBranchExists(safeDir, branch, token)) {
    // Binding means the selected remote branch is the source of truth. Preserve
    // any same-named local branch under a recovery name before aligning it.
    let localBackupBranch = '';
    const localBranchRes = await runCommand(safeDir, ['rev-parse', '--verify', `refs/heads/${branch}`], token, { logOutput: false });
    if (localBranchRes.success) {
      const remoteHeadRes = await runCommand(safeDir, ['rev-parse', `origin/${branch}`], token, { logOutput: false });
      if (remoteHeadRes.success && localBranchRes.stdout !== remoteHeadRes.stdout) {
        localBackupBranch = `gflow-backup/${Date.now()}-${branch}`;
        const backupRes = await runCommand(safeDir, ['branch', localBackupBranch, branch], token);
        if (!backupRes.success) {
          await restoreOriginalRemote();
          return res.json({ success: false, error: '备份原本地分支失败，已取消覆盖性绑定: ' + backupRes.error });
        }
      }
    }

    const checkoutRes = await runCommand(safeDir, ['checkout', '-B', branch, `origin/${branch}`], token);
    if (!checkoutRes.success) {
      await restoreOriginalRemote();
      return res.json({ success: false, error: '切换分支失败: ' + checkoutRes.error });
    }
    return res.json({ success: true, localBackupBranch });
  } else if (!fetchRes.success && !fetchRes.error.includes('couldn\'t find remote ref')) {
    await restoreOriginalRemote();
    return res.json({ success: false, error: '拉取远程分支失败: ' + fetchRes.error });
  } else {
    // Branch does not exist remotely. Create or switch to the local branch only.
    // Uploading source code must remain an explicit action through /api/repo/commit.
    const checkoutNewRes = await checkoutOrCreateLocalBranch(safeDir, branch, token);
    if (!checkoutNewRes.success) {
      return res.json({ success: false, error: '本地新建分支失败: ' + checkoutNewRes.error });
    }
    return res.json({ success: true, pendingPush: true });
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
  res.json({
    success: true,
    absolutePath: absolute,
    protectedPath: isProtectedProjectDirectory(absolute),
    protectedRoot: isProtectedProjectDirectory(absolute) ? APP_ROOT : ''
  });
});

// Get Git Diff for a specific file (tracked or untracked)
app.post('/api/repo/diff', async (req, res) => {
  const { dirPath, filePath, oldPath } = req.body;
  const config = loadConfig();
  const token = config.githubToken || '';
  const repoCheck = await resolveOwnGitRepository(dirPath, token);
  if (!repoCheck.success) {
    return res.status(repoCheck.statusCode).json({ success: false, error: repoCheck.error });
  }
  const { safeDir } = repoCheck;
  if (!filePath) {
    return res.status(400).json({ success: false, error: 'File path is required.' });
  }
  if (!isSafeRelativePathspec(filePath)) {
    return res.status(400).json({ success: false, error: 'File path must be a repository-relative path.' });
  }
  if (oldPath && !isSafeRelativePathspec(oldPath)) {
    return res.status(400).json({ success: false, error: 'Old file path must be a repository-relative path.' });
  }

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
  const { dirPath, confirmExternalAi = false } = req.body;
  const config = loadConfig();
  const token = config.githubToken || '';
  const repoCheck = await resolveOwnGitRepository(dirPath, token);
  if (!repoCheck.success) {
    return res.status(repoCheck.statusCode).json({ success: false, error: repoCheck.error });
  }
  const { safeDir } = repoCheck;
  const aiUrl = normalizeChatCompletionsUrl(config.aiApiUrl);
  const externalAiHost = getExternalAiHost(aiUrl);
  if (externalAiHost && confirmExternalAi !== true) {
    return res.json({
      success: false,
      requiresExternalAiConfirmation: true,
      externalAiHost,
      error: `将向外部 AI 服务 ${externalAiHost} 发送已脱敏的代码改动摘要。请确认后继续。`
    });
  }

  const aiKey = config.aiApiKey || '';
  const aiModel = config.aiModelName || 'deepseek-chat';

  const condensedResult = await getCondensedDiffForAi(safeDir, token, 4000);

  if (!condensedResult.success) {
    return res.json({ success: false, error: condensedResult.error || '未能提取有效改动信息。' });
  }

  const { diffText } = condensedResult;

  // Construct chat body
  const requestBody = {
    model: aiModel,
    messages: [
      {
        role: 'system',
        content: '你是一个专业的 Git 助手。请根据提供的 Git 改动清单及核心代码 Diff，用中文写一行简明扼要的提交说明。不要使用 feat、fix、chore 等英文前缀，不要使用英文标题。请仅返回最终的中文提交说明文本，不要包含 markdown、额外解释或引号。'
      },
      {
        role: 'user',
        content: diffText
      }
    ],
    temperature: 0.2,
    max_tokens: 120,
    stream: false
  };

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (aiKey) {
      headers['Authorization'] = `Bearer ${aiKey}`;
    }

    let aiMessage = '';
    let lastRawText = '';
    let lastParseError = null;

    // 部分兼容服务会偶发返回 HTTP 200 但 choices 内容为空。此时重试一次，
    // 避免把临时服务端空响应误判成用户配置错误。
    for (let attempt = 1; attempt <= AI_EMPTY_RESPONSE_MAX_ATTEMPTS; attempt += 1) {
      const aiResult = await requestAiCompletion(aiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });

      if (!aiResult.success) {
        const safeError = maskSensitiveLog(maskSensitiveLog(aiResult.rawText, aiKey), token).slice(0, 2000);
        return res.json({
          success: false,
          error: `AI 服务返回错误 (${aiResult.status})${safeError ? `: ${safeError}` : ''}`
        });
      }

      lastRawText = aiResult.rawText;
      try {
        aiMessage = parseAiResponse(lastRawText).message;
        if (aiMessage) break;
      } catch (err) {
        lastParseError = err;
      }

      if (attempt < AI_EMPTY_RESPONSE_MAX_ATTEMPTS) await delay(800);
    }

    if (!aiMessage) {
      if (lastParseError) {
        const safeResponse = maskSensitiveLog(maskSensitiveLog(lastRawText, aiKey), token).slice(0, 1000);
        return res.json({
          success: false,
          error: `解析 AI 响应失败: ${lastParseError.message}${safeResponse ? `。响应摘要: ${safeResponse}` : ''}`
        });
      }
      const reason = getAiEmptyResponseReason(lastRawText);
      return res.json({
        success: false,
        error: `AI 服务连续 ${AI_EMPTY_RESPONSE_MAX_ATTEMPTS} 次返回空内容（${reason}）。这通常是模型服务临时负载或上游响应异常，请稍后重试。`
      });
    }

    // Clean up typical AI wrappers if present
    const cleanMessage = aiMessage.replace(/^["'`\s]+|["'`\s]+$/g, '');
    res.json({ success: true, commitMessage: cleanMessage });
  } catch (err) {
    let errMsg = `AI 服务请求异常: ${err.message}`;
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      errMsg = `AI 服务连续两次请求均超过 ${AI_REQUEST_TIMEOUT_MS / 1000} 秒，已自动停止。请稍后重试或检查模型服务负载。`;
    } else if (err.message && err.message.includes('fetch failed')) {
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


