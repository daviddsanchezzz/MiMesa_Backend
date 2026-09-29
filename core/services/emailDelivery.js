const EmailLog = require('../models/EmailLog');

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [String(value)];
}

function first(value) {
  if (!value) return '';
  if (Array.isArray(value)) return value[0] ? String(value[0]) : '';
  return String(value);
}

async function sendTrackedEmail({ resend, payload, source = 'unknown', metadata = null }) {
  let result = null;
  let status = 'sent';
  let thrown = null;

  try {
    result = await resend.emails.send(payload);
    if (result?.error) status = 'failed';
  } catch (err) {
    status = 'failed';
    thrown = err;
  }

  try {
    await EmailLog.create({
      provider: 'resend',
      source,
      status,
      from: first(payload?.from),
      to: toArray(payload?.to),
      cc: toArray(payload?.cc),
      bcc: toArray(payload?.bcc),
      replyTo: first(payload?.replyTo),
      subject: String(payload?.subject || ''),
      html: String(payload?.html || ''),
      providerMessageId: String(result?.data?.id || ''),
      errorMessage: String(result?.error?.message || thrown?.message || ''),
      errorRaw: result?.error || (thrown ? { message: thrown.message, name: thrown.name } : null),
      metadata,
    });
  } catch (logErr) {
    console.error('[email-log] failed to persist log:', logErr.message);
  }

  if (thrown) throw thrown;
  return result;
}

module.exports = { sendTrackedEmail };

