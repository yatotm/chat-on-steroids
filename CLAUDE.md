# Claude repository instructions

Read and follow `AGENTS.md` before changing this repository.

This is a public repository. Never add Claude provenance session URLs or session trailers to
commit messages, files, release notes, logs, or generated artifacts. Maintainer commits must use
a GitHub noreply address; never use a personal mailbox or a private local path. Before every
commit, push, tag, or release, run `npm run verify:privacy`. The versioned Git hooks installed by
`npm run hooks:install` enforce the same policy for Claude-created commits.

Do not bypass these guards with `--no-verify`. If a privacy check blocks a change, remove the
private value at its source and create a new clean commit instead.

后续使用正常 `git commit`，从已经核对过的公共基线继续，不再例行重建提交历史。旧的私有实验
分支仍不得混入公开历史；保留隐私检查、noreply 身份与上游作者历史。

仅在用户明确安排 push 时推送，并把已批准的改动正常合并到 `main`。若该次授权同时允许更新
版本，则同步版本声明、更新发布说明并发布新 release；若只允许 push，则仅合并 `main`，
不自动升级版本、不打发布标签、不创建 release。一次授权不代表以后可自动推送。

Never add a `Co-Authored-By` trailer, a "Generated with" line, or any other Claude attribution to
commits, pull requests, tags or release notes. The maintainer is the only author on this repository.
