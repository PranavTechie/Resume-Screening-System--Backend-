import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env, validateEnv } from './config/env';
import { logger } from './utils/logger';
import routes from './routes';
import { errorHandler } from './middleware/error.middleware';
import { apiLimiter } from './middleware/rateLimit.middleware';

const app = express();
const PORT = parseInt(env.PORT, 10) || 3000;

// Validate essential environment configuration
validateEnv();

// Security and utility middlewares
app.use(helmet({
  contentSecurityPolicy: false, // Allows flexible integration when embedded
}));

// CORS Configuration
const corsOptions: cors.CorsOptions = {
  origin: (requestOrigin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman, server-to-server)
    if (!requestOrigin) {
      return callback(null, true);
    }

    const normalizedOrigin = requestOrigin.replace(/\/+$/, '');
    const isDev = env.NODE_ENV !== 'production';

    // 1. Check explicitly configured frontend URLs (supported in development and production)
    const configuredOrigins = (env.FRONTEND_URL || '')
      .split(',')
      .map((u) => u.trim().replace(/\/+$/, ''))
      .filter(Boolean);

    // In production, disallow '*' wildcard for security when credentials are used
    const hasWildcard = configuredOrigins.includes('*');
    if (configuredOrigins.includes(normalizedOrigin) || (hasWildcard && isDev)) {
      return callback(null, true);
    }

    // 2. Local development origins (localhost, 127.0.0.1, [::1] on any port, http/https)
    if (isDev) {
      // Matches http/https localhost or loopback with optional port
      const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(normalizedOrigin);
      if (isLocalhost) {
        return callback(null, true);
      }

      // Matches private LAN IPs (RFC 1918) when Vite is accessed via --host 0.0.0.0
      const isPrivateLan = /^https?:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?$/i.test(normalizedOrigin);
      if (isPrivateLan) {
        return callback(null, true);
      }
    }

    logger.warn(`CORS blocked request from origin: ${requestOrigin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers',
  ],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// Explicit preflight handler for OPTIONS requests
app.options('*', cors(corsOptions));

app.use(morgan('combined', {
  stream: {
    write: (message: string) => logger.info(message.trim()),
  },
}));

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Apply general API rate limiting
app.use('/api', apiLimiter);

// Mount combined API routes
app.use('/', routes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`,
    },
    timestamp: new Date().toISOString(),
  });
});

// Centralized error handling middleware
app.use(errorHandler);

// Start HTTP server
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Resume Screening System Backend API running on port ${PORT} [Mode: ${env.NODE_ENV}]`);
});

export default app;
