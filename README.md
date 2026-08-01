# Lengua — demo

A clickable 5-screen demo: intro reel → landing page → tutor list → video
call → travel fund.

## Deploy to Railway (get your URL)

**Easiest path — Railway CLI:**

1. Unzip this project somewhere on your computer.
2. Install the CLI once: `npm install -g @railway/cli`
3. From inside the project folder, run:
   ```
   railway login
   railway init
   railway up
   ```
4. When it finishes, run `railway domain` to get your public URL
   (or generate one from the Railway dashboard → your project → Settings → Networking → "Generate Domain").

**Or — GitHub path:**

1. Push this folder to a new GitHub repo.
2. In Railway: New Project → Deploy from GitHub repo → pick the repo.
3. Railway detects `package.json` and runs `npm start` automatically.
4. Generate a domain the same way as above.

Either way, no config files are needed beyond what's already here —
Railway's Node builder picks up `package.json` and `server.js` on its own.

## Running it locally first (optional)

```
npm install
npm start
```
then open `http://localhost:3000`.

## Editing the content

Almost everything you'd want to change lives in one place:
`public/app.js`, at the top, in the `CONFIG` object:

- `tutorName`, `pricePerLesson`
- `destinationCode` — shows on the boarding-pass screen
- `goalAmount`, `startingBalance`, `startingLessons`
- `captions` — the three lines that appear during the video call

The travel fund balance is saved in the browser's local storage, so it'll
remember the running total between visits on the same device/browser.

Text on the landing page and tutor card lives directly in
`public/index.html` if you want to tweak wording, and colors/fonts are in
`public/style.css` under the `:root` variables at the top.

The photo used for the tutor is `public/assets/zacarias.jpg` — swap in a
different file with the same name to change it.
