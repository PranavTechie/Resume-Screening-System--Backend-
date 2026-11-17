# Resume Screening System Backend Service

A high-performance Node.js / Express backend with Supabase PostgreSQL integration and Gemini AI parsing, designed for automatic 1-click deployment on **Railway**.

---

## 🚀 Features

- **Express & TypeScript**: Strongly typed, modular architecture.
- **Supabase Integration**: Direct integration with PostgreSQL database, Supabase Auth, and Supabase Storage for resume files.
- **Gemini AI Service**: Structured JSON extraction for resume parsing, skill matching, ATS audits, and targeted interview prep using `@google/genai`.
- **Railway Ready**: Pre-configured `railway.json` and build scripts for seamless Nixpacks deployment.
- **Credit Engine**: Monetization logic for tracking parsing & ranking balance per user.
- **Security**: Rate limiting, Helmet HTTP headers, CORS protection, Zod request validation, and Supabase Row Level Security (RLS) policies.

---

## 📋 Environment Variables

Create a `.env` file in `/backend` (or set these in Railway Environment Settings):

```env
# Server Config
PORT=3000
NODE_ENV=production
FRONTEND_URL=https://your-frontend-domain.up.railway.app

# Supabase Settings
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_STORAGE_BUCKET=resumes

# Gemini AI Key (Server-Side Only)
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-flash-lite-latest

# Storage & Upload Constraints
MAX_RESUME_FILE_SIZE=5242880
```

---

## 🛠️ Supabase Database Migration Setup

1. Log into your [Supabase Dashboard](https://supabase.com).
2. Go to **SQL Editor**.
3. Copy the contents of `supabase/migrations/20260811000000_initial_schema.sql` and run it.
4. This creates all required tables (`profiles`, `resumes`, `jobs`, `job_matches`, `credit_transactions`, `user_preferences`, `analysis_reports`), triggers, and Storage policies.

---

## 🚂 Railway Deployment Instructions

1. **Push to GitHub**: Commit your repository to GitHub.
2. **Open Railway**: Go to [Railway Dashboard](https://railway.app) and create a **New Project**.
3. **Deploy from GitHub**: Select your repository and choose the `/backend` directory as the Root Directory.
4. **Set Environment Variables**: In Railway settings, add all environment variables specified above.
5. **Healthcheck**: Railway will automatically use the `/health` endpoint configured in `railway.json`.

---

## 💻 Local Development

```bash
cd backend
npm install
npm run dev
```

The server will start at `http://localhost:3000` with hot-reloading via `tsx`.

### API Endpoints

- `GET /health`: Healthcheck endpoint
- `GET /api/auth/me`: Get authenticated profile & credit balance
- `POST /api/resumes`: Upload resume file (PDF/DOCX/TXT) for AI parsing & analysis
- `GET /api/resumes`: List user's analyzed resumes
- `POST /api/jobs`: Create job description workspace
- `POST /api/jobs/:id/attach`: Attach resumes to job workspace
- `POST /api/jobs/:id/rank`: Trigger AI candidate ranking & match calculation
- `GET /api/credits/balance`: Fetch credit balance
- `GET /api/preferences`: Get user settings
- `GET /api/reports`: List generated reports
