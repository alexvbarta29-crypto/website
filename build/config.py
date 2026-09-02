"""Everything the referral app prints about the business and the offer.

The app is deliberately self-contained: it deploys as its own Netlify site,
so it carries its own snapshot of the business details rather than importing
the main website's build. Keep the numbers in REFERRAL in step with
netlify/lib/referral-config.mjs (REWARDS), which drives the API, texts and
CRM notes.
"""

# Where the app itself lives. Used for canonical / Open Graph URLs (the link
# preview when the owner texts the program link). Set the real domain here
# once the Netlify site has one (e.g. refer.bartawindowwashing.com) and
# rebuild; the API side reads the same from SITE_URL / Netlify's URL.
APP_URL = "https://refer.bartawindowwashing.com"

BIZ = {
    "name": "Barta Window Washing",
    "short": "Barta",
    "tagline": "Delano's Premium Exterior Cleaning Company",
    "phone_display": "(763) 314-3400",
    "phone_href": "+17633143400",
    "email": "office@bartawindowwashing.com",
    "street": "320 3rd St S",
    "city": "Delano",
    "state": "MN",
    "zip": "55328",
    "hours": "Mon–Fri 8am–6pm, Sat 8am–5pm, Sun Closed",
    "rating": "5.0",
    "review_count": "100",
    # The main website; the app links out to it for services, quotes and
    # the legal pages instead of carrying copies.
    "site": "https://www.bartawindowwashing.com",
    "facebook": "https://www.facebook.com/p/Barta-Window-Washing-Services-61558622544052/",
    "instagram": "https://www.instagram.com/bartawindowwashing",
    "google": "https://www.google.com/search?q=Barta+Window+Washing+Services#lrd=0x52b4a9e4856ebf2f:0x384cc062f9b0d3f9,1,,,,",
}

# The offer. Every dollar amount on every page comes from here.
REFERRAL = {
    "friend_discount": 25,      # $ off the referred friend's first service
    "referrer_credit": 50,      # $ account credit per friend who books...
    "referrer_gift_card": 25,   # ...or a $ gift card instead (referrer's choice)
    "code_prefix": "BARTA",     # share codes look like BARTA-7K3XQ
    "max_friends": 10,          # per submission
}

# What a referred friend most often books first. Shown on the friend page
# (linking to the main site) and offered as checkboxes on the claim form.
SERVICES = [
    {"slug": "exterior-window-cleaning", "name": "Exterior Window Cleaning", "icon": "window",
     "short": "Streak-free exterior glass, frames, and sills, cleaned without ladders in your flower beds."},
    {"slug": "gutter-cleaning", "name": "Gutter Cleaning", "icon": "gutter",
     "short": "Hand-cleared gutters and downspouts that protect your foundation, roof, and siding."},
    {"slug": "house-washing", "name": "House Washing", "icon": "house",
     "short": "Gentle, thorough soft washing that removes algae, mildew, and dirt from siding."},
    {"slug": "pressure-washing", "name": "Pressure Washing", "icon": "pressure",
     "short": "Restore driveways, patios, walkways, and decks to like-new with controlled high-pressure cleaning."},
]
