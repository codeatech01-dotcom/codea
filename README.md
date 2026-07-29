# Codea — Customer Manager (PWA)

A mobile-first Progressive Web App to manage customers, services, payments, and invoices for **Codea**.

## ✨ Features
- 🔐 Login / password protection (default: `admin` / `codea123` — change in Settings)
- 🏠 Dashboard with totals: customers, total received, total owed, total sales
- 👥 Customers list with search by name or phone
- ➕ Add / edit customer with:
  - Customer name
  - Phone / contact
  - Service / product description
  - Total price, Amount received, **Remaining auto-calculated**
  - **Status** (paid / partial / unpaid) auto-calculated
  - Payment date, Notes
  - **Multi-photo upload** (up to 10 per customer, camera or gallery, auto-resized, uploaded to Firebase Storage)
  - **File attachments** (up to 5 documents per customer — PDFs, images, etc. — uploaded to Firebase Storage)
  - **Photo gallery + lightbox** viewer with keyboard/swipe navigation
  - **Per-item actions** on each photo and file:
    - 🔍 Preview (fullscreen lightbox for photos, inline PDF viewer for docs)
    - ⭳ Download (saves original file to device)
    - ✏️ Rename
    - 🗑 Delete (removes from cloud storage too)
- 💰 **Payment history** — log multiple payments per customer, each with its own amount and payment date, plus an automatic total paid summary
- 🧾 **Invoice PDF** generation (one-tap download)
- 🌐 **Optional database sync** — put any REST URL in Settings, and every save is `PUT` to that URL as JSON. Login also pulls from it.
- 📱 Installable as a PWA (Add to Home Screen on iOS / Install on Android)
- 📴 Works offline (service worker caches assets, data stays in localStorage)
- 🖼 Company logo — drop `icons/logo.png` and it appears on login, top bar, and PDF invoices

## 📁 File Structure
```
codea-app/
├── index.html          # Main HTML
├── styles.css          # Mobile-first CSS
├── app.js              # All app logic
├── manifest.json       # PWA manifest
├── sw.js               # Service worker (offline)
└── icons/
    ├── icon-192.png    # App icon 192×192
    ├── icon-512.png    # App icon 512×512
    └── logo.png        # Your Codea logo (shown in app + invoices)
```

## 🚀 How to Deploy

### Option 1 — Free hosting with a public URL (recommended)
1. Push this folder to a **GitHub** repo.
2. Enable **GitHub Pages** (Settings → Pages → deploy from main).
3. Your app is now live at `https://<username>.github.io/<repo>/`.

Other free options: **Netlify Drop** (drag & drop the folder), **Vercel**, **Cloudflare Pages**, **Firebase Hosting**.

### Option 2 — Run locally
Any static server works. Example with Python:
```
cd codea-app
python3 -m http.server 8080
```
Open `http://localhost:8080` in your phone browser (same Wi-Fi) or desktop.

### Install on Phone
- **Android**: Open in Chrome → menu → *Add to Home Screen* / *Install app*
- **iOS**: Open in Safari → Share → *Add to Home Screen*

## 🔥 Firebase Storage (for photos & files)

Cloud file storage is enabled. The app uploads photos and files directly to Firebase Storage under `/codea/{customerId}/photos/` and `/codea/{customerId}/files/`.

### Setup checklist
1. In Firebase Console → **Build → Storage** → **Get Started**
2. Choose a location and finish setup
3. Storage → **Rules** tab → replace with:
   ```
   rules_version = '2';
   service firebase.storage {
     match /b/{bucket}/o {
       match /codea/{allPaths=**} {
         allow read, write: if true;
       }
     }
   }
   ```
4. Publish
5. In the app: **Settings → Firebase Storage Bucket** → already pre-configured to `codea-b9d61.firebasestorage.app`
6. Tap **Test Connection** — you should see both DB and Storage as ✅

### Limits (in-app)
- **10 photos** per customer (auto-resized to max 1600px, JPEG 85%)
- **5 files** per customer, max 20 MB per file

### What if Storage is not configured?
- Photos still work — they're stored as base64 in the database (fine for a few photos)
- Files are disabled without Storage (they'd blow past DB size limits)

## 🔗 Firebase Realtime Database (Already Configured)

This app is pre-configured to sync with your Firebase Realtime Database:
```
https://codea-b9d61-default-rtdb.firebaseio.com/
```
Data is stored under the `/codea` node. The app auto-appends `.json` for Firebase REST access.

### Required: Set Firebase security rules
Before the app can sync, open [Firebase Console](https://console.firebase.google.com/) → your project → **Realtime Database** → **Rules**, and paste:
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```
Click **Publish**.

⚠️ These rules make the DB public. Fine for personal/testing use. For production with real customer data, secure with Firebase Auth.

### Test connection
Inside the app: **Settings → Test Connection** button. You should see ✅ "Connected!".

### Sync status indicator
The topbar shows the current sync state under the page title:
- **Syncing…** — saving to Firebase now
- **Synced** — all changes safely stored
- **Offline** — changes saved locally, will retry

### Change the DB later
Settings → Database URL → paste any Firebase Realtime DB URL or generic REST endpoint.

## 🖼 Logo Assets
The app is already branded with the official Codea logo across every touchpoint:
- `icons/logo.png` — used in login screen, top bar, and PDF invoices
- `icons/logo-wide.png` — padded version used for PDF invoice headers
- `icons/icon-192.png` / `icon-512.png` — PWA install icons (shown on phone home screen after install)
- `icons/favicon.png` — browser tab icon

To update the logo later, replace these files with new PNGs of the same names.

## 🔒 Security Notes
- The default password is stored in localStorage — this is device-level protection only, not server-level auth. For production/multi-user, put an authenticated API behind the Database URL.
- Never commit real customer data to a public git repo.

## 📞 Support
Everything is self-contained HTML/CSS/JS — no build step, no dependencies to install. Just open `index.html`.
