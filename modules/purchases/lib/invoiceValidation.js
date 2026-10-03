const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

class InvoiceValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvoiceValidationError';
    this.status = 422;
  }
}

function nullableText(value, field, maxLength) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new InvoiceValidationError(`${field} debe ser texto o null`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  if (clean.length > maxLength) throw new InvoiceValidationError(`${field} es demasiado largo`);
  return clean;
}

function nullableNumber(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new InvoiceValidationError(`${field} no es un numero valido`);
  }
  return value;
}

function nullableDate(value) {
  const clean = nullableText(value, 'invoiceDate', 10);
  if (clean === null) return null;
  if (!DATE_RE.test(clean)) throw new InvoiceValidationError('invoiceDate debe usar YYYY-MM-DD');
  const [year, month, day] = clean.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new InvoiceValidationError('invoiceDate no es una fecha valida');
  }
  return clean;
}

function normalizeItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new InvoiceValidationError(`items[${index}] no es valido`);
  }
  const description = nullableText(item.description, `items[${index}].description`, 500);
  if (!description) throw new InvoiceValidationError(`items[${index}].description es obligatorio`);
  return {
    description,
    quantity: nullableNumber(item.quantity, `items[${index}].quantity`, { min: 0 }),
    unitPrice: nullableNumber(item.unitPrice, `items[${index}].unitPrice`),
    discount: nullableNumber(item.discount, `items[${index}].discount`),
    taxRate: nullableNumber(item.taxRate, `items[${index}].taxRate`, { max: 100 }),
    total: nullableNumber(item.total, `items[${index}].total`),
  };
}

function approximatelyDifferent(a, b) {
  return Math.abs(a - b) > Math.max(0.05, Math.abs(b) * 0.02);
}

function validationWarnings(data) {
  const warnings = [];
  const lineTotals = data.items.map((item) => item.total).filter((value) => value !== null);
  if (lineTotals.length === data.items.length && lineTotals.length && data.subtotal !== null) {
    const lines = lineTotals.reduce((sum, value) => sum + value, 0);
    if (approximatelyDifferent(lines, data.subtotal)) {
      warnings.push('La suma de las lineas no coincide aproximadamente con el subtotal');
    }
  }
  if (data.subtotal !== null && data.taxAmount !== null && data.total !== null
      && approximatelyDifferent(data.subtotal + data.taxAmount, data.total)) {
    warnings.push('Subtotal e impuestos no coinciden aproximadamente con el total');
  }
  return warnings;
}

function normalizeInvoiceExtraction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvoiceValidationError('La IA no devolvio un objeto de factura valido');
  }
  if (!raw.supplier || typeof raw.supplier !== 'object' || Array.isArray(raw.supplier)) {
    throw new InvoiceValidationError('supplier no es valido');
  }
  if (!Array.isArray(raw.items) || raw.items.length > 500) {
    throw new InvoiceValidationError('items debe ser una lista de hasta 500 lineas');
  }

  const currencyText = nullableText(raw.currency, 'currency', 3);
  const currency = currencyText ? currencyText.toUpperCase() : null;
  if (currency && !CURRENCY_RE.test(currency)) {
    throw new InvoiceValidationError('currency debe ser un codigo ISO de tres letras');
  }

  const data = {
    supplier: {
      name: nullableText(raw.supplier.name, 'supplier.name', 200),
      taxId: nullableText(raw.supplier.taxId, 'supplier.taxId', 50),
    },
    invoiceNumber: nullableText(raw.invoiceNumber, 'invoiceNumber', 100),
    invoiceDate: nullableDate(raw.invoiceDate),
    currency,
    items: raw.items.map(normalizeItem),
    subtotal: nullableNumber(raw.subtotal, 'subtotal'),
    taxAmount: nullableNumber(raw.taxAmount, 'taxAmount'),
    total: nullableNumber(raw.total, 'total'),
  };

  return { data, warnings: validationWarnings(data) };
}

module.exports = {
  InvoiceValidationError,
  normalizeInvoiceExtraction,
  validationWarnings,
};
