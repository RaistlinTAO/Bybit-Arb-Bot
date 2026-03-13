require('dotenv').config({ quiet: true });

const { loadConfig } = require('./config');
const { BybitGateway } = require('./bybitClient');
const { DualOrderBot } = require('./bot');
const { error } = require('./logger');

async function main() {
  const config = loadConfig();
  const gateway = new BybitGateway(config);
  const bot = new DualOrderBot({ config, gateway });
  await bot.start();
}

main().catch((err) => {
  error('Fatal error', { message: err.message || String(err) });
  process.exit(1);
});
