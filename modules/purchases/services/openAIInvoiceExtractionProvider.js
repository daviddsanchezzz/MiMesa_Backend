const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['supplier', 'invoiceNumber', 'invoiceDate', 'currency', 'items', 'subtotal', 'taxAmount', 'total'],
  properties: {
    supplier: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'taxId'],
      properties: {
        name: { type: ['string', 'null'] },
        taxId: { type: ['string', 'null'] },
      },
    },
    invoiceNumber: { type: ['string', 'null'] },
    invoiceDate: { type: ['string', 'null'], description: 'YYYY-MM-DD when clearly present' },
    currency: { type: ['string', 'null'], description: 'Three-letter ISO 4217 code' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'quantity', 'unitPrice', 'discount', 'taxRate', 'total'],
        properties: {
          description: { type: 'string' },
          quantity: { type: ['number', 'null'] },
          unitPrice: { type: ['number', 'null'] },
          discount: { type: ['number', 'null'] },
          taxRate: { type: ['number', 'null'] },
          total: { type: ['number', 'null'] },
        },
      },
    },
    subtotal: { type: ['number', 'null'] },
    taxAmount: { type: ['number', 'null'] },
    total: { type: ['number', 'null'] },
  },
};

function outputText(response) {
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'refusal') throw new Error('El proveedor de IA rechazo el documento');
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  throw new Error('El proveedor de IA no devolvio contenido');
}

class OpenAIInvoiceExtractionProvider {
  async extract(document) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY no esta configurada');

    const dataUrl = `data:${document.mimeType};base64,${document.buffer.toString('base64')}`;
    const documentInput = document.mimeType === 'application/pdf'
      ? { type: 'input_file', filename: document.originalName || 'invoice.pdf', file_data: dataUrl, detail: 'high' }
      : { type: 'input_image', image_url: dataUrl, detail: 'high' };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.INVOICE_AI_TIMEOUT_MS || 90000));
    let response;
    try {
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: process.env.OPENAI_INVOICE_MODEL || 'gpt-4.1-mini',
          store: false,
          max_output_tokens: Number(process.env.INVOICE_AI_MAX_OUTPUT_TOKENS || 12000),
          instructions: [
            'Extract only information clearly visible in this supplier invoice.',
            'Never infer, calculate, complete, translate, normalize products, or invent missing values.',
            'Use null whenever a value is absent or ambiguous. Preserve each invoice line description.',
            'Discount and taxRate are percentages only when explicitly shown as percentages.',
          ].join(' '),
          input: [{
            role: 'user',
            content: [documentInput, { type: 'input_text', text: 'Extract the invoice into the required schema.' }],
          }],
          text: {
            format: {
              type: 'json_schema',
              name: 'invoice_extraction',
              strict: true,
              schema: EXTRACTION_SCHEMA,
            },
          },
        }),
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const requestId = response.headers.get('x-request-id');
      throw new Error(`OpenAI respondio ${response.status}${requestId ? ` (request ${requestId})` : ''}`);
    }
    const payload = await response.json();
    return JSON.parse(outputText(payload));
  }
}

module.exports = { OpenAIInvoiceExtractionProvider, EXTRACTION_SCHEMA };
