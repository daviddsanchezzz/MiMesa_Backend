const { normalizeInvoiceExtraction } = require('../lib/invoiceValidation');
const { OpenAIInvoiceExtractionProvider } = require('./openAIInvoiceExtractionProvider');

class InvoiceExtractionService {
  constructor(provider = new OpenAIInvoiceExtractionProvider()) {
    this.provider = provider;
  }

  async extract(document) {
    const raw = await this.provider.extract(document);
    const { data, warnings } = normalizeInvoiceExtraction(raw);
    return { data, warnings, raw };
  }
}

module.exports = { InvoiceExtractionService };
