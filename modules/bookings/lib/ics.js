/**
 * iCalendar (.ics) feed of a professional's appointments, to subscribe from
 * Google Calendar, Apple Calendar or Outlook. Pure: strings in, string out.
 */
const CRLF = '\r\n';

const pad = (n) => String(n).padStart(2, '0');

/** 20261014T093000Z */
function utc(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Lines longer than 75 bytes continue on the next line, starting with a space. */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (size + n > limit) { parts.push(current); current = ch; size = n; } else { current += ch; size += n; }
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

/**
 * @param {object} p
 * @param {string} p.name     calendar name ("Ana · Estética Son")
 * @param {Array}  p.events   { uid, start, end, summary, description?, location?, status?, updated? }
 */
function buildCalendar({ name, events = [], now = new Date() }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vetra//Agenda//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${utc(e.updated || now)}`,
      `DTSTART:${utc(e.start)}`,
      `DTEND:${utc(e.end)}`,
      `SUMMARY:${escapeText(e.summary)}`,
      ...(e.description ? [`DESCRIPTION:${escapeText(e.description)}`] : []),
      ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
      `STATUS:${e.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED'}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join(CRLF) + CRLF;
}

module.exports = { buildCalendar, escapeText, fold, utc };
