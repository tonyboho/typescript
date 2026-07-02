---
"ts-mixin-class": patch
---

A fifth coverage pass: auto-accessor support, variance-annotation stripping, and a batch of pins.

- **AUTO-ACCESSORS (`accessor x: T`, TS 4.9) on a mixin are handled by their RUNTIME kind** —
  a get/set pair on the prototype, not a field: the generated interface carries real `get`/`set`
  signatures (§1.27), and the TS990010 member-kind guard classifies them as accessors (a consumer
  FIELD over a mixin `accessor` is rejected under define semantics; a get/set PAIR over one is a
  legal accessor-over-accessor override). The one extension to the define-only gating: an
  auto-accessor overriding a DEEPER FIELD is rejected under BOTH semantics — its private backing
  slot is installed only after `super()` returns, so under set semantics the deeper field's
  constructor assignment fires the generated setter before the slot exists (a guaranteed
  TypeError at construction).
- **Variance annotations (`in`/`out`) on a generic mixin's type parameters no longer break the
  build**: they are stripped when the parameters are cloned into generated SIGNATURE positions
  (the factory function expression, the generic value-cast constructor type, the `.mix` apply
  function type — TS1274) and kept on the generated interface, the annotations' surviving
  carrier after the class is erased in emit.
- Newly pinned: a mixin's SPLIT accessor pair consumed through a published `.d.ts` package keeps
  its distinct read/write types; a public PARAMETER PROPERTY on a construction class's own
  constructor is an optional `.new` config key present in `<Class>Config`; a `declare` (ambient)
  mixin field stays type-only — never emitted, never filled.
