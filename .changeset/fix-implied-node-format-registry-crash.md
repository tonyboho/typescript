---
"ts-mixin-class": patch
---

Fix a tsserver crash (`Debug Failure`) on every edit in a package that uses
`moduleResolution` `node16`/`nodenext`. A source file the transform re-creates from existing
text — the source-view clone and the emit reprint — dropped the original's `impliedNodeFormat`.
Under node16/nodenext that field is part of the `DocumentRegistry` bucket key, so the file was
acquired under one key but released under another on the next incremental program build, aborting
the diagnostics request — the editor then silently showed no errors at all. Re-created source
files now carry `impliedNodeFormat`.
