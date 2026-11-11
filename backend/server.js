// Starts SecureTrade. The app itself is built in app.js, from the modules in lib/ and routes/.
const app = require('./app');
const { PORT } = require('./lib/core');
const { startJobs } = require('./lib/jobs');

if (require.main === module) {
  startJobs();
  app.listen(PORT, () => console.log(`SecureTrade API running on http://localhost:${PORT}`));
}

module.exports = app;
