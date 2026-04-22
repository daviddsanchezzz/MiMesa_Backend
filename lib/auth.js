const { betterAuth } = require('better-auth');
const { mongodbAdapter } = require('better-auth/adapters/mongodb');
const { twoFactor, bearer } = require('better-auth/plugins');
const { admin } = require('better-auth/plugins');
const { Resend } = require('resend');
const { sendTrackedEmail } = require('../services/emailDelivery');

let _warnedMissingResendKey = false;
function getResendClient() {
  if (!process.env.RESEND_API_KEY) {
    if (!_warnedMissingResendKey) {
      console.warn('[BetterAuth] RESEND_API_KEY is not configured. Email sending is disabled.');
      _warnedMissingResendKey = true;
    }
    return null;
  }
  return new Resend(process.env.RESEND_API_KEY);
}

// Lazy-created auth instance (needs MongoDB client injected via initAuth)
let _auth = null;

function initAuth(mongoClient) {
  const Business = require('../models/Business');
const BusinessMember = require('../models/BusinessMember');
  const dbName = process.env.MONGO_DB_NAME || 'tpv-simple';

  _auth = betterAuth({
    // mongodbAdapter expects a Db object, not a MongoClient
    database: mongodbAdapter(mongoClient.db(dbName)),

    // Required: secret for signing session cookies
    secret: process.env.BETTER_AUTH_SECRET,

    baseURL: process.env.BACKEND_URL || 'http://localhost:5000',
    basePath: '/api/betterauth',

    trustedOrigins: (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3005')
      .split(',').map(o => o.trim()).filter(Boolean),

    // Production cross-origin cookie config (frontend on Netlify, backend on Render)
    advanced: {
      useSecureCookies: process.env.NODE_ENV === 'production',
      cookies: {
        session_token: {
          attributes: {
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            secure:   process.env.NODE_ENV === 'production',
          },
        },
      },
    },

    // ---------- Email / Password ----------
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        try {
          const resend = getResendClient();
          if (!resend) return;
          await sendTrackedEmail({
            resend,
            source: 'auth.reset_password',
            metadata: { userId: user.id, userEmail: user.email },
            payload: {
            from: process.env.RESEND_FROM_SYSTEM || 'Tableo <onboarding@resend.dev>',
            to: user.email,
            subject: 'Restablecer contrasena - Tableo',
            html: `
              <p>Hola,</p>
              <p>Haz clic en el siguiente enlace para restablecer tu contrasena. Caduca en 1 hora.</p>
              <a href="${url}" style="background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;">
                Restablecer contrasena
              </a>
              <p style="color:#888;font-size:12px;margin-top:16px;">Si no solicitaste esto, ignora este email.</p>
            `,
            },
          });
        } catch (err) {
          console.error('[BetterAuth] sendResetPassword error:', err.message);
        }
      },
    },

    // ---------- Email verification ----------
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        try {
          let verificationLink = url;
          try {
            const parsed = new URL(url);
            const token = parsed.searchParams.get('token');
            const frontendBase = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3005')
              .split(',')[0]
              .trim();
            if (token && frontendBase) {
              verificationLink = `${frontendBase.replace(/\/$/, '')}/verify-email?token=${encodeURIComponent(token)}`;
            }
          } catch {
            // fallback to provider URL
          }

          const resend = getResendClient();
          if (!resend) return;
          await sendTrackedEmail({
            resend,
            source: 'auth.verify_email',
            metadata: { userId: user.id, userEmail: user.email },
            payload: {
            from: process.env.RESEND_FROM_INVITE || 'Tableo <onboarding@resend.dev>',
            to: user.email,
            subject: 'Verifica tu email - Tableo',
            html: `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

        <!-- Header -->
        <tr><td style="background:#0f0a1e;border-radius:12px 12px 0 0;padding:28px 40px;text-align:center;">
          <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">⬡ Tableo</span>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#ffffff;padding:40px 40px 32px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
          <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#111827;line-height:1.25;">Verifica tu dirección de email</p>
          <p style="margin:0 0 28px;font-size:15px;color:#6b7280;line-height:1.6;">
            Hola <strong style="color:#111827;">${user.name}</strong>, gracias por registrarte en Tableo.<br>
            Haz clic en el botón para confirmar tu cuenta y empezar a gestionar tus reservas.
          </p>
          <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
            <tr><td style="border-radius:10px;background:#7c3aed;">
              <a href="${verificationLink}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.01em;">
                Verificar email →
              </a>
            </td></tr>
          </table>
          <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
            Si no creaste esta cuenta puedes ignorar este correo.<br>
            El enlace caduca en 24 horas.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:20px 40px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">
            © ${new Date().getFullYear()} Tableo · Gestión de reservas para restaurantes
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
            },
          });
        } catch (err) {
          console.error('[BetterAuth] sendVerificationEmail error:', err.message);
        }
      },
    },

    // ---------- Google OAuth ----------
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
        enabled: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      },
    },

    // ---------- Plugins ----------
    plugins: [
      // 2FA (TOTP + backup codes). User opts-in from Profile page.
      twoFactor({
        issuer: 'Tableo',
        otpOptions: { digits: 6, period: 30 },
      }),
      // Admin panel capabilities: list users, ban, impersonate (owner-only)
      admin(),
      // Bearer token support: required for cross-origin setups (Netlify frontend â†’ Render backend)
      // Client stores the token in localStorage and sends it as Authorization: Bearer <token>
      bearer(),
    ],

    // ---------- Session ----------
    session: {
      expiresIn: 60 * 60 * 24 * 90,  // 90 days
      updateAge: 60 * 60 * 24,        // slide the window each day
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,               // 5-min signed cookie cache (avoids DB hit on every request)
      },
    },

    // ---------- Additional user fields ----------
    user: {
      additionalFields: {
        phone: { type: 'string', required: false, defaultValue: '' },
      },
    },

    // ---------- After user creation: bootstrap their Business ----------
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            try {
              const Invitation = require('../models/Invitation');

              // Dev users: skip creating a personal Business.
              const { isDev } = require('../middleware/requireDev');
              if (isDev(user.email)) return;

              // Invited users: skip creating a personal Business.
              // acceptInvitation will add them to the correct business.
              const hasPendingInvite = await Invitation.exists({
                email: user.email.toLowerCase(),
                status: 'pending',
                expiresAt: { $gt: new Date() },
              });
              if (hasPendingInvite) return;

              let business = await Business.findOne({ ownerId: user.id });

              if (!business) {
                // Migration: legacy Business with same email but no ownerId
                business = await Business.findOne({ email: user.email.toLowerCase() });
                if (business) {
                  business.ownerId = user.id;
                  await business.save();
                } else {
                  // New user â€” they will create their Business via the Onboarding page.
                  return;
                }
              }

              // Ensure owner membership record exists (with name/email for display)
              await BusinessMember.findOneAndUpdate(
                { userId: user.id, businessId: business._id },
                { $setOnInsert: { role: 'owner', status: 'active', userName: user.name || '', userEmail: user.email } },
                { upsert: true, new: true },
              );
            } catch (err) {
              console.error('[BetterAuth] Failed to bootstrap Business/Member for user', user.id, err.message);
            }
          },
        },
      },
    },
  });

  return _auth;
}

function getAuth() {
  if (!_auth) throw new Error('Better Auth not initialized. Call initAuth(mongoClient) first.');
  return _auth;
}

module.exports = { initAuth, getAuth };
