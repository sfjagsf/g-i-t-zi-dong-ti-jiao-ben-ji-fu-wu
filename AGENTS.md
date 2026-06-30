# AGENTS.md

## 工作语言

- 默认使用中文回复、审查和总结。
- 所有 Git 提交说明必须使用中文，不要使用英文提交标题。

## 项目安全规则

- 重点检查是否误提交 API Key、GitHub Token、`.env`、`config.local.json`、私钥文件和证书文件。
- AI/API 密钥只能保存在 `config.local.json` 或环境变量中，不允许写入已跟踪的默认配置文件。
- 如果发现 `ghp_`、`github_pat_`、`sk-`、`BEGIN PRIVATE KEY` 或明显的 token/password/secret 长密钥值，视为高危问题。

## Review guidelines

- 审查 Git 命令执行逻辑时，确认参数使用数组传入 `execFile`，避免字符串拼接执行 shell。
- 审查路径输入时，确认只能处理用户指定的真实目录和仓库相对路径，避免绝对路径、`..` 或空字节绕过。
- 审查日志输出时，确认 GitHub Token、AI API Key 和带凭证的远程地址会被脱敏。
- 审查前端提交流程时，确认按钮禁用、加载状态、失败恢复、风险确认和刷新状态同步都可靠。
- 不要主动重构无关代码；优先修复会影响提交、推送、配置保存和风险检查的实际问题。
