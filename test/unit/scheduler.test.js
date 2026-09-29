const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

test('both background jobs register with the same schedules as before', () => {
  load('verticals/restaurant/jobs/reservationReminders');
  load('modules/finance/jobs/recurringExpenses');
  const { registeredJobs } = load('core/services/scheduler');
  assert.deepEqual(registeredJobs(), [
    { schedule: '*/15 * * * *', name: 'reservation reminders' },
    { schedule: '0 5 * * *', name: 'recurring expenses' },
  ]);
});
