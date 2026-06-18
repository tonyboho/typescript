---
"ts-mixin-class": patch
---

Fix language-server navigation on a mixin consumer class's own name. The generated `$base` interface and class were range-mapped onto the consumer's header in source view, so they overlapped the original class name and its type parameters. `getTokenAtPosition` then resolved a click on the consumer name to the overlapping `$base` node, so find-all-references and go-to-definition on a consumer class name missed the declaration itself (clicking the class name in the editor did nothing), and quickinfo on a later type parameter (`Consumer<T, A>`'s `A`) resolved to the first one. The generated `$base` helpers — which are internal and never navigated to — are now collapsed to an off-screen range for consumers as well as for decorated mixins, so the real, position-preserved declaration owns its source positions again. Declaration emit and required-base diagnostics are unaffected (they are positioned from the real consumer, not from the `$base` ranges).
