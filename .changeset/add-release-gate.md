---
---

Add a pre-release gate (`release:check`): clean → typecheck → build → lint → test → publint → attw, wired into `release` before `changeset publish`.
