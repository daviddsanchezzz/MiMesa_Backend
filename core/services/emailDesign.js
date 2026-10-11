/**
 * Email design system shared by every email Vetra sends.
 *
 * Email clients (Gmail, Outlook, Apple Mail) only understand old-school HTML:
 * tables for layout, inline styles, no web fonts or flexbox. Everything here
 * follows those rules and is tested with fixed data (see test/unit/emails.test.js).
 *
 *   layout({ brand, preheader, content, footer })  → the whole HTML document
 *   brandOf(business) / VETRA_BRAND                → who the email is from
 *   h1, p, small, button, buttons, card, eventCard, details, notice, divider, links
 *
 * Text passed to components is escaped unless the parameter name ends in Html.
 */
const { escapeHtml: esc } = require('../lib/escapeHtml');

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const C = {
  ink: '#111827', body: '#374151', muted: '#6b7280', faint: '#9ca3af', line: '#e5e7eb',
  soft: '#f9fafb', page: '#f3f4f6', white: '#ffffff',
};
const VIOLET = '#7c3aed';

function landingUrl() {
  return process.env.LANDING_URL || 'https://vetrareserve.com';
}

// ── Colour helpers ──────────────────────────────────────────────────────────
function normalizeHex(value, fallback = VIOLET) {
  const v = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v.slice(1).split('').map((c) => c + c).join('')}`.toLowerCase();
  return fallback;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

// Text colour that reads well on top of `bg`.
function onColor(bg) {
  return luminance(bg) > 0.45 ? C.ink : C.white;
}

// Very light brand colours (yellow, pastel) are unreadable as text/buttons on white.
function usableAccent(hex) {
  return luminance(hex) > 0.75 ? C.ink : hex;
}

function tint(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c * alpha + 255 * (1 - alpha));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix).map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// ── Who the email is from ───────────────────────────────────────────────────
/**
 * business: { name, brandColor, logoUrl?, address?, phone?, email? }
 * The logo URL must be absolute (see core/lib/images.businessLogoUrl).
 */
function brandOf(business = {}, { logoUrl = null } = {}) {
  const color = usableAccent(normalizeHex(business.brandColor, VIOLET));
  return {
    name: business.name || '',
    color,
    logoUrl: logoUrl || business.logoUrl || null,
    address: business.address || '',
    phone: business.phone || '',
    email: business.email || '',
  };
}

const VETRA_BRAND = { name: 'Vetra', color: VIOLET, logoUrl: null, address: '', phone: '', email: '', isVetra: true };

// ── Small text helpers ──────────────────────────────────────────────────────
/** "david sanchez" → "David"; "Ana & Co" → "Ana". */
function firstName(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  if (!first) return '';
  return first === first.toLowerCase() ? first.charAt(0).toUpperCase() + first.slice(1) : first;
}

function mapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function telHref(phone) {
  return `tel:${String(phone).replace(/[^\d+]/g, '')}`;
}

// ── Components ──────────────────────────────────────────────────────────────
function h1(text) {
  return `<h1 style="margin:0 0 10px;font-family:${FONT};font-size:24px;line-height:1.25;font-weight:700;color:${C.ink};letter-spacing:-0.2px;">${esc(text)}</h1>`;
}

function p(html, { size = 15, color = C.body, margin = '0 0 14px' } = {}) {
  return `<p style="margin:${margin};font-family:${FONT};font-size:${size}px;line-height:1.6;color:${color};">${html}</p>`;
}

function small(html, { margin = '12px 0 0' } = {}) {
  return p(html, { size: 13, color: C.muted, margin });
}

function divider(margin = '24px 0') {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:${margin};"><tr><td style="border-top:1px solid ${C.line};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}

/** Bulletproof button (works in Outlook). variant: primary | secondary. */
function button(href, label, color = VIOLET, { variant = 'primary', full = false, compact = false } = {}) {
  const primary = variant === 'primary';
  const bg = primary ? color : C.white;
  const fg = primary ? onColor(color) : C.ink;
  const border = primary ? color : C.line;
  return `<table role="presentation" cellpadding="0" cellspacing="0" ${full ? 'width="100%"' : ''} style="border-collapse:separate;">
    <tr><td align="center" valign="middle" bgcolor="${bg}" style="border-radius:10px;background:${bg};border:1px solid ${border};">
      <a href="${esc(href)}" target="_blank" style="display:${full ? 'block' : 'inline-block'};padding:${compact ? '13px 4px' : '13px 22px'};font-family:${FONT};font-size:${compact ? '13px' : '15px'};font-weight:600;line-height:1.25;color:${fg};text-decoration:none;border-radius:10px;">${esc(label)}</a>
    </td></tr>
  </table>`;
}

/**
 * One button, or two side by side each taking half the width (also on phones).
 * items: [{ href, label, variant }]
 */
function buttons(items, color = VIOLET) {
  const list = items.filter(Boolean).slice(0, 2);
  if (!list.length) return '';
  const variantOf = (b, i) => b.variant || (i === 0 ? 'primary' : 'secondary');
  if (list.length === 1) {
    const b = list[0];
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px;"><tr><td valign="top">${button(b.href, b.label, color, { variant: variantOf(b, 0) })}</td></tr></table>`;
  }
  const cells = list.map((b, i) => `<td width="50%" valign="top" style="width:50%;padding:${i === 0 ? '0 5px 0 0' : '0 0 0 5px'};">${button(b.href, b.label, color, { variant: variantOf(b, i), full: true, compact: true })}</td>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 6px;table-layout:fixed;"><tr>${cells}</tr></table>`;
}

/** Rows of label / value. rows: [{ label, value, valueHtml? }] */
function details(rows, { margin = '0' } = {}) {
  const list = rows.filter((r) => r && (r.value || r.valueHtml));
  if (!list.length) return '';
  const tr = list.map((r, i) => `<tr>
      <td valign="top" style="padding:${i ? '9px' : '0'} 12px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};white-space:nowrap;width:1%;">${esc(r.label)}</td>
      <td valign="top" style="padding:${i ? '9px' : '0'} 0 0;font-family:${FONT};font-size:14px;line-height:1.5;color:${C.ink};font-weight:600;">${r.valueHtml || esc(r.value)}</td>
    </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:${margin};">${tr}</table>`;
}

/** A soft box around some content. */
function card(innerHtml, { margin = '18px 0 0', background = C.soft } = {}) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:${margin};border:1px solid ${C.line};border-radius:14px;background:${background};">
    <tr><td style="padding:18px 20px;">${innerHtml}</td></tr>
  </table>`;
}

const MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/** Parts of a local date 'YYYY-MM-DD' for the calendar tile. */
function dateParts(localDate) {
  const [y, m, d] = localDate.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  const monthsLong = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return { day: d, month: MONTHS[m - 1], weekday: WEEKDAYS[dow], long: `${WEEKDAYS[dow]}, ${d} de ${monthsLong[m - 1]}` };
}

/**
 * The appointment / reservation at a glance: a calendar tile with the day and,
 * next to it, what, when and with whom. Extra rows (price, address…) below.
 * localDate: 'YYYY-MM-DD'. lines: strings under the title. rows: see details().
 */
function eventCard({ localDate, title, lines = [], rows = [], color = VIOLET, muted = false }) {
  const d = dateParts(localDate);
  const accent = muted ? C.faint : color;
  const tile = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:64px;border:1px solid ${C.line};border-radius:12px;background:${C.white};">
      <tr><td align="center" bgcolor="${accent}" style="background:${accent};border-radius:11px 11px 0 0;padding:4px 0;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:1px;color:${onColor(accent)};">${d.month}</td></tr>
      <tr><td align="center" style="padding:6px 0 7px;font-family:${FONT};font-size:26px;line-height:1;font-weight:700;color:${muted ? C.faint : C.ink};">${d.day}</td></tr>
    </table>`;
  const text = `
      <p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.4;color:${C.muted};">${esc(d.long)}</p>
      <p style="margin:3px 0 0;font-family:${FONT};font-size:17px;line-height:1.35;font-weight:700;color:${muted ? C.faint : C.ink};${muted ? 'text-decoration:line-through;' : ''}">${esc(title)}</p>
      ${lines.filter(Boolean).map((l) => `<p style="margin:3px 0 0;font-family:${FONT};font-size:14px;line-height:1.45;color:${C.body};">${esc(l)}</p>`).join('')}`;
  const extra = rows.filter((r) => r && (r.value || r.valueHtml)).length
    ? `<tr><td colspan="2" style="padding-top:16px;">${divider('0 0 14px')}${details(rows)}</td></tr>` : '';
  return card(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td valign="top" style="width:64px;padding-right:16px;">${tile}</td><td valign="top">${text}</td></tr>
      ${extra}
    </table>`);
}

/** A coloured note. tone: info | success | warning | danger. */
function notice(html, tone = 'info') {
  const t = {
    info: ['#eff6ff', '#bfdbfe', '#1e3a8a'],
    success: ['#ecfdf5', '#a7f3d0', '#065f46'],
    warning: ['#fffbeb', '#fde68a', '#78350f'],
    danger: ['#fef2f2', '#fecaca', '#7f1d1d'],
  }[tone] || ['#eff6ff', '#bfdbfe', '#1e3a8a'];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0;border:1px solid ${t[1]};border-radius:12px;background:${t[0]};">
    <tr><td style="padding:12px 16px;font-family:${FONT};font-size:14px;line-height:1.55;color:${t[2]};">${html}</td></tr>
  </table>`;
}

/** Small text links in a row: "Añadir al calendario · Cómo llegar". items: [{ href, label }] */
function links(items, color = VIOLET, { margin = '14px 0 0' } = {}) {
  const list = items.filter(Boolean);
  if (!list.length) return '';
  const html = list.map((l) => `<a href="${esc(l.href)}" target="_blank" style="color:${color};font-weight:600;text-decoration:none;">${esc(l.label)}</a>`)
    .join(`<span style="color:${C.line};">&nbsp;&nbsp;|&nbsp;&nbsp;</span>`);
  return `<p style="margin:${margin};font-family:${FONT};font-size:14px;line-height:1.6;">${html}</p>`;
}

// ── The document ────────────────────────────────────────────────────────────
function header(brand) {
  if (brand.logoUrl) {
    return `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" height="44" style="display:block;height:44px;max-height:44px;width:auto;max-width:200px;border:0;outline:none;" />`;
  }
  const initial = esc((brand.name || '?').trim().charAt(0).toUpperCase());
  return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td align="center" valign="middle" bgcolor="${brand.color}" style="width:36px;height:36px;border-radius:10px;background:${brand.color};font-family:${FONT};font-size:17px;font-weight:700;color:${onColor(brand.color)};">${initial}</td>
      <td style="padding-left:12px;font-family:${FONT};font-size:17px;font-weight:700;color:${C.ink};">${esc(brand.name)}</td>
    </tr></table>`;
}

function footerBlock(brand, { note = '', replyHint = false } = {}) {
  const contact = [
    brand.phone ? `<a href="${esc(telHref(brand.phone))}" style="color:${C.muted};text-decoration:none;">${esc(brand.phone)}</a>` : '',
    brand.email ? `<a href="mailto:${esc(brand.email)}" style="color:${C.muted};text-decoration:none;">${esc(brand.email)}</a>` : '',
  ].filter(Boolean).join('&nbsp;&nbsp;·&nbsp;&nbsp;');
  const lines = brand.isVetra ? [] : [
    `<strong style="color:${C.body};">${esc(brand.name)}</strong>`,
    brand.address ? esc(brand.address) : '',
    contact,
    replyHint && brand.email ? '¿Tienes alguna duda? Responde a este email y te contestaremos.' : '',
  ].filter(Boolean);
  const vetra = brand.isVetra
    ? `<a href="${esc(landingUrl())}" style="color:${C.faint};text-decoration:none;">Vetra · Reservas y agenda para negocios</a>`
    : `Gestionado con <a href="${esc(landingUrl())}" style="color:${C.faint};text-decoration:none;font-weight:600;">Vetra</a>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:24px 24px 8px;font-family:${FONT};font-size:12px;line-height:1.7;color:${C.muted};">
      ${lines.join('<br>')}
      ${note ? `<p style="margin:${lines.length ? '12px' : '0'} 0 0;font-size:11px;line-height:1.6;color:${C.faint};">${note}</p>` : ''}
      <p style="margin:14px 0 0;font-size:11px;color:${C.faint};">${vetra}</p>
    </td></tr>
  </table>`;
}

/**
 * brand: brandOf(business) or VETRA_BRAND. preheader: the grey text shown next
 * to the subject in the inbox. content: body HTML. footer: { note, replyHint }.
 */
function layout({ brand = VETRA_BRAND, preheader = '', content, footer = {}, title = '' }) {
  return `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light only" />
  <title>${esc(title || brand.name)}</title>
  <style>
    @media only screen and (max-width: 600px) {
      .container { width: 100% !important; }
      .pad { padding: 26px 22px !important; }
      .stack { display: block !important; width: 100% !important; padding-right: 0 !important; }
      .stack table { width: 100% !important; }
      .stack a { display: block !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${esc(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.page}" style="background:${C.page};">
    <tr><td align="center" style="padding:28px 12px 32px;">
      <table role="presentation" class="container" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:560px;">
        <tr><td bgcolor="${C.white}" style="background:${C.white};border-radius:18px;border:1px solid ${C.line};overflow:hidden;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td bgcolor="${brand.color}" style="height:5px;line-height:5px;font-size:0;background:${brand.color};border-radius:18px 18px 0 0;">&nbsp;</td></tr>
            <tr><td class="pad" style="padding:26px 36px 0;">${header(brand)}</td></tr>
            <tr><td class="pad" style="padding:26px 36px 34px;">${content}</td></tr>
          </table>
        </td></tr>
        <tr><td>${footerBlock(brand, footer)}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Calendar links & invite file ────────────────────────────────────────────
function utcStamp(date) {
  return new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function googleCalendarUrl({ title, start, end, location = '', details = '' }) {
  const q = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${utcStamp(start)}/${utcStamp(end)}`, details, location });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** An .ics invite (Apple Calendar, Outlook…) to attach to confirmation emails. */
function icsInvite({ uid, title, start, end, location = '', description = '', organizerName = '', stamp = null, sequence = 0 }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vetra//Reservas//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsEscape(uid)}@vetrareserve.com`,
    `DTSTAMP:${utcStamp(stamp || start)}`,
    // Same UID with a higher SEQUENCE: calendars update the event instead of adding another
    sequence ? `SEQUENCE:${sequence}` : '',
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${icsEscape(title)}`,
    location ? `LOCATION:${icsEscape(location)}` : '',
    description ? `DESCRIPTION:${icsEscape(description)}` : '',
    organizerName ? `ORGANIZER;CN=${icsEscape(organizerName)}:mailto:noreply@vetrareserve.com` : '',
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n');
}

// ── Plain-text version (better deliverability, readable anywhere) ───────────
function htmlToText(html) {
  return String(html || '')
    .replace(/<head[\s\S]*?<\/head>/i, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<div style="display:none[\s\S]*?<\/div>/i, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      return href.startsWith('mailto:') || href.startsWith('tel:') || !text ? text : `${text}: ${href}`;
    })
    .replace(/<(br|\/p|\/h1|\/tr|\/table)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&zwnj;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = {
  C, VIOLET, FONT, VETRA_BRAND,
  brandOf, layout, firstName, mapsUrl, telHref, dateParts,
  h1, p, small, divider, button, buttons, details, card, eventCard, notice, links,
  googleCalendarUrl, icsInvite, htmlToText, onColor, normalizeHex, tint,
};
