# OverSize Route — Backend Server

Permit-compliant GPS dispatch platform for oversized load trucking.

---

## What this does

- **Office Portal** — dispatchers upload permits, AI builds the permit-compliant route, sends a link to the driver
- **Driver GPS** — driver opens the link on their phone, gets live turn-by-turn navigation with voice and permit restriction alerts
- **Live tracking** — driver's GPS pings the server every 30 seconds so the office can see where they are

---

## Deploy to Railway (step by step)

### Step 1 — Push to GitHub

```bash
# On your computer, open a terminal in this folder, then:
git init
git add .
git commit -m "Initial commit — OverSize Route backend"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/oversize-route.git
git push -u origin main
```

### Step 2 — Create Railway project

1. Go to **railway.app** and sign in with your GitHub account
2. Click **"New Project"**
3. Choose **"Deploy from GitHub repo"**
4. Select **oversize-route** from the list
5. Railway will detect Node.js automatically and start deploying

### Step 3 — Add a PostgreSQL database

1. In your Railway project, click **"New"** → **"Database"** → **"PostgreSQL"**
2. Railway creates the database and automatically sets the `DATABASE_URL` environment variable — nothing else needed here

### Step 4 — Set environment variables

In your Railway project → **Variables** tab, add these one by one:

| Variable | Value | Notes |
|---|---|---|
| `JWT_SECRET` | (random 64-char string) | Run: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `NODE_ENV` | `production` | |
| `GOOGLE_MAPS_API_KEY` | `AIzaSy...` | Your Google Maps key |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Your Anthropic key |
| `APP_URL` | `https://your-app.up.railway.app` | Copy from Railway after first deploy |

**Optional — only if you want file storage on S3/Cloudflare R2:**

| Variable | Value |
|---|---|
| `S3_BUCKET` | Your bucket name |
| `S3_REGION` | `us-east-1` (or your region) |
| `S3_ACCESS_KEY` | Your access key |
| `S3_SECRET_KEY` | Your secret key |

If you skip S3, permit PDFs store locally on the Railway server — fine for testing, but they'll clear on redeploy. Add S3 before going to production.

### Step 5 — Run database migrations

Once the server is deployed, open the Railway terminal (or use the Run command):

```bash
npm run db:migrate
npm run db:seed
```

This creates all the tables and a default admin login.

**Default login after seed:**
- Email: `admin@oversizeroute.app`
- Password: `ChangeMe123!`
- **Change this immediately after first login.**

### Step 6 — Add your frontend files

Copy your two HTML files into the `public/` folder:
- `public/index.html` — the office portal (desktop)
- `public/driver.html` — the driver GPS app (mobile)

Then commit and push:
```bash
git add public/
git commit -m "Add frontend files"
git push
```

Railway redeploys automatically every time you push.

### Step 7 — Test it

1. Open your Railway URL (e.g. `https://oversize-route.up.railway.app`)
2. You should see the office portal
3. Log in with `admin@oversizeroute.app` / `ChangeMe123!`
4. Create a route, upload permits, run analysis, click "Send to Driver"
5. Open the driver link on your phone

---

## API Reference

All protected endpoints require: `Authorization: Bearer <token>`

### Auth
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/login` | Login → returns JWT token |
| POST | `/api/auth/register` | Create dispatcher account |
| GET | `/api/auth/me` | Get current user |
| POST | `/api/auth/change-password` | Update password |

### Routes
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/routes` | List all routes |
| POST | `/api/routes` | Create new route |
| GET | `/api/routes/:id` | Get route with permits + activity |
| PUT | `/api/routes/:id` | Update route details |
| POST | `/api/routes/:id/analyze` | Run AI permit analysis |
| POST | `/api/routes/:id/send` | Mark as sent, get driver link |
| POST | `/api/routes/:id/ping` | Driver GPS location update |
| GET | `/api/routes/:id/live` | Office polls driver location |
| DELETE | `/api/routes/:id` | Delete route |

### Permits
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/permits/upload/:routeId` | Upload permit PDF/image |
| GET | `/api/permits/:routeId` | List permits for a route |
| DELETE | `/api/permits/:id` | Delete a permit |

### Drivers
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/drivers` | List all drivers |
| POST | `/api/drivers` | Add a driver |
| PUT | `/api/drivers/:id` | Update driver |
| DELETE | `/api/drivers/:id` | Deactivate driver |

### Driver View (public — no auth)
| Method | Endpoint | Description |
|---|---|---|
| GET | `/drive/:token` | Serves driver GPS app |
| GET | `/drive/:token/data` | Returns route JSON for GPS app |

---

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Copy environment file
cp .env.example .env
# Edit .env with your local database URL and API keys

# 3. Create local database (requires PostgreSQL installed)
createdb oversize_route

# 4. Run migrations and seed
npm run db:migrate
npm run db:seed

# 5. Start dev server (auto-restarts on file changes)
npm run dev
```

Server runs at `http://localhost:3000`

---

## Project structure

```
oversize-route/
├── src/
│   ├── server.js          ← Main Express app
│   ├── db/
│   │   ├── pool.js        ← Database connection
│   │   ├── migrate.js     ← Creates all tables
│   │   └── seed.js        ← Default admin user
│   ├── middleware/
│   │   ├── auth.js        ← JWT verification
│   │   └── upload.js      ← File upload (local or S3)
│   ├── routes/
│   │   ├── auth.js        ← Login/register
│   │   ├── routes.js      ← Route management + AI analysis
│   │   ├── permits.js     ← Permit file upload
│   │   ├── drivers.js     ← Driver management
│   │   └── driverView.js  ← Public driver GPS endpoint
│   └── services/
│       └── ai.js          ← Anthropic API integration
├── public/
│   ├── index.html         ← Office portal (add this)
│   └── driver.html        ← Driver GPS app (add this)
├── uploads/               ← Local permit file storage (auto-created)
├── package.json
├── nixpacks.toml          ← Railway build config
├── Procfile               ← Railway start command
├── .env.example           ← Environment variable template
└── .gitignore
```
