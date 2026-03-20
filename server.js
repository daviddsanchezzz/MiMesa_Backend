require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const cookieParser = require('cookie-parser');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const connectDB  = require('./config/db');
const { getMongoClient } = require('./lib/mongoClient');
const { initAuth }       = require('./lib/auth');

const app = express();

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
app.use('/api/auth/public',         publicCors);
app.use('/api/rooms/public',        publicCors);
app.use('/api/shifts/public',       publicCors);
app.use('/api/vacations/public',    publicCors);
app.use('/api/reservations/public', publicCors);

// Authenticated + Better Auth endpoints: specific origin with credentials
// FRONTEND_URLS supports comma-separated list for multiple origins (e.g. Netlify + custom domain)
const allowedOrigins = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3005')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. Postman, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ── Stripe webhook — MUST be before express.json() ──────────────────────────
// Stripe signature verification requires the raw request body (Buffer).
// express.raw() captures it without parsing; express.json() would destroy it.
// Stripe webhook needs raw body for signature verification
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  require('./controllers/stripeController').handleWebhook,
);

// ── Body / cookie parsing ────────────────────────────────────────────────────
app.use(express.json());
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

// ── MongoDB + Better Auth bootstrap ─────────────────────────────────────────
// Connect Mongoose for business data, then spin up Better Auth with native client
connectDB();

getMongoClient().then((mongoClient) => {
  const { toNodeHandler } = require('better-auth/node');
  const auth = initAuth(mongoClient);

  // Better Auth handles all its own routes under /api/betterauth/*
  // This is intentionally separate from legacy /api/auth/* to avoid conflicts.
  app.all('/api/betterauth/*', toNodeHandler(auth));

  console.log('[server] Better Auth initialized');
}).catch((err) => {
  console.error('[server] Better Auth initialization failed:', err.message);
});

// ── Application routes ───────────────────────────────────────────────────────
app.use('/api/dev',          require('./routes/dev'));
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/businesses',   require('./routes/businesses'));
app.use('/api/stripe',       require('./routes/stripe'));
app.use('/api/members',      require('./routes/members'));
app.use('/api/invitations',  require('./routes/invitations'));
app.use('/api/rooms',        require('./routes/rooms'));
app.use('/api/tables',       require('./routes/tables'));
app.use('/api/customers',    require('./routes/customers'));
app.use('/api/reservations', require('./routes/reservations'));
app.use('/api/shifts',       require('./routes/shifts'));
app.use('/api/vacations',    require('./routes/vacations'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
