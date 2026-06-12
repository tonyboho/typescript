# Agent Notes: ts-mixin-class

This package follows the same broad shape as `tools/ts-lazy-property`: it is a `ts-patch`
ProgramTransformer plus a small runtime helper. The design goal is specified in
`SPEC.md`; the original scratch spikes have mostly been promoted into fixture and
tsserver tests.

Current implementation status (SPEC.md plan):

- [x] Step 1: runtime helper with C3 linearization, cached mixin linearizations, cached
  applications per `(mixin, base)`, and `Symbol.hasInstance` support. Generated consumer
  bases call `mixinChain(Base, M1, M2)`; generated mixin values are registered with
  `defineMixinClass(...)`. The canonical class returned by `defineMixinClass` is also
  stored as the cached application of that mixin to its canonical requirement base, so
  sibling/deeper dependents reuse existing chain segments instead of rebuilding them.
- [x] Step 2: mixin-class expansion (print + reparse mode). A top-level class decorated
  with `@mixin(...)` (imported from this package) is replaced with three declarations:
  `interface X<T>` (instance member signatures), `const X$mixin = function <T>(base)
  { return class extends base {...} }` (the single copy of the body) and
  `const X = defineMixinClass(...) as unknown as ...` (the value, with statics extracted
  via `ClassStatics`). Mixin dependencies declared with `implements` produce a typed
  `base` parameter and a runtime dependency list.
  If a mixin class declares `extends RequiredBase`, that base is treated as a required
  base constraint, not as a fixed final base: the factory receives
  `AnyConstructor<RequiredBase>`, the generated interface extends `RequiredBase`, and
  `defineMixinClass(..., RequiredBase)` records the runtime requirement.
  Consumers with an explicit base get a generated type-alias constraint that rejects
  unrelated bases during typecheck. Imported/declaration mixins carry the constraint
  through `RuntimeMixinClass<RequiredBase>` and `typeof Mixin["$requiredBase"]`.
- [x] Step 3: cross-file mixin registry (program pre-scan + module resolution).
  `tests/fixture-suite` imports mixin classes from `src/mixins.ts` and verifies that a
  consumer in another file receives their members, statics, and generics at compile time.
- [x] Step 4: consumer transformation. A class whose `implements` list references
  mixin classes is expanded into `interface X$base` (repeats the mixin entries of the
  implements list verbatim - declaration merging provides the member types) +
  `class X$base extends (mixinChain(...) as unknown as typeof Base &
  ClassStatics<...>)` (runtime chain with transitive dependencies
  linearized/deduplicated) + the original
  class with its `extends` switched to `X$base<TypeParams>`. Non-mixin implements
  entries stay out of `X$base` so the contract check still applies.
  Consumers without an explicit base get a generated empty base class (`X$empty`) and
  the runtime chain starts from that class instead of `Object`; if a consumed mixin has
  a required base, a no-base consumer starts from that required base instead.
  Generic consumer bases (`extends Base<T>`) are supported for instance typing and
  runtime.
- [x] Step 5: fixture coverage for the core proof of concept. `tests/fixture-suite`
  builds and runs under real `tsc + ts-patch` in standard and legacy decorator modes.
  Coverage includes cross-file consumers (`basic.t.ts`), no-base consumers and consumer
  subclassing (`heritage.t.ts`), static inheritance (`statics.t.ts`), self-reference
  from inside a mixin body (`self-reference.t.ts`), required-base mixins
  (`required-base.t.ts`), negative imported/declaration required-base builds, generic
  bases, imported mixins, `super` chains, and runtime behavior.
- [ ] Step 5 remaining: add more negative type fixtures (`@ts-expect-error`) for wrong
  generic arguments/consumer contracts and add an explicit diamond/conflicting-order
  fixture on the generated transformer output, not only the runtime helper.
- [ ] Step 6: diagnostics. Constraint violations (constructor/private/protected/abstract
  on a mixin class, members without explicit type annotations, unsupported exports, and
  required-base combinations that cannot be checked structurally) currently throw
  `MixinTransformError` or runtime errors; convert them to proper `ts.Diagnostic`
  reporting with original source positions where possible. Static-name collision
  reporting is still not implemented.
- [x] Step 7 proof: declaration-file consumption between packages. `tests/fixture-suite`
  emits declarations and `tests/declaration-fixture-suite` imports it as a workspace
  dependency, then verifies typing and runtime through the generated `.d.ts`/`.js`
  package boundary.
- [ ] Step 7 remaining: harden public declaration emit for package-quality output:
  exported helper/intermediate declarations, stable public names, unsupported
  `export default` behavior, no-base consumer startup from imported `.d.ts`
  required-base metadata, and README/API documentation still need review.
- [x] Step 8: position-preserving IDE mode. The compiler host keeps original
  `SourceFile.text` in noEmit/IDE mode and overlays a transformed AST. Tests cover
  source-text preservation, source-position stability outside generated declarations,
  tsserver definition, definitionAndBoundSpan, quickinfo, and rename for plain classes,
  local/imported mixin members, fixture-like imported generic mixins, `this`, external
  consumer access, and `super` calls.
- [ ] Step 8 remaining: continue dogfooding in the IDE and add regression tests for any
  editor operation that still behaves differently from plain TypeScript. Known areas to
  watch: overlapping rename edits, SourceFile caching/reuse (`hasDifferentAstShape`),
  and editor features that distinguish interface/type/value declarations.
- Consumer limitations for now: consumers must be top-level named class declarations.
- Generic consumer bases are supported for instance typing and runtime, but the generated
  runtime `extends` cast intentionally uses `AnyConstructor` plus
  `ClassStatics<typeof Base>` because TypeScript forbids referencing consumer type
  parameters in base-class expressions (`TS2562`); constructor argument types are therefore
  permissive for this case.

Implementation notes:

- Entry point: `src/index.ts`. Default export: `transformProgram`.
- Compiler host mode mirrors `ts-lazy-property`: emit builds use printed transformed
  source, while IDE/noEmit/tsserver mode returns the transformed AST over the original
  `SourceFile.text` so editor ranges/highlights keep source coordinates. The config
  option `mode` can force `"emit"` or `"ide"`.
- Keep import-aware detection. A local function named `mixin` must not be treated as the
  package marker.
- Generated code imports `type AnyConstructor` / `type ClassStatics` from the package
  (specifier-level type imports - `createImportClause` changed its signature in TS 6).
- Constraint violations (constructor/private/protected/abstract on a mixin class,
  members without explicit type annotations) currently throw `MixinTransformError`;
  proper ts.Diagnostic reporting is planned for step 6. `extends` on a mixin is allowed
  and means "required base".
- Known not-yet-handled: name collisions with the injected helper type import, mixin
  classes nested in namespaces/functions, `export default` mixin classes.
- `README.md` is stale and still describes the early skeleton/no-op transformer.
- Mixin class members must not use `private` or `protected` (root `AGENTS.md` rule);
  the transformer enforces this.
- Tests: `tests/runtime-helper.t.ts` (C3 order, application cache, `instanceof`),
  `tests/compiler-host-source-view.t.ts` (compiler-host IDE/emit source text mode),
  `tests/source-transform.t.ts` (AST/printed assertions + a full in-memory
  typecheck of transformed output via `typecheckText` in `tests/util.ts`),
  `tests/source-position-preservation.t.ts` (stable source positions outside
  generated top-level declarations) and
  `tests/tsserver-editor-features.t.ts` (definition/quickinfo/rename through tsserver),
  `tests/fixture-build-and-runtime.t.ts` (real `tsc + ts-patch` standard/legacy decorator
  builds plus runtime Siesta runs of `tests/fixture-suite`), and
  `tests/declaration-fixture-build-and-runtime.t.ts` (workspace package boundary using
  emitted declarations from `tests/fixture-suite`).
