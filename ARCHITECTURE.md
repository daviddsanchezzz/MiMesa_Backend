# Arquitectura del backend

El código está separado en tres capas para poder reutilizar la base con clientes de otros sectores.

```
core/                 Común a cualquier negocio
  config/ lib/ middleware/ models/ controllers/ routes/ services/
  - auth (Better Auth), negocios, miembros y roles, invitaciones
  - planes y módulos (planCapabilities, requireModule, requirePlan)
  - clientes, marketing, Stripe (suscripciones), push, contacto, consola dev
  - emails: emailKit (envío + layout común) y systemEmails
  - scheduler: registro de tareas programadas (cada módulo registra las suyas)

modules/              Funcionalidades reutilizables entre sectores
  staff/              Personal: puestos, empleados, salarios, asignaciones, costes
  finance/            Gastos, gastos recurrentes (job diario), ingresos, categorías
  purchases/          Proveedores, productos, pedidos y facturas extraidas con IA
  bookings/           Agenda genérica: recursos, horarios, servicios y citas (opcional por negocio, ver su README)

verticals/restaurant/ Lo específico de restaurantes
  - reservas (públicas y privadas), pagos de reservas, salas, mesas,
    turnos de servicio, vacaciones, excepciones, códigos promo, analítica
  - services/reservationEmails, jobs/reservationReminders (cada 15 min)
  - lib/reservationLimits (cupo mensual del plan Free)
```

## Reglas

- `core/` no importa nada de `modules/` ni de `verticals/`.
- `modules/` no importa nada de `verticals/`.
- Las excepciones que aún existen están congeladas en `test/unit/architecture.test.js` (`KNOWN_DEBT`). Esa lista solo puede reducirse.

## Verticales y el modelo Business

`verticals.config.js` indica qué verticales están activas (hoy solo `restaurant`). Cada vertical declara en `verticals/<nombre>/business.js` lo que añade al negocio:

- `fields`: campos extra del esquema `Business` (reservas, recordatorios, pagos de reservas, ticket medio)
- `publicFields`: campos que puede leer la página pública de reservas
- `serialize(b)`: campos extra que recibe la app en el payload del negocio
- `applyUpdate(body, update)`: ajustes que el propietario puede cambiar

Los campos siguen guardándose en el mismo sitio del documento en MongoDB, así que no hay migración de datos. `test/unit/businessSchema.test.js` garantiza que el esquema resultante es idéntico campo a campo.

## Tests

```bash
npm test                                             # sin base de datos
MONGO_TEST_URI="mongodb://127.0.0.1:27017" npm test  # + tests con MongoDB real (base temporal que se borra)
UPDATE_SNAPSHOT=1 npm test                           # regenerar snapshots a propósito
```

Para los tests con base de datos sirve un MongoDB local o [FerretDB](https://github.com/FerretDB/FerretDB) (compatible con MongoDB, un solo binario, sin instalar nada):

```bash
ferretdb --handler=sqlite --sqlite-url=file:./.ferretdb/ --listen-addr=127.0.0.1:27017 --telemetry=disable
```

- `test/routes.snapshot.test.js`: lista de las rutas con su middleware y controlador. Un refactor no debe cambiarla.
- `test/unit/emails.test.js`: HTML exacto de los 11 emails.
- `test/unit/http.test.js`: todas las rutas privadas responden 401 sin sesión, y validación de reservas públicas.
- `test/integration/`: reservas del restaurante y agenda genérica de principio a fin, aislamiento entre negocios, roles, módulos, doble booking (necesita MongoDB).
- `test/unit/bookings*.test.js`: motor de huecos libres y validación de la agenda genérica.
