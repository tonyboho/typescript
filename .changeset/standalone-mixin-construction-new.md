---
"ts-mixin-class": patch
---

Fix `Mixin.new()` on a standalone construction-base mixin resolving to `Base` instead of the mixin's own instance type. The source-view class form now regenerates its own `static new`, the emit value cast prepends a construction `new`, and consumers exclude an applied mixin's `new` from their inherited statics. Also removed the `instance-type` construction config mode (and the `constructionConfig` option / `ConstructionConfigMode` type); the public-only config is now the only behavior.
