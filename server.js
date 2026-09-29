require('dotenv').config();
require('./core/lib/asyncErrors');
const connectDB  = require('./core/config/db');
const { getMongoClient } = require('./core/lib/mongoClient');
const { initAuth }       = require('./core/lib/auth');
const { startSchedulers } = require('./core/services/scheduler');
const { app, mountAuthAndErrorHandlers } = require('./app');

// Background jobs register themselves with the core scheduler.
require('./verticals/restaurant/jobs/reservationReminders');
require('./modules/finance/jobs/recurringExpenses');
require('./modules/bookings/jobs/bookingReminders');

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err);
  process.exit(1);
});

// ── Bootstrap ────────────────────────────────────────────────────────────────
// Only start accepting traffic once MongoDB and Better Auth are ready.
async function start() {
  await connectDB();
  const mongoClient = await getMongoClient();
  const { toNodeHandler } = require('better-auth/node');
  const auth = initAuth(mongoClient);
  console.log('[server] Better Auth initialized');

  // Better Auth handles all its own routes under /api/betterauth/*
  mountAuthAndErrorHandlers(toNodeHandler(auth));

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    startSchedulers();
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('[server] Startup failed:', err.message);
  process.exit(1);
});
