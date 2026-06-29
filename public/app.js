// Global state
let currentConfig = {
  hasGithubToken: false,
  hasAiApiKey: false,
  username: '',
  avatarUrl: '',
  lastProjectPath: '',
  recentPaths: [],
  aiApiUrl: '',
  aiModelName: ''
};
let currentRepoStatus = { isRepo: false, remoteUrl: '', currentBranch: '', hasChanges: false, changesList: [] };
let selectedBranch = '';
let selectedCommitHash = '';
let logOffset = 0;
let githubActionRuns = [];

// Repository dropdown and branch list caches
let globalReposList = [];
let repoBranchesCache = {}; // { repoFullName: [branches] }
let activeSelectedRepo = null; // Currently active selected repository object from dropdown

// DOM elements
const pathInput = document.getElementById('project-path');
const btnLoadPath = document.getElementById('btn-load-path');
const recentPathsSelect = document.getElementById('recent-paths-select');
const authStatusDot = document.getElementById('auth-status-dot');
const authUsernameDisplay = document.getElementById('auth-username-display');
const authAvatar = document.getElementById('auth-avatar');

const repoSelect = document.getElementById('repo-select');
const btnDeleteActiveRepo = document.getElementById('btn-delete-active-repo');
const btnOpenCreateRepo = document.getElementById('btn-open-create-repo');
const btnRefreshRepos = document.getElementById('btn-refresh-repos');
const branchesListContainer = document.getElementById('branches-list');

const newBranchInput = document.getElementById('new-branch-input');
const btnCreateBranch = document.getElementById('btn-create-branch');

const activeRepoRibbon = document.getElementById('active-repo-ribbon');
const ribbonPath = document.getElementById('ribbon-path');
const ribbonRepo = document.getElementById('ribbon-repo');
const ribbonBranch = document.getElementById('ribbon-branch');
const btnRibbonCreateBranch = document.getElementById('btn-ribbon-create-branch');

const fileChangesListContainer = document.getElementById('file-changes-list');
const changesCountBadge = document.getElementById('changes-count-badge');
const btnRefreshChanges = document.getElementById('btn-refresh-changes');
const commitDescInput = document.getElementById('commit-desc-input');
const btnCommitPush = document.getElementById('btn-commit-push');

const historyContent = document.getElementById('history-content');
const consoleOutputBox = document.getElementById('console-output-box');
const btnClearLogs = document.getElementById('btn-clear-logs');

// Auth Modal
const authModal = document.getElementById('auth-modal');
const tokenInput = document.getElementById('token-input');
const btnSaveToken = document.getElementById('btn-save-token');

// Create Repo Modal
const createRepoModal = document.getElementById('create-repo-modal');
const newRepoName = document.getElementById('new-repo-name');
const newRepoPrivate = document.getElementById('new-repo-private');
const newRepoInit = document.getElementById('new-repo-init');
const btnConfirmCreateRepo = document.getElementById('btn-confirm-create-repo');
const btnCancelCreateRepo = document.getElementById('btn-cancel-create-repo');
const btnCloseCreateRepo = document.getElementById('btn-close-create-repo');

// Dialog Modal
const dialogModal = document.getElementById('dialog-modal');
const dialogTitle = document.getElementById('dialog-title');
const dialogMessage = document.getElementById('dialog-message');
const dialogBtnConfirm = document.getElementById('dialog-btn-confirm');
const dialogBtnCancel = document.getElementById('dialog-btn-cancel');

// AI Commit Button
const btnAiCommit = document.getElementById('btn-ai-commit');
const aiBtnText = document.getElementById('ai-btn-text');
const aiBtnSpinner = document.getElementById('ai-btn-spinner');

// Diff Modal Elements
const diffModal = document.getElementById('diff-modal');
const diffFilename = document.getElementById('diff-filename');
const btnToggleDiffFormat = document.getElementById('btn-toggle-diff-format');
const btnCloseDiff = document.getElementById('btn-close-diff');
const diffBody = document.getElementById('diff-body');

let currentDiffText = '';
let currentDiffFormat = 'side-by-side'; // side-by-side or line-by-line

// Custom Dialog Utility (Returns Promise)
function showCustomDialog({ title, message, confirmText = '确认', cancelText = '取消', isDanger = false }) {
  return new Promise((resolve) => {
    dialogTitle.innerText = title;
    dialogMessage.innerText = message;
    dialogBtnConfirm.innerText = confirmText;
    dialogBtnCancel.innerText = cancelText;

    if (isDanger) {
      dialogBtnConfirm.className = 'btn btn-danger';
    } else {
      dialogBtnConfirm.className = 'btn btn-accent';
    }

    dialogModal.classList.remove('hidden');

    const onConfirm = () => {
      cleanup();
      resolve(true);
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };

    const cleanup = () => {
      dialogModal.classList.add('hidden');
      dialogBtnConfirm.removeEventListener('click', onConfirm);
      dialogBtnCancel.removeEventListener('click', onCancel);
    };

    dialogBtnConfirm.addEventListener('click', onConfirm);
    dialogBtnCancel.addEventListener('click', onCancel);
  });
}

function toggleAuthModal() {
  authModal.classList.toggle('hidden');
  if (!authModal.classList.contains('hidden')) {
    tokenInput.value = '';
    tokenInput.placeholder = currentConfig.hasGithubToken
      ? '已保存 GitHub Token，留空保持不变'
      : 'ghp_xxxxxxxxxxxxxxxxxxxx';
    document.getElementById('ai-url-input').value = currentConfig.aiApiUrl || '';
    const aiKeyInput = document.getElementById('ai-key-input');
    aiKeyInput.value = '';
    aiKeyInput.placeholder = currentConfig.hasAiApiKey
      ? '已保存 AI API Key，留空保持不变'
      : 'sk-xxxxxxxxxxxxxxxxxxxx';
    document.getElementById('ai-model-input').value = currentConfig.aiModelName || '';
  }
}

// Write system logs to console
function addSystemLog(text) {
  const line = document.createElement('div');
  line.className = 'console-line system';
  line.innerText = `// ${new Date().toLocaleTimeString()} - ${text}`;
  consoleOutputBox.appendChild(line);
  consoleOutputBox.scrollTop = consoleOutputBox.scrollHeight;
}

function appendIcon(parent, name, className = '') {
  const icon = document.createElement('i');
  icon.setAttribute('data-lucide', name);
  if (className) icon.className = className;
  parent.appendChild(icon);
  return icon;
}

function setTextState(container, text, extraClass = '') {
  container.replaceChildren();
  const state = document.createElement('div');
  state.className = `empty-state-text${extraClass ? ` ${extraClass}` : ''}`;
  state.innerText = text;
  container.appendChild(state);
}

function setSelectMessage(select, text) {
  select.replaceChildren();
  const option = document.createElement('option');
  option.value = '';
  option.innerText = text;
  select.appendChild(option);
}

function createGraphTrack(symbols) {
  const track = document.createElement('span');
  track.className = 'git-graph-track';

  Array.from(symbols).forEach(char => {
    const span = document.createElement('span');
    span.innerText = char;
    if (char === '*') {
      span.className = 'graph-node';
    } else if (char === '|') {
      span.className = 'graph-line-vertical';
    } else if (char === '/' || char === '\\' || char === '_') {
      span.className = 'graph-line-slash';
    }
    track.appendChild(span);
  });

  return track;
}

// API Call Wrappers
async function apiPost(url, data = {}) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await res.json();
  } catch (err) {
    console.error(`API Error (${url}):`, err);
    return { success: false, error: '网络连接失败，请检查后端服务是否开启。' };
  }
}

async function apiGet(url) {
  try {
    const res = await fetch(url);
    return await res.json();
  } catch (err) {
    console.error(`API Error (${url}):`, err);
    return { success: false, error: '网络连接失败，请检查后端服务是否开启。' };
  }
}

// Load configurations from server
async function loadServerConfig() {
  const config = await apiGet('/api/config');
  if (config) {
    currentConfig = config;
    if (config.hasGithubToken) {
      tokenInput.value = '';
      updateAuthUI(true, config.username || 'GitHub 账户已关联', config.avatarUrl);
      await fetchGithubRepos(); // Fetch repos immediately
    } else {
      updateAuthUI(false);
    }

    // Populate AI Settings fields
    document.getElementById('ai-url-input').value = config.aiApiUrl || '';
    document.getElementById('ai-key-input').value = '';
    document.getElementById('ai-model-input').value = config.aiModelName || '';

    // Populate recent paths dropdown
    populateRecentPathsDropdown(config.recentPaths || []);
    
    if (config.lastProjectPath) {
      pathInput.value = config.lastProjectPath;
      loadProjectPath(config.lastProjectPath);
    }
  }
}

// Populate recent paths dropdown
function populateRecentPathsDropdown(paths) {
  recentPathsSelect.innerHTML = '<option value="">最近链接的目录...</option>';
  paths.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.innerText = p;
    opt.title = p;
    recentPathsSelect.appendChild(opt);
  });
}

// Append new physical path to recent history
async function addPathToRecent(newPath) {
  let paths = currentConfig.recentPaths || [];
  
  // Filter out duplicates
  paths = paths.filter(p => p !== newPath);
  // Prepend to top
  paths.unshift(newPath);
  // Cap at 10 items
  if (paths.length > 10) {
    paths = paths.slice(0, 10);
  }

  currentConfig.recentPaths = paths;
  
  // Persist to backend config
  await apiPost('/api/config', { recentPaths: paths });
  
  // Refresh dropdown list
  populateRecentPathsDropdown(paths);
}

// Recent paths dropdown switch listener
recentPathsSelect.addEventListener('change', () => {
  const selectedPath = recentPathsSelect.value;
  if (selectedPath) {
    pathInput.value = selectedPath;
    // Switch directory directly
    loadProjectPath(selectedPath);
  }
});

// Update authentication UI status
function updateAuthUI(isLoggedIn, username = '', avatarUrl = '') {
  if (isLoggedIn) {
    authStatusDot.className = 'status-dot online';
    authUsernameDisplay.innerText = username;
    if (avatarUrl) {
      authAvatar.src = avatarUrl;
      authAvatar.classList.remove('hidden');
    } else {
      authAvatar.classList.add('hidden');
    }
    btnOpenCreateRepo.classList.remove('hidden');
  } else {
    authStatusDot.className = 'status-dot offline';
    authUsernameDisplay.innerText = '未连接 GitHub';
    authAvatar.classList.add('hidden');
    btnOpenCreateRepo.classList.add('hidden');
  }
}

// Fetch GitHub Username and Avatar using the token
async function fetchGithubProfile(token) {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `token ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      return {
        username: data.login,
        avatarUrl: data.avatar_url
      };
    }
  } catch (e) {
    console.error('Failed to fetch github profile:', e);
  }
  return null;
}

// Save Token Configuration
btnSaveToken.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  const aiUrl = document.getElementById('ai-url-input').value.trim();
  const aiKey = document.getElementById('ai-key-input').value.trim();
  const aiModel = document.getElementById('ai-model-input').value.trim();

  if (!token && !currentConfig.hasGithubToken) {
    addSystemLog('Token 不能为空。');
    return;
  }

  let profile = null;
  if (token) {
    addSystemLog('正在验证 GitHub Token...');
    profile = await fetchGithubProfile(token);
  }
  
  let saveObj = {
    aiApiUrl: aiUrl,
    aiModelName: aiModel
  };
  if (token) saveObj.githubToken = token;
  if (aiKey) saveObj.aiApiKey = aiKey;
  if (profile) {
    saveObj.username = profile.username;
    saveObj.avatarUrl = profile.avatarUrl;
    addSystemLog(`GitHub 认证成功: ${profile.username}`);
  } else if (token) {
    addSystemLog('无法获取 GitHub 个人信息，请检查 Token 权限（已保存凭证）。');
  }

  const res = await apiPost('/api/config', saveObj);
  if (res.success) {
    currentConfig = res.config;
    updateAuthUI(true, res.config.username || 'GitHub 账户已关联', res.config.avatarUrl || '');
    toggleAuthModal();
    fetchGithubRepos(); // Refresh repositories
  }
});

// Fetch GitHub User Repositories
async function fetchGithubRepos() {
  if (!currentConfig.hasGithubToken) return;
  
  setSelectMessage(repoSelect, '正在读取仓库列表...');
  
  const res = await apiGet('/api/github/repos');
  if (res.success) {
    globalReposList = res.repos;
    populateRepoDropdown(res.repos);
  } else {
    setSelectMessage(repoSelect, `加载仓库失败: ${res.error}`);
  }
}

// Populate the repositories dropdown
function populateRepoDropdown(repos) {
  repoSelect.innerHTML = '<option value="">请选择 GitHub 仓库...</option>';
  
  if (repos.length === 0) {
    repoSelect.innerHTML = '<option value="">未找到任何仓库，请新建</option>';
    return;
  }

  repos.forEach(repo => {
    const opt = document.createElement('option');
    opt.value = repo.fullName;
    opt.innerText = repo.description || repo.name; // Prioritize Chinese description
    opt.title = `${repo.fullName} (${repo.name})`;
    repoSelect.appendChild(opt);
  });

  // Re-sync dropdown if we already have an active remote loaded in memory
  if (currentRepoStatus.isRepo && currentRepoStatus.remoteUrl) {
    syncDropdownWithRemote(currentRepoStatus.remoteUrl);
  }
}

// Sync Dropdown choice with local directory remote url
function syncDropdownWithRemote(remoteUrl) {
  const match = globalReposList.find(repo => isMatchingRemote(remoteUrl, repo.fullName));
  if (match) {
    repoSelect.value = match.fullName;
    activeSelectedRepo = match;
    btnDeleteActiveRepo.classList.remove('hidden');
    loadBranchesForSelectedRepo(match);
  } else {
    btnDeleteActiveRepo.classList.add('hidden');
  }
}

// Dropdown change listener
repoSelect.addEventListener('change', async () => {
  const selectedFullName = repoSelect.value;
  if (!selectedFullName) {
    activeSelectedRepo = null;
    btnDeleteActiveRepo.classList.add('hidden');
    branchesListContainer.innerHTML = '<div class="empty-state-text">请在上方选择一个 GitHub 仓库</div>';
    return;
  }

  const match = globalReposList.find(repo => repo.fullName === selectedFullName);
  if (match) {
    activeSelectedRepo = match;
    btnDeleteActiveRepo.classList.remove('hidden');
    loadBranchesForSelectedRepo(match);

    // If local path is set, check if we need to auto-init or re-associate remote origin
    const dirPath = pathInput.value.trim();
    if (dirPath) {
      const needsInitOrBind = !currentRepoStatus.isRepo || 
                              !currentRepoStatus.remoteUrl || 
                              !isMatchingRemote(currentRepoStatus.remoteUrl, match.fullName);
      
      if (needsInitOrBind) {
        addSystemLog(`检测到本地路径 [${dirPath}] 需要配置远程关联。正在自动初始化并关联至远程仓库 [${match.fullName}]...`);
        const initRes = await apiPost('/api/repo/init', {
          dirPath,
          remoteUrl: match.htmlUrl
        });
        if (initRes.success) {
          addSystemLog(`自动配置关联成功。`);
          loadProjectPath(dirPath);
        } else {
          addSystemLog(`自动配置关联失败: ${initRes.error}`);
        }
      }
    }
  }
});

// Load and populate branches for selected repository
async function loadBranchesForSelectedRepo(repo) {
  branchesListContainer.innerHTML = '<div class="loading-spinner">正在获取分支...</div>';
  
  if (repoBranchesCache[repo.fullName]) {
    populateBranchesUI(repo, repoBranchesCache[repo.fullName]);
    return;
  }

  const res = await apiPost('/api/github/repos/branches', { owner: repo.owner, repo: repo.name });
  if (res.success) {
    repoBranchesCache[repo.fullName] = res.branches;
    populateBranchesUI(repo, res.branches);
  } else {
    const errorText = res.error || '';
    const branches = res.statusCode === 409 || errorText.includes('Git Repository is empty') ? [] : null;
    if (branches !== null) {
      populateBranchesUI(repo, ['main']);
    } else {
      setTextState(branchesListContainer, `加载分支失败: ${res.error}`, 'text-warning');
    }
  }
}

// Populate branches in Left Panel Branch List Container
function populateBranchesUI(repo, branches) {
  branchesListContainer.innerHTML = '';
  
  if (branches.length === 0) {
    branches = ['main'];
  }

  branches.forEach(branch => {
    // Check if this repository/branch is currently active
    const isActive = currentRepoStatus.isRepo && 
                     isMatchingRemote(currentRepoStatus.remoteUrl, repo.fullName) &&
                     currentRepoStatus.currentBranch === branch;

    const item = document.createElement('div');
    item.className = `branch-item ${isActive ? 'active' : ''}`;

    const nameWrap = document.createElement('div');
    nameWrap.className = 'branch-name-wrap';
    appendIcon(nameWrap, 'git-branch', 'icon-xs');
    const branchNameSpan = document.createElement('span');
    branchNameSpan.innerText = branch;
    nameWrap.appendChild(branchNameSpan);

    item.appendChild(nameWrap);

    // Delete branch icon (except if it is active or default)
    if (!isActive && branch !== repo.defaultBranch) {
      const btnDelBranch = document.createElement('button');
      btnDelBranch.className = 'btn-delete-branch';
      btnDelBranch.innerHTML = '<i data-lucide="trash-2" class="icon-xs"></i>';
      btnDelBranch.title = '删除此远程分支';
      
      btnDelBranch.addEventListener('click', async (e) => {
        e.stopPropagation();
        
        const confirmDelete = await showCustomDialog({
          title: '删除远程分支',
          message: `确定要删除仓库 [${repo.name}] 的远程分支 [${branch}] 吗？此操作无法撤销。`,
          confirmText: '确认删除',
          isDanger: true
        });

        if (confirmDelete) {
          addSystemLog(`正在删除 [${repo.fullName}] 的远程分支: ${branch}...`);
          const localPath = pathInput.value.trim();
          if (localPath && isMatchingRemote(currentRepoStatus.remoteUrl, repo.fullName)) {
            const delRes = await apiPost('/api/repo/delete-branch', { dirPath: localPath, branchToDelete: branch });
            if (delRes.success) {
              addSystemLog(`分支 [${branch}] 已成功删除`);
              delete repoBranchesCache[repo.fullName]; // Clear cache
              loadBranchesForSelectedRepo(repo);
            } else {
              addSystemLog(`删除分支失败: ${delRes.error}`);
            }
          } else {
            addSystemLog(`请先将文件夹链接到该仓库，再进行分支删除操作。`);
          }
        }
      });

      item.appendChild(btnDelBranch);
    }

    // Bind local folder to this branch on click
    item.addEventListener('click', () => {
      bindLocalDirectoryToBranch(repo, branch);
    });

    branchesListContainer.appendChild(item);
  });

  lucide.createIcons();
}

// Match remote URL
function isMatchingRemote(url, fullName) {
  if (!url) return false;
  const cleanUrl = url.toLowerCase();
  const target = fullName.toLowerCase();
  
  const stripGit = (str) => str.endsWith('.git') ? str.slice(0, -4) : str;
  const cleanTarget = stripGit(target);
  const cleanRemote = stripGit(cleanUrl);

  return cleanRemote.includes(`github.com/${cleanTarget}`) || cleanRemote.includes(`github.com:${cleanTarget}`);
}

// Bind local directory to repository and branch
async function bindLocalDirectoryToBranch(repo, branchName) {
  const dirPath = pathInput.value.trim();
  
  if (!dirPath) {
    await showCustomDialog({
      title: '提示',
      message: '请先在顶部输入框粘贴或拖入您想关联的本地物理文件夹路径，然后再点击分支进行绑定！',
      confirmText: '我知道了'
    });
    pathInput.focus();
    return;
  }

  // Check if directory already has changes
  const checkStatus = await apiPost('/api/repo/status', { dirPath });
  let hasChanges = false;
  if (checkStatus.success && checkStatus.isRepo && checkStatus.hasChanges) {
    hasChanges = true;
  }

  // If there are changes, alert the user first
  if (hasChanges) {
    const proceed = await showCustomDialog({
      title: '未提交的修改',
      message: '当前本地文件夹有未提交的改动。切换绑定会丢弃或影响本地未提交的修改。是否确定要继续绑定？',
      confirmText: '强制切换并绑定',
      cancelText: '取消',
      isDanger: true
    });
    if (!proceed) {
      addSystemLog('用户取消切换绑定操作。');
      return;
    }
  }

  addSystemLog(`正在将本地目录 [${dirPath}] 绑定至远程 [${repo.fullName}] 的 [${branchName}] 分支...`);
  const res = await apiPost('/api/repo/bind', {
    dirPath,
    remoteUrl: repo.htmlUrl,
    branch: branchName
  });

  if (res.success) {
    addSystemLog(`成功关联绑定到 [${repo.fullName}] 的 [${branchName}] 分支`);
    loadProjectPath(dirPath);
    delete repoBranchesCache[repo.fullName]; // Clear branch cache to refresh status
    fetchGithubRepos();
  } else {
    addSystemLog(`关联绑定失败: ${res.error}`);
    await showCustomDialog({
      title: '绑定失败',
      message: `无法将本地文件夹与远程分支绑定，原因: ${res.error}`,
      confirmText: '关闭'
    });
  }
}

// Load project path & verify repo status
function updateLocalRepoUi(statusRes, absolutePath, { refreshBranches = true, refreshHistory = true } = {}) {
  currentRepoStatus = statusRes;

  if (statusRes.isRepo) {
    activeRepoRibbon.classList.remove('hidden');
    ribbonPath.innerText = absolutePath;
    ribbonBranch.innerText = statusRes.currentBranch || 'DETACHED';
    selectedBranch = statusRes.currentBranch;

    if (globalReposList.length > 0 && statusRes.remoteUrl) {
      const match = globalReposList.find(repo => isMatchingRemote(statusRes.remoteUrl, repo.fullName));
      if (match) {
        repoSelect.value = match.fullName;
        activeSelectedRepo = match;
        btnDeleteActiveRepo.classList.remove('hidden');
        ribbonRepo.innerText = match.description || match.name;

        if (refreshBranches) {
          loadBranchesForSelectedRepo(match);
        }
      } else {
        ribbonRepo.innerText = statusRes.remoteUrl;
      }
    } else {
      ribbonRepo.innerText = statusRes.remoteUrl || '-';
    }

    renderFileChanges(statusRes.changesList);

    if (refreshHistory && selectedBranch) {
      loadCommitHistory();
    }
  } else {
    activeRepoRibbon.classList.add('hidden');
    fileChangesListContainer.innerHTML = '<div class="empty-state-text">本地文件夹尚未绑定仓库。在左侧下拉框中选择仓库并点击其分支以建立绑定。</div>';
    changesCountBadge.innerText = 0;
    historyContent.innerHTML = '<div class="empty-state-text">未绑定仓库，无提交历史</div>';
    addSystemLog('检测到此目录不是 Git 仓库。请在左侧下拉框中选择仓库并点击其分支以建立绑定。');
  }
}

async function loadProjectPath(dirPath, isRetry = false) {
  if (!dirPath) return;
  
  addSystemLog(`正在检测本地路径: ${dirPath}`);
  
  const checkPath = await apiPost('/api/fs/validate-path', { dirPath });
  if (!checkPath.success) {
    addSystemLog(`路径无效: ${checkPath.error}`);
    activeRepoRibbon.classList.add('hidden');
    return;
  }

  const absolutePath = checkPath.absolutePath;
  pathInput.value = absolutePath;

  // Add path to config recentPaths
  addPathToRecent(absolutePath);

  // Fetch status
  const statusRes = await apiPost('/api/repo/status', { dirPath: absolutePath });
  if (statusRes.success) {
    // Check if we need to auto-initialize or auto-associate the selected remote repository
    if (activeSelectedRepo && !isRetry) {
      const needsInitOrBind = !statusRes.isRepo || 
                              !statusRes.remoteUrl || 
                              !isMatchingRemote(statusRes.remoteUrl, activeSelectedRepo.fullName);
                              
      if (needsInitOrBind) {
        addSystemLog(`检测到本地路径 [${absolutePath}] 需要配置远程关联。正在自动初始化并关联至远程仓库 [${activeSelectedRepo.fullName}]...`);
        const initRes = await apiPost('/api/repo/init', {
          dirPath: absolutePath,
          remoteUrl: activeSelectedRepo.htmlUrl
        });
        if (initRes.success) {
          addSystemLog(`自动配置关联成功。`);
          loadProjectPath(absolutePath, true);
          return;
        } else {
          addSystemLog(`自动配置关联失败: ${initRes.error}`);
        }
      }
    }

    updateLocalRepoUi(statusRes, absolutePath);
  } else {
    addSystemLog(`加载仓库状态出错: ${statusRes.error}`);
  }
}

async function refreshLocalChanges() {
  const dirPath = pathInput.value.trim();
  if (!dirPath) return;

  addSystemLog('正在手动扫描工作区改动...');
  const checkPath = await apiPost('/api/fs/validate-path', { dirPath });
  if (!checkPath.success) {
    addSystemLog(`路径无效: ${checkPath.error}`);
    return;
  }

  const absolutePath = checkPath.absolutePath;
  pathInput.value = absolutePath;

  const statusRes = await apiPost('/api/repo/status', { dirPath: absolutePath });
  if (statusRes.success) {
    updateLocalRepoUi(statusRes, absolutePath, {
      refreshBranches: false,
      refreshHistory: false
    });
    addSystemLog('本地改动刷新完成。');
  } else {
    addSystemLog(`刷新本地改动失败: ${statusRes.error}`);
  }
}

// Render uncommitted files list
function renderFileChanges(files) {
  fileChangesListContainer.innerHTML = '';
  changesCountBadge.innerText = files.length;

  if (files.length === 0) {
    fileChangesListContainer.innerHTML = '<div class="empty-state-text">无未提交的更改，工作区干净</div>';
    return;
  }

  files.forEach(fileLine => {
    const statusFlag = fileLine.substring(0, 2).trim();
    const filePath = fileLine.substring(3);

    const item = document.createElement('div');
    item.className = 'file-change-item clickable';

    const info = document.createElement('div');
    info.className = 'file-info';

    let badgeClass = 'status-m';
    let badgeText = 'M';

    if (statusFlag === 'M') {
      badgeClass = 'status-m';
      badgeText = 'MOD';
    } else if (statusFlag === 'A') {
      badgeClass = 'status-a';
      badgeText = 'ADD';
    } else if (statusFlag === 'D') {
      badgeClass = 'status-d';
      badgeText = 'DEL';
    } else if (statusFlag === '??') {
      badgeClass = 'status-u';
      badgeText = 'NEW';
    }

    const badge = document.createElement('span');
    badge.className = `file-status-badge ${badgeClass}`;
    badge.innerText = badgeText;

    const fileName = document.createElement('span');
    fileName.className = 'file-name';
    fileName.title = filePath;
    fileName.innerText = filePath;

    info.appendChild(badge);
    info.appendChild(fileName);

    item.appendChild(info);
    
    // Bind click event to trigger visual diff modal
    item.addEventListener('click', () => {
      showFileDiff(filePath);
    });

    fileChangesListContainer.appendChild(item);
  });
}

// Close Diff Modal overlay
function closeDiffModal() {
  diffModal.classList.add('hidden');
}

document.getElementById('btn-close-diff').addEventListener('click', closeDiffModal);

// Toggle between Side-by-Side and Unified Inline Diff representation
btnToggleDiffFormat.addEventListener('click', () => {
  if (currentDiffFormat === 'side-by-side') {
    currentDiffFormat = 'line-by-line';
    btnToggleDiffFormat.innerText = '切换并排显示 (Side-by-Side)';
  } else {
    currentDiffFormat = 'side-by-side';
    btnToggleDiffFormat.innerText = '切换单栏显示 (Inline)';
  }
  renderDiffHtml();
});

// Render the loaded unified diff using diff2html
function renderDiffHtml() {
  if (!currentDiffText) {
    diffBody.innerHTML = '<div class="empty-state-text">文件没有改动数据</div>';
    return;
  }

  const html = Diff2Html.html(currentDiffText, {
    drawFileList: false,
    matching: 'lines',
    outputFormat: currentDiffFormat
  });

  diffBody.innerHTML = html;
}

// Fetch and display code diff
async function showFileDiff(filePath) {
  const dirPath = pathInput.value.trim();
  if (!dirPath) return;

  addSystemLog(`正在读取文件 [${filePath}] 的改动差异对比...`);
  const res = await apiPost('/api/repo/diff', { dirPath, filePath });

  if (res.success) {
    currentDiffText = res.diff;
    diffFilename.innerText = `改动差异对比: ${filePath}`;
    currentDiffFormat = 'side-by-side';
    btnToggleDiffFormat.innerText = '切换单栏显示 (Inline)';
    renderDiffHtml();
    diffModal.classList.remove('hidden');
  } else {
    addSystemLog(`读取改动差异对比失败: ${res.error}`);
  }
}

// AI Commit Generation Button click listener
btnAiCommit.addEventListener('click', async () => {
  const dirPath = pathInput.value.trim();
  if (!dirPath) {
    addSystemLog('请先链接仓库目录！');
    return;
  }
  if (currentRepoStatus.changesList.length === 0) {
    addSystemLog('当前工作区无任何改动，无法生成描述。');
    return;
  }

  addSystemLog('正在通过 AI 生成提交描述...');
  btnAiCommit.disabled = true;
  aiBtnText.innerText = '正在智能生成...';
  aiBtnSpinner.classList.remove('hidden');

  const res = await apiPost('/api/ai/generate-commit', { dirPath });

  btnAiCommit.disabled = false;
  aiBtnText.innerText = '✨ AI 智能生成';
  aiBtnSpinner.classList.add('hidden');

  if (res.success) {
    commitDescInput.value = res.commitMessage;
    addSystemLog('AI 描述生成并填入完成！');
  } else {
    addSystemLog(`AI 描述生成失败: ${res.error}`);
    alert(`生成失败: ${res.error}`);
  }
});

// Load Commit History for current branch (integrating visual ASCII graph symbols)
async function loadCommitHistory() {
  const dirPath = pathInput.value.trim();
  if (!dirPath || !selectedBranch) return;

  historyContent.innerHTML = '<div class="loading-spinner">拉取提交历史中...</div>';

  const res = await apiPost('/api/repo/history', { dirPath, branch: selectedBranch });
  if (res.success) {
    historyContent.innerHTML = '';
    const commits = res.commits;

    if (commits.length === 0) {
      historyContent.innerHTML = '<div class="empty-state-text">此分支没有历史提交</div>';
      return;
    }

    const timeline = document.createElement('div');
    timeline.className = 'history-timeline';

    commits.forEach(commit => {
      const isSelected = commit.hash && commit.hash === selectedCommitHash;

      const item = document.createElement('div');
      item.className = `history-item ${isSelected ? 'selected' : ''}`;

      if (commit.hash) {
        const graphCell = document.createElement('div');
        graphCell.className = 'history-graph-cell';
        if (commit.graphSymbols) {
          graphCell.appendChild(createGraphTrack(commit.graphSymbols));
        }

        const body = document.createElement('div');
        body.className = 'history-item-body';

        const meta = document.createElement('div');
        meta.className = 'history-meta';

        const hash = document.createElement('span');
        hash.className = 'history-hash';
        hash.innerText = commit.hash;

        const author = document.createElement('span');
        author.className = 'history-author';
        author.innerText = commit.author;

        const message = document.createElement('div');
        message.className = 'history-msg';
        message.innerText = commit.message;

        const date = document.createElement('div');
        date.className = 'history-date';
        date.innerText = commit.date;

        meta.appendChild(hash);
        meta.appendChild(author);
        body.appendChild(meta);
        body.appendChild(message);
        body.appendChild(date);
        item.appendChild(graphCell);
        item.appendChild(body);
        
        item.addEventListener('click', (e) => {
          if (e.target.closest('.history-actions-box')) return;
          toggleCommitSelection(commit.hash);
        });
      } else {
        // Graph-only structural line
        item.classList.add('graph-only');
        const graphCell = document.createElement('div');
        graphCell.className = 'history-graph-cell graph-only-cell';
        if (commit.graphSymbols) {
          graphCell.appendChild(createGraphTrack(commit.graphSymbols));
        }
        const body = document.createElement('div');
        body.className = 'history-item-body graph-only-body';
        item.appendChild(graphCell);
        item.appendChild(body);
      }

      timeline.appendChild(item);
    });

    historyContent.appendChild(timeline);
    lucide.createIcons();

    // Trigger Actions workflow runs fetch in background
    loadActionsRunsForRepo();
  } else {
    setTextState(historyContent, `加载历史失败: ${res.error}`, 'text-warning');
  }
}

// Fetch GitHub Actions run status in background
async function loadActionsRunsForRepo() {
  if (!activeSelectedRepo || !currentConfig.hasGithubToken) return;

  const res = await apiPost('/api/github/actions/runs', {
    owner: activeSelectedRepo.owner,
    repo: activeSelectedRepo.name
  });

  if (res.success && Array.isArray(res.runs)) {
    githubActionRuns = res.runs;
    renderHistoryWithActionsStatus();
  }
}

// Map workflow runs to commit history timeline items
function renderHistoryWithActionsStatus() {
  const timelineEl = historyContent.querySelector('.history-timeline');
  if (!timelineEl) return;

  const items = timelineEl.querySelectorAll('.history-item');
  items.forEach(item => {
    const hashSpan = item.querySelector('.history-hash');
    if (!hashSpan) return;
    
    const hash = hashSpan.innerText;

    const matchedRun = githubActionRuns.find(run => 
      run.head_sha.startsWith(hash) || hash.startsWith(run.head_sha.substring(0, 7))
    );

    // Remove existing badge
    const existingBadge = item.querySelector('.action-status-badge');
    if (existingBadge) existingBadge.remove();

    if (matchedRun) {
      const badge = document.createElement('span');
      badge.className = 'action-status-badge';
      
      let iconName = 'help-circle';
      let tooltip = `CI Status: ${matchedRun.status}`;
      
      if (matchedRun.status === 'completed') {
        if (matchedRun.conclusion === 'success') {
          badge.className += ' success';
          iconName = 'check-circle';
          tooltip = 'CI 构建成功';
        } else if (matchedRun.conclusion === 'failure') {
          badge.className += ' failure';
          iconName = 'x-circle';
          tooltip = 'CI 构建失败';
        } else {
          badge.className += ' other';
          iconName = 'minus-circle';
          tooltip = `CI 结果: ${matchedRun.conclusion}`;
        }
      } else {
        badge.className += ' running';
        iconName = 'loader';
        tooltip = 'CI 正在构建中...';
      }

      const icon = appendIcon(badge, iconName, 'icon-xs');
      icon.title = tooltip;
      
      const metaRow = item.querySelector('.history-meta');
      if (metaRow) {
        metaRow.appendChild(badge);
      }
    }
  });

  lucide.createIcons();
}

// Expand action menu on a specific history item
function toggleCommitSelection(hash) {
  if (selectedCommitHash === hash) {
    selectedCommitHash = ''; // Deselect
  } else {
    selectedCommitHash = hash;
  }
  renderHistoryWithSelectedMenu();
}

function renderHistoryWithSelectedMenu() {
  const timelineEl = historyContent.querySelector('.history-timeline');
  if (!timelineEl) return;

  const items = timelineEl.querySelectorAll('.history-item');
  items.forEach(item => {
    const hashSpan = item.querySelector('.history-hash');
    if (!hashSpan) return;

    const hash = hashSpan.innerText;
    
    item.classList.remove('selected');
    const actionsBox = item.querySelector('.history-actions-box');
    if (actionsBox) actionsBox.remove();

    if (hash === selectedCommitHash) {
      item.classList.add('selected');

      const actionMenu = document.createElement('div');
      actionMenu.className = 'history-actions-box';
      
      const btnReset = document.createElement('button');
      btnReset.className = 'btn btn-danger btn-xs';
      btnReset.innerHTML = '<i data-lucide="rotate-ccw"></i> 重置到此历史';
      btnReset.addEventListener('click', () => resetToCommit(hash));

      const btnBranch = document.createElement('button');
      btnBranch.className = 'btn btn-secondary btn-xs';
      btnBranch.innerHTML = '<i data-lucide="plus"></i> 新建分支';
      btnBranch.addEventListener('click', () => createBranchFromHash(hash));

      actionMenu.appendChild(btnReset);
      actionMenu.appendChild(btnBranch);
      
      const bodyEl = item.querySelector('.history-item-body');
      if (bodyEl) {
        bodyEl.appendChild(actionMenu);
      }
      
      lucide.createIcons();
    }
  });
}

// Reset branch to commit hash
async function resetToCommit(hash) {
  const dirPath = pathInput.value.trim();
  if (!dirPath || !selectedBranch) return;

  const confirmReset = await showCustomDialog({
    title: '重置分支历史',
    message: `您确定要将当前分支 [${selectedBranch}] 强制重置到提交 [${hash}] 吗？这会强制覆盖远程历史，丢弃该提交后的所有远程更改。`,
    confirmText: '确认重置并强制推送',
    isDanger: true
  });

  if (confirmReset) {
    addSystemLog(`正在重置当前分支至 ${hash}...`);
    const resetRes = await apiPost('/api/repo/reset', { dirPath, branch: selectedBranch, hash });
    if (resetRes.success) {
      addSystemLog(`重置成功。远程仓库已回滚至 ${hash}`);
      selectedCommitHash = '';
      loadProjectPath(dirPath);
    } else {
      addSystemLog(`重置失败: ${resetRes.error}`);
    }
  }
}

// Create new branch from hash (history timeline)
async function createBranchFromHash(hash) {
  const dirPath = pathInput.value.trim();
  if (!dirPath) return;

  const name = prompt('请输入新建的分支名称:');
  if (!name) return;

  const cleanName = name.trim();
  if (!cleanName) {
    addSystemLog('分支名称不能为空');
    return;
  }

  addSystemLog(`正在以提交 [${hash}] 为基准创建新远程分支 [${cleanName}]...`);
  const res = await apiPost('/api/repo/create-branch', { dirPath, newBranchName: cleanName, fromHash: hash });
  
  if (res.success) {
    addSystemLog(`新分支 [${cleanName}] 创建并推送成功，已自动切换至新分支`);
    selectedCommitHash = '';
    
    loadProjectPath(dirPath);
    if (activeSelectedRepo) {
      delete repoBranchesCache[activeSelectedRepo.fullName]; // Clear branches cache
      loadBranchesForSelectedRepo(activeSelectedRepo);
    }
  } else {
    addSystemLog(`新建分支失败: ${res.error}`);
  }
}

// Helper to create a branch from local current position and sync to remote
async function performBranchCreation(cleanName) {
  const dirPath = pathInput.value.trim();
  if (!dirPath) return;

  addSystemLog(`正在创建并同步推送新分支 [${cleanName}]...`);
  const res = await apiPost('/api/repo/create-branch', { dirPath, newBranchName: cleanName });
  if (res.success) {
    addSystemLog(`新分支 [${cleanName}] 创建并同步远程成功，已自动切换至新分支`);
    
    loadProjectPath(dirPath);
    if (activeSelectedRepo) {
      delete repoBranchesCache[activeSelectedRepo.fullName];
      loadBranchesForSelectedRepo(activeSelectedRepo);
    }
  } else {
    addSystemLog(`创建分支失败: ${res.error}`);
    alert(`创建分支失败: ${res.error}`);
  }
}

// Branch list inline branch creation button click
btnCreateBranch.addEventListener('click', () => {
  const name = newBranchInput.value.trim();
  if (!name) {
    addSystemLog('请输入分支名称。');
    return;
  }
  newBranchInput.value = '';
  performBranchCreation(name);
});

// Branch list inline branch creation enter key press
newBranchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const name = newBranchInput.value.trim();
    if (!name) {
      addSystemLog('请输入分支名称。');
      return;
    }
    newBranchInput.value = '';
    performBranchCreation(name);
  }
});

// Ribbon Create Branch click
btnRibbonCreateBranch.addEventListener('click', async () => {
  const name = prompt('请输入要创建的新分支名称:');
  if (!name) return;
  const cleanName = name.trim();
  if (!cleanName) {
    addSystemLog('分支名称不能为空。');
    return;
  }
  performBranchCreation(cleanName);
});

// Manual refresh local changes button click
btnRefreshChanges.addEventListener('click', () => {
  refreshLocalChanges();
});

// Commit and force push button
btnCommitPush.addEventListener('click', async () => {
  const dirPath = pathInput.value.trim();
  const desc = commitDescInput.value.trim();

  if (!dirPath || !selectedBranch) {
    addSystemLog('未链接仓库或未选定当前分支。');
    return;
  }

  if (currentRepoStatus.changesList.length === 0) {
    addSystemLog('当前工作区无任何改动，无需提交。');
    return;
  }

  if (!desc) {
    addSystemLog('请输入提交描述！');
    commitDescInput.focus();
    return;
  }

  addSystemLog(`开始提交并强制推送至远程分支 [${selectedBranch}]...`);
  
  btnCommitPush.disabled = true;
  btnCommitPush.innerText = '正在提交并推送...';

  const res = await apiPost('/api/repo/commit', {
    dirPath,
    branch: selectedBranch,
    description: desc
  });

  btnCommitPush.disabled = false;
  btnCommitPush.innerHTML = '<i data-lucide="upload-cloud"></i> 立即提交并强制推送 (Force Push)';
  lucide.createIcons();

  if (res.success) {
    addSystemLog(`成功提交并强推至 [${selectedBranch}]`);
    commitDescInput.value = '';
    refreshLocalChanges();
  } else {
    addSystemLog(`提交失败: ${res.error}`);
  }
});

// Refresh repositories list manual click
btnRefreshRepos.addEventListener('click', () => {
  fetchGithubRepos();
  addSystemLog('已手动刷新 GitHub 仓库列表');
});

// Path selector load path manual click
btnLoadPath.addEventListener('click', () => {
  const val = pathInput.value.trim();
  if (val) {
    loadProjectPath(val);
  }
});

// Load path on pressing enter inside the input
pathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = pathInput.value.trim();
    if (val) {
      loadProjectPath(val);
    }
  }
});

// Open / Close Create Repo Modal
btnOpenCreateRepo.addEventListener('click', () => {
  if (!currentConfig.hasGithubToken) {
    addSystemLog('请先关联 GitHub Access Token！');
    return;
  }
  newRepoName.value = '';
  createRepoModal.classList.remove('hidden');
});

function closeCreateRepoModal() {
  createRepoModal.classList.add('hidden');
}

btnCloseCreateRepo.addEventListener('click', closeCreateRepoModal);
btnCancelCreateRepo.addEventListener('click', closeCreateRepoModal);

// Confirm Create Repository
btnConfirmCreateRepo.addEventListener('click', async () => {
  const name = newRepoName.value.trim();
  if (!name) {
    alert('请输入仓库名称');
    return;
  }

  const isPrivate = newRepoPrivate.checked;
  const autoInit = newRepoInit.checked;

  addSystemLog(`正在 GitHub 上创建仓库 [${name}] (私有: ${isPrivate}, 初始化: ${autoInit})...`);
  
  btnConfirmCreateRepo.disabled = true;
  btnConfirmCreateRepo.innerText = '正在创建...';

  const res = await apiPost('/api/github/repos/create', {
    name,
    isPrivate,
    autoInit
  });

  btnConfirmCreateRepo.disabled = false;
  btnConfirmCreateRepo.innerText = '确认创建';

  if (res.success) {
    addSystemLog(`成功创建远程仓库: ${res.repo.fullName}`);
    closeCreateRepoModal();
    await fetchGithubRepos();
    
    repoSelect.value = res.repo.fullName;
    repoSelect.dispatchEvent(new Event('change'));
  } else {
    addSystemLog(`创建仓库失败: ${res.error}`);
    alert(`创建仓库失败: ${res.error}`);
  }
});

// Delete active selected GitHub repository
btnDeleteActiveRepo.addEventListener('click', async () => {
  if (!activeSelectedRepo) return;
  await deleteGithubRepo(activeSelectedRepo.owner, activeSelectedRepo.name);
});

// Delete GitHub repository
async function deleteGithubRepo(owner, repoName) {
  const fullName = `${owner}/${repoName}`;
  
  const proceed = await showCustomDialog({
    title: '删除远程仓库',
    message: `您确定要在 GitHub 上彻底删除仓库 [${fullName}] 吗？\n警告：此操作将永久抹除远程仓库，无法恢复！`,
    confirmText: '确认删除 (高危操作)',
    cancelText: '取消',
    isDanger: true
  });

  if (proceed) {
    const userInput = prompt(`请输入该仓库名称 [ ${repoName} ] 进行二次确认:`);
    if (userInput !== repoName) {
      addSystemLog('两次输入的仓库名称不一致，已取消删除。');
      return;
    }

    addSystemLog(`正在 GitHub 上删除仓库 [${fullName}]...`);
    const res = await apiPost('/api/github/repos/delete', { owner, repo: repoName });
    if (res.success) {
      addSystemLog(`已成功删除远程仓库 [${fullName}]`);
      delete repoBranchesCache[fullName];
      
      if (currentRepoStatus.isRepo && isMatchingRemote(currentRepoStatus.remoteUrl, fullName)) {
        activeRepoRibbon.classList.add('hidden');
        fileChangesListContainer.innerHTML = '<div class="empty-state-text">关联的远程仓库已被删除。</div>';
        currentRepoStatus.isRepo = false;
      }
      
      activeSelectedRepo = null;
      await fetchGithubRepos();
      branchesListContainer.innerHTML = '<div class="empty-state-text">请在上方选择一个 GitHub 仓库</div>';
      btnDeleteActiveRepo.classList.add('hidden');
    } else {
      addSystemLog(`删除仓库失败: ${res.error}`);
      await showCustomDialog({
        title: '删除失败',
        message: `无法删除仓库，原因: ${res.error}。请检查您的 Access Token 是否具有 delete_repo 权限。`,
        confirmText: '我知道了'
      });
    }
  }
}

// Console terminal polling logs
async function pollLogs() {
  const res = await apiGet(`/api/git-logs?offset=${logOffset}`);
  if (res && res.success && Array.isArray(res.logs) && res.logs.length > 0) {
    res.logs.forEach(log => {
      const line = document.createElement('div');
      line.className = `console-line ${log.type}`;
      line.innerText = log.text;
      consoleOutputBox.appendChild(line);
    });
    
    // Cap console DOM elements to 200 to prevent rendering lag
    while (consoleOutputBox.children.length > 200) {
      consoleOutputBox.removeChild(consoleOutputBox.firstChild);
    }
    
    consoleOutputBox.scrollTop = consoleOutputBox.scrollHeight;
    logOffset = res.nextOffset;
  }
}

// Clear console logs
btnClearLogs.addEventListener('click', async () => {
  const res = await apiPost('/api/git-logs/clear');
  if (res.success) {
    consoleOutputBox.innerHTML = '';
    logOffset = 0;
    addSystemLog('控制台已清空。');
  }
});

// Drag and drop folders logic
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.getElementById('drag-overlay').classList.remove('hidden');
});

document.getElementById('drag-overlay').addEventListener('dragleave', (e) => {
  document.getElementById('drag-overlay').classList.add('hidden');
});

document.getElementById('drag-overlay').addEventListener('drop', (e) => {
  e.preventDefault();
  document.getElementById('drag-overlay').classList.add('hidden');
  
  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    const file = files[0];
    if (file.path) {
      pathInput.value = file.path;
      loadProjectPath(file.path);
    } else {
      addSystemLog('检测到拖入文件。如果在浏览器中无法自动读取绝对路径，请直接将文件夹拖入顶部输入框中，或者复制粘贴该文件夹的绝对路径。');
    }
  }
});

// Modal background click close helpers
diffModal.addEventListener('click', (e) => {
  if (e.target === diffModal) closeDiffModal();
});
authModal.addEventListener('click', (e) => {
  if (e.target === authModal) toggleAuthModal();
});
createRepoModal.addEventListener('click', (e) => {
  if (e.target === createRepoModal) closeCreateRepoModal();
});

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  loadServerConfig();
  
  // Poll logs every 1500ms
  setInterval(pollLogs, 1500);
});
