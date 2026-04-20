# Where's Ya Bin? 🗑️

A mobile-first Progressive Web App (PWA) that tells residents of a Denbighshire estate which bins go out and when — and sends a push notification to their phone at 5pm the day before collection.

No app store. No Telegram. No technical knowledge required. Just tap the link, enter your house number, say yes to notifications, and add it to your home screen. Job done.

---

## What it does

- Fetches live bin collection dates from the Denbighshire Council refuse calendar API
- Each resident gets their own personalised URL (e.g. `/21`) with their exact schedule, including garden waste if they subscribe to it
- Sends a push notification at 5pm the evening before any collection day
- Works as a home screen app on both Android and iPhone (iOS 16.4+)
- Runs entirely on a VPS — no third-party services, no monthly fees beyond hosting

---

## Stack

- **Node 22 + Express** — serves the app and proxies the council API
- **web-push (VAPID)** — sends push notifications without a third-party service
- **better-sqlite3** — stores push subscriptions
- **node-cron** — fires the daily notification check at 5pm
- **Docker + docker-compose** — containerised for easy deployment
- **Nginx + Certbot** — reverse proxy and SSL

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/darrenhughes87/wheresyabin.git
cd wheresyabin
```

### 2. Generate VAPID keys

Run this once and save the output — you'll need it in step 3.

```bash
npx web-push generate-vapid-keys
```

### 3. Create your `.env` file

```bash
cp .env.example .env
nano .env
```

Fill in all five values:

```
POSTCODE=LL113EJ
VAPID_CONTACT_EMAIL=you@youremail.com
VAPID_PUBLIC_KEY=<your public key>
VAPID_PRIVATE_KEY=<your private key>
ADMIN_SECRET=<make something up — used to trigger test pushes>
```

### 4. Start the container

```bash
docker compose up -d
```

The app will be running on port 3002.

### 5. Set up Nginx

Copy the included config and point it at your domain:

```bash
sudo cp nginx-bins.conf /etc/nginx/sites-available/wheresyabin
sudo ln -s /etc/nginx/sites-available/wheresyabin /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Then get your SSL certificate:

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

### 6. Update the Nginx config with your domain

Open `nginx-bins.conf` and replace `wheresyabin.info` with your actual domain before running the steps above.

---

## Testing a push notification

Once the app is live and you've subscribed on a device, you can trigger a test push without waiting for 5pm:

```bash
curl -X POST https://yourdomain.com/api/test-push \
  -H "x-admin-secret: YOUR_ADMIN_SECRET"
```

---

## How the council API works

The Denbighshire refuse calendar API requires a two-step authentication:

1. `GET /Csrf/token` — returns a short-lived CSRF token
2. `GET /Calendar/{uprn}` — returns bin dates for a property, with the token in the `X-CSRF-TOKEN` header

Each property has a unique UPRN (Unique Property Reference Number). This app looks up every property's UPRN at startup using the postcode lookup endpoint, so each resident gets their own accurate schedule — including garden waste, which varies by subscription.

---

## iOS note

Web push on iPhone requires iOS 16.4 or later and the site must be **added to the home screen** before notifications will work. The app guides users through this with an in-app prompt.

---

## Updating the app

SSH into your VPS and run:

```bash
cd /path/to/wheresyabin
git pull
docker compose up -d --build
```
