import { type ChildSessionFactory, type DefaultChildSessionFactoryOptions } from "../shared/child-session.ts";
export interface RunnerChildSessionConfig {
    /** Test seam: module whose default export is a `ChildSessionFactory`, or a function returning one. */
    childSessionFactoryModule?: string;
}
export declare function loadRunnerChildSessionFactory(config: RunnerChildSessionConfig, options?: DefaultChildSessionFactoryOptions): Promise<ChildSessionFactory>;
//# sourceMappingURL=runner-child-sessions.d.ts.map