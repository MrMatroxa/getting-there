# Getting there

A carpool board for the weekend. Drivers post rides for each trip (Fri there, Sat there, Sat back, Sun back), people grab a seat or add themselves to the "still looking" list, and everyone reaches each other through WhatsApp links. Nobody needs an account.

Runs free on Cloudflare: the page, a small API, and storage all deploy with one command.

## 1. One-time setup

1. Install **Node.js** (the LTS version) from https://nodejs.org if you don't have it.
2. Open a terminal in this folder and run:
   ```
   npm install
   ```
3. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up if you don't have one.

## 2. Make it yours

Edit `public/config.js`:

- **pickupPoints**: the meeting spots in the city. The ones in the file are placeholders.
- **legs**: add the dates (e.g. `date: "2026-11-06"`) so people see "Fri 6 Nov" instead of just "Friday".
- **eventName**, **tagline**, **venueNote**, **whatsappGroupUrl**: optional wording and links.

## 3. Try it on your computer (optional)

```
copy .dev.vars.example .dev.vars
npm run dev
```

Open http://localhost:8787. The event code is `letsgo` and the organizer key is whatever is in `.dev.vars`.

## 4. Put it online

```
npx wrangler login
npm run deploy
```

This prints your link, something like `https://getting-there.<your-name>.workers.dev`.

Then set the two secrets. Each command asks you to type the value:

```
npx wrangler secret put EVENT_CODE
npx wrangler secret put ADMIN_KEY
```

- **EVENT_CODE**: a simple word you share in the WhatsApp group (not case-sensitive). It keeps names and phone numbers away from anyone who stumbles on the link. If you skip it, the board is open to anyone with the link.
- **ADMIN_KEY**: your private organizer password. Use something long.

Post the link and the event code in the group.

Changed `config.js` later? Run `npm run deploy` again. Rides that are already posted stay.

## How it works

- **Drivers** tap "I'm driving", pick the trip, time, free seats, meeting point and trunk space. After posting a ride to the house, they're offered to add the trip back too.
- **Riders** tap "Take a seat" on a car with space, or "I need a ride" to join the Still looking list for one or more trips.
- **Drivers** can add people from the Still looking list straight into their car, remove passengers, edit or cancel the ride. People who get removed, or whose ride is cancelled, go back on the Still looking list automatically.
- **Each day's header** shows free seats against people still looking, and turns orange when there aren't enough seats. That's your cue to nudge the group.
- **Copy summary for WhatsApp** at the bottom puts a text overview of every trip on the clipboard, ready to paste in the group.
- **Organizer** (bottom of the page): enter your ADMIN_KEY to edit or remove anything.

The page refreshes itself every 20 seconds.

**Good to know:** a phone remembers what its owner posted (their ride, their seat) in the browser. If someone switches phones or browsers, or clears their data, they can't edit their entry any more. You can fix it for them in organizer mode.

## Files

- `public/`: the page (`index.html`, `styles.css`, `app.js`) and `config.js`
- `src/board.js`: all the carpool rules (seats, who can change what)
- `src/index.js`: the Cloudflare wiring. One Durable Object stores the board and handles one request at a time, so two people can't grab the same last seat.
- `test/board.test.js`: run `npm test` to check the rules (no Cloudflare needed)
