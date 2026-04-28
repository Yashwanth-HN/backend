# Backend

Express backend for Glow Research.

## Setup

1. Install dependencies:
   npm install
2. Create env file:
   copy .env.example .env
3. Start development server:
   npm run dev

## API

- GET /api/health
- POST /api/auth/request-otp
- POST /api/auth/verify-otp
- POST /api/auth/register
- POST /api/auth/login

### Agent APIs

- POST /api/agents/run
- GET /api/agents/jobs/:jobId
- POST /api/agents/jobs/:jobId/synthesize

### Research Compatibility APIs

These aliases keep the current frontend research client working without structural changes:

- POST /api/research/start
- GET /api/research/status/:jobId
- POST /api/research/synthesize/:jobId
