require('dotenv').config();
require('./core/lib/asyncErrors');
const express    = require('express');
const cors       = require('cors');
const cookieParser = require('cookie-parser');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const app = express();

// Behind Render's proxy: without this every client shares the proxy IP and rate limits collapse.
// Override with TRUST_PROXY_HOPS if another proxy (e.g. Cloudflare) sits in front.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));

// ── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
  // Allow embedding via iframe (embed mode for public reservation widget)
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:', 'https:'],
      connectSrc:  ["'self'", 'https:'],
      frameAncestors: ["'self'", '*'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ── CORS ─────────────────────────────────────────────────────────────────────
// Public endpoints: no credentials needed, embeddable from any domain
const publicCors = cors({ origin: '*' });
const PUBLIC_PREFIXES = [
  '/api/auth/public', '/api/rooms/public', '/api/shifts/public', '/api/vacations/public',
  '/api/exceptions/public', '/api/reservations/public', '/api/marketing/public', '/api/promos/public',
  '/api/pricing/public', '/api/contact', '/api/bookings/public',
];
PUBLIC_PREFIXES.forEach((prefix) => app.use(prefix, publicCors));
// Public pages are served from other origins too (vetrareserve.com/{slug}, business
// websites): those routes must not go through the app-only CORS below.
const isPublicPath = (path) => PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

// Authenticated + Better Auth endpoints: specific origin with credentials
// FRONTEND_URLS supports comma-separated list for multiple origins (e.g. Netlify + custom domain)
const normalizeOrigin = (value) => {
  try {
    return new URL(String(value).trim()).origin.toLowerCase();
  } catch {
    return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
  }
};
const allowedOrigins = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3005')
  .split(',')
  .map(o => normalizeOrigin(o))
  .filter(Boolean);

const appCors = cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. Postman, server-to-server)
    if (!origin) return callback(null, true);
    const normalizedOrigin = normalizeOrigin(origin);
    if (allowedOrigins.includes(normalizedOrigin)) return callback(null, true);
    console.warn(`[CORS] Blocked origin: ${origin}. Allowed: ${allowedOrigins.join(', ')}`);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
});
app.use((req, res, next) => (isPublicPath(req.path) ? next() : appCors(req, res, next)));

// ── Stripe webhook — MUST be before express.json() ──────────────────────────
// Stripe signature verification requires the raw request body (Buffer).
// express.raw() captures it without parsing; express.json() would destroy it.
// Stripe webhook needs raw body for signature verification
const stripeWebhookHandler = require('./core/controllers/stripeController').handleWebhook;
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhookHandler,
);
// Backward-compat alias (some Stripe CLI setups still forward here)
app.post(
  '/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  stripeWebhookHandler,
);

// ── Body / cookie parsing ────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' })); // logos and staff photos travel as small data URLs
app.use(cookieParser());

// ── Rate limiting on auth endpoints ─────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiados intentos, inténtalo en 15 minutos' },
});
app.use('/api/auth/login',           authLimiter);
app.use('/api/auth/register',        authLimiter);
app.use('/api/betterauth/sign-in',   authLimiter);
app.use('/api/betterauth/sign-up',   authLimiter);
app.use('/api/betterauth/forget-password', authLimiter);
app.use('/api/betterauth/forgot-password', authLimiter);
app.use('/api/betterauth/request-password-reset', authLimiter);

// ── Rate limiting on public (unauthenticated) endpoints ─────────────────────
const makePublicLimiter = (windowMinutes, max, message) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message },
});
app.post('/api/contact',                          makePublicLimiter(60, 5,  'Demasiados mensajes, inténtalo más tarde'));
app.post('/api/reservations/public',              makePublicLimiter(15, 20, 'Demasiadas reservas desde esta conexión, inténtalo más tarde'));
app.post('/api/reservations/public/payment-intent', makePublicLimiter(15, 30, 'Demasiados intentos de pago, inténtalo más tarde'));
app.use('/api/reservations/public/details',       makePublicLimiter(15, 60, 'Demasiadas consultas, inténtalo más tarde'));
app.use('/api/reservations/public/cancel',        makePublicLimiter(15, 30, 'Demasiados intentos, inténtalo más tarde'));
app.use('/api/bookings/public', makePublicLimiter(15, 120, 'Demasiadas consultas, inténtalo más tarde'));
app.post('/api/bookings/public/:businessId/bookings', makePublicLimiter(15, 20, 'Demasiadas reservas desde esta conexión, inténtalo más tarde'));
app.post('/api/bookings/public/cancel', makePublicLimiter(15, 30, 'Demasiados intentos, inténtalo más tarde'));
app.post('/api/bookings/public/reschedule', makePublicLimiter(15, 20, 'Demasiados cambios, inténtalo más tarde'));

app.use('/api/contact', require('./core/routes/contact'));

// Compatibility aliases for legacy frontend versions:
// /forget-password and /forgot-password now map to Better Auth's
// canonical /request-password-reset endpoint.
app.use('/api/betterauth', (req, res, next) => {
  if (req.path === '/forget-password' || req.path === '/forgot-password') {
    req.url = req.url.replace(req.path, '/request-password-reset');
  }
  next();
});

// Never leak internal error details on 5xx responses in production (they are logged instead).
app.use('/api', (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500 && process.env.NODE_ENV === 'production' && body && typeof body === 'object') {
      console.error(`[error] ${req.method} ${req.originalUrl} -> ${res.statusCode}: ${body.message}`);
      return json({ message: 'Error interno del servidor' });
    }
    return json(body);
  };
  next();
});

// ── Application routes ───────────────────────────────────────────────────────
app.use('/api/dev',          require('./core/routes/dev'));
app.use('/api/auth',         require('./core/routes/auth'));
app.use('/api/users',        require('./core/routes/users'));
app.use('/api/businesses',   require('./core/routes/businesses'));
app.use('/api/stripe',       require('./core/routes/stripe'));
app.use('/api/members',      require('./core/routes/members'));
app.use('/api/invitations',  require('./core/routes/invitations'));
// Starting templates for new businesses (registered with core/lib/businessTemplates)
require('./modules/bookings/templates');
require('./modules/bookings/memberLinks');
require('./modules/bookings/customerData');
require('./modules/purchases/businessData');
require('./modules/finance/businessData');
require('./modules/menu/businessData');
require('./verticals/restaurant/customerData');
require('./verticals/restaurant/templates');

app.use('/api/rooms',        require('./verticals/restaurant/routes/rooms'));
app.use('/api/tables',       require('./verticals/restaurant/routes/tables'));
app.use('/api/customers',    require('./core/routes/customers'));
app.use('/api/reservations', require('./verticals/restaurant/routes/reservations'));
app.use('/api/shifts',       require('./verticals/restaurant/routes/shifts'));
app.use('/api/vacations',    require('./verticals/restaurant/routes/vacations'));
app.use('/api/exceptions',   require('./verticals/restaurant/routes/exceptions'));
app.use('/api/pricing',      require('./core/routes/pricing'));
app.use('/api/marketing',    require('./core/routes/marketing'));
app.use('/api/promos',       require('./verticals/restaurant/routes/promos'));
app.use('/api/analytics',    require('./verticals/restaurant/routes/analytics'));
app.use('/api/staff',        require('./modules/staff/routes/staff'));
app.use('/api/suppliers',    require('./modules/purchases/routes/suppliers'));
app.use('/api/expenses',     require('./modules/finance/routes/expenses'));
app.use('/api/revenue',      require('./modules/finance/routes/revenue'));
app.use('/api/categories',   require('./modules/finance/routes/categories'));
app.use('/api/purchases',    require('./modules/purchases/routes/purchases'));
app.use('/api/invoices',     require('./modules/purchases/routes/invoices'));
app.use('/api/bookings',     require('./modules/bookings/routes/bookings'));
app.use('/api/menu',         require('./modules/menu/routes/menu'));
app.use('/api/push',         require('./core/routes/pushNotifications'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ── Errors ───────────────────────────────────────────────────────────────────
function registerErrorHandlers() {
  app.use('/api', (req, res) => res.status(404).json({ message: 'Ruta no encontrada' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (String(err?.message || '').startsWith('CORS:')) {
      return res.status(403).json({ message: 'Origen no permitido' });
    }
    const status = Number(err?.status || err?.statusCode);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ message: err.type === 'entity.too.large' ? 'Solicitud demasiado grande' : 'Solicitud no valida' });
    }
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    res.status(500).json({ message: 'Error interno del servidor' });
  });
}

// Mounted after Better Auth is initialized (needs the Mongo client), so the
// catch-all 404 and error handlers are registered last.
function mountAuthAndErrorHandlers(authHandler) {
  app.all('/api/betterauth/*', authHandler);
  registerErrorHandlers();
}

module.exports = { app, mountAuthAndErrorHandlers };
