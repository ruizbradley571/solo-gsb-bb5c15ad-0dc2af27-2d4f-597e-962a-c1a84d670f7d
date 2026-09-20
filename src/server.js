'use strict';

const { buildApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const app = buildApp();

app
  .listen({ port: PORT, host: HOST })
  .then((addr) => {
    app.log.info(`config-merge-rehearsal listening at ${addr}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    app.close().then(() => process.exit(0));
  });
}
