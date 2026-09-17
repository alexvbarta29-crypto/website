# Referral program email (Rotor campaign)

The customer email that announces the "Give $25, Get $50" referral program
(`/referral`). It is built to look the same on iPhone Mail, Gmail (web,
iOS, Android), Outlook and Samsung Mail, in light *and* dark mode, and it
only uses photos and the logo that are already live on the website, so it
works the moment it is pasted into Rotor.

| File | What it is |
|------|------------|
| `referral-program.html` | The email. Paste the whole file into Rotor's HTML editor. |
| `referral-program.txt` | Plain-text version, if Rotor asks for one. |

## Sending it from Rotor

1. New email campaign → custom HTML / code view → paste **all** of
   `referral-program.html`, `<head>` included. The `<head>` holds the
   phone layout, the dark-mode colors and the site's fonts. If Rotor only
   keeps what is inside `<body>`, the email still works: every style that
   matters is inline. You lose only the stacked ticket on phones, the
   tuned dark-mode palette and the web fonts.
2. Subject line (pick one) and preview text:
   - *Give $25, get $50: our new referral program*
   - *Know someone who'd love spotless windows?*
   - *A thank-you for being a Barta customer*
   - Preview text: *Send a friend $25 off their first service, and earn a
     $50 credit (or a $25 gift card) every time one of them books.* The
     same line is hidden at the top of the HTML, so leave Rotor's preview
     field blank if it would show twice.
3. Send a test to a Gmail address **and** an iPhone, and look at both in
   light and dark mode before the real send.

Every "Refer a friend" button and both photos link to
`bartawindowwashing.com/referral#refer-form`, which opens the referral
page scrolled to the "About you" fields.

### Two things to customize

- **Greeting.** It says `Hi there,`. If Rotor has a first-name merge
  field, search the HTML for `Hi there,` and use it (the comment above
  that line marks the spot).
- **Unsubscribe.** The footer's *Unsubscribe* link is a `mailto:` to the
  office with an "Unsubscribe" subject, which is a valid CAN-SPAM opt-out
  as long as those replies are honored within 10 days. If Rotor inserts
  its own unsubscribe link or has a merge tag for one, swap it in
  (search for `Unsubscribe`).

## Why it holds up across clients

The problems seen before ("good on Apple, bad on Android", "good in dark,
bad in light") come from three things email clients do:

1. **Gmail, Outlook and Yahoo never load web fonts.** Apple Mail does.
   The headings use the site's Cabinet Grotesk where it loads and a
   matching bold system font everywhere else, so nothing depends on it.
   (The `Access-Control-Allow-Origin` header in `netlify.toml` is what
   lets Apple Mail load the fonts from the site.)
2. **Dark mode is three different behaviors.** Apple Mail respects the
   email's own `prefers-color-scheme: dark` rules; Outlook exposes
   `[data-ogsc]`/`[data-ogsb]` hooks; Gmail *forces* its own inversion
   and offers no control. The email has a designed dark palette for the
   first two, and its colors and images are chosen to survive Gmail's
   inversion. Two Gmail rules shape the markup:
   - Gmail flips plain background colors but leaves **gradient
     backgrounds alone**, while it flips text colors either way. So the
     logo bar (image only, no text) and the coral buttons use a gradient
     to stay put, and every cell that holds text uses a plain color so
     text and background invert together and stay readable.
   - Images are never changed, so the white logo lives only on that
     locked dark bar, and the photos are photos.
3. **Layout.** Tables only, widths set inline, `max-width: 600px` with a
   fluid `width: 100%`, so it fits a phone even when a client strips the
   `<style>` block. Media queries then stack the offer ticket, widen the
   buttons and tighten the padding on small screens.

## Editing

- Copy: edit `referral-program.html` directly. Keep pictures to files the
  site already serves (anything under `assets/img/` that a page uses), or
  add new ones to the site and deploy before sending.
- Keep gradients off any cell that contains text (see above).
