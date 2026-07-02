---
"ts-mixin-class": patch
---

A coverage pass over the use-case catalog: two fixes and a batch of newly pinned edge cases.

- **Fixed: a mixin/consumer declared in a `switch` case/default clause** was indexed as nested
  but silently never expanded (a clause's statement list is not a `Block`); it now splices into
  the clause on both planes. The other statement-list containers — a class method body, a getter
  body, an arrow function body, a namespace — are pinned by tests too.
- **Fixed: editor completions offered the generated helper names** (`__X$base`, `__X$empty`,
  `__X$mixin`) as phantom entries in scope-level identifier lists; the language-service plugin now
  filters them. Completions (`this.` members, the `.new({ … })` config keys), signature help on
  `.new(`, the navigation tree, and folding spans are now covered by tests.
- **New native diagnostic TS990008**: a class applying a local mixin declared LATER in the same
  scope (plain TS allows the type-only `implements`, but the generated value reference would hit
  the const TDZ at runtime) — spanned on the heritage reference, in both planes. A deferred-scope
  use (a function body applying a later top-level mixin) stays legal.
- A `static {}` block on a `@mixin` is now diagnosed as "static initialization block" instead of
  the misleading "member constructor" (a consumer's static block is supported and pinned).
- Newly pinned by fixtures/tests: async / generator / async-generator mixin methods; computed
  symbol-named members; a user decorator on a consumer (incl. a construction consumer); the
  `const K = Mixin.mix(Base)` workaround; two same-named mixins from different files; circularly
  importing mixin files; a NodeNext `type: module` package (emit + `--noEmit` + runtime).
