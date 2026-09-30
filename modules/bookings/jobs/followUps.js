/**
 * Follow-up emails after visits: review requests (every 30 minutes, a few
 * hours after the appointment) and "te toca volver" (once a day per business,
 * from 10:00 local time). Both only for businesses that turned them on.
 */
const { registerJob } = require('../../../core/services/scheduler');
const { runReviewRequests, runRebookReminders } = require('../services/followUpsService');

registerJob({
  schedule: '*/30 * * * *',
  run: async () => { await runReviewRequests(); await runRebookReminders(); },
  failureLabel: 'follow-up emails',
  startedLog: 'started follow-up emails job (every 30 minutes)',
});
