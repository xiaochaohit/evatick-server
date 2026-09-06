# Codex Project Instructions

Before changing this repository, read `CONTEXT.md` for domain language and context.
Development workflow and security rules are maintained in this file.

## Required workflow

- Commit every completed code change before ending the task. Do not leave Codex-authored code changes only in the working tree.
- Keep commits focused and stage only files that belong to the current task. Never include unrelated pre-existing changes.
- Before every commit, inspect `git status` and the staged diff.
- Never commit secrets or sensitive information, including API keys, access tokens, passwords, private keys, credentials, or populated environment files. Use environment variables and redacted example placeholders instead.
- Supply sensitive values through environment variables or secure secret management; example files must use explicit placeholders.
- If sensitive information is found, stop it from being committed, remove it from the change, and tell the user if the exposed credential may need rotation.
