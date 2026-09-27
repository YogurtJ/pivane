import { fileURLToPath } from 'node:url';
import upstream from '../vendor/pi-subagents/index.js';
import { setChildSessionFactory, setChildSessionFactoryModule } from '../vendor/pi-subagents/src/runs/shared/child-session.js';
import childFactory from './pi-subagent-child-factory.mjs';

export default function bundledSubagents(pi) {
    setChildSessionFactory(childFactory());
    setChildSessionFactoryModule(fileURLToPath(new URL('./pi-subagent-child-factory.mjs', import.meta.url)));
    return upstream(pi);
}
