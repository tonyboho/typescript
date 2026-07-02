---
"ts-mixin-class": patch
---

A third coverage pass over the use-case catalog: a new native diagnostic and a batch of pins.

- **New native diagnostic TS990009**: an INSTANTIATED namespace merged with a `@mixin` class
  (the static-helper pattern) is rejected on the namespace name in both planes — the class is
  rewritten into a `const`, which a namespace cannot merge with, silently losing the namespace
  exports from the mixin's value type. The message points at static members as the supported
  alternative. A TYPE-ONLY namespace merge stays legal and un-diagnosed.
- Newly pinned: a subclass of a consumer adding MORE mixins (both mixin sets, `super` order,
  `instanceof` per layer); an interface merged with a mixin class (trusted members, plain-TS
  class-interface-merge semantics through the chain); `this`-typed parameters and self-named
  member types; a mixin with a dependency and a plain interface contract in one `implements`
  list; a type-only import referenced only from a mixin member signature surviving the import
  pruner; a construction-base mixin imported through a re-export barrel.
- Deferred (xit + TODO): construction through a manual `.mix` heritage
  (`class X extends M.mix(BaseDescendant)`) is not construction-recognized — the class keeps
  the inherited `.new` with no own config aggregation.
