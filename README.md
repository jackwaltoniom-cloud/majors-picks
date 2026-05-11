# The Majors Sweepstake

A web app for running a golf majors picking game with a shared live leaderboard.
Built with React, Vite, and Firebase Firestore.

## What you need to know

- **All data lives in Firestore** (collection `majors_picks`, with documents `config`, `field`, `entries`). The Firebase config is in `src/firebase.js` and is safe to be public — security is handled by Firestore Security Rules, not by hiding the API key.
- **Test-mode rules** allow anyone to read/write to the database. They expire 30 days after creation. To extend or tighten them, go to Firebase Console → Firestore Database → Rules.
- **The admin PIN** is stored in plain text in the `config` document. For a small private group this is acceptable; anyone with database read access could see it.

## Local development (optional)

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Deployment

This project is pre-configured to deploy on Vercel with zero changes:

1. Push this folder to a new GitHub repository (the repo can be public — the Firebase keys here are designed to be public).
2. Go to https://vercel.com → sign in with GitHub → "Add New Project".
3. Import the repository. Vercel will auto-detect Vite. Click **Deploy**.
4. Within ~90 seconds you'll have a `*.vercel.app` URL ready to share.

## After a tournament

In the running app: **Admin → Reset → "Clear all scores & player statuses"** keeps the entries list and tournament name but wipes scores. Use the full reset for a clean slate before the next major.

## Extending the Firestore test-mode rules

By default, test-mode rules expire 30 days after the database is created. Before they expire (or any time before the next major), open Firebase Console → Firestore Database → Rules and change the date in the existing rule (the one that says `request.time < timestamp.date('YYYY-MM-DD')`) to a future date.
