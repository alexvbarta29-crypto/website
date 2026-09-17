# Referral program email (Rotor campaign)

The customer email that announces the "Give $25, Get $50" referral program
(`/referral`). It is built to look the same on iPhone Mail, Gmail (web,
iOS, Android), Outlook and Samsung Mail, in light *and* dark mode.

| File | What it is |
|------|------------|
| `referral-program.html` | The email. Paste the whole file into Rotor's HTML editor. |
| `referral-program.txt` | Plain-text version, if Rotor asks for one. |
| `../assets/img/email/` | The four images the email loads (hero, crew photo, Alex's photo, the coral mark). |
| `../build/email-hero.html`, `../build/email_hero.mjs` | Source and one-line renderer for the hero image, for the next campaign. |

## Sending it from Rotor

1. Deploy this branch first. The images are served by the website
   (`https://www.bartawindowwashing.com/assets/img/email/…`) and the
   "View in browser" link points at
   `https://www.bartawindowwashing.com/email/referral-program.html`, so a
   test send before the deploy shows alt text where the pictures go.
2. New email campaign → custom HTML / code view → paste **all** of
   `referral-program.html`, `<head>` included. The `<head>` holds the
   phone layout, the dark-mode colors and the site's fonts. If Rotor only
   keeps what is inside `<body>`, the email still works: every style that
   matters is inline. You lose only the stacked ticket on phones, the
   tuned dark-mode palette and the web fonts.
3. Subject line (pick one) and preview text:
   - *Give $25, get $50: our new referral program*
   - *Know someone who'd love spotless windows?*
   - *A thank-you for being a Barta customer*
   - Preview text: *Send a friend $25 off their first service, and earn a
     $50 credit (or a $25 gift card) every time one of them books.* The
     same line is hidden at the top of the HTML, so leave Rotor's preview
     field blank if it would show twice.
4. Send a test to a Gmail address **and** an iPhone, and look at both in
   light and dark mode before the real send.

### Two things to customize

- **Greeting.** It says `Hi there,`. If Rotor has a first-name merge
  field, search the HTML for `Hi there,` and use it (the comment above
  that line marks the spot).
- **Unsubscribe.** The footer's *Unsubscribe* link is a `mailto:` to the
  office with an "Unsubscribe" subject, which is a valid CAN-SPAM opt-out
  as long as those replies are honored within 10 days. If Rotor inserts
  its own unsubscribe link or has a merge tag for one, swap it in
  (search for `Unsubscribe`).

Every link to the site carries `utm_campaign=referral_launch`, so clicks
show up in GA4 as source `rotor`, medium `email`.

## Why it holds up across clients

The problems you saw before ("good on Apple, bad on Android", "good in
dark, bad in light") come from three things email clients do:

1. **Gmail, Outlook and Yahoo never load web fonts.** Apple Mail does.
   Any text set in the site's typefaces looks right on an iPhone and falls
   back to Arial/Roboto everywhere else. Here the headline and logo are a
   single image rendered with the real fonts (`referral-hero.v1.jpg`), so
   the brand type is identical in every client, and the live text below
   it uses the site's fonts where they load and a matching system stack
   where they don't.
2. **Dark mode is three different behaviors.** Apple Mail respects the
   email's own `prefers-color-scheme: dark` rules; Outlook exposes
   `[data-ogsc]`/`[data-ogsb]` hooks; Gmail *forces* its own inversion and
   offers no control. The email has a designed dark palette for the first
   two, and its colors and images are chosen to survive Gmail's inversion:
   photos and transparent PNGs (never a white logo on a dark cell, which
   goes invisible when Gmail flips the cell to light), text colors that
   keep contrast when their lightness is flipped, and the dark hero baked
   into an image so it stays dark everywhere.
3. **Layout.** Tables only, widths set inline, `max-width: 600px` with a
   fluid `width: 100%`, so it fits a phone even when a client strips the
   `<style>` block. Media queries then stack the offer ticket, widen the
   buttons and tighten the padding on small screens.

## Editing

- Copy: edit `referral-program.html` directly. Keep new images under
  `assets/img/email/` and bump the `.v1` in the filename when you replace
  one: the site serves assets with a one-year cache, so a changed file
  under the same name would keep showing the old picture.
- Hero image: edit `build/email-hero.html` (the fonts and logo come from
  the repo) and render it at 2× with

  ```bash
  npm i -D playwright && npx playwright install chromium   # once
  node build/email_hero.mjs                                # writes assets/img/email/referral-hero.v1.jpg
  ```

  then bump the version in the filename and in the email.
