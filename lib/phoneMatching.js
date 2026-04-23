function normalizePhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '');
}

function canonicalizePhoneDigits(digits) {
  if (!digits) return '';
  let base = String(digits);

  // Convert 0034XXXXXXXXX -> 34XXXXXXXXX for easier handling
  if (base.startsWith('00')) base = base.slice(2);

  // Spain: +34XXXXXXXXX and national XXXXXXXXX should be considered equivalent
  if (base.startsWith('34') && base.length === 11) {
    return base.slice(2);
  }

  return base;
}

function toStoredNormalizedPhone(raw) {
  const digits = normalizePhone(raw);
  if (!digits) return '';
  return canonicalizePhoneDigits(digits);
}

function getPhoneMatchCandidates(raw) {
  const digits = normalizePhone(raw);
  if (!digits) return [];

  const set = new Set();
  set.add(digits);

  if (digits.startsWith('00')) {
    set.add(digits.slice(2));
  }

  const without00 = digits.startsWith('00') ? digits.slice(2) : digits;
  set.add(without00);

  // Spain aliases:
  // local: XXXXXXXXX
  // intl: 34XXXXXXXXX / 0034XXXXXXXXX
  if (without00.startsWith('34') && without00.length === 11) {
    const local = without00.slice(2);
    set.add(local);
    set.add(`34${local}`);
    set.add(`0034${local}`);
  } else if (without00.length === 9) {
    set.add(`34${without00}`);
    set.add(`0034${without00}`);
  }

  const canonical = canonicalizePhoneDigits(digits);
  if (canonical) set.add(canonical);

  return [...set].filter(Boolean);
}

module.exports = {
  normalizePhone,
  canonicalizePhoneDigits,
  toStoredNormalizedPhone,
  getPhoneMatchCandidates,
};

