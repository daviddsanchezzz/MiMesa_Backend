const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../helpers/load');

test('background jobs register with their schedules', () => {
  load('verticals/restaurant/jobs/reservationReminders');
  load('modules/finance/jobs/recurringExpenses');
  load('modules/bookings/jobs/bookingReminders');
  const { registeredJobs } = load('core/services/scheduler');
  assert.deepEqual(registeredJobs(), [
    { schedule: '*/15 * * * *', name: 'reservation reminders' },
    { schedule: '0 5 * * *', name: 'recurring expenses' },
    { schedule: '*/15 * * * *', name: 'booking reminders' },
  ]);
});
