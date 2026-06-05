# ts-lazy-property basic project

Small workspace fixture for manually checking `ts-lazy-property` in an editor.

Open this folder directly in VS Code/Cursor and use the workspace TypeScript version. The `src/basic.ts` file should typecheck with `instance.$lazyProperty`, while the visible source text stays unchanged.

Useful commands:

```shell
pnpm --dir tools/ts-lazy-property/fixtures/basic-project run typecheck
pnpm --dir tools/ts-lazy-property/fixtures/basic-project run build
```
