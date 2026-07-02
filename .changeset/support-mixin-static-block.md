---
"ts-mixin-class": patch
---

A `static {}` initialization block on a `@mixin` class is now supported (previously rejected
with TS990004). The block stays in the factory class expression, so it runs once per distinct
base the mixin is applied over — the canonical standalone class plus each consumer application,
memoized per base (base-less consumers each bring their own synthetic empty base) — the same
per-application semantics static field initializers already have. Note: inside a mixin's static
block refer to the class as `this`, never by its name — the canonical invocation happens inside
`defineMixinClass(...)`, before the class constant is initialized (TDZ).
