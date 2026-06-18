---
"ts-mixin-class": patch
---

Fix two source-view navigation span defects where a quickinfo/hover highlight landed off the symbol. Every generated type-parameter clone of a consumer was pinned to the whole `<T, A>` list range, so hovering a later parameter (`A`) resolved to the first (`T`) and highlighted the entire list; each clone now maps onto its own source parameter. A mixin's rewritten `extends Base` reference spanned the whole heritage clause, so hovering the source base name highlighted all of `extends Base`; the generated reference is now pinned onto the source base type name. Both are covered by the `stress-quickinfo` corpus sweep.
