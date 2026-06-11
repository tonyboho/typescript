# Agent Notes: ts-mixin-class

This package follows the same broad shape as `tools/ts-lazy-property`: it is a `ts-patch`
ProgramTransformer, not a regular runtime library. The design is specified in detail in
`SPEC.md` and backed by executable spikes in `scratch/`.

Current implementation status (SPEC.md plan):

- [x] Step 2: mixin-class expansion (print + reparse mode). A top-level class decorated
  with `@mixin(...)` (imported from this package) is replaced with three declarations:
  `interface X<T>` (instance member signatures), `const X$mixin = <T>(base) => class
  extends base {...}` (the single copy of the body) and `const X = X$mixin(Object) as
  unknown as ...` (the value, with statics extracted via `ClassStatics`).
  Same-file mixin dependencies (declared with `implements`) produce a typed `base`
  parameter and a nested factory chain.
- [x] Step 4: consumer transformation. A class whose `implements` list references
  same-file mixin classes is expanded into `interface X$base` (repeats the mixin
  entries of the implements list verbatim - declaration merging provides the member
  types) + `class X$base extends (chain as unknown as typeof Base & ClassStatics<...>)`
  (runtime chain with transitive dependencies linearized/deduplicated) + the original
  class with its `extends` switched to `X$base<TypeParams>`. Non-mixin implements
  entries stay out of `X$base` so the contract check still applies.
  `tests/fixture-suite` (basic.t.ts) builds under real tsc + ts-patch.
- [x] Step 1: runtime helper with C3 linearization, cached mixin linearizations, cached
  applications per `(mixin, base)`, and `Symbol.hasInstance` support. Generated consumer
  bases call `mixinChain(Base, M1, M2)`; generated mixin values are registered with
  `defineMixinClass(...)`. The canonical class returned by `defineMixinClass` is also
  stored as the cached application of that mixin to its canonical requirement base, so
  sibling/deeper dependents reuse existing chain segments instead of rebuilding them.
- [x] Step 3: cross-file mixin registry (program pre-scan + module resolution).
  `tests/fixture-suite` imports mixin classes from `src/mixins.ts` and verifies that a
  consumer in another file receives their members, statics, and generics at compile time.
- [ ] Steps 5-8: more fixtures, proper diagnostics, declaration emit,
  position-preserving tsserver mode.
- Consumer limitations for now: generic base classes (`extends Base<T>`) are rejected,
  intermediate declarations are not exported (declaration emit will need this),
  consumers must be top-level named class declarations.

Implementation notes:

- Entry point: `src/index.ts`. Default export: `transformProgram`.
- Keep import-aware detection. A local function named `mixin` must not be treated as the
  package marker.
- Generated code imports `type AnyConstructor` / `type ClassStatics` from the package
  (specifier-level type imports - `createImportClause` changed its signature in TS 6).
- Constraint violations (extends/constructor/private/protected/abstract on a mixin class,
  members without explicit type annotations) currently throw `MixinTransformError`;
  proper ts.Diagnostic reporting is planned for step 6.
- Known not-yet-handled: name collisions with the injected helper type import, mixin
  classes nested in namespaces/functions, `export default` mixin classes.
- Mixin class members must not use `private` or `protected` (root `AGENTS.md` rule);
  the transformer enforces this.
- Tests: `tests/runtime-helper.t.ts` (C3 order, application cache, `instanceof`),
  `tests/source-transform.t.ts` (AST/printed assertions + a full in-memory
  typecheck of transformed output via `typecheckText` in `tests/util.ts`) and
  `tests/fixture-build-and-runtime.t.ts` (real `tsc + ts-patch` standard/legacy decorator
  builds plus runtime Siesta runs of `tests/fixture-suite`).
  Fixture coverage includes cross-file consumers (`basic.t.ts`), static inheritance
  (`statics.t.ts`), and self-reference from inside a mixin body (`self-reference.t.ts`).
