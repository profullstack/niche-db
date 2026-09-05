import { close } from './index.js';
import { migrate } from './migrate.js';

await migrate();
await close();
