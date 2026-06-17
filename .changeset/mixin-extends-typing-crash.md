---
"ts-mixin-class": patch
---

Fix the source-view transform throwing on a half-typed `@mixin class X extends ` (the body `{` is parsed as an object-literal base during incremental re-parsing). The throw crashed the whole tsserver program build, which fell back to the untransformed program for the entire project — so unrelated construction-base classes lost their generated `static new` and the broken state stuck until a server restart. `requiredBaseType` now treats any non-entity-name `extends` base as no base, and `deepCloneNode` falls back to a trivia-preserving clone when the source-file-resolving path fails.
