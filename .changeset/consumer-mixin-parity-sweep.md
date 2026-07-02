---
"ts-mixin-class": patch
---

A consumer ↔ mixin PARITY sweep: consumers and mixins take different code paths, so every
consumer-verified feature is now pinned on the mixin side too (this exact gap held the recent
real bugs — the generic construction mixin, the mixin-emit `hasStaticNew` gate). All pins came
up green: TS990008 for a later-declared mixin DEPENDENCY, a barrel-imported dependency, the
TS990010 kind guard for a mixin burying its dependency's accessor, a plain class subclassing a
mixin value directly (`extends`, not `implements`), a construction mixin in a NESTED scope, and
the full config-shape matrix of a construction mixin's own `.new` (split accessor keyed by the
setter, `readonly`/`!`/unknown keys, parameter properties, layering through a dependency,
config-alias export tracking). The parity axis is now documented in USE-CASES.md as a standing
review question for future pins.
