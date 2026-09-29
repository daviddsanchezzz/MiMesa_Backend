/**
 * Tiny job registry. Each module or vertical registers its own cron jobs
 * (see verticals/restaurant/jobs, modules/finance/jobs) and the server starts
 * them all once it is listening. Core knows nothing about what the jobs do.
 */
const cron = require('node-cron');

const jobs = [];
let started = false;

function registerJob({ schedule, run, failureLabel, startedLog }) {
  jobs.push({ schedule, run, failureLabel, startedLog });
}

function startSchedulers() {
  if (started) return;
  started = true;
  for (const job of jobs) {
    cron.schedule(job.schedule, () => {
      job.run().catch((err) => {
        console.error(`[scheduler] ${job.failureLabel} failed:`, err.message);
      });
    });
    console.log(`[scheduler] ${job.startedLog}`);
  }
}

function registeredJobs() {
  return jobs.map(({ schedule, failureLabel }) => ({ schedule, name: failureLabel }));
}

module.exports = { registerJob, startSchedulers, registeredJobs };
