# Agent Notes: ts-mixin-class

This package follows the same broad shape as `tools/ts-lazy-property`: it is a `ts-patch`
ProgramTransformer plus a small runtime helper. The design goal is specified in
`SPEC.md`; the original scratch spikes have mostly been promoted into fixture and
tsserver tests.

Implemented snapshot:

- Runtime helper: C3 linearization, cached linearizations/applications, `Symbol.hasInstance`,
  required-base runtime checks, and canonical requirement-chain reuse.
- Emit transform: `@mixin()` classes expand into interface + factory + runtime value;
  consumers expand through a merged intermediate base and `mixinChain(...)`.
- Named `export default class M` mixins are supported; anonymous default mixin classes
  produce a custom diagnostic requiring a stable name.
- Required-base mixins: `@mixin() class M extends RequiredBase` means "M can be applied
  to RequiredBase or its descendants", not "M is permanently based on RequiredBase".
  Explicit-base consumers get typecheck constraints; no-base consumers start from the
  required base. This works for same-file, imported source, and `.d.ts` package-boundary
  mixins, including generated value imports for required bases. Required-base mismatches
  produce a custom TypeScript diagnostic message through a generated conditional type.
- Cross-file registry: program pre-scan + module resolution handles imported mixins,
  transitive dependencies, required-base metadata, and declaration-file consumers.
- Fixture coverage: real `tsc + ts-patch` builds in standard/legacy decorator modes,
  runtime Siesta runs, declaration-package consumers, no-base consumers, generic bases,
  statics, self-reference, `super` chains, named default-exported mixins, required-base
  positive/negative cases, consumer contract negative builds,
  generated diamond/conflicting-order diagnostics, custom diagnostic-message checks,
  declaration-enabled tsserver diagnostics, and tsserver editor behavior.
- Invalid mixin declaration constraints (abstract mixin/member, constructor,
  private/protected/#private members, missing explicit property/method/accessor/parameter
  types, unsupported members) are reported as custom TypeScript diagnostics generated
  through type-level diagnostic aliases instead of transformer exceptions.
- Anonymous mixin consumer class declarations are reported as custom diagnostics requiring
  a stable class name for generated intermediate bases and declarations.
- Unsupported mixin consumer base expressions, such as `extends makeBase()`, are reported
  as custom diagnostics. For now consumers must use named bases like `extends Base` or
  `extends ns.Base`.
- Type-only imported mixins are supported for consumers: the source import remains usable
  for `implements`, and the transformer generates a separate runtime value import alias
  for `mixinChain(...)` and static typing.
- Generated top-level helper names use a double-underscore prefix, for example
  `__Source$mixin`, `__Consumer$base`, `__Consumer$empty`, and
  `__Source$mixinValue`, to reduce accidental collisions with user declarations.

Current plan:

- Harden public declaration emit for package-quality output: exported helper/intermediate
  declarations, stable public names, default-exported mixin declaration shape, and
  README/API documentation.
- Continue IDE dogfooding and add regression tests for any editor operation that still
  behaves differently from plain TypeScript. Watch overlapping rename edits, SourceFile
  caching/reuse (`hasDifferentAstShape`), and features that distinguish interface/type/
  value declarations.
- Consumer limitation to remove later: consumers must be top-level named class
  declarations; anonymous consumer declarations currently get a custom diagnostic.
- Generic consumer bases are supported for instance typing and runtime, but the generated
  runtime `extends` cast intentionally uses `AnyConstructor` plus
  `ClassStatics<typeof Base>` because TypeScript forbids referencing consumer type
  parameters in base-class expressions (`TS2562`); constructor argument types are therefore
  permissive for this case.

Future Work:

- Support dynamic consumer base expressions instead of rejecting them. Likely shape:
  generate a stable runtime base constant preserving evaluation order, for example
  `const Consumer$runtimeBase = makeBase()`, use it in `mixinChain(...)`, and represent
  the instance side with `InstanceType<typeof Consumer$runtimeBase>` plus mixin
  interfaces, while the runtime/static side is typed as `AnyConstructor` intersected
  with `ClassStatics<typeof Consumer$runtimeBase>` and mixin statics. This needs careful
  declaration emit, source-range preservation, static typing, and runtime semantics tests
  before enabling.

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
- Diagnostics that must work in both `tsc` and tsserver are generated via type-level
  diagnostics rather than real custom TS diagnostic codes. `extends` on a mixin is
  allowed and means "required base".
- Known not-yet-handled: name collisions with the injected helper type import, mixin
  classes nested in namespaces/functions.
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
