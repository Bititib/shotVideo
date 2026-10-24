import { createApp } from './app.js';

// Local frontend development against the existing account/model database.
// Do not seed administrator settings or resume historic paid jobs on startup.
const port = Number(process.env.DEV_API_PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DEV_API_PORT');
const app = await createApp();
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Development API ready at http://127.0.0.1:${port}`);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => process.exit(0)));
