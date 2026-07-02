---
"ts-mixin-class": patch
---

A fourth coverage pass: honest interface accessors, a member-kind override guard, reserved
helper aliases, and a batch of pins.

- **The generated mixin interface now carries REAL `get`/`set` signatures** for accessor
  members (a split pair keeps its distinct read/write types; a set-only accessor becomes a
  true set-only signature) instead of collapsing to a property signature.
- **New native diagnostic TS990010** (the checker's own TS2610/TS2611 never fire through an
  interface-typed base): a class FIELD shadowing a mixin ACCESSOR is rejected in both planes
  under both class-field semantics; an ACCESSOR over a mixin FIELD is rejected **only under
  define semantics** — a deliberate deviation from plain TS, because with
  `useDefineForClassFields: false` the field assignment fires the overriding setter (the
  reactive-property pattern). Covers mixin-vs-mixin overlaps in one `implements` list
  (first-listed = nearest layer) and transitive local `extends` chains.
- **The runtime value helpers are imported under reserved local aliases**
  (`defineMixinClass as __defineMixinClass__`, `__mixinChain__`, `__mixinChainLinearized__`),
  so a user binding named like a helper can never collide with the injected import; the
  language-service plugin keeps the aliases out of completions.
- Newly pinned: one generic mixin instantiated differently by two consumers, a consumer
  forwarding its parameter into two generic mixins, a subclass fixing a generic consumer's
  parameter; field-initializer ORDER across the linearized chain; construction config
  LAYERING down a subclass chain (re-defaulted inherited key + subclass-added required key);
  a local class named `Base`; a doubled `@mixin()` decorator.
