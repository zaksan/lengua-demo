# Lengua — demo

A clickable 5-screen demo: intro reel → landing page → tutor list → video
call → travel fund. Plus two extras in the nav: a real 2-person video call
("Video test") and a 1965 console TV with 13 programmable channels
("Beta features").

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

## Storage for the beta TV (do this, or uploads disappear)

Railway containers get a fresh filesystem on every redeploy. Without a
volume the TV still works, but every uploaded video and channel assignment
is wiped the next time you deploy. YouTube channels survive either way,
since those are just a video id.

**Attach a volume — that's the whole setup, no variables needed:**

1. Railway dashboard → your service → **Variables** tab
2. Scroll to **Volumes** → **New Volume** (or Settings → Volumes in some
   layouts)
3. Set the mount path to `/data`
4. Railway redeploys on its own

Railway sets `RAILWAY_VOLUME_MOUNT_PATH` automatically when a volume is
attached, and the server reads that, so there is deliberately no variable
to set by hand.

To confirm it worked, check the deploy logs for:

```
[tv] channel storage: /data (Railway volume)
```

If it says `local disk — NOT persistent on Railway`, the volume isn't
attached and uploads will keep vanishing.

Videos live in `<mount>/videos` and the channel map in
`<mount>/channels.json`. Locally, with no volume and no override,
everything goes to `./uploads/` (git-ignored). Setting `UPLOAD_DIR`
overrides both if you ever need it.

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

## The beta TV

Reachable from the "Beta features" nav link, or directly at `/#tv`.

- **Power** turns the set on with a CRT warm-up; off collapses the picture
  to a dot.
- **The dial** is a real 13-position rotary knob. Click it to advance a
  channel, drag it to spin straight to one, or focus it and use the arrow
  keys. Underlined numbers on the ring are channels that have something on
  them; empty ones show static.
- **Program channels** opens the uploader. Two ways to fill a channel:
  upload a video file (up to 500 MB), or paste a YouTube link of any
  length. YouTube costs no storage, so that's the better option for
  anything long.

YouTube channels play with all of YouTube's own controls and overlays
suppressed, so the tube shows nothing but picture. Two things are outside
our control: YouTube may run an ad before a video, and some videos have
embedding disabled by their owner — those fall back to static rather than
showing a broken frame.

The upload size cap is `MAX_UPLOAD_BYTES` near the top of `server.js` if
you want it different.
