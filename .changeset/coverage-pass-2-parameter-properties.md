---
"ts-mixin-class": patch
---

A second coverage pass over the use-case catalog: one fix and a batch of newly pinned edge cases.

- **Fixed: parameter properties in a mixin's own constructor** (`constructor(public label:
  string = …)`) were dropped from the generated mixin interface on the EMIT plane — the runtime
  instance carried the member while the type denied it (TS2339 on the consumer); source view was
  already clean, so this was also a plane divergence. They now become interface property
  signatures (`readonly` survives); `private`/`protected` and missing-type parameter properties
  are diagnosed like declared fields.
- Newly pinned by fixtures: exotic member shapes (a default parameter value → optional signature
  parameter; optional + rest parameters; a set-only accessor; string-literal and numeric member
  names; optional members); a consumer implementing a mixin and a plain interface side by side
  (the plain contract stays enforced); the same mixin listed twice (tolerated, applied once);
  consumers declared inside a `static {}` block and in try/catch/finally blocks; a consumer's own
  parameter-property constructor.
- Deferred (xit + TODO): QUALIFIED mixin references (`implements lib.Logger` via a namespace
  import, `implements NS.Tagger` via a local namespace) are not resolved — pinned as skipped
  tests with a TODO design sketch.
