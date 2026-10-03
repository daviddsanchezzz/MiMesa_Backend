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
    packageQuantity: nullableNumber(item.packageQuantity, `items[${index}].packageQuantity`, { min: 0 }),
    quantity: nullableNumber(item.quantity, `items[${index}].quantity`, { min: 0 }),
    unitPrice: nullableNumber(item.unitPrice, `items[${index}].unitPrice`),
    discount: nullableNumber(item.discount, `items[${index}].discount`),
    taxRate: nullableNumber(item.taxRate, `items[${index}].taxRate`, { max: 100 }),
    total: nullableNumber(item.total, `items[${index}].total`),
  };
}

function normalizeTaxBreakdown(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new InvoiceValidationError(`taxBreakdown[${index}] no es valido`);
  }
  return {
    taxRate: nullableNumber(entry.taxRate, `taxBreakdown[${index}].taxRate`, { max: 100 }),
    taxableBase: nullableNumber(entry.taxableBase, `taxBreakdown[${index}].taxableBase`),
    taxAmount: nullableNumber(entry.taxAmount, `taxBreakdown[${index}].taxAmount`),
  };
}

function approximatelyDifferent(a, b) {
  return Math.abs(a - b) > Math.max(0.05, Math.abs(b) * 0.02);
}

function formatAmount(value, currency) {
  return `${Number(value).toFixed(2).replace('.', ',')} ${currency || 'EUR'}`;
}

function validationWarnings(data) {
  const warnings = [];
  const amount = (value) => formatAmount(value, data.currency);
  const lineTotals = data.items.map((item) => item.total).filter((value) => value !== null);
  const lines = lineTotals.reduce((sum, value) => sum + value, 0);
  const allLineTotals = lineTotals.length === data.items.length && lineTotals.length > 0;
  const breakdownBases = data.taxBreakdown.map((entry) => entry.taxableBase).filter((value) => value !== null);
  const breakdownTaxes = data.taxBreakdown.map((entry) => entry.taxAmount).filter((value) => value !== null);
  const hasAllBreakdownBases = breakdownBases.length === data.taxBreakdown.length && breakdownBases.length > 0;
  const hasAllBreakdownTaxes = breakdownTaxes.length === data.taxBreakdown.length && breakdownTaxes.length > 0;
  const breakdownBase = breakdownBases.reduce((sum, value) => sum + value, 0);
  const breakdownTax = breakdownTaxes.reduce((sum, value) => sum + value, 0);

  if (allLineTotals) {
    const comparableGross = data.grossAmount !== null
      ? data.grossAmount
      : (data.discountAmount === null && data.shippingAmount === null && !hasAllBreakdownBases ? data.subtotal : null);
    if (comparableGross !== null && approximatelyDifferent(lines, comparableGross)) {
      warnings.push(`La suma de las lineas (${amount(lines)}) no coincide con el total neto (${amount(comparableGross)})`);
    }
  }

  data.items.forEach((item, index) => {
    if (item.quantity === null || item.unitPrice === null || item.total === null) return;
    const discountMultiplier = item.discount === null ? 1 : (1 - item.discount / 100);
    const expected = item.quantity * item.unitPrice * discountMultiplier;
    if (approximatelyDifferent(expected, item.total)) {
      warnings.push(`La cantidad y el precio de la linea ${index + 1} no coinciden con su importe`);
    }
  });

  if (data.grossAmount !== null && data.discountRate !== null && data.discountAmount !== null) {
    const calculatedDiscount = data.grossAmount * data.discountRate / 100;
    if (approximatelyDifferent(calculatedDiscount, data.discountAmount)) {
      warnings.push('El porcentaje de descuento global no coincide con el importe del descuento');
    }
  }

  if (data.grossAmount !== null) {
    const calculatedBase = data.grossAmount - (data.discountAmount || 0) + (data.shippingAmount || 0);
    const statedBase = hasAllBreakdownBases ? breakdownBase : data.subtotal;
    if (statedBase !== null && approximatelyDifferent(calculatedBase, statedBase)) {
      warnings.push(`El total neto menos descuentos y mas portes (${amount(calculatedBase)}) no coincide con la base imponible (${amount(statedBase)})`);
    }
  }

  if (hasAllBreakdownBases && data.subtotal !== null && approximatelyDifferent(breakdownBase, data.subtotal)) {
    const difference = Math.abs(breakdownBase - data.subtotal);
    const matchesDiscount = data.discountAmount !== null && !approximatelyDifferent(difference, data.discountAmount);
    warnings.push(`La base imponible indicada (${amount(data.subtotal)}) no coincide con el desglose de IVA (${amount(breakdownBase)})${matchesDiscount ? '; la diferencia coincide con el descuento global' : ''}`);
  }

  if (hasAllBreakdownTaxes && data.taxAmount !== null && approximatelyDifferent(breakdownTax, data.taxAmount)) {
    warnings.push(`El IVA indicado (${amount(data.taxAmount)}) no coincide con el desglose de IVA (${amount(breakdownTax)})`);
  }

  if (data.taxBreakdown.length) {
    const breakdownRates = new Set(data.taxBreakdown.map((entry) => entry.taxRate).filter((value) => value !== null));
    const unexpectedRates = [...new Set(data.items.map((item) => item.taxRate)
      .filter((value) => value !== null && !breakdownRates.has(value)))];
    if (unexpectedRates.length) {
      warnings.push(`Hay lineas con tipos de IVA que no aparecen en el desglose: ${unexpectedRates.join('%, ')}%`);
    }
  }

  const totalBase = hasAllBreakdownBases ? breakdownBase : data.subtotal;
  const totalTax = hasAllBreakdownTaxes ? breakdownTax : data.taxAmount;
  if (totalBase !== null && totalTax !== null && data.total !== null
      && approximatelyDifferent(totalBase + totalTax, data.total)) {
    warnings.push(`La base imponible mas impuestos (${amount(totalBase + totalTax)}) no coincide con el total (${amount(data.total)})`);
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
  if (raw.taxBreakdown !== undefined && raw.taxBreakdown !== null
      && (!Array.isArray(raw.taxBreakdown) || raw.taxBreakdown.length > 20)) {
    throw new InvoiceValidationError('taxBreakdown debe ser una lista de hasta 20 tipos de IVA');
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
    grossAmount: nullableNumber(raw.grossAmount, 'grossAmount'),
    discountRate: nullableNumber(raw.discountRate, 'discountRate', { max: 100 }),
    discountAmount: nullableNumber(raw.discountAmount, 'discountAmount'),
    shippingAmount: nullableNumber(raw.shippingAmount, 'shippingAmount'),
    subtotal: nullableNumber(raw.subtotal, 'subtotal'),
    taxAmount: nullableNumber(raw.taxAmount, 'taxAmount'),
    total: nullableNumber(raw.total, 'total'),
    taxBreakdown: (raw.taxBreakdown || []).map(normalizeTaxBreakdown),
  };

  return { data, warnings: validationWarnings(data) };
}

module.exports = {
  InvoiceValidationError,
  normalizeInvoiceExtraction,
  validationWarnings,
};
