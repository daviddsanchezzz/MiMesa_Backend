# Compras y facturas

Las facturas usan el mismo `businessId` y los mismos permisos que proveedores,
gastos y compras. Los documentos no se sirven de forma publica: se descargan
por `GET /api/invoices/:id/document`, que vuelve a comprobar sesion y negocio.

## Configuracion de extraccion

- `OPENAI_API_KEY` (obligatoria para extraccion real)
- `OPENAI_INVOICE_MODEL` (por defecto `gpt-4.1-mini`)
- `INVOICE_AI_TIMEOUT_MS` (por defecto `90000`)
- `INVOICE_AI_MAX_OUTPUT_TOKENS` (por defecto `12000`)
- `INVOICE_MAX_FILE_SIZE` (por defecto 10 MiB)
- `INVOICE_STORAGE_DIR` (por defecto `backend/storage/invoices`)

`INVOICE_STORAGE_DIR` debe apuntar a un volumen persistente en produccion.
Se aceptan PDF, JPEG, PNG y WebP; el tipo declarado y la firma del fichero se
validan antes de enviarlo al proveedor de IA.
