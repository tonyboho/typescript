# Benchmarks

The base benchmark suite is the default entry point:

```bash
pnpm run bench
```

For output without pnpm's command echo, run:

```bash
pnpm --silent run bench
```

It builds the package and prints one transform-pass table plus end-to-end
fixture tables:

- `Transform-pass source-view benchmark`
- `Compile benchmark`
- `Tsserver semantic diagnostics benchmark`
- `Tsserver edit processing benchmark`

Each table row is one scenario. The duration columns are per operation:

- transform-pass rows report one source-view transform pass
- compile rows report one clean `tsc -p` run
- tsserver diagnostics rows report one `semanticDiagnosticsSync` request
- edit rows report one edit plus one consumer `semanticDiagnosticsSync` request

By default, tables are compact and show only the median duration. Use the full
table mode for min, median, mean, max, sample count, and transform-pass step
breakdown:

```bash
TS_MIXIN_BENCH_TABLE=full pnpm run bench
```

## Modes

```bash
pnpm run bench
pnpm run bench:transform
pnpm run bench:compile
pnpm run bench:tsserver
pnpm run bench:edit
pnpm run bench:transform-pass
```

`bench:transform-pass` runs the older focused transform-pass step breakdown.
`bench:transform` runs the transform-pass scenarios inside the base suite table
format.

## Common settings

```bash
TS_MIXIN_BENCH_ITERATIONS=5
TS_MIXIN_BENCH_WARMUPS=1
TS_MIXIN_BENCH_TABLE=compact
TS_MIXIN_BENCH_OUTPUT=bench/baseline-suite-raw.txt
```

## Transform-pass scenarios

The base suite accepts transform-pass scenarios as:

```bash
TS_MIXIN_BENCH_TRANSFORM_SCENARIOS=mixins:props:window:consumers,...
TS_MIXIN_BENCH_TRANSFORM_ITERATIONS=80
```

Example:

```bash
env TS_MIXIN_BENCH_TRANSFORM_SCENARIOS=80:3:4:8,300:5:8:8 \
    TS_MIXIN_BENCH_TRANSFORM_ITERATIONS=120 \
    pnpm run bench:transform
```

`TS_MIXIN_BENCH_TRANSFORM_ITERATIONS` is the number of internal transform passes
inside each measured sample. Increasing it makes the per-pass timing steadier.

## End-to-end fixture scenarios

```bash
TS_MIXIN_BENCH_SIZES=10,30
TS_MIXIN_BENCH_TSSERVER_SIZES=10,30
TS_MIXIN_BENCH_EDIT_SIZES=10,30
TS_MIXIN_BENCH_CONSTRUCTION=plain
TS_MIXIN_BENCH_PROPERTY_COUNT=1
TS_MIXIN_BENCH_PROPERTY_VISIBILITY=implicit
TS_MIXIN_BENCH_DEP_MIN=1
TS_MIXIN_BENCH_DEP_MAX=3
TS_MIXIN_BENCH_DEP_WINDOW=8
TS_MIXIN_BENCH_EDIT_COUNT=8
```

`TS_MIXIN_BENCH_SIZES` is the default size list for compile, tsserver, and edit
fixture groups. `TS_MIXIN_BENCH_TSSERVER_SIZES` and
`TS_MIXIN_BENCH_EDIT_SIZES` override it for their specific groups.

Use `TS_MIXIN_BENCH_PROPERTY_VISIBILITY=public` to generate explicit `public`
fields. The default `implicit` mode generates the same fields without an
accessibility modifier.

Use `TS_MIXIN_BENCH_CONSTRUCTION=base` to make fixture consumers extend
`ts-mixin-class/base` and call `Consumer.new(...)`, which exercises the
public-only construction config path.

Large release-style run:

```bash
env TS_MIXIN_BENCH_SIZES=25,100,250 \
    TS_MIXIN_BENCH_TSSERVER_SIZES=25,100 \
    TS_MIXIN_BENCH_EDIT_SIZES=25,100 \
    TS_MIXIN_BENCH_DEP_MIN=2 \
    TS_MIXIN_BENCH_DEP_MAX=5 \
    TS_MIXIN_BENCH_DEP_WINDOW=24 \
    pnpm run bench
```
