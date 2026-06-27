---
"ts-mixin-class": patch
---

Name the generated `<Class>Config` alias in the editor. A failing
`<Class>.new({ ... })`, or any reference to the config type, used to show a
meaningless `}` where the alias name belongs; the IDE now reads the real
`<Class>Config` name in diagnostics, hovers, and quickinfo — generics included.

This adds a companion language-service plugin. Register it next to the program
transform in `tsconfig.json` so editor navigation (go-to-definition,
find-references, rename) stays clean for the generated aliases:

```json
{
    "compilerOptions": {
        "plugins": [
            { "transform": "ts-mixin-class", "transformProgram": true },
            { "name": "ts-mixin-class/language-service-plugin" }
        ]
    }
}
```

It is optional but recommended.
