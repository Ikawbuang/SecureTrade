const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const { rateLimit } = require('express-rate-limit');
require('./lib/core');
const { sendError } = require('./lib/core');


const app = express();

// Who the real visitor is, for the sign-in limits. On this computer ngrok connects from here, so only
// "loopback" is believed. On a host (Railway, Render) set TRUST_PROXY=1: one proxy sits in front.
function trustProxySetting(value) {
  if (!value) return 'loopback';
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  return value;   // for example "loopback, 10.0.0.0/8"
}
app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));

// Online over HTTPS, browsers are told to always use HTTPS for this site (HSTS). Not on this computer.
const httpsSite = /^https:\/\//.test(process.env.PUBLIC_URL || '') && process.env.NODE_ENV === 'production';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  strictTransportSecurity: httpsSite ? { maxAge: 180 * 24 * 3600, includeSubDomains: false } : false,
}));

// Set CORS_ORIGINS in .env (comma-separated) to choose which sites may call the API.
// Without it, only this project's own addresses may.
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean);

if (!allowedOrigins.length) {
  allowedOrigins.push('http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5500', 'http://127.0.0.1:5500');
  if (process.env.PUBLIC_URL) allowedOrigins.push(process.env.PUBLIC_URL.replace(/\/$/, ''));
}

app.use(cors({ origin: allowedOrigins }));

app.use(express.json());

// The website itself, so Xendit can send buyers back to a real address
app.use(express.static(path.join(__dirname, '..', 'frontend')));


// A request with no JSON body gets an empty one, so the checks answer "required" instead of crashing
app.use((req, res, next) => {
  req.body = req.body || {};
  next();
});


// Limits per visitor, on the routes that guess passwords and PINs or send email
const limiter = (limit, message) => rateLimit({
  windowMs: 15 * 60 * 1000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message },
});

const TOO_MANY_TRIES = 'Too many attempts. Please wait 15 minutes and try again.';

app.use(['/api/login', '/api/register', '/api/password', '/api/profile/password', '/api/profile/email'], limiter(60, TOO_MANY_TRIES));

app.use(['/api/register/start', '/api/register/resend', '/api/password/forgot'], limiter(10, 'Too many emails were requested. Please wait 15 minutes and try again.'));

// Each feature adds its own routes
require('./routes/account').register(app);
require('./routes/support').register(app);
require('./routes/community').register(app);
require('./routes/trades').register(app);
require('./routes/payments').register(app);
require('./routes/history').register(app);
require('./routes/disputes').register(app);
require('./routes/profile').register(app);
require('./routes/verification').register(app);
require('./routes/admin').register(app);
require('./routes/notifications').register(app);


// Anything no route handled (for example broken JSON) still gets a JSON answer
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ message: 'That request could not be read.' });
  sendError(res, err);
});

module.exports = app;
module.exports.trustProxySetting = trustProxySetting;
