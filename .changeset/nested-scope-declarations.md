---
"ts-mixin-class": patch
---

A `@mixin` or a mixin consumer may now be declared **anywhere a class declaration is legal** —
inside a function body or a block, not just at the top level. The generated helpers are emitted
into the same scope as the class, so it works on both planes (a `tsc` build and the editor:
navigation, quickinfo, diagnostics, declaration emit).

- **Consumer and `@mixin` relax together** — both work nested. A nested class is a local: it
  cannot be exported, and it never leaks its (or a generated helper's) name into the `.d.ts` (an
  escaping instance widens to its structural shape).
- **Two same-named nested mixins in sibling scopes** each expand from their own declaration, and a
  nested mixin **shadowing** a top-level one resolves correctly at its consumer.
- **Nested construction classes** (`extends Base`) work too — the generated static `.new(...)` and
  the `<Name>Config` alias land in the block and construct through the inherited `Base.new`.
- **Class expressions** (`const C = class implements M {}`, anonymous or named) remain unsupported
  — they have no stable statement slot — but are now flagged with a clean diagnostic (TS990002 for
  a `@mixin`, TS990003 for a consumer) instead of a bare TS2420.

Note: a nested mixin/consumer's runtime setup runs on each call of its enclosing function (no
leak; just not memoized across calls), like any class declared inside a function.
