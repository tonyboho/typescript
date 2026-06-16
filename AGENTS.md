# Project workflow rules

## Private and protected class members in mixins

Do not use `private` and `protected` modifiers for members of the mixin classes (created with `ts-mixin-class` facilities). They do not work well for mixins. Just declare a regular member of the class.

## Linter and stylistic issues

If you find a stylistic issue (an ESLint warning, including from `@stylistic/eslint-plugin` and alignment rules) — do not fix it manually one by one.

Instead, in the package directory that defines `lint:fix`, run:

```bash
pnpm run lint:fix
```

If, after such run there are still some stylistic warnings you can ignore them.

## Comments

Comments should be written in English.

## Build artefacts

Treat build artefacts (`/dist` directory, various bundles, etc) as disposable things, do not hesitate to remove them completely and re-create.

Removing `/dists` is needed when you've changed the branch or reset repo to a different commit for example. Also it is needed, when you've renamed some test files.

## `/dist` directory

Once you've launch build, either using `npx tsc` or `pnpm run build` and it completed correctly - assume all sources have been correctly placed into the `/dist` directory. Do not manually check that source files has been updated in `/dist` - that is waste of time.


## Dependencies

Do not hesitate adding dependencies to the packages. Use `pnpm` for that. Its fast and cheap. Always specify the exact version of the package, not a range.


## Git ignore

When writing .gitignore files, always prefer specifing the exact paths starting from the repo root:

    /dist

instead of

    dist

This is to match only the intended directory and not any other.

## Usage of @bryntum/siesta testing library

For internal launches, add `--no-color` option to disable coloring and visual effects in terminal output.

Siesta tests are regular Node.js executables, if you need to launch a single test, you can just launch its file with Node:

    node path/to/test.t.js