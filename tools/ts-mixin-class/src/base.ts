export type NonFunctionPropertyNames<T> = {
    [Key in keyof T]: T[Key] extends (...args: any[]) => any ? never : Key
}[keyof T]

export type Config<T> = Partial<Pick<T, NonFunctionPropertyNames<T>>>

export class Base {
    initialize(props?: Config<this>): void {
        if (props !== undefined) {
            Object.assign(this, props)
        }
    }

    static new<T extends typeof Base>(this: T, props?: Config<InstanceType<T>>): InstanceType<T> {
        const instance = new this() as InstanceType<T>

        instance.initialize(props)

        return instance
    }

}
