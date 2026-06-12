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
  statics, self-reference, `super` chains, plain non-mixin `implements` contracts on
  mixin classes, direct canonical mixin instantiation
  (including required-base and dependent mixins), `instanceof` for direct and transitive
  consumed mixins, named default-exported mixins, required-base positive/negative cases,
  consumer contract negative builds,
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
- Runtime mixin metadata is exposed through exported unique symbols
  (`factory`, `requirements`, `base`) instead of string properties, so class values
  stay introspectable without showing `$mixin`-style fields as normal public API
  members. Fixture tests exercise user-facing introspection for factory, requirements,
  and required-base metadata.
- Static collision diagnostics are configurable through `staticCollisionCheck`.
  Default `"never"` mode uses a cheaper `StaticNeverConflictKeys` type-level check
  that catches impossible static field/property intersections. `"strict"` enables
  the stronger assignability-based `StaticStrictConflictKeys` check, including
  method-shaped static collisions. `false` disables these diagnostics.
- Declaration package-boundary coverage includes named and default-exported mixins.
  Tests assert that required generated factories are exported in `.d.ts`, default mixin
  declarations preserve `export default`, and downstream consumers can import default
  mixins through package exports.
- Consumer constructor arguments are intentionally permissive (`AnyConstructor`) even for
  generic bases. Instance members, `super`, runtime inheritance, and statics are typed;
  construction will later be modeled through an explicit static factory/new protocol
  instead of trying to merge arbitrary constructor signatures from mixins and bases.

Active gaps:

- Architectural consumer limitation: consumers must currently be named top-level class
  declarations. Named class declarations inside blocks/functions/namespaces could be
  supported later by transforming nested statement lists, but class expressions and
  anonymous classes need a separate transform shape because the current declaration
  merging strategy requires a stable declaration name for generated `__Name$base`
  siblings. Anonymous consumer declarations currently get a custom diagnostic.
- Name collisions with injected helper imports and generated helper declarations are
  not handled yet. Generated top-level names use a double-underscore prefix to reduce
  risk, but there is no collision scan/diagnostic for user declarations such as
  `__Source$mixin`, `__Consumer$base`, or imported helper aliases.
- `README.md` is stale and still describes the early skeleton/no-op transformer.
- Continue IDE dogfooding and add regression tests for any editor operation that still
  behaves differently from plain TypeScript. Existing coverage includes definition,
  quickinfo, references, rename, semantic diagnostics, and source-position preservation.

Future Work:

- Support dynamic consumer base expressions instead of rejecting them. Likely shape:
  generate a stable runtime base constant preserving evaluation order, for example
  `const Consumer$runtimeBase = makeBase()`, use it in `mixinChain(...)`, and represent
  the instance side with `InstanceType<typeof Consumer$runtimeBase>` plus mixin
  interfaces, while the runtime/static side is typed as `AnyConstructor` intersected
  with `ClassStatics<typeof Consumer$runtimeBase>` and mixin statics. This needs careful
  declaration emit, source-range preservation, static typing, and runtime semantics tests
  before enabling.
- Add the explicit construction protocol (planned static factory/new shape) instead of
  trying to merge arbitrary constructor signatures from bases and mixins.

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
- Unsupported shapes are tracked in Active gaps above: helper/generated-name collisions
  and mixin/consumer classes nested in namespaces/functions.
- Mixin class members must not use `private` or `protected` (root `AGENTS.md` rule);
  the transformer enforces this.
- Tests: `tests/runtime-helper.t.ts` (C3 order, application cache, `instanceof`),
  `tests/compiler-host-source-view.t.ts` (compiler-host IDE/emit source text mode),
  `tests/source-transform-mixins.t.ts` (mixin marker detection and mixin declaration
  expansion), `tests/source-transform-consumer-emit.t.ts` (consumer expansion printed
  output), `tests/source-transform-consumer-typecheck.t.ts` (consumer transformed
  output in-memory typecheck via `typecheckText` in `tests/util.ts`),
  `tests/source-transform-diagnostics.t.ts` (transform-time/type-level diagnostic
  emit assertions), `tests/source-position-preservation.t.ts` (stable source positions
  outside generated top-level declarations), `tests/tsserver-definition.t.ts`
  (definition/definitionAndBoundSpan through tsserver), `tests/tsserver-quickinfo.t.ts`
  (quickinfo through tsserver), `tests/tsserver-references.t.ts` (find references
  through tsserver), `tests/tsserver-rename.t.ts` (method/property rename through
  tsserver), `tests/tsserver-diagnostics.t.ts` (semantic diagnostics through tsserver),
  `tests/fixture-build-and-runtime.t.ts` (real `tsc + ts-patch` standard/legacy
  decorator builds plus runtime Siesta runs of `tests/fixture-suite`), and
  `tests/declaration-fixture-build-and-runtime.t.ts` (workspace package boundary using
  emitted declarations from `tests/fixture-suite`).
- Fixture layout: `tests/fixture-suite/src/mixins.ts` and `default-mixin.ts` are the
  exported library surface used by package-boundary declaration tests. Runtime scenario
  files are named by behavior: `consumer-imported-mixins.t.ts`,
  `consumer-inheritance.t.ts`, `required-base-local.t.ts`,
  `required-base-imported-no-base.t.ts`, `type-only-imported-mixin.t.ts`,
  `default-mixin-consumer.t.ts`, `mixin-statics.t.ts`, and
  `mixin-self-reference.t.ts`. Declaration fixture files use the `package-*` prefix
  because they consume the built fixture package through `.d.ts` files.
