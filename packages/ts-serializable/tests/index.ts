import { Project } from "@bryntum/siesta/nodejs.js"

const project = Project.new({
    title                   : 'ts-serializable test suite',

    testDescriptor          : {}
})

project.plan(
    'serializable.t.js',
    'serializable_scoped.t.js'
)

project.start()
