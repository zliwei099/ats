import { Store } from './store.js';
import { buildServer } from './server.js';

const app = buildServer(new Store(process.env.ATS_DB ?? 'ats.sqlite'));
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
