# Módulo `bookings`: agenda genérica

Agenda por **recursos** (personas, espacios, equipos), **horarios** y **servicios**, válida para peluquerías, consultas, talleres o cualquier negocio con citas. Es la implementación de la sección 3 de [`docs/modelo-de-datos.md`](../../docs/modelo-de-datos.md). No toca las reservas del restaurante.

## Activación

Es un módulo **opcional por negocio**: está disponible en todos los planes, pero apagado hasta que se activa para un negocio concreto, igual que TheFork. Se activa desde la consola de desarrollador ("Agenda de citas") o poniendo `moduleOverrides.bookings.enabled = true` en el negocio.

Sin activar, las rutas privadas devuelven 403 y las públicas 404.

## Piezas

| Archivo | Qué hace |
|---|---|
| `models/Resource.js` | recurso: `kind` (`staff`, `space`, `equipment`), capacidad, capacidad mínima |
| `models/Schedule.js` | horario del negocio o de un recurso: reglas semanales + excepciones por fecha |
| `models/Service.js` | servicio: duración, márgenes, intervalo, requisitos de recursos, aforo, precio, IVA, reserva online |
| `models/Booking.js` | cita con uno o varios segmentos (servicio + recursos + horas) |
| `models/Occupancy.js` | celdas de 5 min por recurso con índice único: la base de datos impide el doble booking |
| `lib/availability.js` | motor de huecos libres (funciones puras, sin base de datos) |
| `services/bookingsService.js` | crear, cancelar y cambiar el estado de las citas |
| `lib/validation.js` | validación de todas las entradas de la API |

## Reglas del motor de huecos

Una hora está libre para un servicio si:

1. el negocio está abierto durante toda la duración;
2. para cada requisito obligatorio hay suficientes recursos que trabajan a esa hora (su horario propio, recortado por el del negocio, o el del negocio si no tienen) y que no están ocupados, contando los márgenes antes y después;
3. en modo `pool`, las personas ya reservadas más el grupo caben en el aforo;
4. si es online: respeta la antelación mínima, los días máximos y los recursos marcados como no reservables online.

Asignación: con "cualquier profesional" se elige el primero libre por `sortOrder`. Con `matchPartySize`, el recurso más pequeño en el que cabe el grupo y cuya capacidad mínima no supera el grupo.

Límites de esta primera versión:
- no hay citas que crucen la medianoche;
- las horas, duraciones y márgenes van en múltiplos de 5 minutos;
- no hay combinación de mesas;
- el aforo (`pool`) se protege con el bloqueo en memoria, así que solo es seguro con una instancia del servidor. Los recursos, en cambio, los protege el índice único de la base de datos.

## API

Rutas privadas bajo `/api/bookings`. Requieren sesión y el módulo activado. Configurar recursos, servicios y horarios exige rol `manager`; ver la agenda y reservar, cualquier miembro.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/resources` | lista (`?includeInactive=true`) |
| POST / PUT / DELETE | `/resources`, `/resources/:id` | crear, editar, desactivar |
| GET | `/services` | lista |
| POST / PUT / DELETE | `/services`, `/services/:id` | crear, editar, desactivar |
| GET / PUT | `/schedule` | horario del negocio; con `?ownerType=resource&ownerId=…`, el de un recurso |
| DELETE | `/schedule?ownerType=resource&ownerId=…` | el recurso vuelve a seguir el horario del negocio |
| GET | `/availability?serviceId&from&to&partySize&resourceId` | huecos con los recursos que se asignarían |
| GET | `/?from&to&status&resourceId` | citas del rango |
| POST | `/` | crear cita (teléfono, mostrador) |
| GET | `/:id` | detalle |
| PATCH | `/:id/status` | `confirmed`, `checked_in`, `completed`, `cancelled`, `no_show` |
| PATCH | `/:id/notes` | notas y notas internas |

Rutas públicas bajo `/api/bookings/public`, sin sesión y con límite de peticiones:

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/:businessId/catalog` | negocio, servicios online y profesionales elegibles |
| GET | `/:businessId/availability?serviceId&from&to&partySize&resourceId` | horas libres (sin ids de recursos) |
| POST | `/:businessId/bookings` | reservar; exige teléfono, email y `consent: true`; devuelve `token` |
| GET / POST | `/cancel` | ver o cancelar con `bookingId` + `token` |

Los errores tienen la forma `{ message, code, reason? }`. `code` puede ser `BAD_REQUEST`, `NOT_FOUND`, `NOT_AVAILABLE` (con `reason`: `closed`, `no_resource`, `notice`, `pool_full`…), `SLOT_TAKEN` o `BAD_TRANSITION`.

## Ejemplo: montar una peluquería

```http
POST /api/bookings/resources   { "kind": "staff", "name": "Ana" }
POST /api/bookings/resources   { "kind": "staff", "name": "Luis" }

PUT  /api/bookings/schedule
{ "rules": [
    { "days": [2,3,4,5,6], "start": "09:00", "end": "14:00" },
    { "days": [2,3,4,5],   "start": "16:00", "end": "20:00" } ],
  "overrides": [ { "from": "2026-12-25", "closed": true, "reason": "Navidad" } ] }

PUT  /api/bookings/schedule          (Luis solo tardes)
{ "ownerType": "resource", "ownerId": "<luis>",
  "rules": [ { "days": [2,3,4,5], "start": "16:00", "end": "20:00" } ] }

POST /api/bookings/services
{ "name": "Corte", "durationMin": 30, "slotIntervalMin": 30,
  "requirements": [ { "kind": "staff", "customerCanChoose": true } ],
  "price": { "amount": 1800 },
  "onlineBooking": { "minNoticeHours": 2, "maxDaysAhead": 60 } }

POST /api/bookings/services          (solo Ana hace tintes)
{ "name": "Tinte", "durationMin": 60, "bufferAfterMin": 10,
  "requirements": [ { "kind": "staff", "resourceIds": ["<ana>"], "customerCanChoose": true } ],
  "price": { "amount": 4500 } }

POST /api/bookings/public/<businessId>/bookings
{ "date": "2026-10-13", "time": "11:00",
  "items": [ { "serviceId": "<corte>" }, { "serviceId": "<tinte>" } ],
  "guestName": "Carla", "guestPhone": "622000111", "guestEmail": "carla@ejemplo.es", "consent": true }
```

Otros sectores:
- **Psicólogo:** servicio de 50 minutos con 10 de margen, requisitos `[{ kind: "staff" }, { kind: "space", optional: true }]` y `tax: { rate: 0, exemptReason: "art20_sanitario" }`.
- **Aforo por franja** (restaurante o talleres): `capacityMode: "pool"`, `poolCapacity: 40`, `partySize: { min: 1, max: 8 }`.
- **Carpintería:** la visita de medición es un servicio normal; los trabajos a medida usan `bookingMode: "quote"` y no se pueden reservar.

## Pendiente (siguientes versiones)

- Emails de confirmación y recordatorio: reutilizar `emailKit` y registrar un job en el scheduler.
- Pago online (depósito o completo) con Stripe Connect, como en las reservas del restaurante.
- Citas recurrentes (series) y bonos de sesiones.
- Líneas de venta y comisiones, y facturas a través de un proveedor externo.
- Pantallas en el frontend: agenda por profesional, configuración y página pública.
