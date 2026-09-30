"""
Barta Window Washing, site data & shared components.
Single source of truth for NAP, services, areas, plans, icons, and HTML partials.
"""

# ---------------------------------------------------------------------------
# Business identity (NAP), edit here to update site-wide
# ---------------------------------------------------------------------------
BIZ = {
    "name": "Barta Window Washing",
    "legal_name": "Barta Window Washing Services",
    "short": "Barta",
    "tagline": "Delano's Premium Exterior Cleaning Company",
    "phone_display": "(763) 314-3400",
    "phone_href": "+17633143400",
    "email": "office@bartawindowwashing.com",
    "street": "320 3rd St S",
    "city": "Delano",
    "state": "MN",
    "zip": "55328",
    "lat": "45.0419",
    "lng": "-93.7891",
    "hours": "Mon–Fri 8am–6pm, Sat 8am–5pm, Sun Closed",
    "founded": "2024",
    "rating": "5.0",
    "review_count": "100",
    "domain": "https://www.bartawindowwashing.com",
    "facebook": "https://www.facebook.com/p/Barta-Window-Washing-Services-61558622544052/",
    "instagram": "https://www.instagram.com/bartawindowwashing",
    "tiktok": "https://www.tiktok.com/@bartawindowwashing",
    "google": "https://www.google.com/search?q=Barta+Window+Washing+Services#lrd=0x52b4a9e4856ebf2f:0x384cc062f9b0d3f9,1,,,,",
}

# ---------------------------------------------------------------------------
# Where quote-form submissions are delivered.
#
# This is a static site with no server of its own, so the browser posts
# straight to whatever URL is set here. That means the endpoint has to be one
# that's safe to expose publicly, a CRM/Zapier inbound webhook, or a form
# service's public submit URL. Never put a secret API key here: everything in
# this dict is visible in the page source. See docs/LEAD-FORM-SETUP.md.
#
# While "endpoint" is empty the forms deliberately do NOT show a success
# message, they tell the visitor to call instead, because a confirmation we
# can't honour is worse than no form at all.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Google Analytics 4. The gtag snippet renders once in every page's <head>
# (via components.head) whenever this is set; empty string disables it.
# "G-XXXXXXXXXX" is Google's docs placeholder, swap in the real measurement
# ID from GA4 Admin → Data streams → Web, then rebuild.
# ---------------------------------------------------------------------------
GA4_ID = "G-TRBCP1HHNR"

# ---------------------------------------------------------------------------
# Meta (Facebook) Pixel. Renders once in every page's <head> (via
# components.head) whenever this is set; empty string disables it. The ID
# comes from Meta Events Manager → Data sources → your pixel. Unlike GA4
# above, the fbevents.js library loads immediately rather than waiting for
# first interaction: deferring it makes Meta's Pixel Helper flicker between
# "found" and "not found". See the comment in components.head.
# ---------------------------------------------------------------------------
META_PIXEL_ID = "1629810322074915"

LEAD_FORM = {
    # Same-origin Netlify Function (netlify/functions/lead.mjs) that forwards
    # to Rotor CRM with the API key held server-side in the ROTOR_API_KEY
    # Netlify environment variable. Inert on the GitHub Pages preview, where
    # the POST fails and the form shows the honest call-us fallback.
    "endpoint": "/api/lead",
    "access_key": "",   # only for services that use a public submit key (Web3Forms); leave blank otherwise
    "subject": "New quote request from bartawindowwashing.com",
}

# ---------------------------------------------------------------------------
# Customer referral program ("Give $25, Get $50"), see docs/REFERRAL-PROGRAM.md.
# Every dollar amount printed on refer.html / referred.html / the admin
# dashboard comes from here. The serverless side (API responses, CRM notes,
# text messages) reads the same numbers from netlify/lib/referral-config.mjs;
# change both together.
# ---------------------------------------------------------------------------
REFERRAL = {
    "friend_discount": 25,      # $ off the referred friend's first service
    "referrer_credit": 50,      # $ account credit per friend who books...
    "referrer_gift_card": 25,   # ...or a $ gift card instead (referrer's choice)
    "code_prefix": "BARTA",     # share codes look like BARTA-7K3XQ
    "max_friends": 10,          # per submission
}

# ---------------------------------------------------------------------------
# Services, each drives a full service page + nav + cards
# ---------------------------------------------------------------------------
SERVICES = [
    {
        "slug": "exterior-window-cleaning",
        "name": "Exterior Window Cleaning",
        "icon": "window",
        "hero_pos": "68% 35%",
        "image": "assets/img/svc-exterior-window-cleaning.jpg",
        "short": "Streak-free exterior glass, frames, and sills, cleaned without ladders in your flower beds.",
        "hero_sub": "Serving Delano and communities throughout the western Twin Cities.",
        "seo_title": "Exterior Window Cleaning Delano, MN | Barta",
        "seo_desc": "Exterior window cleaning in Delano and the western Twin Cities. Streak-free glass, detailed frames and professional service. Get a free quote.",
        "h1": "Professional Exterior Window Cleaning",
        # Service schema "name", broader territory framing to match the H1;
        # serviceType/areaServed (schema.py) are untouched, so Delano and
        # every legitimate surrounding city are still fully represented.
        "schema_name": "Professional Exterior Window Cleaning",
        "kw": "exterior window cleaning Delano MN",
        "kw2": ["exterior window cleaning", "professional window washers", "water-fed pole window cleaning", "streak-free window cleaning"],
        "benefits": [
            ("Streak-free guarantee", "We don't leave until every pane is spotless, or we come back free."),
            ("Water-fed pole technology", "Purified water rinses glass cleaner and keeps it clearer, longer."),
            ("Safer upper-story reach", "Water-fed poles mean less ladder work on second-story glass, safer for our crew and your landscaping."),
            # Deliberately not "hard-water removal", standard cleaning doesn't
            # include spot treatment; see includes note + FAQ below.
            ("Frames &amp; sills detailed", "We hand-wipe every frame and sill on every visit, the parts most companies skip."),
        ],
        "intro": "The outside of your glass takes the brunt of Minnesota's weather, pollen, rain spots, and road grime dull your view from the street and from inside. Barta's exterior window cleaning uses whatever approach fits each window best, hand-detailing, a ladder, or a water-fed pole for second-story and hard-to-reach glass, finishing with a wipe-down of every sill and frame so the whole window looks new.",
        "includes": [
            "Exterior glass hand-cleaned and squeegeed",
            "Exterior sills and frames wiped down",
            "Water-fed pole cleaning for second-story and hard-to-reach glass",
            "Full cleanup, we leave your property tidier than we found it",
            "Screens, track cleaning, and interior window cleaning available as add-ons",
            "Hard-water spot treatment available as an add-on, free on certain plans",
        ],
        "process": [
            ("Mop", "We work an eco-friendly cleaning solution into every pane with a T-bar scrubber, lifting loose dirt, dust, and pollen before anything else touches the glass."),
            ("Scrub", "Silicone overspray, painter's tape residue, and baked-on grime that the T-bar can't lift gets hand-scrubbed with industrial-grade abrasive pads, safe on glass, tough on the stuff a simple wash leaves behind."),
            ("Squeegee", "A professional-grade squeegee pulls every drop off the glass edge to edge, so nothing is left to dry into streaks or spots."),
            ("Detail", "We finish each window by hand-wiping the glass, frames, and sills, the parts of the job most companies skip, so it looks finished, not just rinsed."),
        ],
        "faqs": [
            ("How is exterior window cleaning priced?",
             "Pricing depends on your home's size, number of windows, and accessibility. Request a free quote and we'll give you clear, upfront pricing before any work begins."),
            ("Are screens included?",
             "Screen cleaning is an add-on to exterior window cleaning rather than something included automatically. Just let us know when you request your quote and we'll add screen removal, hand-washing, and reinstallation to your visit."),
            ("Are frames and sills included?",
             "Yes, exterior sills and frames are wiped down on every visit, not just the glass. Window track cleaning is a separate add-on service if you'd like those detailed too."),
            ("How do water-fed poles work?",
             "For second-story and hard-to-reach glass, we use purified, deionized water on extension poles. Because the water carries no minerals, it rinses spot-free without soap, and it often lets us skip a ladder in your flower beds, though some spots still call for one."),
            ("Is hard-water stain removal included?",
             "Hard-water spot treatment isn't part of a standard exterior window cleaning, it's included at no charge on certain service plans, or available as an add-on. Deeper, embedded mineral staining that's bonded to the glass is a separate service, our Hard Water Stain Removal page has details, or ask us for an assessment."),
            ("How often do Minnesota homes need exterior window cleaning?",
             "We recommend four visits a year to keep your windows consistently clean and as well-maintained as possible. At minimum, we recommend twice a year, once in late spring after pollen settles, and again in early fall, to keep things properly maintained."),
            ("What happens if it rains after service?",
             "Don't let the forecast hold you back from booking, rain itself typically doesn't cause mineral spotting on professionally cleaned glass. And with certain plans, every visit is backed by a 7-day rain guarantee, so if weather does cause an issue within a week of your cleaning, just let us know and we'll make it right."),
            ("Do you offer discounts for recurring service?",
             "Yes, our Biannual, Quarterly, and Monthly recurring plans all save you money on every cleaning, and Quarterly and Monthly plans add priority scheduling, a 7-day rain guarantee, and free hard-water treatment."),
            ("Do you guarantee your work?",
             "Yes, every exterior window cleaning is backed by our 100% Satisfaction Guarantee. If anything isn't right, let us know and we'll come back and make it right, free."),
        ],
    },
    {
        "slug": "interior-window-cleaning",
        "name": "Interior Window Cleaning",
        "icon": "window",
        "hero_pos": "50% 44%",
        "image": "assets/img/svc-interior-window-cleaning.jpg",
        "short": "Spotless interior glass, sills, and frames, hand-detailed without disturbing your home.",
        "hero_sub": "Serving Delano and communities throughout the western Twin Cities with spotless, streak-free interior glass.",
        "seo_title": "Interior Window Cleaning Delano, MN | Barta",
        "seo_desc": "Interior window cleaning in Delano and the western Twin Cities. Carefully cleaned glass, sills and frames with respect for your home. Get a quote.",
        "h1": "Professional Interior Window Cleaning",
        "schema_name": "Professional Interior Window Cleaning",
        "kw": "interior window cleaning Delano MN",
        "kw2": ["interior window cleaning", "inside window washing", "streak-free interior glass", "residential interior window cleaning"],
        "benefits": [
            ("Streak-free guarantee", "We don't leave until every pane is spotless, or we come back free."),
            ("Furniture-safe process", "Drop cloths and careful technique keep your floors and furnishings protected."),
            ("Every sill &amp; frame detailed", "We hand-wipe the parts most companies skip."),
            ("We work around your home", "Light furniture, blinds, pets, kids, we adapt to whatever's happening in your house that day."),
        ],
        "intro": "Interior glass takes a different kind of wear than the outside, fingerprints on the slider, dust along the sill, everyday grime that builds up on the glass you're actually looking through all day. Barta hand-details every pane, frame, and sill room by room, laying down drop cloths and working carefully so your floors and furnishings stay protected the whole time.",
        "includes": [
            "Interior glass hand-cleaned and squeegeed",
            "Interior sills and frames wiped down",
            "Drop cloths placed to protect floors and furnishings",
            "Screens and track cleaning available as add-ons",
        ],
        "process": [
            ("Mop", "We work an eco-friendly cleaning solution into every pane with a T-bar scrubber, lifting loose dirt and dust before anything else touches the glass."),
            ("Scrub", "Fingerprints, tape residue, and baked-on grime that the T-bar can't lift gets hand-scrubbed with industrial-grade abrasive pads, safe on glass, tough on the stuff a simple wash leaves behind."),
            ("Squeegee", "A professional-grade squeegee pulls every drop off the glass edge to edge, so nothing is left to dry into streaks or spots."),
            ("Detail", "We finish each window by hand-wiping the glass, frames, and sills, the parts of the job most companies skip, so it looks finished, not just rinsed."),
        ],
        "faqs": [
            ("How should I prepare for interior window cleaning?",
             "Clear breakables from windowsills a day or two before your visit and let us know about anything fragile nearby, we bring drop cloths to protect the rest."),
            ("Will you move furniture or window coverings?",
             "We move light furniture and blinds as needed to reach the glass, then put everything back. Let us know in advance about anything heavy or delicate you'd rather we handle differently."),
            ("Are screens included?",
             "Screen cleaning is an add-on to interior window cleaning rather than something included automatically. Let us know when you request your quote and we'll add it to your visit."),
            ("Are frames and sills included?",
             "Yes, interior sills and frames are wiped down on every visit. Window track cleaning is a separate add-on service if you'd like those detailed too."),
            ("What about pets and access to my home?",
             "We're comfortable around pets, but recommend keeping them in a separate room for everyone's comfort while we work. We'll coordinate access with you ahead of time."),
            ("What cleaning solutions do you use?",
             "Just soap and water, it's our tools and technique, not harsh chemicals, that get the streak-free result. Safe for your family and pets."),
            ("Can I book interior and exterior cleaning together?",
             "Yes, and it's what we recommend, since combining both in one visit gives your home the full effect, inside and out."),
            ("How often should interior window cleaning be scheduled?",
             "Most homes benefit from interior cleaning about once or twice a year, often paired with your exterior visit, homes with pets, kids, or lots of natural light may want it more often."),
            ("Do you guarantee your work?",
             "Yes, every interior window cleaning is backed by our 100% Satisfaction Guarantee. If anything isn't right, let us know and we'll come back and make it right, free."),
        ],
    },
    {
        "slug": "track-detailing",
        "name": "Track Detailing",
        "icon": "wrench",
        "image": "assets/img/svc-track-detailing.jpg",
        "hero_pos": "50% 58%",
        "short": "Deep-cleaned window tracks and sills, free of built-up grime and debris.",
        "hero_sub": "Serving Delano and communities throughout the western Twin Cities with hand-detailed window tracks and sills.",
        "seo_title": "Window Track Cleaning Delano, MN | Barta",
        "seo_desc": "Window track cleaning in Delano and the western Twin Cities. Hand-detailed tracks and sills, cleared of built-up grime. Get a free quote.",
        "h1": "Professional Window Track Cleaning",
        "schema_name": "Professional Window Track Cleaning",
        "kw": "window track cleaning Delano MN",
        "kw2": ["window track cleaning", "window sill cleaning", "window track detailing service", "deep clean window tracks"],
        "benefits": [
            ("Built-up grime, gone", "Years of dirt, dead bugs, and grit removed from every track."),
            ("Smoother-sliding windows", "Clean tracks mean windows and screens glide the way they should."),
            ("Hand-detailed, not just vacuumed", "We get into the corners other services skip."),
            ("Pairs perfectly with window cleaning", "The finishing touch that makes freshly cleaned glass look complete."),
        ],
        "intro": "Spotless glass still looks unfinished sitting above a track full of dirt and debris. We open the window, vacuum out the dry debris, work in a cleaning solution, hand-scrub every channel with a brush, vacuum up the wet residue, then hand-detail and wipe each track clean, so your windows look as good up close as they do from across the room, and glide smoothly again.",
        "includes": [
            "Interior and exterior window tracks",
            "Dry debris vacuumed out first",
            "Cleaning solution applied and hand-scrubbed with a brush",
            "Wet residue vacuumed, then hand-detailed and wiped clean",
            "Sills de-gunked along the way",
            "Add-on to any window cleaning service",
        ],
        "process_note": "Track detailing is available as an add-on to any window cleaning visit.",
        "faqs": [
            ("What's included in window track cleaning?",
             "We hand-clean interior and exterior tracks, de-gunk sills, and clear built-up dirt, grit, and debris from every corner and channel."),
            ("How is track detailing priced?",
             "Pricing depends on the number of windows and how built-up the tracks are. Request a free quote and we'll give you clear, upfront pricing before any work begins."),
            ("Will my windows and screens slide easier afterward?",
             "Yes, clearing built-up grime from the tracks is exactly what makes windows and screens glide smoothly again."),
            ("How often should window tracks be cleaned?",
             "Most homes benefit from track detailing about once a year, alongside your regular window cleaning, sliding doors and high-traffic tracks may need it more often."),
            ("How long does track detailing take?",
             "Most homes are finished in a couple of hours, depending on the number of windows and how built-up the tracks are."),
            ("Can I combine track detailing with regular window cleaning?",
             "Yes, track detailing is designed to pair with any window cleaning visit, so you can add it right when you book."),
        ],
    },
    {
        "slug": "gutter-cleaning",
        "name": "Gutter Cleaning",
        "icon": "gutter",
        "hero_pos": "45%",
        "image": "assets/img/svc-gutter-cleaning.jpg",
        "short": "Hand-cleared gutters and downspouts that protect your foundation, roof, and siding.",
        "hero_sub": "Serving Delano and communities throughout the western Twin Cities with hand-cleared gutters and flushed downspouts.",
        "seo_title": "Gutter Cleaning Delano, MN | Barta",
        "seo_desc": "Professional gutter cleaning in Delano and the western Twin Cities. Clear debris and downspouts to help protect your roof and foundation. Get a quote.",
        "h1": "Professional Gutter Cleaning",
        "schema_name": "Professional Gutter Cleaning",
        "kw": "gutter cleaning Delano MN",
        "kw2": ["gutter cleaning near me", "downspout cleaning", "gutter clearing service", "residential gutter cleaning"],
        "benefits": [
            ("Protect your foundation", "Free-flowing gutters route water away from your home, not into it."),
            ("Hand-cleared gutters", "We clear debris by hand and blower, so nothing stays clogged in the corners."),
            ("Downspouts flushed", "We confirm water flows freely from gutter to ground."),
            ("Free roof &amp; gutter check", "We'll let you know if we spot any damage on your shingles or gutters."),
        ],
        "intro": "Minnesota's freeze-thaw cycles, maple seeds, and autumn leaves turn gutters into clogged troughs that send water where it doesn't belong. Barta clears every gutter and downspout by hand and blower, then flushes the system to confirm proper flow, protecting your fascia, foundation, and landscaping season after season.",
        "includes": [
            "All gutters cleared of leaves, seeds, and debris by hand",
            "Downspouts flushed and tested for proper flow",
            "Debris cleared by hand and blower",
            "Gutters wiped down at the waterline where needed",
            "Free visual check for damage on your roof and gutters",
            "Photo report of anything that needs attention",
        ],
        "process_note": "Ask about gutter guards and recurring plans to keep them clear year-round.",
        "why_barta": "Minnesota's maple seeds, oak leaves, and freeze-thaw cycles are hard on gutters, and our crew, trained and led by co-owner Alex Barta, deals with them firsthand on every job. We get hands-on with every gutter, so we're able to flag anything that looks off before it turns into fascia rot or a wet basement. Every job is insured and backed by our satisfaction guarantee.",
        "faqs": [
            ("How often should gutters be cleaned?",
             "Most Minnesota homes need gutters cleared at least twice a year, once in spring and once in fall, though homes with heavy tree cover may need more frequent visits."),
            ("Do you clear the downspouts too?",
             "Yes, every downspout is flushed and tested to confirm water flows freely from gutter to ground."),
            ("What happens to the debris?",
             "We clear debris out by hand and with a leaf blower. Most of it gets bagged and hauled away, though a little may end up in your yard, especially with heavier leaf cover."),
            ("How do you access the roofline?",
             "Our insured crew accesses your gutters safely with the right equipment, so you don't have to get on a ladder yourself."),
            ("What are the signs my gutters need cleaning?",
             "Watch for water spilling over the sides during rain, sagging sections, plants growing in the gutter, or water pooling near your foundation."),
            ("Should I schedule in spring or fall?",
             "Fall cleaning clears leaves before winter to help prevent ice dams; spring cleaning clears seeds and winter debris before spring rains. Most homes benefit from both."),
            ("Do I need to be home during gutter cleaning?",
             "No, as long as we can safely access your gutters and downspouts from the exterior, you don't need to be home."),
            ("Can I bundle gutter cleaning with other services?",
             "Yes, many customers pair gutter cleaning with window cleaning, pressure washing, or house washing for a complete exterior refresh in one visit."),
        ],
    },
    {
        "slug": "pressure-washing",
        "name": "Pressure Washing",
        "icon": "pressure",
        "hero_pos": "6% 16%",
        "image": "assets/img/svc-pressure-washing.jpg",
        "short": "Restore driveways, patios, walkways, and decks to like-new with controlled high-pressure cleaning.",
        "hero_sub": "Serving Delano and communities throughout the western Twin Cities with driveway, patio, and walkway pressure washing.",
        "seo_title": "Pressure Washing Delano, MN | Barta",
        "seo_desc": "Pressure washing in Delano and the western Twin Cities for driveways, patios and walkways. Restore dirty exterior surfaces. Request a free quote.",
        "h1": "Professional Pressure Washing",
        "schema_name": "Professional Pressure Washing",
        "kw": "pressure washing Delano MN",
        "kw2": ["power washing near me", "driveway cleaning", "concrete pressure washing", "patio cleaning service"],
        "benefits": [
            ("Like-new surfaces", "Driveways, patios, and walkways come back to their original color."),
            ("Surface-safe pressure", "We dial pressure and nozzles to each material, no etching or gouging."),
            ("Oil &amp; rust treatment", "Targeted pre-treatment lifts stains pressure alone can't."),
            ("Curb appeal that lasts", "Clean hardscapes instantly lift the look and value of your home."),
        ],
        "intro": "Concrete, brick, and pavers collect oil, tire marks, algae, and embedded grime that make even a well-kept home look tired. Barta's pressure washing uses commercial equipment and the right pressure for each surface, plus surface cleaners that leave wide, even, stripe-free results across driveways, patios, sidewalks, and pool decks.",
        "includes": [
            "Driveways, walkways, patios, and pool decks",
            "Pre-treatment for oil, rust, and organic staining",
            "Flat-surface cleaner for even, stripe-free results",
            "Steps, curbs, and retaining walls",
            "Post-rinse and debris cleanup",
        ],
        "process_note": "Pair with house washing for a complete exterior refresh and bundle savings.",
        "why_barta": "We know Minnesota concrete takes a beating from salt, sand, and freeze-thaw cycles every winter, and co-owner Alex Barta trains every technician on exactly which pressure and nozzle to use on which surface, so you get a like-new result without the etching or gouging an untrained operator can cause. Insured and backed by our satisfaction guarantee.",
        "faqs": [
            ("What surfaces can be pressure washed?",
             "Concrete driveways, paver patios, sidewalks, pool decks, steps, and retaining walls, durable, hard surfaces built for higher pressure."),
            ("What's the difference between pressure washing and soft washing?",
             "Pressure washing uses higher pressure suited to durable hardscapes like concrete and pavers. Delicate surfaces, stucco, siding, screens, should be soft washed instead, which we also offer."),
            ("Do you handle concrete, patios, and walkways?",
             "Yes, these are exactly the surfaces pressure washing is built for, using a flat-surface cleaner for even, stripe-free results."),
            ("How should I prepare for service?",
             "Move vehicles, patio furniture, and any items off the surface being cleaned. We'll walk you through anything else specific to your property before we start."),
            ("Will you protect my property during the wash?",
             "We adjust pressure and technique to each surface and take care to protect nearby landscaping and structures during the wash."),
            ("How long does the surface take to dry?",
             "Most surfaces are dry to the touch within a few hours, though full drying can take up to a day depending on weather and surface type."),
            ("How long does a pressure washing job take?",
             "Most jobs are finished in just a few hours, depending on the size and number of surfaces, we'll give you a time estimate with your quote."),
            ("Can I bundle pressure washing with other services?",
             "Yes, pressure washing pairs well with house washing, gutter cleaning, and window cleaning for a complete exterior refresh, and bundling can save you money."),
        ],
    },
    {
        "slug": "house-washing",
        "name": "House Washing",
        "icon": "house",
        "image": "assets/img/svc-soft-washing.jpg",
        "hero_pos": "58%",
        "short": "Gentle, thorough exterior washing that removes algae, mildew, and dirt from siding.",
        "hero_sub": "Serving Delano and communities throughout the western Twin Cities with safe, thorough house washing.",
        "seo_title": "House Washing Delano, MN | Barta",
        "seo_desc": "Professional house washing in Delano and the western Twin Cities. Safely remove dirt, algae and mildew from exterior siding. Request a free quote.",
        "h1": "Professional House Washing",
        "schema_name": "Professional House Washing",
        "kw": "house washing Delano MN",
        "kw2": ["exterior house washing", "vinyl siding cleaning", "house soft wash", "siding cleaning near me"],
        "benefits": [
            ("Whole-home refresh", "Siding, soffits, fascia, trim, and eaves cleaned top to bottom."),
            ("Safe for every surface", "Low-pressure soft washing protects siding, paint, and landscaping."),
            ("Kills the green, not just rinses", "Our solution treats algae and mildew at the root."),
            ("Boost curb appeal &amp; value", "The single highest-impact exterior upgrade you can make."),
        ],
        "intro": "That green and gray film creeping across the north side of your home is living algae, and rinsing it off only hides it for a few weeks. Barta's house washing combines low-pressure soft washing with professional-grade, plant-safe solutions that kill organic growth at the source, so your siding stays cleaner far longer and looks years younger.",
        "includes": [
            "Vinyl, fiber-cement, stucco, brick, and painted siding",
            "Soffits, fascia, gutters' exterior face, and trim",
            "Plant-safe, biodegradable cleaning solution",
            "Low-pressure soft wash, safe for your home and landscaping",
            "Spider webs, wasp nests, and surface debris removed",
            "Pre-wash plant protection and post-wash rinse",
        ],
        "why_barta": "Co-owner Alex Barta and the crew he leads have washed homes throughout the Delano area long enough to know what happens when someone uses too much pressure on siding, cracked panels, water forced behind trim, stripped paint. Barta only soft-washes: low pressure, the right chemistry for algae and mildew, and a gentle rinse. It's safer for your home and the results last far longer than a pressure-only rinse. Fully insured and backed by our 100% satisfaction guarantee.",
        "faqs": [
            ("What surfaces are included in house washing?",
             "Vinyl, fiber-cement, stucco, brick, and painted siding, plus soffits, fascia, and trim."),
            ("Is this the same as pressure washing?",
             "No, house washing uses low-pressure soft washing, which is safer for siding, paint, and landscaping than high-pressure cleaning."),
            ("Will it actually kill the algae, not just rinse it away?",
             "Yes, our solution is formulated to kill algae and mildew at the root, not just rinse the surface, so results last significantly longer than a pressure-only wash."),
            ("Will it harm my landscaping?",
             "We apply pre-wash plant protection and a post-wash rinse as part of every job to protect your landscaping."),
            ("How often should I wash my house?",
             "Most Minnesota homes benefit from a wash about once a year, though homes with heavy shade or lake-adjacent humidity may want it more often."),
            ("Is house washing safe for my windows and other surfaces?",
             "Yes, low-pressure soft washing won't harm windows, trim, or nearby surfaces the way high-pressure cleaning can."),
            ("Can I bundle house washing with other services?",
             "Yes, house washing pairs well with pressure washing, gutter cleaning, and window cleaning for a complete exterior refresh, and bundling can save you money."),
        ],
    },
    {
        "slug": "soft-washing",
        "name": "Soft Washing",
        "icon": "soft",
        "image": "assets/img/svc-soft-washing.jpg",
        "hero_pos": "58%",
        "short": "Low-pressure cleaning for delicate surfaces, stucco, siding, and painted exteriors.",
        "hero_sub": "Serving Delano and communities throughout the western Twin Cities with safe, low-pressure soft washing.",
        "seo_title": "Soft Washing Delano, MN | Barta",
        "seo_desc": "Soft washing in Delano and the western Twin Cities for stucco, siding and painted surfaces. Low-pressure cleaning that protects delicate exteriors.",
        "h1": "Professional Soft Washing",
        "schema_name": "Professional Soft Washing",
        "kw": "soft washing Delano MN",
        "kw2": ["soft wash siding cleaning", "low pressure house wash", "soft washing service", "algae removal soft wash"],
        "benefits": [
            ("Damage-free cleaning", "Low pressure means no etched stucco, stripped paint, or damaged siding."),
            ("Kills at the root", "We treat algae, mold, and mildew at the source, not just knock it off the surface."),
            ("Right chemistry, right surface", "Solutions tuned to each material and the organism we're treating."),
            ("Eco-conscious", "Biodegradable detergents and careful plant protection."),
        ],
        "intro": "High pressure has no place on stucco, screens, or painted surfaces. Soft washing applies specially formulated, biodegradable solutions at low pressure to dissolve algae, mold, mildew, and bacteria, then gently rinses everything clean. It's the method siding manufacturers actually recommend for these delicate surfaces.",
        "includes": [
            "Stucco, siding, and other delicate painted surfaces",
            "Algae, mold, mildew, lichen, and moss treatment",
            "Biodegradable, surface-specific cleaning solutions",
            "Low-pressure application and gentle rinse",
            "Landscaping protection before and after",
        ],
        "process_note": "The trusted method for any surface that high pressure could damage.",
        "why_barta": "Soft washing is the method siding manufacturers actually recommend, and it's how our crew, trained by co-owner Alex Barta, cleans every delicate surface around Delano. We match the chemistry to the surface and the organism instead of just turning up the pressure. Insured, guaranteed, and gentle on everything but the grime.",
        "faqs": [
            ("What surfaces need soft washing instead of pressure washing?",
             "Stucco, siding, screens, and other painted or delicate surfaces should always be soft washed rather than pressure washed."),
            ("Will low pressure actually get things clean?",
             "Yes, soft washing pairs low pressure with solutions that dissolve algae, mold, and mildew at the root, which loosens organic growth thoroughly without needing high pressure."),
            ("Is it safe for my landscaping?",
             "We protect landscaping before washing and rinse thoroughly afterward as part of every job."),
            ("Will this damage paint or siding?",
             "No, that's the point of soft washing. Low pressure means no etched stucco, stripped paint, or damaged siding, unlike pressure washing on delicate surfaces."),
            ("How often should soft washing be done?",
             "Most surfaces benefit from soft washing about once a year, though algae-prone, shaded, or lake-adjacent homes may need it more often to stay ahead of regrowth."),
            ("Do you offer recurring plans for soft washing?",
             "Yes, our membership plans can bundle it on the ideal schedule at a member discount, so it's handled automatically."),
        ],
    },
    {
        "slug": "solar-panel-cleaning",
        "name": "Solar Panel Cleaning",
        "icon": "solar",
        "hero_pos": "29% 30%",
        "image": "assets/img/svc-solar-panel-cleaning.jpg",
        "short": "Dust, pollen, and grime cut solar output, we restore peak efficiency safely.",
        "hero_sub": "Serving Delano and communities throughout the western Twin Cities with safe solar panel cleaning that restores lost output.",
        "seo_title": "Solar Panel Cleaning Delano, MN | Barta",
        "seo_desc": "Solar panel cleaning in Delano and the western Twin Cities. Restore lost energy output with safe, spot-free panel washing. Get a free quote.",
        "h1": "Professional Solar Panel Cleaning",
        "schema_name": "Professional Solar Panel Cleaning",
        "kw": "solar panel cleaning Delano MN",
        "kw2": ["solar panel cleaning service", "solar panel washing", "clean solar panels near me", "solar maintenance"],
        "benefits": [
            ("Recover lost output", "Dust and grime buildup can quietly reduce how much power your panels produce."),
            ("Manufacturer-safe methods", "Pure water and soft tools protect panels and coatings."),
            ("Protect your ROI", "Maximize the return on your solar investment."),
            ("Safe, insured access", "Trained, fully insured technicians handle the height."),
        ],
        "intro": "Solar panels are an investment in lower energy bills, but pollen, dust, bird droppings, and Minnesota winter grime form a film that quietly steals output. Barta cleans panels with pure, deionized water and soft, non-abrasive tools that protect the glass and anti-reflective coating, restoring efficiency without scratches or harsh chemicals.",
        "includes": [
            "Residential and commercial solar arrays",
            "Pure-water, spot-free cleaning",
            "Soft, non-abrasive tools safe for panel coatings",
            "Removal of pollen, dust, droppings, and film",
            "Safe, insured roof and array access",
            "Recommended cleaning schedule for your system",
        ],
        "process_note": "Ask about seasonal cleaning plans to keep production at its peak.",
        "why_barta": "A layer of dust and pollen can cost you real solar output without ever being obvious from the ground, and co-owner Alex Barta and the crew he leads help Delano-area homeowners recover that lost production. We only use pure water and soft tools, because scratched glass or a damaged coating costs you far more than the wash saves. Fully insured for roof and ground-mount access, and backed by our satisfaction guarantee.",
        "faqs": [
            ("How much output can dirty panels lose?",
             "It depends on how much buildup has accumulated, but even a light layer of dust and grime can noticeably reduce how much power your panels produce, cleaning restores that lost output."),
            ("Will cleaning damage my panels or their coating?",
             "No, we use pure, deionized water and soft, non-abrasive tools designed to protect the glass and anti-reflective coating."),
            ("Do you clean residential and commercial arrays?",
             "Yes, we clean both residential rooftop systems and commercial arrays."),
            ("How often should solar panels be cleaned?",
             "We recommend cleaning solar panels twice a year to keep them performing at their best."),
            ("Is roof access included and safe?",
             "Yes, our insured technicians handle roof and ground-mount access safely as part of the service."),
            ("Will cleaning extend the life of my solar panels?",
             "Keeping panels free of dust, grime, and buildup helps prevent long-term wear on the glass and coating, so regular cleaning is one of the easiest ways to protect your investment."),
            ("Can I clean my solar panels myself?",
             "You can, but the wrong tools or technique can scratch the glass, damage the anti-reflective coating, or void your manufacturer's warranty. Our insured technicians use pure water and soft, non-abrasive tools specifically to avoid that risk."),
        ],
    },
    {
        "slug": "screen-cleaning",
        "name": "Screen Cleaning Services",
        "icon": "screen",
        "image": "assets/img/svc-screen-cleaning-services.jpg",
        "hero_pos": "95% 20%",
        "short": "Hand-washed window screens that breathe better and look brand new.",
        "hero_sub": "Serving Delano and communities throughout the western Twin Cities with hand-washed window screens.",
        "seo_title": "Screen Cleaning Delano, MN | Barta",
        "seo_desc": "Screen cleaning in Delano and the western Twin Cities. Hand-washed window screens for clearer views and better airflow. Get a free quote.",
        "h1": "Professional Screen Cleaning",
        "schema_name": "Professional Screen Cleaning",
        "kw": "window screen cleaning Delano MN",
        "kw2": ["screen cleaning service", "window screen washing", "window screen repair", "screen repair near me"],
        "benefits": [
            ("Clearer views", "Clean screens let in more light and a crisper view."),
            ("Better airflow", "Dust and pollen come out of the mesh, not into your home."),
            ("Hand-washed, not just brushed", "Each screen is washed, rinsed, and dried by hand."),
            ("Pairs with window cleaning", "The perfect finishing touch on freshly cleaned glass."),
        ],
        "intro": "There's no point cleaning your glass and reinstalling dusty screens over it. Barta removes and hand-washes every window screen, clearing the mesh of pollen, dust, and cobwebs, then reinstalls each one exactly where it belongs. The result is brighter rooms, better airflow, and windows that truly look finished.",
        "includes": [
            "All window screens on your home",
            "Removed and hand-washed",
            "Frames and mesh cleaned and rinsed",
            "Dried and reinstalled in the correct opening",
            "Some screens available for repair upon request",
            "Add-on to any window cleaning service",
        ],
        "process_note": "Screen cleaning is available as an add-on to any window cleaning visit.",
        "why_barta": "Screens are the last thing most companies think about and the first thing we do right, we hand-wash every screen we touch instead of just brushing off the front. It's a small detail that makes a real difference in how much light and airflow actually gets through. Easy to add to any window cleaning visit, and backed by our satisfaction guarantee.",
        "faqs": [
            ("Are screens removed or cleaned in place?",
             "We remove and hand-wash each screen individually, then reinstall it in its original opening, nothing is cleaned in place."),
            ("How often should screens be cleaned?",
             "Most homes benefit from screen cleaning about once a year, timed with your regular window cleaning, more often if you're near open fields, construction, or heavy pollen."),
            ("What if a screen is torn or damaged?",
             "If a screen is torn or damaged, we won't clean it, we don't want to risk making the damage worse. Depending on the screen, repair may be available upon request for an added charge; just ask when you book."),
            ("Do you clean both sides of the screen?",
             "Yes, each screen is fully removed so we can wash both sides and the frame, not just what's visible from outside."),
        ],
    },
    {
        "slug": "hard-water-stain-removal",
        "name": "Hard Water Stain Removal",
        "icon": "drop",
        "image": "assets/img/svc-hand-scrubbing.jpg",
        "hero_pos": "63% 37%",
        "short": "Remove cloudy mineral stains from glass that ordinary cleaning can't touch.",
        "hero_sub": "Serving Delano and communities throughout the western Twin Cities with professional hard water stain removal for glass.",
        "seo_title": "Hard Water Stain Removal Delano, MN | Barta",
        "seo_desc": "Hard water stain removal in Delano and the western Twin Cities. Restore cloudy, mineral-stained glass that ordinary cleaning can't fix. Get a quote.",
        "h1": "Professional Hard Water Stain Removal",
        "schema_name": "Professional Hard Water Stain Removal",
        "kw": "hard water stain removal Delano MN",
        "kw2": ["hard water stain removal glass", "mineral stain removal windows", "water spot removal", "glass restoration service"],
        "benefits": [
            ("Restore clear glass", "Remove the cloudy haze sprinklers and minerals leave behind."),
            ("Save the windows", "Far cheaper than replacing etched or stained glass."),
            ("Specialized process", "Professional compounds and technique, not guesswork."),
            ("Protective options", "Ask about coatings that help repel future spotting."),
        ],
        "intro": "Sprinkler overspray, runoff, and Minnesota's hard water leave behind mineral deposits that bond to glass and fog it permanently if ignored. Barta uses professional restoration compounds and proven technique to dissolve and lift these deposits, bringing back clarity that standard window cleaning simply cannot, and we can apply a protective treatment to slow future buildup.",
        "includes": [
            "Windows, glass doors, and shower glass",
            "Assessment of stain severity and etching",
            "Professional mineral-dissolving restoration process",
            "Multi-stage treatment for heavy deposits",
            "Optional protective glass coating",
            "Prevention tips to keep glass clearer",
        ],
        "process_note": "Severity varies, we provide an honest assessment before any work begins.",
        "why_barta": "Minnesota's hard water and sprinkler overspray leave mineral deposits that regular window cleaning can't touch, and our crew, trained by co-owner Alex Barta, restores glass for homeowners around Delano. We'll give you an honest read on what's recoverable before starting, sometimes buildup lifts completely, sometimes years of etching means a coating is the best next step. Either way, no guesswork, no surprise charges, and our satisfaction guarantee applies.",
        "faqs": [
            ("How is this different from regular window cleaning?",
             "Regular window cleaning removes ordinary dirt, pollen, and everyday grime. Hard-water spot treatment isn't part of a standard visit, it's included at no charge on certain service plans, or available as an add-on. Hard Water Stain Removal is a separate, dedicated process for mineral deposits and etching that have bonded to the glass and that standard cleaning can't dissolve."),
            ("Can all hard water staining be removed?",
             "It depends on severity, light-to-moderate buildup usually lifts in one treatment, but years of untreated exposure can etch the glass itself, which limits how much clarity comes back. We give an honest assessment before starting."),
            ("Will this prevent staining from coming back?",
             "We can apply an optional protective coating that makes it harder for new deposits to bond, though the most effective prevention is addressing the water source itself, for example, redirecting a sprinkler head."),
            ("How is pricing determined?",
             "Severity varies significantly from window to window, so we assess your glass and provide an honest, upfront quote before any work begins."),
        ],
    },
    {
        "slug": "christmas-light-installation",
        "name": "Christmas Light Installation",
        "hero_pos": "70% 48%",
        "icon": "lights",
        "image": "assets/img/xmas-lights-stone-home.jpg",
        "short": "Professional, custom holiday lighting, design, install, maintain, and take down.",
        "hero_sub": "Skip the cold ladder, serving Delano and communities throughout the western Twin Cities with premium holiday lighting.",
        # Exact title/meta/H1 per the Dec-2026 SEO pass, this service gets its
        # own copy instead of the generic "<Service> in <City>, MN" template.
        "seo_title": f"Christmas Light Installation Delano, MN | {BIZ['short']}",
        "seo_desc": "Custom Christmas light installation in Delano and the western Twin Cities. Design, installation, maintenance and removal included. Get a quote.",
        "h1": "Custom Christmas Light Installation",
        "schema_name": "Custom Christmas Light Installation",
        "kw": "Christmas light installation Delano MN",
        "kw2": ["holiday light installation", "Christmas light hanging service", "professional holiday lighting", "outdoor Christmas lights installation"],
        "benefits": [
            ("Custom-cut strands", "Every strand is measured and cut to your roofline and peaks, no extra lights or cords hanging off your home."),
            ("Premium commercial-grade LED bulbs", "Bright, energy-efficient LED bulbs built to outlast a Minnesota winter and look sharp season after season."),
            ("Takedown &amp; storage included", "When the season's over, we take it all down and store it for you, built into your price, not an extra add-on."),
            ("Clips that last", "Heavy-duty clips grip any roofline, shingle, or gutter without damage, built to hold through the hardest winter months."),
            ("Proper safety equipment", "Our insured crew climbs so you don't have to, full safety gear every time, so nobody's risking a fall on an icy ladder."),
            ("Upfront, honest pricing", "Clear pricing before we start, no surprise fees and no pressure, just an honest quote for a beautifully lit home."),
        ],
        "intro": "The magic of a beautifully lit home, without a single trip up a frozen ladder. Barta designs a custom holiday display for your rooflines, walkways, trees, and shrubs, installs premium commercial-grade lighting, and keeps it shining all season. When the holidays end, we take everything down and store it for next year. You enjoy the lights; we handle everything else.",
        "includes": [
            "Free custom lighting design consultation",
            "Premium, commercial-grade LED lights and greenery",
            "Professional installation on rooflines, trees, and walkways",
            "In-season maintenance, burnt-out bulbs replaced free",
            "Post-season takedown",
            "Storage of your lights between seasons, included in your price",
        ],
        "process_note": "Books up fast, reserve your install in early fall for best availability.",
        # Promotional, not a second feature list, the intro and the benefits
        # already cover design, custom-cutting, insurance, maintenance and
        # takedown. No role attribution: who does what was being stated wrong.
        "why_barta": "Make your home the one the whole street slows down for. Our team will have it glowing before the first snow and keep it that way right through the season, so all you have to do is pull into the driveway and enjoy it.",
        "experience_steps": [
            ("Custom-Cut Christmas Lights", "We measure your roofline and peaks, then custom-cut every strand to fit, no extra lights or cords bunched up or hanging loose."),
            ("Takedown &amp; Storage, Included", "Storing lights is a hassle, so we handle it. After the holidays, we take everything down and store it at our shop, organized and ready to go for next year, it's part of your price, not something you add on separately."),
            ("Come Back Next Year", "Every fall, we reach out to get you back on the schedule, so your lights are up and ready well before the holidays."),
        ],
        # Replaces the generic shared service-page FAQ (which talks about
        # "scheduling twice a year" and "membership plans", neither applies
        # to a seasonal install). Every answer is written from copy already
        # established above (includes/process_note), nothing new invented.
        # [OWNER VERIFICATION REQUIRED] exact takedown timing/month is
        # carried over from existing site copy and should be confirmed
        # before relying on this page commercially. (Storage confirmed
        # included in price, not a separate add-on; insurance wording
        # confirmed accurate, owner confirmed there is no such thing as a
        # window-cleaner's license in Minnesota, so "licensed" claims were
        # removed sitewide in favor of "insured" only.)
        "faqs": [
            ("How much does Christmas light installation cost?",
             "Every home's roofline and layout is different, so there's no fixed price list. Request a free quote and we'll give you clear, upfront pricing before any work begins."),
            ("Does Barta provide the lights?",
             "Yes, commercial-grade LED lights and greenery are included in the installation. You don't need to buy or supply anything yourself."),
            ("What is included with installation?",
             "A free design consultation, commercial-grade LED lights, professional installation on your roofline, trees, and walkways, in-season maintenance, and post-season takedown and storage, all included in your price."),
            ("What happens if a bulb or strand fails?",
             "Let us know and we'll repair or replace it at no charge during the season as part of our included in-season maintenance."),
            ("When are the lights taken down?",
             "We schedule takedown after the holiday season ends. Your installer will confirm the planned takedown window with you."),
            ("Can Barta store the lights?",
             "Yes, storage between seasons is included in your price, not a separate add-on, so your lights are organized and ready to go again next year."),
            ("When should I reserve installation?",
             "Installation books up quickly each season, so we recommend reserving your spot in early fall for the best availability."),
            ("What areas do you serve?",
             "Delano and the western Twin Cities metro, the same service area we cover for all of our exterior cleaning services."),
        ],
    },
    {
        "slug": "commercial-cleaning",
        "name": "Commercial Cleaning",
        "icon": "building",
        "hero_pos": "42%",
        "image": "assets/img/svc-commercial-cleaning.jpg",
        "short": "Reliable, scheduled exterior cleaning for your business, storefronts, offices, and more.",
        "hero_sub": "Serving Delano and businesses throughout the western Twin Cities, from storefronts to multi-building portfolios, with flexible scheduling and a single point of contact.",
        "seo_title": "Commercial Exterior Cleaning Delano, MN | Barta",
        "seo_desc": "Commercial exterior cleaning in Delano and the western Twin Cities. Scheduled window, gutter and pressure washing for your property. Get a quote.",
        "h1": "Commercial Exterior Cleaning Services",
        "schema_name": "Commercial Exterior Cleaning Services",
        "kw": "commercial window cleaning Twin Cities MN",
        "kw2": ["commercial window cleaning", "office building cleaning", "retail storefront cleaning", "property management exterior services"],
        "benefits": [
            ("One reliable vendor", "Every building, every service, one point of contact."),
            ("Fully insured", "Comprehensive insurance coverage on every job, for your property and our team."),
            ("Flexible scheduling", "We work around your hours and your tenants, day or night."),
            ("Fast quote turnaround", "Clear, upfront commercial quotes typically within 24 hours."),
        ],
        "intro": "Your building is the first impression every customer, tenant, and partner forms about your business. Streaked windows and grimy entrances quietly cost you, clean ones quietly win. Barta delivers dependable, scheduled commercial cleaning that keeps your property looking its absolute best, without you having to manage it. We work around your hours, carry full insurance coverage, and assign a single account contact so service is effortless.",
        "includes": [
            "Storefront &amp; office window cleaning",
            "High-rise &amp; multi-story water-fed pole cleaning",
            "Pressure washing for lots, walkways &amp; entries",
            "Building &amp; awning soft washing",
            "Gutter cleaning &amp; maintenance",
            "Solar array cleaning",
            "Recurring scheduled service contracts",
            "Post-construction cleanup",
        ],
        # [OWNER VERIFICATION REQUIRED] the "typically within 24 hours"
        # quote-turnaround figure (benefits above) is a pre-existing site
        # claim, not introduced here. (Insured wording confirmed; "licensed"
        # and "bonded" claims removed, owner confirmed neither applies.)
        "faqs": [
            ("What services are included for commercial properties?",
             "Storefront and office window cleaning, high-rise water-fed pole cleaning, pressure washing, building soft washing, gutter cleaning, and solar array cleaning, scheduled around your business."),
            ("Can you work outside business hours?",
             "Yes, we schedule around your hours and your tenants, including evenings and weekends when needed."),
            ("Do you offer recurring service contracts?",
             "Yes, recurring scheduled service contracts are available for ongoing maintenance rather than one-off visits."),
            ("Do you handle multi-building portfolios?",
             "Yes, from single storefronts to multi-building portfolios, we act as one reliable vendor and point of contact."),
        ],
        "cta_text": "Get your free, no-obligation commercial exterior cleaning quote today and see why businesses and property managers across the western Twin Cities trust Barta.",
    },
]

# ---------------------------------------------------------------------------
# Header "Our Services" dropdown, exact list as offered, mapped to pages.
# (label, target page relative to site root)
# ---------------------------------------------------------------------------
DROPDOWN_SERVICES = [
    ("Exterior Window Cleaning", "services/exterior-window-cleaning.html"),
    ("Interior Window Cleaning", "services/interior-window-cleaning.html"),
    ("Screen Cleaning Services", "services/screen-cleaning.html"),
    ("Track Detailing", "services/track-detailing.html"),
    ("Solar Panel Cleaning", "services/solar-panel-cleaning.html"),
    ("Gutter Cleaning", "services/gutter-cleaning.html"),
    ("Soft Washing", "services/soft-washing.html"),
    ("Pressure Washing", "services/pressure-washing.html"),
    ("Christmas Light Installation", "services/christmas-light-installation.html"),
]

# Homepage "Our Services" picture-box grid (first two are featured/large).
HOME_SERVICES = [
    {"label": "Exterior Window Cleaning", "target": "services/exterior-window-cleaning.html", "icon": "window", "featured": True,
     "desc": "Streak-free exterior glass that makes your whole home shine."},
    {"label": "Interior Window Cleaning", "target": "services/interior-window-cleaning.html", "icon": "window", "featured": True,
     "desc": "Spotless interior glass for brighter, sun-filled rooms."},
    {"label": "Screen Cleaning Services", "target": "services/screen-cleaning.html", "icon": "screen",
     "desc": "Hand-washed screens for clearer views and better airflow."},
    {"label": "Track Detailing", "target": "services/track-detailing.html", "icon": "wrench",
     "desc": "Deep-cleaned window tracks and sills, free of built-up grime."},
    {"label": "Solar Panel Cleaning", "target": "services/solar-panel-cleaning.html", "icon": "solar",
     "desc": "Restore lost output with safe, spot-free panel cleaning."},
    {"label": "Gutter Cleaning", "target": "services/gutter-cleaning.html", "icon": "gutter",
     "desc": "Hand-cleared gutters and flushed downspouts that protect your home."},
    {"label": "Soft Washing", "target": "services/soft-washing.html", "icon": "soft",
     "desc": "Gentle, low-pressure cleaning that kills algae and mildew."},
    {"label": "Pressure Washing", "target": "services/pressure-washing.html", "icon": "pressure",
     "desc": "Restore driveways, patios, and walkways to like-new."},
    {"label": "Commercial Cleaning", "target": "services/commercial-cleaning.html", "icon": "building",
     "desc": "Reliable, scheduled exterior cleaning for your business."},
    # Explicit img: this card's filename guess (svc-christmas-light-installation.jpg)
    # is the service's old hero photo, which now only lives in the gallery. Point
    # it at the current hero so the card matches the page it links to.
    {"label": "Christmas Light Installation", "target": "services/christmas-light-installation.html", "icon": "lights",
     "img": "assets/img/xmas-lights-stone-home.jpg",
     "desc": "Custom holiday lighting, we design, hang, maintain, and take it down."},
]

# ---------------------------------------------------------------------------
# Service areas, each drives a local landing page
# ---------------------------------------------------------------------------
AREAS = [
    # Primary service area
    {"slug": "delano", "city": "Delano", "neighborhoods": ["Downtown Delano", "Highland Ridge", "Crow River", "Kings Pointe"], "note": "our home base", "tier": "primary"},
    {"slug": "buffalo", "city": "Buffalo", "neighborhoods": ["Buffalo Lake", "Sturges Park", "Griffing"], "note": "", "tier": "primary"},
    {"slug": "medina", "city": "Medina", "neighborhoods": ["Hamel", "Independence Beach border", "Loretto border"], "note": "", "tier": "primary"},
    {"slug": "mound", "city": "Mound", "neighborhoods": ["Lake Minnetonka shoreline", "Downtown Mound"], "note": "", "tier": "primary"},
    {"slug": "plymouth", "city": "Plymouth", "neighborhoods": ["Bass Lake", "Medicine Lake", "Plymouth Creek", "Kingsview"], "note": "", "tier": "primary"},
    {"slug": "st-michael", "city": "St. Michael", "neighborhoods": ["Downtown St. Michael", "Riverview Preserve", "STMA area"], "note": "", "tier": "primary"},
    # Additional service area
    {"slug": "chanhassen", "city": "Chanhassen", "neighborhoods": ["Lake Minnewashta", "Lotus Lake", "Longacres"], "note": "", "tier": "extended"},
    {"slug": "corcoran", "city": "Corcoran", "neighborhoods": ["Hackamore", "Rush Creek", "Pioneer"], "note": "", "tier": "extended"},
    {"slug": "deephaven", "city": "Deephaven", "neighborhoods": ["Lake Minnetonka shoreline", "Cottagewood"], "note": "", "tier": "extended"},
    {"slug": "excelsior", "city": "Excelsior", "neighborhoods": ["Downtown Excelsior", "Lake Minnetonka shoreline"], "note": "", "tier": "extended"},
    {"slug": "greenfield", "city": "Greenfield", "neighborhoods": ["Rural Greenfield", "Rockford border"], "note": "", "tier": "extended"},
    {"slug": "greenwood", "city": "Greenwood", "neighborhoods": ["Lake Minnetonka shoreline"], "note": "", "tier": "extended"},
    {"slug": "hamel", "city": "Hamel", "neighborhoods": ["Downtown Hamel", "Medina area"], "note": "", "tier": "extended"},
    {"slug": "hanover", "city": "Hanover", "neighborhoods": ["Downtown Hanover", "Crow River"], "note": "", "tier": "extended"},
    {"slug": "independence", "city": "Independence", "neighborhoods": ["Lake Independence", "Lake Sarah"], "note": "", "tier": "extended"},
    {"slug": "long-lake", "city": "Long Lake", "neighborhoods": ["Long Lake shoreline", "Downtown Long Lake"], "note": "", "tier": "extended"},
    {"slug": "loretto", "city": "Loretto", "neighborhoods": ["Downtown Loretto", "Pioneer Trail area"], "note": "", "tier": "extended"},
    {"slug": "maple-grove", "city": "Maple Grove", "neighborhoods": ["Rush Creek", "Fish Lake", "Weaver Lake", "Arbor Lakes"], "note": "", "tier": "extended"},
    {"slug": "maple-plain", "city": "Maple Plain", "neighborhoods": ["Downtown Maple Plain", "Baker Park area"], "note": "", "tier": "extended"},
    {"slug": "minnetonka", "city": "Minnetonka", "neighborhoods": ["Glen Lake", "Opus", "Groveland"], "note": "", "tier": "extended"},
    {"slug": "minnetonka-beach", "city": "Minnetonka Beach", "neighborhoods": ["Lake Minnetonka shoreline"], "note": "", "tier": "extended"},
    {"slug": "minnetrista", "city": "Minnetrista", "neighborhoods": ["Halsted Bay area", "Lake Minnetonka shoreline"], "note": "", "tier": "extended"},
    {"slug": "montrose", "city": "Montrose", "neighborhoods": ["Downtown Montrose", "South Fork Crow River"], "note": "", "tier": "extended"},
    {"slug": "orono", "city": "Orono", "neighborhoods": ["Crystal Bay", "Navarre", "Lake Minnetonka shoreline"], "note": "", "tier": "extended"},
    {"slug": "rockford", "city": "Rockford", "neighborhoods": ["Downtown Rockford", "Rockford Township"], "note": "", "tier": "extended"},
    {"slug": "rogers", "city": "Rogers", "neighborhoods": ["Downtown Rogers"], "note": "", "tier": "extended"},
    {"slug": "spring-park", "city": "Spring Park", "neighborhoods": ["Lake Minnetonka shoreline"], "note": "", "tier": "extended"},
    {"slug": "st-bonifacius", "city": "St. Bonifacius", "neighborhoods": ["Downtown St. Bonifacius", "Lake Minnetonka area"], "note": "", "tier": "extended"},
    {"slug": "tonka-bay", "city": "Tonka Bay", "neighborhoods": ["Lake Minnetonka shoreline"], "note": "", "tier": "extended"},
    {"slug": "victoria", "city": "Victoria", "neighborhoods": ["Downtown Victoria", "Lake Bavaria area"], "note": "", "tier": "extended"},
    {"slug": "waconia", "city": "Waconia", "neighborhoods": ["Downtown Waconia", "Lake Waconia shoreline", "Lakeview Terrace"], "note": "", "tier": "extended"},
    {"slug": "waverly", "city": "Waverly", "neighborhoods": ["Downtown Waverly", "Waverly Lake"], "note": "", "tier": "extended"},
    {"slug": "wayzata", "city": "Wayzata", "neighborhoods": ["Ferndale", "Holdridge", "Downtown Wayzata"], "note": "", "tier": "extended"},
    {"slug": "woodland", "city": "Woodland", "neighborhoods": ["Lake Minnetonka shoreline"], "note": "", "tier": "extended"},
    # Every remaining city in Wright and Carver within SERVICE_RADIUS_MI
    # straight-line miles of Delano, with the distance measured from each
    # city's own published coordinates (the comment on each line).
    # "neighborhoods" is only rendered on a city's own page, which extended
    # cities do not have (the assertion below guards that).
    {"slug": "howard-lake", "city": "Howard Lake", "neighborhoods": [], "note": "", "tier": "extended"},      # 13.9 mi
    {"slug": "albertville", "city": "Albertville", "neighborhoods": [], "note": "", "tier": "extended"},      # 14.9 mi
    {"slug": "maple-lake", "city": "Maple Lake", "neighborhoods": [], "note": "", "tier": "extended"},        # 16.6 mi
    {"slug": "monticello", "city": "Monticello", "neighborhoods": [], "note": "", "tier": "extended"},        # 17.9 mi
    {"slug": "otsego", "city": "Otsego", "neighborhoods": [], "note": "", "tier": "extended"},                # 18.4 mi
    {"slug": "cokato", "city": "Cokato", "neighborhoods": [], "note": "", "tier": "extended"},                # 19.7 mi
    {"slug": "watertown", "city": "Watertown", "neighborhoods": [], "note": "", "tier": "extended"},          #  6.2 mi
    {"slug": "mayer", "city": "Mayer", "neighborhoods": [], "note": "", "tier": "extended"},                  # 11.8 mi
    {"slug": "new-germany", "city": "New Germany", "neighborhoods": [], "note": "", "tier": "extended"},      # 14.3 mi
    {"slug": "chaska", "city": "Chaska", "neighborhoods": [], "note": "", "tier": "extended"},                # 17.7 mi
    {"slug": "cologne", "city": "Cologne", "neighborhoods": [], "note": "", "tier": "extended"},              # 18.8 mi
    {"slug": "norwood-young-america", "city": "Norwood Young America", "neighborhoods": [], "note": "", "tier": "extended"},  # 19.7 mi
]

# How far we travel from Delano: the rule every city in AREAS was measured
# against (straight-line miles from Delano's lat/lng to the city's own
# published coordinates). Not printed on the site — the pages say "the west
# metro and surrounding areas", which is how a customer thinks about it —
# but it is what decides whether a town belongs on the list.
SERVICE_RADIUS_MI = 20

# The counties those cities sit in, in the order the pages list them (home
# base first). "query" is what the map is searched for — Google's keyless
# embed draws a county's boundary for a "<County>, MN" search — and what its
# "open in Google Maps" link points at.
COUNTIES = [
    {"name": "Wright County", "query": "Wright County, MN"},
    {"name": "Hennepin County", "query": "Hennepin County, MN"},
    {"name": "Carver County", "query": "Carver County, MN"},
]

# What the map shows before any county is opened, and what it returns to when
# one is closed: Hennepin, where most of the towns we serve are, drawn as an
# outline. No pin on the shop — the question the map answers is "do you come
# out my way?", not "where are you?". The county list keeps its own order
# (home base first), so this names the county rather than taking a position.
SERVICE_AREA_VIEW = dict(next(c for c in COUNTIES if c["name"] == "Hennepin County"),
                         label="Hennepin County")

# Which county each service-area city belongs to (by slug). A city that
# straddles a county line is listed under the county holding most of it:
# Hanover and Rockford reach into Hennepin, Chanhassen into Hennepin.
CITY_COUNTY = {
    "delano": "Wright County", "buffalo": "Wright County", "st-michael": "Wright County",
    "hanover": "Wright County", "montrose": "Wright County", "rockford": "Wright County",
    "waverly": "Wright County", "howard-lake": "Wright County", "albertville": "Wright County",
    "maple-lake": "Wright County", "monticello": "Wright County", "otsego": "Wright County",
    "cokato": "Wright County",
    "medina": "Hennepin County", "mound": "Hennepin County", "plymouth": "Hennepin County",
    "corcoran": "Hennepin County", "deephaven": "Hennepin County",
    "excelsior": "Hennepin County", "greenfield": "Hennepin County",
    "greenwood": "Hennepin County", "hamel": "Hennepin County", "independence": "Hennepin County",
    "long-lake": "Hennepin County", "loretto": "Hennepin County", "maple-grove": "Hennepin County",
    "maple-plain": "Hennepin County", "minnetonka": "Hennepin County", "minnetonka-beach": "Hennepin County",
    "minnetrista": "Hennepin County", "orono": "Hennepin County", "rogers": "Hennepin County",
    "spring-park": "Hennepin County", "st-bonifacius": "Hennepin County", "tonka-bay": "Hennepin County",
    "wayzata": "Hennepin County", "woodland": "Hennepin County",
    "chanhassen": "Carver County", "victoria": "Carver County", "waconia": "Carver County",
    "watertown": "Carver County", "mayer": "Carver County", "new-germany": "Carver County",
    "chaska": "Carver County", "cologne": "Carver County", "norwood-young-america": "Carver County",
}
for _a in AREAS:
    _a["county"] = CITY_COUNTY[_a["slug"]]   # KeyError = a city with no county; fix the map above
assert {c["name"] for c in COUNTIES} == set(CITY_COUNTY.values()), "every county in CITY_COUNTY needs a COUNTIES entry, and vice versa"
assert len({_a["slug"] for _a in AREAS}) == len(AREAS), "duplicate city slug in AREAS"
# A city page prints its neighborhoods in a sentence, so a primary-tier city
# has to have some; extended cities have no page and may leave the list empty.
assert all(_a["neighborhoods"] for _a in AREAS if _a["tier"] == "primary"), \
    "a primary-tier city needs neighborhoods — its own page prints them"

# The closing call-to-action's photo rotation: pages take one each, in build
# order (components.cta_band). The band is a wide, short strip with white
# text over the middle of it, so a photo earns a place here only if the 3:1
# crop still shows the work and the text still reads — "focal_y" is the
# background-position that keeps the subject in that crop. Every entry was
# judged against the real image at banner proportions, twice.
# Ordered so consecutive pages get visibly different scenes — a wide shot
# then a close one, a technician then a house.
CTA_PHOTOS = [
    {"image": "assets/img/svc-exterior-window-cleaning.jpg", "focal_x": 76, "focal_y": 45},
    {"image": "assets/img/3P8A8136.JPEG", "focal_y": 55},
    {"image": "assets/img/instagram/18105187085130700_1.jpg", "focal_y": 45},
    {"image": "assets/img/svc-detail-frame.jpg", "focal_y": 43},
    {"image": "assets/img/DSC03260.jpg", "focal_y": 30},
    {"image": "assets/img/svc-commercial-cleaning.jpg", "focal_y": 40},
    {"image": "assets/img/svc-screen-cleaning-services.jpg", "focal_y": 19},
    {"image": "assets/img/3P8A7912.JPEG", "focal_x": 90, "focal_y": 45},
    {"image": "assets/img/svc-solar-panel-cleaning.jpg", "focal_y": 44},
]

# Two pages pin their own banner instead of taking a turn: the gallery (so
# the photo above the fold isn't repeated in its own grid) and the Christmas
# page (lights, not window cleaning). Listed here, not inline at the call
# site, so they get the same sharp 1600w treatment as the rotation.
CTA_PINNED_PHOTOS = {
    "gallery": {"image": "assets/img/hero-home-main.jpg", "focal_x": 58, "focal_y": 55},
    "christmas": {"image": "assets/img/xmas-lights-stone-home.jpg", "focal_x": 70, "focal_y": 42},
}

# ZIP codes served, shown on the Service Areas hub page for local SEO.
ZIP_CODES = [
    "55305", "55311", "55313", "55317", "55328", "55331", "55340", "55341",
    "55343", "55345", "55356", "55357", "55359", "55363", "55364", "55369",
    "55373", "55374", "55375", "55376", "55384", "55386", "55387", "55388",
    "55390", "55391", "55446", "55447",
]

# ---------------------------------------------------------------------------
# Recurring-plan promo cards (Biannual / Quarterly / Monthly), the compact
# 3-card widget shown on the homepage, every service page, and the quote
# wizard's plan step. This is the SINGLE recurring-plan program on the site:
# every renderer (components.promo_plan_cards, components.quote_wizard) reads
# from these two names, so the numbers can't drift out of sync between pages.
#
# A prior, unrelated "Clear View / Crystal Plus / Signature Estate" monthly-
# membership system (formerly `PLANS`, rendered on `service-plans.html`) was
# created by mistake and has been permanently deleted at the owner's
# direction, see docs/OWNER-VERIFICATION.md Section 1. This is the only
# recurring-plan data structure left in the repo.
#
# [OWNER VERIFICATION REQUIRED], the dollar amounts and perks below are
# still unverified against real business practice (see
# docs/OWNER-VERIFICATION.md items 1-6). "7-Day Rain Guarantee" and "Free
# Hard Water Removal" in particular appear nowhere else in the repo to
# corroborate them.
PROMO_PLANS = [
    # (display name, url slug, "$ off per cleaning", featured-in-comparison, most-popular-badge, cadence line)
    ("Biannual", "biannual", "50", False, False, "2 Exterior Cleans / Year"),
    ("Quarterly", "quarterly", "100", True, True, "3 Exterior + 1 Interior / Year"),
    ("Monthly", "monthly", "150", True, False, "12 Exterior Cleans / Year"),
]
PROMO_FEATS = ["Priority Scheduling", "7-Day Rain Guarantee", "Free Hard Water Removal"]

# ---------------------------------------------------------------------------
# Testimonials, intentionally empty. There is no curated-quote content here;
# real reviews live on Google (see BIZ["google"]) and render via the
# REVIEWS_WIDGET embed in build.py when configured. Do not add invented
# testimonials here, reviews_block() in components.py falls back to a
# Google-badge CTA when this list is empty, instead of a blank grid.
# ---------------------------------------------------------------------------
REVIEWS = []

# ---------------------------------------------------------------------------
# Team, Alex and Jacob are brothers who co-founded the company in 2024.
# Alex leads the field side (technicians and crews, on every job site);
# Jacob runs the office and sales side (quotes, scheduling, customer contact).
# ---------------------------------------------------------------------------
TEAM = [
    ("Jacob Barta", "Co-Owner", "JB", "assets/img/team-jacob.jpg", "Jacob is organized and straightforward, the one who makes sure nothing falls through the cracks. If you've talked to Barta on the phone or gotten a clear answer fast, that's Jacob."),
    ("Alex Barta", "Co-Owner", "AB", "assets/img/team-alex.jpg", "Alex is steady and hands-on, the kind of person who'd rather show you than tell you. He manages the crew day to day and holds everyone, himself included, to the standard he'd want at his own home."),
]

# ---------------------------------------------------------------------------
# Blog posts
# ---------------------------------------------------------------------------
POSTS = [
    {
        "slug": "how-often-clean-windows-minnesota",
        "seo_title": "How Often to Clean Windows in Minnesota",
        "title": "How Often Should You Clean Your Windows in Minnesota?",
        "excerpt": "Pollen in spring, dust in summer, and ice in winter all take a toll. Here's the realistic cleaning schedule we recommend for Minnesota homes.",
        "date": "2026-05-18",
        "read": "5 min",
        "cat": "Window Cleaning",
    },
    {
        "slug": "soft-washing-vs-pressure-washing",
        "seo_title": "Soft Washing vs. Pressure Washing",
        "title": "Soft Washing vs. Pressure Washing: Which Does Your Home Need?",
        "excerpt": "Using the wrong method can damage siding, stucco, and paint. Here's how to tell which approach is right for each surface on your home.",
        "date": "2026-04-29",
        "read": "6 min",
        "cat": "House Washing",
    },
    {
        "slug": "gutter-cleaning-checklist-fall",
        "seo_title": "Minnesota Fall Gutter-Cleaning Checklist",
        "title": "The Minnesota Fall Gutter-Cleaning Checklist",
        "excerpt": "Before the first freeze, run through these steps to protect your foundation, fascia, and roof through a Minnesota winter, and what to check first.",
        "date": "2026-03-22",
        "read": "5 min",
        "cat": "Gutter Cleaning",
    },
    {
        "slug": "hard-water-stains-windows",
        "seo_title": "Hard Water Stains on Windows: How to Fix",
        "title": "Hard Water Stains on Windows: Why They Happen and How to Fix Them",
        "excerpt": "Sprinkler overspray and Minnesota's mineral-heavy water leave a cloudy film ordinary cleaning can't remove. Here's what actually works.",
        "date": "2026-06-08",
        "read": "5 min",
        "cat": "Window Cleaning",
    },
    {
        "slug": "winter-prep-checklist-minnesota",
        "seo_title": "Minnesota Fall &amp; Winter Prep Checklist",
        "title": "The Minnesota Homeowner's Fall & Winter Exterior Prep Checklist",
        "excerpt": "From gutters to siding, here's what to check before the first hard freeze so your home comes through winter without surprises.",
        "date": "2026-06-22",
        "read": "6 min",
        "cat": "Seasonal Maintenance",
    },
    {
        "slug": "spring-exterior-cleaning-checklist",
        "seo_title": "Spring Exterior Cleaning Checklist (MN)",
        "title": "The Spring Exterior Cleaning Checklist for Minnesota Homes",
        "excerpt": "Salt, sand, and a long winter leave every exterior surface needing attention. Here's the order we recommend tackling it in.",
        "date": "2026-06-15",
        "read": "5 min",
        "cat": "Seasonal Maintenance",
    },
    {
        "slug": "window-cleaning-mistakes-to-avoid",
        "seo_title": "5 Window Cleaning Mistakes to Avoid",
        "title": "5 Window Cleaning Mistakes That Actually Make Windows Look Worse",
        "excerpt": "Paper towels, dish soap, and cleaning in direct sun are all common habits that work against you. Here's what to do instead.",
        "date": "2026-06-01",
        "read": "4 min",
        "cat": "Window Cleaning",
    },
]

# ---------------------------------------------------------------------------
# FAQs (general)
# ---------------------------------------------------------------------------
FAQS = [
    ("Are you insured?", "Yes, we're fully insured."),
    ("How do I get a free quote?", "The best way is to call us at " + BIZ["phone_display"] + " or fill out the quote form on this site."),
    ("Do I need to be home during the service?", "Not for most exterior work. As long as we have access to the areas being cleaned and any gates are unlocked, you don't need to be home. For interior window cleaning, we'll coordinate a time that works for you."),
    ("What if I'm not satisfied?", "Every Barta service is backed by our 100% Satisfaction Guarantee. If anything isn't right, call us and we'll make it right, re-cleaning at no charge. We don't consider a job done until you're thrilled."),
    ("How is pricing determined?", "Pricing is based on the size of your home, number and accessibility of windows or surfaces, and the services you choose. We give clear, upfront, all-in quotes, no hidden fees and no surprises on the invoice."),
    ("Are your cleaning products safe for kids, pets, and plants?", "Yes. We use professional-grade, biodegradable solutions and pre-wet and rinse landscaping on every soft-wash job. Our methods are safe for your family, pets, and yard."),
    ("How far in advance should I book?", "It varies, depending on the season and our schedule, we can sometimes get to you the same day, or it may be a week or two out. Holiday lighting books up earliest, so reserve your spot by early fall. Priority-plan members get scheduling preference."),
    ("Do you offer recurring maintenance plans?", "We do, and they're our most popular option. Choose a Biannual, Quarterly, or Monthly recurring plan to save on every cleaning, with priority scheduling included on Quarterly and Monthly. Just select a plan when you request your free quote."),
]

# ---------------------------------------------------------------------------
# Real-photo alt text, describes what each photo actually shows, keyed by
# its asset path. Reused everywhere a photo appears (homepage/residential
# cards, process-slider steps) so the same real photo always gets the same
# accurate description instead of a per-use "<Service> in Delano, MN"
# label that repeats the adjacent heading and states a location the photo
# itself doesn't show.
# ---------------------------------------------------------------------------
# Where each photo's subject sits, as a CSS object-position ("x% y%"), per
# slot the photo appears in. Most
# slots crop their photo (a 4:5 job tile, a wide page-top band, a phone-width
# hero), and the browser crops around the centre unless told otherwise, which
# cut off heads, ladders and the glass being cleaned. Every <img> built by
# components.picture() uses the entry for its photo, and so do the share
# cards (build.generate_og_images). Page heroes and CTA banners still set
# their own position ("hero_pos", CTA_PHOTOS["focal_y"]), because a very wide
# band often wants a different anchor than a card does.
IMAGE_FOCAL = {
    # {slot: position}. Slots: "16/9", "5/4", "4/5" (components.photo's
    # ratio), "img-card-bg" / "insta-card-media-el" (the <img> class),
    # "process" (the process slider), "og" (share card), "*" (any slot).
    "assets/img/svc-soft-washing.jpg": {"img-card-bg": "50% 80%", "og": "50% 52%"},
    "assets/img/xmas-lights-stone-home.jpg": {"img-card-bg": "75% 50%"},
    "assets/img/svc-gutter-cleaning.jpg": {"16/9": "50% 38%"},
    "assets/img/svc-pressure-washing.jpg": {"16/9": "50% 15%", "og": "50% 17%"},
    "assets/img/svc-mop-window.jpg": {"16/9": "50% 81%", "process": "50% 71%", "og": "50% 83%"},
    "assets/img/service-van.jpg": {"5/4": "50% 35%"},
    "assets/img/jobs/watertown-area-water-fed-pole-second-story.jpg": {"4/5": "50% 26%"},
    "assets/img/instagram/17950840314027611.jpg": {"insta-card-media-el": "50% 33%"},
    "assets/img/svc-interior-window-cleaning.jpg": {"og": "50% 43%"},
    "assets/img/svc-screen-cleaning-services.jpg": {"og": "50% 19%"},
    "assets/img/svc-hand-scrubbing.jpg": {"og": "50% 47%"},
    "assets/img/instagram/18001854047986368_3.jpg": {"og": "50% 3%"},
    "assets/img/instagram/18001854047986368_0.jpg": {"og": "50% 77%"},
    "assets/img/instagram/17870581794546118_0.jpg": {"og": "50% 14%"},
    "assets/img/instagram/17870581794546118_2.jpg": {"og": "50% 4%"},
    "assets/img/hero-home.jpg": {"og": "50% 60%"},
}

IMAGE_ALT = {
    "assets/img/svc-exterior-window-cleaning.jpg": "Two Barta Window Washing technicians cleaning exterior windows on a home, with screens removed nearby",
    "assets/img/svc-cta-squeegee.jpg": "Close-up of a Barta Window Washing technician squeegeeing an arched window",
    "assets/img/svc-interior-window-cleaning.jpg": "Technician cleaning interior window glass with a squeegee",
    "assets/img/svc-track-detailing.jpg": "Technician vacuuming a window track with a wet/dry vacuum",
    "assets/img/svc-gutter-cleaning.jpg": "Technician clearing a gutter by hand from a ladder",
    "assets/img/svc-pressure-washing.jpg": "Pressure washing a concrete patio with a surface-cleaner attachment",
    "assets/img/svc-soft-washing.jpg": "Soft washing a home's exterior siding with low-pressure equipment",
    "assets/img/svc-solar-panel-cleaning.jpg": "Rooftop solar panels being cleaned with a soft-bristle brush on an extension pole",
    "assets/img/svc-screen-cleaning-services.jpg": "Technician washing a window screen at a screen-cleaning station",
    "assets/img/svc-hand-scrubbing.jpg": "Hand-scrubbing a window pane with an abrasive pad",
    "assets/img/svc-christmas-light-installation.jpg": "Warm white holiday lights installed along a home's roofline at night",
    "assets/img/xmas-lights-stone-home.jpg": "Warm white holiday lights outlining every roofline and peak of a large stone home at dusk",
    "assets/img/xmas-lights-candy-cane.jpg": "Red and white holiday lights installed along a bungalow's roofline at night",
    "assets/img/xmas-lights-craftsman-gables.jpg": "White holiday lights tracing the gables of a craftsman-style home above a snow-covered driveway",
    "assets/img/svc-commercial-cleaning.jpg": "Technicians cleaning storefront windows on a commercial building",
    "assets/img/svc-mop-window.jpg": "Applying cleaning solution to a window with a T-bar mop",
    "assets/img/svc-detail-frame.jpg": "Hand-detailing a window frame with a microfiber cloth",
    "assets/img/hero-home.jpg": "The branded Barta Window Washing (BWW) service van",
    # --- Gallery-only photos below this line. -------------------------------
    # Real job photos that previously sat in the repo unreferenced: four
    # straight-from-camera originals plus the photos from Instagram posts old
    # enough to have rotated out of the 10-post feed manifest (the sync
    # downloads every post's photos but the carousel/gallery only read the
    # manifest, so once a post aged out its photos silently vanished from the
    # site). Listing them here puts each one in the gallery permanently and
    # hands them to generate_webp_versions for right-sized derivatives.
    # Every entry was checked against the rest of the site by perceptual hash
    # AND by eye; photos that turned out to be the same shot as an existing
    # site image (e.g. the uncropped originals of svc-hand-scrubbing,
    # svc-interior-window-cleaning and svc-detail-frame that also live in
    # assets/img/instagram/) are deliberately NOT listed.
    "assets/img/3P8A8136.JPEG": "Technician scrubbing an exterior window, his reflection caught in the freshly wetted glass",
    # 3P8A8143.JPEG (same shoot, technician reaching to the window top) is
    # deliberately NOT listed — the owner asked for it to stay out of the
    # gallery (too similar to the shot above, 2026-09).
    "assets/img/3P8A7912.JPEG": "Technician with microfiber cloths in hand on a covered porch, ready to detail the next window",
    "assets/img/DSC02797.JPG": "Technician raising a water-fed pole to clean windows beneath a mature shade tree",
    "assets/img/instagram/17870581794546118_0.jpg": "Technician cleaning second-story windows from the ground using a water-fed pole",
    "assets/img/instagram/17870581794546118_1.jpg": "Technician looking up while guiding a water-fed pole brush toward a home's upper windows",
    "assets/img/instagram/17870581794546118_2.jpg": "Water-fed pole brush scrubbing an upper pane, rinse water sheeting down the glass",
    "assets/img/instagram/17870581794546118_3.jpg": "Technician reaching the top windows of a stucco home's corner with a water-fed pole",
    "assets/img/instagram/17870581794546118_4.jpg": "Technician cleaning around an opened window sash from inside the home",
    "assets/img/instagram/17870581794546118_5.jpg": "Technician rinsing a high window beneath an overhanging oak branch",
    "assets/img/instagram/17870581794546118_6.jpg": "Close-up of a water-fed pole brush head working across leafy reflected glass",
    "assets/img/instagram/18001854047986368_0.jpg": "Technician setting down buckets beside the Barta Window Washing van on a rural road",
    "assets/img/instagram/18001854047986368_3.jpg": "Technician wiping down a window's edge with a blue microfiber cloth after squeegeeing",
    "assets/img/instagram/18105187085130700_1.jpg": "Row of freshly cleaned black-framed windows reflecting the lake and trees",
    "assets/img/instagram/18143533390535660_0.jpg": "Barta Window Washing van arriving on the paver driveway of a two-story home",
    "assets/img/instagram/18143533390535660_1.jpg": "Technician rinsing a tall vinyl-sided gable wall from the back lawn",
    "assets/img/instagram/18143533390535660_2.jpg": "Technician on a ladder cleaning lakeside sunroom windows",
    "assets/img/instagram/18144547531542050_0.jpg": "Extension ladder staged against a tall home for upper-window cleaning",
    "assets/img/instagram/18144547531542050_1.jpg": "Brass-channel squeegee clearing suds from a textured privacy-glass window",
    "assets/img/instagram/18144547531542050_2.jpg": "View over a backyard pool through a just-cleaned open window",
    "assets/img/instagram/18461203987113057.jpg": "Two Barta Window Washing crew members on a pickup tailgate flanked by American flags",
    "assets/img/DSC03260.jpg": "Two technicians stringing holiday lights across a modern farmhouse roof, seen from above",
    "assets/img/DSC03257.jpg": "Technician fastening holiday light clips along the roofline of a white home",
    "assets/img/DSC03255.jpg": "Close-up of a C9 holiday bulb clipped to the shingle roofline during installation",
}

# ---------------------------------------------------------------------------
# Trust badges
# ---------------------------------------------------------------------------
BADGES = [
    ("shield", "Insured"),
    ("home", "Locally &amp; Family Owned"),
    ("star", BIZ["rating"] + "★ Rated (" + BIZ["review_count"] + "+ reviews)"),
    ("check", "100% Satisfaction Guarantee"),
    ("leaf", "Safe, Eco-Friendly Methods"),
    ("clock", "Since " + BIZ["founded"]),
]

# ---------------------------------------------------------------------------
# City service pages, served at /window-cleaning-<slug>-mn/ (built by
# build/city_pages.py). Unlike AREAS above, whose pages share one template,
# every entry here carries its own hand-written copy so no two pages read
# alike: the generator only supplies the frame (hero, services grid, CTA).
#
# "live": False keeps a drafted town out of the build, the footer, and the
# services-page sentence until its copy is ready. "review" and "jobs" are
# None/empty until the owner supplies real ones; the page then shows a
# clearly marked placeholder (see SHOW_PLACEHOLDERS in city_pages.py).
# Never write a review here that a customer did not actually leave.
#
# "verify" lists the local claims the owner should confirm before the page
# goes live. It is not rendered.
# ---------------------------------------------------------------------------
CITY_PAGES = [
    {
        "slug": "wayzata",
        "city": "Wayzata",
        "county": "Hennepin County",
        "live": True,
        "title": "Window Cleaning in Wayzata, MN",
        "desc": "Window cleaning in Wayzata, MN for lake homes and in-town houses: streak-free glass, screens and hard-water spot removal. Free quotes, guaranteed work.",
        "hero": "assets/img/DSC02797.JPG",
        "hero_pos": "59% 35%",
        "hero_sub": "Streak-free glass for homes on Wayzata Bay, the estates along Ferndale Road, and every neighborhood in between. Fully insured, and backed by our 100% satisfaction guarantee.",
        "why_heading": "Wayzata homes are built around the view",
        "why_intro": [
            "Wayzata wraps around Wayzata Bay at the northeast tip of Lake Minnetonka, and so much of what makes the town special is something you take in through glass: the bay from Lake Street, the 1906 Depot at the end of the Lakewalk, the swimmers at Wayzata Beach in summer. The homes follow suit, from the lake estates along Ferndale Road and Grays Bay to the mix of older homes and new builds in Old Holdridge and the condos downtown at the Promenade.",
            "Our crew comes over from Delano on Highway 12, about 20 minutes away, so Wayzata is a regular stop rather than a special trip. That includes the many addresses that carry a Wayzata ZIP code but technically sit in Orono or Minnetonka.",
        ],
        "why_points": [
            ("Lake homes and walls of glass",
             "The lake homes here are built for the view: floor-to-ceiling picture windows, walls of sliders onto the deck, two-story great rooms facing the water. That glass shows every water spot and pollen streak, and much of it is out of reach by hand. Our water-fed poles clean most of it from the ground, which keeps ladders out of your flower beds, and we bring a ladder for the spots that still need one. With older lake homes steadily being replaced by much larger new builds, there&rsquo;s more of that glass every year."),
            ("Very hard water",
             "Wayzata&rsquo;s city water is very hard (local water-treatment companies put it around 18 to 24 grains per gallon), and the city&rsquo;s own drinking-water report notes that iron and manganese can cause staining. When a sprinkler hits the glass, the water dries into mineral rings. Our water-fed poles rinse with purified water, so we don&rsquo;t leave new spots behind, and our hard-water stain removal can lift the ones already there."),
            ("Old trees, lots of pollen",
             "Wayzata&rsquo;s estate lots are old and wooded, and the sugar maples and basswood in the Big Woods Preserve are a reminder of the forest that stood here first. All that shade means pollen in spring, sap in summer, and glass that dries slowly and shows every streak. Regular cleanings keep up with it."),
        ],
        # Owner's own photos (GPS and camera data stripped), labelled from
        # what each shows.
        "jobs": [
            {"photo": "assets/img/jobs/wayzata-lakefront-sunroom-windows.jpg",
             "label": "Lake-facing sunroom glass",
             "alt": "Barta Window Washing technician on a ladder cleaning the windows of a lake-facing sunroom at a Wayzata home"},
            {"photo": "assets/img/jobs/wayzata-second-story-lake-windows.jpg",
             "label": "Second-story windows over the lake",
             "alt": "Freshly cleaned black-framed upper-story windows on a Wayzata lake home, with the lake behind"},
            {"photo": "assets/img/jobs/wayzata-exterior-window-cleaning.jpg",
             "label": "Whole-house exterior windows",
             "alt": "Barta Window Washing technician and van arriving at a Wayzata home for an exterior window cleaning"},
        ],
        "faqs": [
            ("How often should I get my windows cleaned in Wayzata?",
             "We recommend four cleanings a year to keep lake-facing glass consistently clear, and at minimum twice a year: once in late spring, after the ice is off the bay and the pollen has settled, and again in early fall so the view stays clear through winter. Homes where sprinklers hit the glass get the most out of the quarterly schedule."),
            ("Do you clean screens?",
             "Yes. Screen cleaning is an add-on to any window cleaning: we take each screen down, hand-wash both sides and the frame, and put it back in its own opening, so you&rsquo;re not looking at the lake through a layer of dust."),
            ("Can you remove the hard-water spots on my lake-facing windows?",
             "Usually. Light spotting comes off with a regular cleaning. Heavier mineral buildup needs our hard-water stain removal, a separate treatment we quote after assessing your glass. If years of spotting have etched the glass itself, we&rsquo;ll tell you honestly how much clarity can come back before we start. The best prevention is redirecting the sprinkler head that&rsquo;s hitting it."),
            ("How do quotes work?",
             "They&rsquo;re free and no-obligation. Call (763) 314-3400 or fill out the quote form and tell us which services you want. Pricing is based on the size of your home, the number of windows, and how easy they are to reach, and you get a clear, upfront, all-in price before any work begins: no hidden fees."),
        ],
        # Owner double-check list (not rendered).
        "verify": [
            "Your operations: 'Wayzata is a regular stop' and 'about 20 minutes' from Delano on Highway 12 (a distance site says about 17 miles / 21 minutes).",
            "Water hardness '18 to 24 grains per gallon' is from two water-treatment companies' websites, not the city; the iron/manganese staining note is from the city's 2025 Drinking Water Report.",
            "Housing: lake estates along Ferndale Road and Grays Bay and the teardown trend (Star Tribune); Old Holdridge as the east-side neighborhood of older homes and new builds (a local broker's summary of city zoning); condos at the Promenade.",
            "Wayzata's 55391 ZIP code covering some Orono and Minnetonka addresses.",
            "Big Woods Preserve trees: sugar maple and basswood (Trust for Public Land).",
        ],
    },
    {
        "slug": "orono",
        "city": "Orono",
        "county": "Hennepin County",
        "live": True,
        "title": "Window Cleaning in Orono, MN",
        "desc": "Window cleaning in Orono, MN for Lake Minnetonka homes and wooded acreages: lake-facing glass, screens and well-water spots. Free quotes, guaranteed work.",
        # The owner's own Orono job (the Instagram sunroom shot used here first
        # turned out to be one of their Wayzata jobs).
        "hero": "assets/img/jobs/orono-window-cleaning-home.jpg",
        "hero_pos": "45%",
        "hero_sub": "From the lake homes on Crystal Bay and Browns Bay to the wooded acreages back from the water, we keep Orono&rsquo;s glass clear. Fully insured, with a 100% satisfaction guarantee.",
        "why_heading": "One city, two very different kinds of homes",
        "why_intro": [
            "Orono&rsquo;s own planning documents describe a city with two personalities: the historic lakeshore, and the rural woods and fields behind it. About 40 percent of Lake Minnetonka&rsquo;s shoreline lies inside Orono, wrapping Crystal Bay, Browns Bay, Maxwell Bay, Stubbs Bay and the North and West Arms. Much of it was built up as summer cottages that became year-round homes after World War II. Back from the lake, homes sit on wooded lots of two to five acres, many of them on private roads.",
            "We come in from Delano on Highway 12, 20 to 25 minutes depending on the part of town. And if your mailing address says Wayzata, Long Lake, Mound or Maple Plain but your home is in Orono, you&rsquo;re exactly who this page is for: plenty of Orono homes carry a neighboring town&rsquo;s name in their address.",
        ],
        "why_points": [
            ("Lakeshore glass, old and new",
             "Along the bays, converted summer homes sit next to brand-new estates. The city sees about 20 older lakeshore homes torn down and rebuilt each year, so on the same street we&rsquo;ll clean wood windows with storms and two-story walls of glass facing the lake. Water-fed poles reach most of the tall glass from the ground; for the rest, we bring the ladder."),
            ("Well water leaves its mark",
             "Outside Navarre and the Highway 12 corridor, Orono homes run on private wells instead of city water, and the groundwater around here is very hard. When a sprinkler reaches your windows, those minerals dry right onto the glass. The purified water in our water-fed poles rinses clean without adding spots, and if buildup has baked on over a few seasons, our hard-water stain removal is a separate treatment we&rsquo;ll look at first."),
            ("Wooded lots, heavy canopy",
             "Orono was carved out of the Big Woods, and maple-basswood forest still stands on Big Island and across the wooded interior. That canopy is beautiful and hard on windows: pollen in spring, sap in summer, and shaded glass that stays damp longer and shows every streak."),
        ],
        "jobs": [
            {"photo": "assets/img/jobs/orono-three-story-window-cleaning.jpg",
             "label": "Three stories of glass, pole and ladder",
             "alt": "Barta technician cleaning the back windows of a three-story Orono home with a water-fed pole and a ladder"},
            {"photo": "assets/img/jobs/orono-water-fed-pole-gable-window.jpg",
             "label": "High gable window, from the ground",
             "alt": "Water-fed pole reaching a high gable window on an Orono home"},
        ],
        "faqs": [
            ("How often should I get my windows cleaned in Orono?",
             "For lake-facing glass we recommend four cleanings a year, the schedule that keeps the view clear from ice-out to freeze-up. At the least, plan on two: late spring, once the pollen settles, and early fall. Homes on wooded interior lots usually do well on the twice-a-year schedule."),
            ("My address says Wayzata or Long Lake, but I live in Orono. Do you serve my home?",
             "Yes. Orono homes use several neighboring towns&rsquo; ZIP codes, including Wayzata, Long Lake, Mound, Maple Plain and Crystal Bay, so the town on your mailing address doesn&rsquo;t matter to us. On the lake or back in the woods, if you&rsquo;re in Orono, we cover it."),
            ("Do you clean screens?",
             "We do, as an add-on to your window cleaning. Each screen comes down and is hand-washed on both sides, frame included, then goes back in its own window. If a screen is torn, we leave it as is rather than risk making the damage worse."),
            ("How do quotes work?",
             "Call (763) 314-3400 or send the quote form with the services you&rsquo;d like; quotes are free and there&rsquo;s no obligation. We price by the size of the home, the number of windows, and how easy they are to reach, and you&rsquo;ll see one clear, all-in number before we start."),
        ],
        "verify": [
            "About 40 percent of Lake Minnetonka's shoreline inside Orono (city's 2023 financial report), and the bays named: Crystal, Browns, Maxwell, Stubbs, North and West Arms.",
            "'Two personalities' (lakeshore vs rural woods and fields) paraphrases Orono's Community Management Plan; cottages becoming year-round homes after WWII is from the same plan.",
            "Rural lots of two to five acres and private roads (city zoning and plan).",
            "About 20 lakeshore teardowns a year (city).",
            "Private wells outside Navarre and the Highway 12 corridor (city sewer page); 'very hard' groundwater is a water-treatment company's claim, not a city figure.",
            "Big Island maple-basswood forest (City of Orono, Big Island Nature Park).",
            "ZIP codes Orono homes use: Wayzata, Long Lake, Mound, Maple Plain, Crystal Bay.",
            "Your operations: 20 to 25 minutes from Delano on Highway 12.",
        ],
    },
    {
        "slug": "waconia",
        "city": "Waconia",
        "county": "Carver County",
        "live": True,
        "title": "Window Cleaning in Waconia, MN",
        "desc": "Window cleaning in Waconia, MN for lake homes and newer neighborhoods: spot-free glass, screens and hard-water stain removal. Free quotes, guaranteed work.",
        "hero": "assets/img/svc-cta-squeegee.jpg",
        "hero_pos": "30% 40%",
        "hero_sub": "Clear glass for homes on Lake Waconia, around downtown, and in the newer neighborhoods on the edges of town. Fully insured, with a 100% satisfaction guarantee.",
        "why_heading": "A lake town that keeps growing",
        "why_intro": [
            "Waconia sits on the south shore of 3,080-acre Lake Waconia, with Coney Island of the West out on the water and Lake Waconia Regional Park along the shore just east of downtown. Main Street and City Square Park are the heart of town, and every September, Nickle Dickle Day fills downtown with a car show, duck races and an arts-and-crafts fair.",
            "It&rsquo;s a town that has grown fast. The population roughly doubled between 2000 and 2020, and the city&rsquo;s 2021 land-use report counted about 42 percent of Waconia&rsquo;s single-family homes as less than 20 years old. So the homes here run from older houses near Main Street to brand-new builds on the edges of town, about 25 minutes south of our home base in Delano.",
        ],
        "why_points": [
            ("Hard water and evening sprinklers",
             "Waconia&rsquo;s city water comes from deep wells and is very hard; local water-treatment companies measure it around 27 grains per gallon. The city&rsquo;s watering rules keep sprinklers off between 9 a.m. and 7 p.m., so irrigation runs in the early morning and evening, and whatever reaches the glass sits there and dries into mineral spots. Pointing sprinkler heads away from the windows is the best prevention. For spots that are already there, our hard-water stain removal is a separate treatment we quote after seeing the glass."),
            ("Newer homes, bigger glass",
             "Newer houses tend to have more glass: tall entryway windows, big back-of-house panes facing the yard or the lake, windows high above a walkout. Our water-fed poles rinse that glass with purified water, so it dries spot-free, and they let us clean most of it from the ground."),
            ("A Tree City with mature canopy",
             "Waconia has been a Tree City USA community for about 20 years, and its boulevards and parks are full of mature trees. That means pollen on your windows and screens every spring, which is why a late-spring cleaning, once the pollen settles, is the one most Waconia homes shouldn&rsquo;t skip."),
        ],
        # Owner's own photos: GPS and camera data stripped, house numbers blurred.
        "jobs": [
            {"photo": "assets/img/jobs/waconia-patio-doors-transom-windows.jpg",
             "label": "Patio doors and transom windows",
             "alt": "Barta technician cleaning patio doors and transom windows from inside a covered patio at a Waconia home"},
            {"photo": "assets/img/jobs/waconia-spring-window-cleaning.jpg",
             "label": "Spring window cleaning",
             "alt": "Barta Window Washing van parked outside a Waconia home for a spring window cleaning"},
            {"photo": "assets/img/jobs/waconia-two-person-crew-modern-home.jpg",
             "label": "Two-person crew on a modern home",
             "alt": "Two Barta technicians cleaning the front windows of a modern Waconia home"},
        ],
        "faqs": [
            ("How often should I get my windows cleaned in Waconia?",
             "Four times a year is what we recommend if you want your glass consistently clean. At a minimum, go twice: in late spring, once the pollen has settled, and again in early fall. If your sprinklers reach the windows, the quarterly schedule keeps mineral spots from building up."),
            ("Why do spots show up on my windows after the sprinklers run?",
             "Waconia&rsquo;s water is very hard, and because sprinklers here run in the early morning and evening, the spray sits on the glass and dries into mineral rings. Adjusting the heads so they don&rsquo;t reach the windows stops most of it. Spots that have baked on over several seasons need our hard-water stain removal, and if the glass has started to etch, we&rsquo;ll tell you honestly how much we can bring back before we start."),
            ("Do you clean screens?",
             "Yes, as an add-on to a window cleaning. We pull each screen, wash it by hand on both sides along with the frame, and reinstall it in the same window. Once a year, timed with your window cleaning, is enough for most homes."),
            ("How do quotes work?",
             "Quotes are free. Give us a call at (763) 314-3400 or fill out the online form and check off what you&rsquo;d like done. The price depends on your home&rsquo;s size, how many windows it has, and how easy they are to reach, and it&rsquo;s an upfront, all-in number with no hidden fees."),
        ],
        "verify": [
            "Lake Waconia: 3,080 acres, the town on its south shore; Coney Island of the West; Lake Waconia Regional Park just east of downtown (Carver County).",
            "Nickle Dickle Day each September at City Square Park, with a car show, duck races and an arts-and-crafts fair (Waconia chamber).",
            "Population roughly doubling 2000 to 2020 (6,814 to 13,033, census); about 42 percent of single-family homes under 20 years old (city's 2021 land-use report).",
            "Water hardness around 27 grains per gallon is a softener company's figure, not the city's.",
            "City watering rule: no sprinkling 9 a.m. to 7 p.m. (city).",
            "Tree City USA for about 20 years (Minnesota DNR's 2025 list).",
            "Your operations: about 25 minutes from Delano (a distance site says about 17 miles / 24 minutes).",
        ],
    },
    {
        "slug": "buffalo",
        "city": "Buffalo",
        "county": "Wright County",
        "live": True,
        "replaces_area": True,  # owner approved: this page takes over areas/buffalo.html
        "title": "Window Cleaning in Buffalo, MN",
        "desc": "Window cleaning in Buffalo, MN from a crew 15 minutes away in Delano: streak-free glass, screens and hard-water spot removal. Free quotes, guaranteed work.",
        "hero": "assets/img/instagram/18001854047986368_3.jpg",
        "hero_pos": "50% 2%",
        "hero_sub": "Streak-free windows for Buffalo homes, from the older houses near downtown and the lakes to the newer neighborhoods on the edges of town. Fully insured, with a 100% satisfaction guarantee.",
        "why_heading": "Close to home, between two lakes",
        "why_intro": [
            "Buffalo is practically our backyard: the Wright County seat is about 15 minutes up Highway 25 from our home base in Delano. The city sits between two lakes, Buffalo Lake on the south and west side of town and Lake Pulaski to the north, with Sturges Park and its bandshell right across Highway 25 from downtown, where Buffalo Days takes over every June.",
            "Buffalo&rsquo;s homes cover a wide range. Older houses sit close to the downtown, which was platted back in 1856. Lakefront homes line Lake Pulaski and Buffalo Lake. And much of the town is newer, with subdivisions that have grown up around the edges over the past few decades.",
        ],
        "why_points": [
            ("Older homes and newer homes",
             "Older homes tend to mean storm windows and more detail work around frames and sills; newer homes tend to mean bigger panes and taller glass. We&rsquo;re set up for both, and we&rsquo;ll tell you what your windows need before we start."),
            ("21 grains of hard water",
             "Buffalo&rsquo;s city water measures 21 grains per gallon, which the city itself calls very hard, and its water page warns that hard water leaves spots and film on dishes. Your windows get the same treatment from the sprinklers: the city keeps lawn watering off between 7 a.m. and 5 p.m., so irrigation runs early and late, and the spray dries on the glass. Our water-fed poles rinse with purified water, and our hard-water stain removal takes care of spots that have built up."),
            ("Lake homes on Pulaski and Buffalo Lake",
             "The estates along Lake Pulaski and Buffalo Lake are built to look out over the water, and lake-facing glass is where clean windows pay off most. We&rsquo;ll get the lake side and the tall glass above a walkout, not just the windows you can reach from the lawn."),
        ],
        # Owner's own photos, GPS and camera data stripped. The first is a
        # still pulled from a short video of the same lake-home job.
        "jobs": [
            {"photo": "assets/img/jobs/buffalo-lake-home-detailing-windows.jpg",
             "label": "Detailing lake-facing windows",
             "alt": "Barta technician hand-detailing a lake-facing window at a Buffalo lake home"},
            {"photo": "assets/img/jobs/buffalo-lake-home-water-fed-pole.jpg",
             "label": "Upper-level glass, water-fed pole",
             "alt": "Water-fed pole cleaning the upper-level windows of a Buffalo lake home"},
            {"photo": "assets/img/jobs/buffalo-exterior-window-cleaning.jpg",
             "label": "Front windows, ladder and van",
             "alt": "Barta technician on a ladder cleaning the front windows of a Buffalo home, with the Barta van out front"},
        ],
        "faqs": [
            ("How often should I get my windows cleaned in Buffalo?",
             "Our recommendation is four cleanings a year, which keeps glass consistently clear. The minimum we&rsquo;d suggest is twice a year: a late-spring cleaning after the pollen has settled and an early-fall cleaning before the cold sets in. Lake homes and houses where sprinklers hit the glass benefit most from the quarterly plan."),
            ("How far are you from Buffalo?",
             "Not far at all. We&rsquo;re based in Delano, about 12 miles and 15 minutes down Highway 25, which makes Buffalo one of the closest towns we serve. We cover the whole city, from the neighborhoods around Lake Pulaski to the newer subdivisions on the edges of town."),
            ("Do you clean screens?",
             "Yes. It&rsquo;s an add-on to your window cleaning: every screen is taken out, washed by hand on both sides and around the frame, and put back where it came from. Most homes only need it once a year, timed with a window cleaning."),
            ("How do quotes work?",
             "It&rsquo;s free and there&rsquo;s no pressure. Call (763) 314-3400 or use our quote form and tell us which services you&rsquo;re interested in. We base the price on the size of your home, the number of windows and how accessible they are, and you&rsquo;ll get a clear, all-in quote before any work begins."),
        ],
        "verify": [
            "Your operations: 'about 15 minutes' and 'about 12 miles' from Delano on Highway 25 (distance site: 12 miles / 15 minutes).",
            "Buffalo Lake on the south and west side of town, Lake Pulaski to the north (DNR / city).",
            "Sturges Park and bandshell across Highway 25 from downtown; Buffalo Days every June, centered on Sturges Park (city and chamber).",
            "Downtown platted in 1856; lakefront estates on Lake Pulaski and Buffalo Lake at the top of the market (real-estate source).",
            "21 grains per gallon and 'very hard' are the city's own figures; the spots-and-film note is from the city's water page (it mentions dishes).",
            "City watering rule: no lawn watering with city water 7 a.m. to 5 p.m. (the city's 2026 water conservation flyer).",
        ],
    },
    {
        "slug": "plymouth",
        "city": "Plymouth",
        "county": "Hennepin County",
        "live": True,
        "replaces_area": True,  # owner approved: this page takes over areas/plymouth.html
        "title": "Window Cleaning in Plymouth, MN",
        "desc": "Window cleaning in Plymouth, MN for lake homes, 1980s classics and new builds: streak-free glass, screens, hard-water spots. Free quotes, guaranteed work.",
        "hero_sub": "Streak-free glass for Plymouth homes, from the neighborhoods around Medicine Lake and Parkers Lake to the newer streets out by the Northwest Greenway. Fully insured, with a 100% satisfaction guarantee.",
        "why_heading": "A big city with every age of home",
        "why_intro": [
            "Plymouth is Minnesota&rsquo;s seventh-largest city, with 81,026 people at the 2020 census, and it&rsquo;s big enough to feel like several towns. There&rsquo;s Medicine Lake, the second-largest lake in Hennepin County, with French Regional Park on its north shore; Parkers Lake and its city beach; eight lakes and more than 800 wetlands in all. Summer means Music in Plymouth at the Hilde Performance Center, and the Northwest Greenway runs about two miles of wooded trail out toward the city&rsquo;s newest neighborhoods.",
            "Plymouth sits between our home base in Delano and Minneapolis, about 30 minutes east of us, so it&rsquo;s an easy stop on our route. We cover the whole city, from the east side near Medicine Lake to the northwest corner.",
        ],
        "why_points": [
            ("From 1980s classics to brand-new builds",
             "Much of Plymouth was built between the 1970s and the 1990s, while the northwest corner, some of the city&rsquo;s last rural land, filled in with newer homes, most of them built after 2000. So we see everything from sliding windows whose tracks and screens need detailing to two-story walls of glass. Our water-fed poles reach tall glass from the ground, and track detailing and screen cleaning take care of the rest."),
            ("Hard water, iron and summer sprinklers",
             "Plymouth&rsquo;s city water is very hard (a local water-treatment company puts it at 22 to 24 grains per gallon), and the city itself notes that the iron and manganese it treats for can cause staining. From May through September its watering rules keep lawn sprinklers off from noon to 5 p.m., so they run mornings and evenings, and lower windows facing the lawn catch the spray. Our water-fed poles rinse with purified water, so nothing dries into spots behind us; for spots that have already built up, we&rsquo;ll look at the glass and quote our hard-water stain removal."),
            ("A Tree City with lakes and wetlands",
             "Plymouth has been a Tree City USA for more than 40 years, and with its lakes and wetlands, most homes have plenty of trees and greenery around them. That means pollen in spring and sap in summer on your windows and screens, so a late-spring cleaning is the one to keep on the calendar."),
        ],
        "hero": "assets/img/jobs/plymouth-crew-and-van-from-the-roof.jpg",
        "hero_pos": "45%",
        # Owner's own photos: GPS and camera data stripped; a house number and
        # the licence plates of parked cars blurred.
        "jobs": [
            {"photo": "assets/img/jobs/plymouth-skylight-cleaning.jpg",
             "label": "Skylight, cleaned from the roof",
             "alt": "A skylight cleaned from the roof of a Plymouth home, with the sky reflected in the glass"},
            {"photo": "assets/img/jobs/plymouth-screen-washing.jpg",
             "label": "Hand-washing screens on the lawn",
             "alt": "Two Barta technicians hand-washing window screens on the front lawn of a Plymouth home"},
        ],
        "faqs": [
            ("How often should I get my windows cleaned in Plymouth?",
             "Four cleanings a year keeps glass at its best, and it&rsquo;s what we recommend. If that&rsquo;s more than you need, twice a year is the minimum we&rsquo;d suggest: once in late spring, after the pollen, and once in early fall. Homes whose lower windows catch sprinkler spray over the summer benefit most from quarterly visits."),
            ("Can you clean the windows on a two-story new build?",
             "Yes. Tall entryways, great-room windows and upper-story glass are routine for us. Our water-fed poles reach most of it from the ground, and we bring a ladder for the few spots that still need one."),
            ("Do you clean screens?",
             "Yes, as an add-on to your window cleaning. We take the screens out, wash each one by hand, both sides and the frame, and put it back where it belongs. Pair it with track detailing and your windows will glide smoothly again."),
            ("How do quotes work?",
             "Getting a quote is free and there&rsquo;s no commitment. Call (763) 314-3400 or send us the quote form with the services you want. We price by the size of your home, how many windows it has, and how easy they are to reach, and you get the full price up front, with no hidden fees."),
        ],
        "verify": [
            "81,026 people (2020 census) and Minnesota's seventh-largest city (City of Plymouth).",
            "Medicine Lake as Hennepin County's second-largest lake (Bassett Creek WMO); French Regional Park on its north shore (Three Rivers); eight lakes and 800-plus wetlands (city).",
            "Music in Plymouth at the Hilde Performance Center; Northwest Greenway about two miles long (city).",
            "Housing ages: 1970s-1990s for much of the city and mostly post-2000 in the northwest come from NeighborhoodScout and a 2013 Star Tribune story, not the city.",
            "22 to 24 grains per gallon is a water-treatment company's figure; the iron/manganese staining note is the city's.",
            "Watering rule: May-September, no lawn sprinkling noon to 5 p.m. (city).",
            "Tree City USA for more than 40 years (a 2026 Arbor Day proclamation cited the 42nd year).",
            "Your operations: about 30 minutes from Delano (a distance site says about 20 miles / 30 minutes).",
        ],
    },
    {
        "slug": "independence",
        "city": "Independence",
        "county": "Hennepin County",
        "live": True,
        "title": "Window Cleaning in Independence, MN",
        "desc": "Window cleaning in Independence, MN from right next door in Delano: lake homes, acreages and horse properties, glass and screens. Free quotes, guaranteed.",
        "hero_sub": "Streak-free glass for homes on Lake Independence and Lake Sarah, and for the acreages and horse properties in between. We&rsquo;re right next door in Delano. Fully insured, with a 100% satisfaction guarantee.",
        "why_heading": "Right next door, with a lot of country",
        "why_intro": [
            "Independence starts where Delano ends, at County Line Road, and Highway 12 runs straight between the two, so we&rsquo;re just across the line from our home base. It&rsquo;s also one of the most rural towns we serve: about 34.6 square miles of farmland, woods and lakes, home to 3,755 people at the 2020 census. Lake Independence and Baker Park Reserve sit on the city&rsquo;s east side, Lake Sarah to the north, Lake Rebecca Park Reserve protects a stretch of Big Woods landscape, and the Luce Line Trail cuts right through town.",
            "Homes here are spread out. Large parts of the city are guided for long-term agriculture, rural lots start at two and a half buildable acres, and there are horse properties and hobby farms alongside lake homes on Lake Independence and Lake Sarah. The city steers new neighborhoods toward Maple Plain, where the utilities are.",
        ],
        "why_points": [
            ("Well water and sprinkler spots",
             "Independence homes run on private wells rather than city water, and the Minnesota Department of Health notes that iron in well water causes yellow, red and brown stains. When a sprinkler reaches the glass, that iron, or hardness, dries into orange-brown or white spots. Our water-fed poles rinse with purified water, so the final rinse leaves nothing behind, and our hard-water stain removal can take on mineral spots that have built up."),
            ("Big homes on big lots",
             "Custom homes on acreages tend to have big glass: walkouts, two-story great rooms, gable windows up near the peak. Water-fed poles reach most of it from the ground, and we bring ladders for the rest."),
            ("Lake homes and open country",
             "On Lake Independence and Lake Sarah, the lake-facing side is the one that matters most, and usually the hardest to reach. Out in open country, wind carries dust off fields and country roads onto windows and screens, which is why a spring cleaning goes a long way here."),
        ],
        "hero": "assets/img/instagram/18001854047986368_0.jpg",
        "hero_pos": "42% 55%",
        "jobs": [
            {"photo": "assets/img/jobs/independence-tall-glass-ladder.jpg",
             "label": "A wall of tall glass, ladder and pole",
             "alt": "Extension ladder against a wall of tall windows on the back of an Independence home"},
            {"photo": "assets/img/jobs/independence-arched-window-home.jpg",
             "label": "Arched windows, three levels up",
             "alt": "The back of a three-level Independence home with arched windows, mid-cleaning with a ladder"},
            {"photo": "assets/img/jobs/independence-water-fed-pole-gable.jpg",
             "label": "Gable windows from the ground",
             "alt": "Water-fed pole cleaning the gable windows of an Independence home"},
        ],
        "faqs": [
            ("How often should I get my windows cleaned in Independence?",
             "We recommend four cleanings a year for glass that stays consistently clean, and twice a year at the least: once in late spring and again in early fall. Lake homes on Lake Independence and Lake Sarah, where the view is the point, get the most from the quarterly schedule."),
            ("My home is on a well. Does that matter for window cleaning?",
             "It can. Iron or hardness in well water shows up as orange-brown or white spots wherever sprinklers hit the glass. Our water-fed poles rinse with purified water, so the final rinse doesn&rsquo;t add any, and if spots have built up, we&rsquo;ll look at the glass and quote our hard-water stain removal. The best prevention is keeping sprinkler heads pointed away from the windows."),
            ("Do you clean screens?",
             "We do. Screen cleaning is an add-on: each screen is removed, hand-washed on both sides along with its frame, and reinstalled in its own window. Once a year is enough for most homes, and more often if you&rsquo;re next to open fields, which a lot of Independence homes are."),
            ("How do quotes work?",
             "Free, with no obligation. Call (763) 314-3400 or fill out our quote form and tell us what you&rsquo;d like cleaned. The price is based on your home&rsquo;s size, the number of windows and how easy they are to get to, and you&rsquo;ll have a clear, all-in quote before we start."),
        ],
        "verify": [
            "Borders Delano at County Line Road; Highway 12 between the two (City of Delano, MnDOT).",
            "About 34.6 square miles and 3,755 people at the 2020 census (Census / Wikipedia).",
            "Lake Independence and Baker Park Reserve on the east side; Lake Sarah to the north; Lake Rebecca Park Reserve's Big Woods landscape; the Luce Line Trail (city, Three Rivers, DNR).",
            "Rural residential lots need at least 2.5 buildable acres (city code); agricultural guiding and new growth near Maple Plain (2040 Comprehensive Plan).",
            "Private wells (city utilities page); the iron-staining note is from the Minnesota Department of Health.",
            "Horse properties and hobby farms: the Zuhrah Shrine Horsemen's ranch is a documented example; 'hobby farms' is a general description.",
            "'One of the most rural towns we serve' and the country-road dust line are general descriptions, not sourced facts.",
        ],
    },
    {
        "slug": "delano",
        "city": "Delano",
        "county": "Wright County",
        "live": True,
        "replaces_area": True,  # owner approved: this page takes over areas/delano.html
        "title": "Window Cleaning in Delano, MN",
        "desc": "Window cleaning in Delano, MN from the family-owned crew based in town: spot-free glass, screens, gutters and hard-water stain removal. Free quotes.",
        "hero_sub": "Delano is home for us, so a window cleaning here means working for our neighbors. Fully insured, and every visit comes with our 100% satisfaction guarantee.",
        "why_heading": "The river town we call home",
        "why_intro": [
            "Delano sits along Highway 12 in the southeastern corner of Wright County, about 27 miles west of downtown Minneapolis, with the South Fork of the Crow River running right through downtown. The town was incorporated in 1876, and three of its early buildings are on the National Register of Historic Places: the 1888 Village Hall on Bridge Avenue, the Eagle Newspaper Office and the 1893 Simon Weldele House.",
            "It&rsquo;s also where we&rsquo;re based: Barta Window Washing is locally and family owned, at 320 3rd St S. Delano counted 6,484 residents at the 2020 census and keeps adding homes in newer neighborhoods like Highland Ridge, alongside the older houses near downtown. Every Fourth of July, the town hosts a celebration that dates back to 1857 and is billed as the oldest and largest in Minnesota.",
        ],
        "why_points": [
            ("From 46 grains down to 26",
             "Delano Municipal Utilities&rsquo; treatment plant removes the iron and manganese that stain, but it only brings hardness down from about 46 grains per gallon to about 26, which is still very hard. When sprinkler spray dries on a patio door or a lower window, those minerals stay behind as white spots. Up high, our water-fed poles rinse with purified water, so they add no spots of their own, and for spots that have built up over several summers, we assess the glass and quote hard-water stain removal separately."),
            ("Ready for the Fourth",
             "If you&rsquo;re hosting family or friends for the Fourth of July, book your window cleaning for June so the glass is done before guests arrive. A house wash or a pressure-washed driveway can be booked along with it."),
            ("A town full of trees",
             "A survey for the city&rsquo;s emerald ash borer plan counted about 3,400 ash trees in Delano, and that&rsquo;s just one kind of tree. Leaves and seeds end up in gutters every fall, and spring pollen settles on windows and screens. Our gutter cleaning clears what collects, and screens can be added to any window cleaning: each one comes out, is washed by hand on both sides with its frame, and goes back where it came from."),
        ],
        "hero": "assets/img/3P8A8136.JPEG",
        "hero_pos": "58% 35%",
        "jobs": [
            {"photo": "assets/img/jobs/delano-walkout-windows-by-the-pool.jpg",
             "label": "Back windows above the pool",
             "alt": "Crew member on a stepladder cleaning the main-floor back windows of a Delano home beside a backyard pool"},
            {"photo": "assets/img/jobs/delano-storefront-glass.jpg",
             "label": "Storefront glass downtown",
             "alt": "Barta crew member squeegeeing the inside of a large storefront window in downtown Delano"},
        ],
        "faqs": [
            ("How often should a Delano home book window cleaning?",
             "Four visits a year keeps the glass clean from one season to the next. Two is the least we&rsquo;d suggest: late spring, then early fall, once sprinkler season is over."),
            ("Delano treats its city water. Why do my windows still get spots?",
             "The plant takes out the iron and manganese but not the hardness, and those minerals are what sprinkler spray leaves on glass as white, chalky spots. Pointing the heads at the lawn instead of the house prevents most of it, and heavier buildup calls for hard-water stain removal, which we price once we&rsquo;ve seen the glass."),
            ("Do you clean windows for businesses in downtown Delano?",
             "Yes. Commercial window cleaning is one of our services, from storefront and display windows to upper-floor glass, and a quote for a business is free, just like one for a home. We can pressure wash the entry walk, too."),
            ("How do I get a price for my home?",
             "Use the quote form or call (763) 314-3400; either way it&rsquo;s free, with no obligation. The price comes down to the size of the home, the number of windows and the access to each one, and you&rsquo;ll know the complete, all-in number before any work starts."),
        ],
        "verify": [
            "Southeastern Wright County, along Highway 12, about 27 miles west of downtown Minneapolis (Delano Area Chamber of Commerce; Wright County Economic Development Partnership).",
            "South Fork of the Crow River runs through downtown (Lessard-Sams Outdoor Heritage Council funding request).",
            "Incorporated 1876; the 1888 Village Hall, the Eagle Newspaper Office and the 1893 Simon Weldele House are on the National Register (Wikipedia).",
            "6,484 residents at the 2020 census (Census / Wikipedia).",
            "Highland Ridge still adding homes (Lennar lists it as active new construction; the council approved a fifth addition of 26 lots).",
            "Fourth of July celebration dating to 1857, billed as the oldest and largest in Minnesota (Wikipedia; 'billed as' because it is the celebration's own claim).",
            "Treatment plant removes iron and manganese; hardness lowered from about 46 to about 26 grains per gallon (Delano Municipal Utilities facilities page, read from a search excerpt: check both numbers on the live page).",
            "About 3,400 ash trees counted for the emerald ash borer plan (City of Delano EAB Management Plan; an older survey).",
            "Job photos: the pool home was taken on Delano's north side and the storefront downtown, near the city's motor vehicle office (photo GPS). Confirm both were Delano jobs.",
            "Booking in June before Fourth of July guests, and the leaves/pollen lines, are general descriptions, not sourced facts.",
        ],
    },
    {
        "slug": "medina",
        "city": "Medina",
        "county": "Hennepin County",
        "live": True,
        "replaces_area": True,  # owner approved: this page takes over areas/medina.html
        "title": "Window Cleaning in Medina, MN",
        "desc": "Window cleaning in Medina, MN, Hamel included: tall glass on newer homes and big rural lots, sprinkler spots, screens and tracks. Free quotes.",
        "hero_sub": "Window cleaning for Medina homes, from Hamel to Independence Beach and the big rural lots in between, about 20 minutes from Delano. Fully insured, and backed by our 100% satisfaction guarantee.",
        "why_heading": "Newer homes, roomy lots and an old railroad town",
        "why_intro": [
            "Medina is a western Hennepin County city of 6,837 people (2020 census), just west of Plymouth, with Corcoran to the north, Orono to the south, and Independence and Maple Plain to the west. The small city of Loretto sits inside its borders, while Hamel is part of Medina itself: platted as early as 1879 and later named for the family that gave land for its railroad depot, it never incorporated and still has its own post office.",
            "Most of Medina&rsquo;s homes are fairly new. Census survey figures put the median year built at 1999, and neighborhoods like Fields of Medina, Bridgewater at Lake Medina and Foxberry Farms sit among farm fields, wetlands and more than half a dozen lakes. On the east side of Lake Independence, the Independence Beach neighborhood looks out over some 850 acres of water.",
        ],
        "why_points": [
            ("City wells and private ones",
             "Medina&rsquo;s city water comes from wells as deep as 770 feet and is treated to remove iron and manganese, but much of the rural city has no city water, and homes there run on private wells. Either way, sprinkler water usually skips the home&rsquo;s softener, and wherever it dries on glass it leaves mineral spots. The purified water in our water-fed poles dries clean on upper glass, and if spots have set in, we&rsquo;ll see the glass before quoting hard-water stain removal."),
            ("Big houses, lots of high glass",
             "Rural residential lots in Medina start at five acres, and the homes on them are often built big: two stories of windows across the back, transoms and picture windows well over arm&rsquo;s reach. Water-fed poles clean most of that from the ground, and ladders take care of the rest. On windows that have been opening and closing for 20-plus years, track detailing scrubs out the grit where the sashes run."),
            ("Lakes, ponds and wetlands",
             "Between Lake Independence, Lake Medina and the ponds and wetlands around the newer neighborhoods, a lot of Medina homes sit near water, and water brings bugs and spider webs to the screens and the side of the house facing it. Screen cleaning can go on any visit: we lift each one out, hand-wash it front and back with its frame, and set it back in its own window."),
        ],
        "hero": "assets/img/instagram/17870581794546118_5.jpg",
        "hero_pos": "45%",
        "jobs": [],
        "faqs": [
            ("How many times a year should I have my Medina windows cleaned?",
             "We suggest four visits a year if you want glass that stays clean from season to season, and two at the minimum, one in late spring and one in early fall. Homes that face a lake, or where sprinklers reach the glass, get the most out of four."),
            ("My mailing address says Hamel. Is that Medina, and do you come out there?",
             "Yes to both. Hamel is a community within Medina rather than a city of its own, with its own post office and the 55340 ZIP code. Hamel and the rest of Medina are in our service area, and so is Loretto, the separate small city inside Medina&rsquo;s borders."),
            ("Our sprinklers pump from a pond. Can that spot the windows?",
             "It can. Where a stormwater pond is available, Medina&rsquo;s code steers new lawn irrigation to the pond instead of city water, and pond or well water hasn&rsquo;t been through a treatment plant, so whatever it carries stays on the glass when it dries. Aiming the heads so the spray falls short of the house takes care of most of it, and for buildup from past summers, we quote hard-water stain removal after seeing the glass."),
            ("What goes into a quote, and how do I get one?",
             "Call us at (763) 314-3400 or use the quote form, and mention anything you&rsquo;d like added, like screens, gutters or a house wash. The quote is free and there&rsquo;s no obligation to book. The price is set by the size of the home, how many windows it has and how hard they are to reach, and you&rsquo;ll have the complete, all-in number before the work begins."),
        ],
        "verify": [
            "6,837 people at the 2020 census (Census / Wikipedia).",
            "Neighbors: west of Plymouth, Corcoran north, Orono south, Independence and Maple Plain west; Loretto is a separate city inside Medina (City of Medina 2018 Comprehensive Plan).",
            "Hamel: platted as early as 1879, never incorporated, own post office and 55340 ZIP (Wikipedia); named for the Hamel family, who gave land for the depot in 1884 (Comprehensive Plan, Chapter 3).",
            "Median year built 1999 (a real-estate site republishing Census ACS figures). Double-check against Census data.",
            "Fields of Medina, Bridgewater at Lake Medina and Foxberry Farms (City of Medina, Park at Fields of Medina page); lakes named on the city zoning map; Independence Beach on the east side of Lake Independence (City of Medina, Lakeshore Park page); Lake Independence about 850 acres (lake association: 844 to 851).",
            "City wells up to 770 feet deep; treatment removes iron and manganese (City of Medina water quality report and water plant news). Rural homes on private wells is inferred from the city code's well and septic rules. Double-check.",
            "Rural Residential lots at least five acres (City of Medina code, section 826). Confirm the 2026 code update didn't change it.",
            "Irrigation: no property may expand irrigation on city water where a stormwater pond is available (City of Medina code, section 710).",
            "About 20 minutes from Delano (a distance site says about 13 miles / 21 minutes).",
            "Sprinklers bypassing softeners, big homes carrying lots of high glass, and bugs near water are general descriptions, not sourced facts.",
        ],
    },
    {
        "slug": "mound",
        "city": "Mound",
        "county": "Hennepin County",
        "live": True,
        "replaces_area": True,  # owner approved: this page takes over areas/mound.html
        "title": "Window Cleaning in Mound, MN",
        "desc": "Window cleaning in Mound, MN on the west end of Lake Minnetonka: lake-side windows, screens and spots from hard city water. Free quotes, fully insured.",
        "hero_sub": "Clear glass for Mound homes, from the shoreline around Lost Lake and downtown out to Three Points and Shadywood Point. Fully insured, with our 100% satisfaction guarantee on every visit.",
        "why_heading": "Where Lake Minnetonka reaches downtown",
        "why_intro": [
            "Mound sits on the western shores of Lake Minnetonka, about 20 miles west of Minneapolis, and water covers more than 40 percent of the city. Lost Lake, a part of Lake Minnetonka that lies entirely inside Mound, runs right up to downtown and connects to Cooks Bay by a channel, so boaters can tie up and walk into town. The city counts more than 17 miles of shoreline in all.",
            "Mound had 9,398 residents at the 2020 census, and it&rsquo;s where Tonka toys began: Mound Metalcraft started in an old schoolhouse here in 1946 and later became Tonka Toys. The city grew by taking in older lake communities, among them Three Points, Island Park and Shadywood Point, between 1959 and 1963.",
        ],
        "why_points": [
            ("Hard water and odd/even sprinklers",
             "The city&rsquo;s water utility lists Mound water at 21 to 24 grains of hardness per gallon, so sprinkler spray that reaches the house dries into white mineral spots, and with odd/even watering from mid-May through August, a misaimed head can hit the same windows every other day. On upper glass, our water-fed poles use purified water and don&rsquo;t leave spots behind, and we quote hard-water stain removal for spots that have set in."),
            ("The lake side of the house",
             "With that much shoreline, plenty of Mound homes have a lake side, and that&rsquo;s usually where the glass is: wide picture windows, patio doors onto the deck and upper-story windows facing the bay. We clean most of the upper glass from the yard with water-fed poles, and the ladder only comes out where a pole can&rsquo;t reach."),
            ("Older homes, older windows",
             "According to the city&rsquo;s 2040 Comprehensive Plan, more than half of Mound&rsquo;s homes were built by the end of the 1960s. Houses that age often have original wood sashes, storm windows or divided panes, and sliders whose tracks have been collecting grit for decades. We clean the glass inside and out, and our track detailing clears out the channels. Add screen washing and we lift each screen out, hand-wash both sides of the mesh and frame, and refit it in the same opening."),
        ],
        "hero": "assets/img/instagram/17870581794546118_2.jpg",
        "hero_pos": "50% 3%",
        "jobs": [
            {"photo": "assets/img/jobs/mound-stucco-home-two-person-crew.jpg",
             "label": "Two on the job, ladder and stepladder",
             "alt": "Two Barta crew members cleaning the front windows of a stucco home in Mound, one on an extension ladder and one on a stepladder"},
        ],
        "faqs": [
            ("What&rsquo;s the right number of window cleanings a year for a Mound home?",
             "Four times a year keeps the glass looking good through every season, and two, in late spring and early fall, is the least we&rsquo;d recommend. Lake-facing windows and glass in reach of the sprinklers are where the extra visits show most."),
            ("We have a water softener. Why do our windows still get spots?",
             "Because the water hitting your glass probably never went through it. Softeners are usually plumbed for indoor water only, so outdoor faucets and sprinklers on city water still carry Mound&rsquo;s unsoftened water. Re-aiming the sprinkler heads to miss the house does the most good, and anything baked on calls for our hard-water stain removal, quoted separately after we see it."),
            ("Do you work in Three Points, Island Park and Shadywood Point?",
             "Yes. Three Points, Island Park, Halstead Heights and Shadywood Point are all part of Mound, and they&rsquo;re in our service area like the rest of town, whether your home is on the water or a few streets back."),
            ("What does it take to get a price for my Mound home?",
             "Call (763) 314-3400 or send the quote form; there&rsquo;s no charge and no obligation. The price depends on the size of your house, its window count and how hard the glass is to reach, and you get one clearly stated, all-in price before we start."),
        ],
        "verify": [
            "Western shores of Lake Minnetonka, about 20 miles west of Minneapolis, more than 17 miles of shoreline (City of Mound, About the City).",
            "Water covers more than 40 percent of the city: 2.22 of 5.08 square miles (Census Gazetteer via Wikipedia). Double-check.",
            "Lost Lake is part of Lake Minnetonka, lies entirely in Mound beside downtown, and connects to Cooks Bay by a channel (Wikipedia); boaters' day-use docks on the Lost Lake Greenway (City of Mound docks page).",
            "9,398 residents at the 2020 census (Census / Wikipedia).",
            "Mound Metalcraft started in an old schoolhouse in Mound in 1946 and became Tonka Toys (Hennepin History Museum).",
            "Three Points (1959), Island Park and Halstead Heights (1960) and Shadywood Point (1963) joined Mound (City of Mound 2040 Comprehensive Plan). Double-check.",
            "More than half of homes built by the end of the 1960s (City of Mound 2040 Comprehensive Plan). Double-check.",
            "Hardness of 21 to 24 grains per gallon; odd/even sprinkling May 15 to September 1 for city-water homes (City of Mound Water Utility page). Double-check both are current.",
            "Job photo: taken right at the Mound/Minnetrista line (photo GPS). Confirm it was a Mound job.",
            "Softeners plumbed for indoor water only, lake sides carrying the most glass, and older homes' sashes and storms are general descriptions, not sourced facts.",
        ],
    },
    {
        "slug": "st-michael",
        "city": "St. Michael",
        "county": "Wright County",
        "live": True,
        "replaces_area": True,  # owner approved: this page takes over areas/st-michael.html
        "title": "Window Cleaning in St. Michael, MN",
        "desc": "Window cleaning in St. Michael, MN from a Wright County crew based in Delano: hard-water spots, upper-story glass, screens and tracks. Free quotes.",
        "hero_sub": "Window cleaning across St. Michael, from the old downtown around the historic church to the newer neighborhoods near Uhl Lake. Fully insured, and every visit is backed by our 100% satisfaction guarantee.",
        "why_heading": "A fast-growing city along the Crow River",
        "why_intro": [
            "St. Michael sits along I-94 on the eastern side of Wright County, about 30 minutes from downtown Minneapolis, where the Crow River separates it from Rogers. Downtown, the Gothic Revival Church of St. Michael, built in the early 1890s, still stands at Main Street and Central Avenue and has been on the National Register of Historic Places since 1979.",
            "It&rsquo;s growing fast. The 2020 census counted 18,235 people in St. Michael, and the State Demographer&rsquo;s 2025 estimate puts it at 22,623, one of only two Wright County cities past 20,000. Newer neighborhoods have gone up near Uhl Lake and Gonz Lake, among other parts of town, and each August the Daze &amp; Knights Festival brings a parade, live music and fireworks to Town Center Park.",
        ],
        "why_points": [
            ("Filtered water that&rsquo;s still hard",
             "St. Michael&rsquo;s city water comes from the Joint Powers Water Board, which also serves Albertville and Hanover. Its plant filters out iron and manganese, but the water is still rated hard, at 22 grains per gallon, and when sprinkler or hose water dries on glass, those minerals stay behind. Upper glass we reach with water-fed poles gets a purified-water rinse that dries clear, and rings that have already set in get our hard-water stain removal, quoted after we see them."),
            ("Transoms, upper stories and sliders",
             "Census survey data puts the median year built for St. Michael homes at about 1998, so roughly half the houses date from the late 1990s or later. Newer homes tend to carry more glass up high: transoms over the front door, upper-story windows across the back and wide sliding patio doors. Water-fed poles handle most of it from the ground, a ladder covers the rest, and track detailing clears the grit where the sliders run."),
            ("Summer watering hours",
             "From June through September, the city allows lawn sprinkling only between 7 p.m. and 10 a.m., on odd or even dates by house number. That means sprinklers run in the evening and early morning, and any spray on the windows dries in place. Aiming the heads at the lawn prevents most of it, and the early-fall cleaning is a good time to check whether any spots have set in."),
        ],
        "hero": "assets/img/3P8A7912.JPEG",
        "hero_pos": "86% 40%",
        "jobs": [],
        "faqs": [
            ("How often do St. Michael homeowners need their windows cleaned?",
             "We recommend a quarterly schedule, four cleanings a year, and two is the minimum: late spring, then early fall, after the busiest sprinkler months."),
            ("Do you work in St. Michael&rsquo;s newer neighborhoods?",
             "Yes, every part of St. Michael is in our service area, from downtown around the historic church to the newer neighborhoods out by Uhl Lake and Gonz Lake."),
            ("Can you clean our screens too?",
             "We can. Screen cleaning is an add-on to a window cleaning: we take out every screen, hand-wash the mesh and frame on both sides, and return each one to its original window. Once a year is plenty for most homes, usually with the spring visit."),
            ("Is a quote free, and what is it based on?",
             "Call (763) 314-3400 or take a few minutes with the quote form; it&rsquo;s free and you&rsquo;re under no obligation. We price each home by its size, its window count and how reachable the glass is, and you&rsquo;ll know the clear, all-in total before any work begins."),
        ],
        "verify": [
            "Along I-94, about 30 minutes from downtown Minneapolis (City of St. Michael, About Us); Crow River on its eastern edge, across from Rogers (Wikipedia).",
            "Church of St. Michael: Gothic Revival, Main Street and Central Avenue, National Register since 1979 (Wikipedia); built 1890 to 1892 (parish).",
            "18,235 at the 2020 census; 22,623 in the State Demographer's 2025 estimate, one of two Wright County cities over 20,000 with Otsego (Wright County news item).",
            "Newer neighborhoods near Uhl Lake and Gonz Lake (real-estate and builder listings; the city's North Uhl Lake Park is on Legacy Bay Drive). Double-check.",
            "Daze & Knights Festival each August at Town Center Park with a parade, live music and fireworks (festival site; City of St. Michael). Double-check.",
            "Joint Powers Water Board serves St. Michael, Albertville and Hanover; plant removes iron and manganese; water rated hard at 22 grains per gallon (JPWB FAQ; Minnesota Department of Health). Double-check.",
            "Median year built about 1998 (a real-estate site summarizing Census ACS 2019-2023). Double-check against Census data.",
            "Sprinkling June 1 to September 30 only from 7 p.m. to 10 a.m., odd/even by house number (City of St. Michael spring reminders page). Confirm it is current.",
            "Newer homes carrying more high glass, and screens once a year with the spring visit, are general descriptions, not sourced facts.",
        ],
    },
    {
        "slug": "minnetrista",
        "city": "Minnetrista",
        "county": "Hennepin County",
        "live": True,
        "title": "Window Cleaning in Minnetrista, MN",
        "desc": "Window cleaning in Minnetrista, MN for homes on Lake Minnetonka, Whaletail Lake and open lots: lake-side glass, screens and dusty tracks. Free quotes.",
        "hero_sub": "Window cleaning for Minnetrista homes, from lake-facing glass on Whaletail Lake and Lake Minnetonka to newer houses on big, open lots. Fully insured, with our 100% satisfaction guarantee behind every job.",
        "why_heading": "Lakes, open land and plenty of new neighbors",
        "why_intro": [
            "Minnetrista is a Hennepin County city spread across about 31 square miles, nearly 5 of them water. Part of Lake Minnetonka lies inside the city, along with smaller lakes like Whaletail Lake. Gale Woods Farm, a Three Rivers Park District working farm that&rsquo;s open to the public, sits on County Road 110, and the paved Dakota Rail Regional Trail runs through town between Mound and St. Bonifacius, which Minnetrista surrounds completely.",
            "The city has grown fast, from 3,439 residents in 1990 to 8,262 at the 2020 census, but it still had just over 300 people per square mile that year, roughly a tenth of the density next door in Mound.",
        ],
        "why_points": [
            ("Facing the big lake or a small one",
             "Plenty of Minnetrista homes look out over water, and the lake side usually has the biggest panes on the house. A film of dust or pollen there is hard to miss. Up high, our water-fed poles leave nothing behind because the water in them is purified, and mineral marks from sprinklers can be treated with our hard-water stain removal, which we&rsquo;ll price once we&rsquo;ve had a look."),
            ("Neighborhoods still going up",
             "Some of Minnetrista is still being built, and while nearby lots are graded and framed, dust drifts onto glass and sills and settles into window tracks. Our track detailing clears the grit out of those channels, and with the screen cleaning add-on, every screen comes down for a hand scrub of the mesh and frame, front and back, before it goes back in its own opening."),
            ("Room on every side",
             "At that density, Minnetrista homes tend to sit well apart, often with open yard all the way around. That leaves windows on every side out in the sun, wind and weather, second-story panes included. Water-fed poles handle those upper panes from the ground on all four sides, and a ladder comes out for any window a pole can&rsquo;t angle into."),
        ],
        "hero": "assets/img/jobs/minnetrista-farmhouse-with-screen-porch.jpg",
        "hero_pos": "39% 45%",
        "jobs": [
            {"photo": "assets/img/jobs/minnetrista-two-story-windows-inside-and-out.jpg",
             "label": "Two stories of great-room windows",
             "alt": "Seen from inside, a Barta crew member on a ladder cleans the upper panes of a two-story wall of windows in a Minnetrista home"},
            {"photo": "assets/img/jobs/minnetrista-three-story-stucco-home.jpg",
             "label": "Three stories of stucco and glass",
             "alt": "The tall stucco back of a Minnetrista home with a wide band of divided-light windows on the second floor"},
        ],
        "faqs": [
            ("What cleaning schedule makes sense for a Minnetrista home?",
             "Four visits a year is our recommendation if you want the glass clean all the time. Two is the minimum we suggest: one late in spring and one early in fall. Lake-facing homes and houses near new construction gain the most from all four."),
            ("Minnetrista doesn&rsquo;t have its own ZIP code. Will you come to my address?",
             "If the house is in Minnetrista, yes. The city shares ZIP codes with Mound, St. Bonifacius, Excelsior, Maple Plain, Waconia and Watertown, and even City Hall uses Mound&rsquo;s 55364. Mound and St. Bonifacius are in our service area too, so just give us your street address when you ask for a quote."),
            ("Who do I contact for a quote, and what affects the price?",
             "Reach us at (763) 314-3400 or through the quote form. It&rsquo;s free and doesn&rsquo;t commit you to anything. The price depends on the home&rsquo;s size, how many windows there are and how much work it takes to reach them, and you get one all-in figure, spelled out clearly, before any cleaning starts."),
        ],
        "verify": [
            "About 31 square miles, nearly 5 of them water (2019 Census Gazetteer, via a copy of Wikipedia). Double-check.",
            "Part of Lake Minnetonka lies inside the city (Wikipedia; Lake Minnetonka Conservation District member cities). Whaletail Lake is in Minnetrista (MPCA lake list); its acreage is left off because an archived DNR report says 558 acres and current listings say 510.",
            "Gale Woods Farm, a Three Rivers working farm open to the public, at 7210 County Road 110 W (Hennepin County parks data; web search).",
            "Dakota Rail Regional Trail runs through Mound, Minnetrista and St. Bonifacius (Three Rivers); St. Bonifacius is completely surrounded by Minnetrista (St. Bonifacius city site; Wikipedia).",
            "3,439 residents in 1990 and 8,262 at the 2020 census (Census tables via Wikipedia); 2024 estimates run about 8,700 to 9,100, so the page dates the 2020 figure.",
            "Just over 300 people per square mile in 2020 (8,262 on 26.1 square miles of land), about a tenth of Mound's density (Census Gazetteer and SimpleMaps densities).",
            "No ZIP code of its own; ZIPs shared with Mound, St. Bonifacius, Excelsior, Maple Plain, Waconia and Watertown; City Hall uses Mound's 55364 (SimpleMaps ZIP list; Hennepin County election data; polling-place file). USPS not checked.",
            "Parts of the city still being built (a builder lists Woodland Cove in its final phase). Reword if building has wrapped up.",
            "Job photos: taken north of St. Bonifacius and south of Mound (photo GPS). Confirm both, and the top photo, were Minnetrista jobs.",
            "Lake-facing homes, construction dust, and homes sitting well apart are general descriptions, not sourced facts.",
        ],
    },
    {
        "slug": "watertown",
        "city": "Watertown",
        "county": "Carver County",
        "live": True,
        "title": "Window Cleaning in Watertown, MN",
        "desc": "Window cleaning in Watertown, MN for homes in town by the Crow River and out in the country around it: purified-water rinse, screens, tracks. Free quotes.",
        "hero_sub": "Spot-free windows for Watertown homes, in town along the Crow River or out in the lake country around it, just down the road from our home base in Delano. Fully insured, with our 100% satisfaction guarantee.",
        "why_heading": "A river town in lake country",
        "why_intro": [
            "Watertown is a small Carver County city on the South Fork of the Crow River, at the western edge of the Twin Cities metro, with the Luce Line State Trail running through the area. The township around it took its name from the water within its borders, including the river and lakes such as Oak, Swede, Buck and Rice, and much of the land outside town is still open country.",
            "The city has grown steadily, from about 1,400 people in 1970 to 4,659 at the 2020 census. Its schools are in the Watertown-Mayer district, shared with Mayer, about 5 miles to the south-southwest.",
        ],
        "why_points": [
            ("Well water, in town and out",
             "Watertown&rsquo;s city water comes from groundwater wells, and homes out in the country typically have wells of their own. Groundwater carries dissolved minerals, so when sprinkler spray or hose water dries on a window, it leaves white spots behind. Our water-fed poles use purified water, which adds no minerals of its own, and buildup from several summers calls for hard-water stain removal, quoted once we&rsquo;ve looked at your windows."),
            ("River, lakes and green space",
             "Between the Crow River in town and lakes like Oak, Swede and Buck around it, water and greenery are never far off, and homes near them tend to collect spider webs in the window corners, bug specks on the glass and pollen on the screens over the warm months. Add screen cleaning and each screen is taken out, scrubbed by hand on both sides, frame too, and returned to its own window."),
            ("Field dust at planting and harvest",
             "Out past the city limits, homes sit among fields, and at planting and harvest the dust ends up on screens and in window tracks, which track detailing cleans out. Upstairs glass is mostly a job for our water-fed poles, worked from the yard, with a ladder for anything they can&rsquo;t reach."),
        ],
        "hero": "assets/img/instagram/17870581794546118_6.jpg",
        "hero_pos": "66% 35%",
        "jobs": [
            {"photo": "assets/img/jobs/watertown-area-log-home-tall-windows.jpg",
             "label": "Tall windows on a log home, outside town",
             "alt": "Tall windows on the gable end of a log-sided home near Watertown, freshly cleaned and reflecting the sky"},
            {"photo": "assets/img/jobs/watertown-area-water-fed-pole-second-story.jpg",
             "label": "Second-story glass from the deck",
             "alt": "Barta crew member on a deck guiding a water-fed pole up to a second-story window of a gray shingle-sided home near Watertown"},
            {"photo": "assets/img/jobs/watertown-area-arched-windows-water-fed-pole.jpg",
             "label": "Arched windows, same home",
             "alt": "Crew member cleaning a row of arched and square windows along a wet deck with a water-fed pole, beside a stone chimney"},
        ],
        "faqs": [
            ("How frequently should windows be cleaned on a Watertown-area home?",
             "Our advice is four cleanings a year, one per season, and never fewer than two: late spring and early fall. Homes next to open fields get the most from all four."),
            ("Watertown&rsquo;s water comes from wells. Could that be what&rsquo;s spotting my windows?",
             "Quite possibly. When sprinkler spray evaporates off a window, the water leaves but its minerals stay, as white spots. The purified water our poles rinse with won&rsquo;t add more, and for spots already on the glass, we check the windows first, then quote hard-water stain removal as its own treatment."),
            ("Do you serve homes outside the city limits?",
             "Yes. Homes in town and in the countryside around it are all in our service area, whether you&rsquo;re near the Crow River or out by one of the lakes, and our base in Delano is about 6 miles north."),
            ("What does a quote cost, and what goes into the price?",
             "The quote is free, and asking doesn&rsquo;t commit you to anything. Phone (763) 314-3400 or fill in the quote form. The price comes down to the size of the house, how many windows it has and how hard the glass is to reach, and the quote spells out the full price before anything gets cleaned."),
        ],
        "verify": [
            "Small Carver County city on the South Fork of the Crow River, at the edge of the Twin Cities metro (Wikipedia, read from copies because the page was blocked). Double-check.",
            "Luce Line State Trail through the area (DNR; the trail runs through Watertown).",
            "Watertown Township named for the water within its borders, including lakes such as Oak, Swede, Buck and Rice (Wikipedia township article; Carver County place-name history). Double-check.",
            "1,390 people in 1970 (written as about 1,400) and 4,659 at the 2020 census (Census tables via Wikipedia and data copies). Double-check the 2020 count.",
            "Watertown-Mayer Public Schools, ISD 111, shared with Mayer, about 5.5 miles south-southwest of Watertown in a straight line (state school-district list; Census 2021 Gazetteer).",
            "Delano about 6 miles north (5.95 miles straight-line between town centers; the drive is longer).",
            "City water from groundwater wells (EPA drinking-water system records). No hardness figure was found, so none is given; country homes having private wells is a general description.",
            "Job photos: the log home was taken between Delano and Watertown, about 3 miles from Watertown; the other two (one a still from your video) at one home in the countryside west of St. Bonifacius, most likely Watertown Township (photo GPS). Confirm they count as Watertown-area jobs.",
            "Webs, bugs and pollen near water, and field dust at planting and harvest, are general descriptions, not sourced facts.",
        ],
    },
    {
        "slug": "minnetonka",
        "city": "Minnetonka",
        "county": "Hennepin County",
        "live": True,
        "title": "Window Cleaning in Minnetonka, MN",
        "desc": "Window cleaning in Minnetonka, MN for lake-facing homes near Grays Bay and the neighborhoods inland: upper panes, screens and tracks. Free quotes.",
        "hero_sub": "Spot-free glass for Minnetonka homes, from houses near Grays Bay to the neighborhoods that make up most of the city. Fully insured, and every job is backed by our 100% satisfaction guarantee.",
        "why_heading": "A big suburb with a foothold on the lake",
        "why_intro": [
            "Minnetonka is one of the larger cities in Hennepin County&rsquo;s western suburbs, with Plymouth to the north and Wayzata to the northwest. It&rsquo;s one of the 14 member cities of the Lake Minnetonka Conservation District, and at Grays Bay the city runs Gray&rsquo;s Bay Marina, near where Minnehaha Creek leaves the lake on its way east to Minneapolis.",
            "Census counts show how much Minnetonka has grown: 25,037 residents in 1960, 51,301 in 2000 and 53,781 in 2020. A lot of its homes date from those decades of growth. From our base in Delano, Highway 12 and I-394 bring us straight in.",
        ],
        "why_points": [
            ("Grays Bay glass",
             "Minnetonka&rsquo;s stretch of the lake is small, but homes near Grays Bay make the most of it, with big panes turned toward the water and upper windows a story or two off the ground. We reach most of that glass from the grass with water-fed poles, which use purified water, so the view dries without spots, and the odd window tucked under a deck or roofline gets a ladder."),
            ("Let ice-out be your reminder",
             "The ice on Lake Minnetonka usually goes out around mid-April. Whenever it does, that&rsquo;s a good moment to put spring window cleaning on the calendar, and the visit itself is best in late spring, once pollen season winds down."),
            ("Homes that have been lived in for decades",
             "Many of those homes are decades old now, and often so are their windows. Years of use pack grit into the tracks and turn screens gray with dust. Our track detailing cleans out the channels, and if you add screen cleaning, we remove each screen, wash both sides and the frame by hand, and return it to its own window."),
        ],
        "hero": "assets/img/instagram/17870581794546118_0.jpg",
        "hero_pos": "29% 16%",
        "jobs": [],
        "faqs": [
            ("How often do you recommend cleaning windows in Minnetonka?",
             "Quarterly, since four cleanings a year keep the glass clear through every season. Two a year is the floor: late spring and early fall."),
            ("Do you work all over Minnetonka, or only near the lake?",
             "All over. Most Minnetonka homes are inland, and they&rsquo;re in our service area just like the houses near Grays Bay. Inside or out, one story or three, we&rsquo;ll quote whatever glass you&rsquo;d like cleaned."),
            ("White spots keep showing up where my sprinklers hit the windows. What can you do?",
             "Those spots are minerals left behind when sprinkler water dries on glass. Once they build up, they need hard-water stain removal, which we quote on its own after seeing the glass. Our regular cleanings won&rsquo;t add more, since the water in our poles is purified, and keeping the spray off the windows stops new spots from forming."),
            ("How is a Minnetonka quote priced?",
             "A quote is free and doesn&rsquo;t obligate you to book. Phone (763) 314-3400 or request one through the quote form. The price is based on how big the house is, how many windows it has and how hard they are to get at, and you&rsquo;ll see the complete, all-in price before we start."),
        ],
        "verify": [
            "'One of the larger cities in the western suburbs': 53,781 at the 2020 census, about the seventh-largest city in Hennepin County (Census 2020). Double-check.",
            "Plymouth to the north (WorldAtlas) and Wayzata to the northwest (City of Wayzata Comprehensive Plan). Double-check.",
            "One of the 14 member cities of the Lake Minnetonka Conservation District (lmcd.org).",
            "Gray's Bay Marina is a City of Minnetonka park, and Minnehaha Creek's headwaters are at Grays Bay (Hennepin County parks data: Gray's Bay Marina and Minnehaha Creek Headwaters listed as city parks). Check the city parks page.",
            "25,037 in 1960, 51,301 in 2000 and 53,781 in 2020 (Census via Wikipedia). Double-check the 2020 count.",
            "Lake Minnetonka's ice usually goes out around mid-April (median ice-out April 13, per a wayzata.com article). Double-check.",
            "Minnetonka's 'stretch of the lake is small' and most homes being inland follow from the city's lake frontage being around Grays Bay; many homes dating from 1960-2000 is inferred from census growth, not year-built data.",
            "No job photos yet: the 'Jobs we've done' section stays hidden until you add some.",
            "Lake sides carrying the most glass, pollen season, and track grit on older windows are general descriptions, not sourced facts.",
        ],
    },
    {
        "slug": "victoria",
        "city": "Victoria",
        "county": "Carver County",
        "live": True,
        "title": "Window Cleaning in Victoria, MN",
        "desc": "Window cleaning in Victoria, MN for lake homes and big newer houses: upper glass from the ground, sprinkler spots, screens and tracks. Free quotes.",
        "hero_sub": "Clear glass for Victoria homes, whether yours faces one of the city&rsquo;s lakes, backs onto parkland or sits in one of the newer neighborhoods. Fully insured, with our 100% satisfaction guarantee behind the work.",
        "why_heading": "Lakes, parks and a downtown on Stieger Lake",
        "why_intro": [
            "Victoria sits on the southwest edge of Lake Minnetonka in Carver County and calls itself the City of Lakes and Parks: along with its share of Lake Minnetonka, the city&rsquo;s list of lakes includes Lake Virginia, Schutz Lake, Lake Zumbra and Lake Auburn, and it looks after 32 parks and more than 400 acres of reserved land. Downtown, Bayfront Park sits on Stieger Lake, looking across to Carver Park Reserve, and hosts free Live by the Lake concerts on summer Wednesday evenings.",
            "Swiss immigrants settled the area in 1852, and the village that grew up here, named for St. Victoria Church, incorporated in 1915. It has grown quickly since: 7,345 residents at the 2010 census, 10,546 in 2020, and more than 12,000 by the city&rsquo;s 2025 count, with new neighborhoods still going in.",
        ],
        "why_points": [
            ("Hard groundwater and a midday sprinkler ban",
             "Victoria&rsquo;s wells feed a plant that removes iron and manganese, but water-treatment companies still put the city&rsquo;s water at about 18 grains of hardness per gallon, well into the very-hard range. From May through September, the city bans irrigation with city water from 10 a.m. to 5 p.m., so sprinklers run early and late, and any spray that reaches a window dries there and leaves its minerals behind. Our water-fed poles rinse upper panes with purified water that adds no spots of its own; set-in spots need hard-water stain removal, priced after we&rsquo;ve seen the glass."),
            ("Built since 2000, and built big",
             "By NeighborhoodScout&rsquo;s count, about 62 percent of Victoria&rsquo;s housing has gone up since 2000, and big homes are common. Houses that size put glass on every level, from patio doors off the kitchen to dormers and half-round windows up by the roofline. Water-fed poles let our crew clean most of that upper glass with both feet on the ground, and the ladder is for the few windows out of a pole&rsquo;s reach."),
            ("Close to woods, marshes and water",
             "Carver Park Reserve&rsquo;s Lowry Nature Center, on Victoria Drive, was the first public nature center built in the Twin Cities, and its trails wind past lakes, tamarack bogs, cattail marshes and hardwood forest. Homes near that kind of landscape tend to see more pollen on their windows and more cobwebs in the frame corners, and screens collect the same buildup. As an add-on, we pull every screen, hand-wash both faces and the frame, and reinstall each one in the window it belongs to."),
        ],
        "hero": "assets/img/jobs/victoria-two-story-front-windows.jpg",
        "hero_pos": "50%",
        "jobs": [
            {"photo": "assets/img/jobs/victoria-three-stories-above-the-patio.jpg",
             "label": "Three stories above the patio",
             "alt": "The tall back of a Victoria home, three stories of windows rising above a stone patio with a deck and fire pit"},
            {"photo": "assets/img/jobs/victoria-sunroom-windows.jpg",
             "label": "A wall of sunroom windows",
             "alt": "The sunroom on the back of a Victoria home, a long row of windows above a stone retaining wall"},
        ],
        "faqs": [
            ("Is twice a year often enough for windows in Victoria?",
             "It works as a minimum: a cleaning in late spring and another in early fall is the lightest schedule we recommend. For glass that looks clean year-round, we suggest four."),
            ("Our house is in one of Victoria&rsquo;s older neighborhoods. Do older windows need a different approach?",
             "Sometimes. Many of Victoria&rsquo;s older homes date from before 1980, and windows from those decades can have storm panels or small divided panes. We clean those by hand, one pane at a time, finishing each with a squeegee, and if dirt has packed into the tracks, window track detailing cleans it out."),
            ("You&rsquo;re based in Delano. Is Victoria in your service area?",
             "It is. Victoria is about 17 miles from Delano by way of County Road 11, roughly a half-hour drive, and the whole city is in our service area, the newest developments included."),
            ("Will I know the total before any work starts?",
             "Yes. Quotes cost nothing and you&rsquo;re free to say no; call (763) 314-3400 or send in the quote form. Three things set the price: how big the home is, its number of windows, and how easy or awkward they are to reach, and you&rsquo;ll see a clear, all-in total before we begin."),
        ],
        "verify": [
            "Carver County; 7,345 residents at the 2010 census and 10,546 at the 2020 census (Wikipedia; Census, read from search excerpts). More than 12,000 per the city's 2025 budget overview. Double-check.",
            "On the southwest edge of Lake Minnetonka (City of Victoria, About Victoria).",
            "'City of Lakes and Parks', 32 parks and more than 400 acres of reserved land (City of Victoria, Parks and Recreation); Lake Virginia, Schutz Lake, Lake Zumbra and Lake Auburn on the city's lakes list (City of Victoria, Lakes page).",
            "Bayfront Park downtown on Stieger Lake, looking across to Carver Park Reserve; free Live by the Lake concerts on summer Wednesday evenings (City of Victoria).",
            "Settled by Swiss immigrants in 1852 (Carver County Historical Society); named for St. Victoria Church and incorporated in 1915 (City of Victoria, History).",
            "New neighborhoods still going in (the city's development projects list: Marsh Hollow, Victoria Ridge, Estoria).",
            "Wells feed a plant that removes iron and manganese (City of Victoria, Water Services). About 18 grains of hardness is a water-treatment company's figure, not the city's. Double-check against the city's drinking-water report.",
            "No irrigation from city water 10 a.m. to 5 p.m., May through September (City of Victoria, Water Conservation). Confirm it is current.",
            "About 62 percent of housing built since 2000, and big homes common (NeighborhoodScout, about 2021 data). Double-check.",
            "Lowry Nature Center in Carver Park Reserve on Victoria Drive, the first public nature center built in the Twin Cities (Three Rivers Park District).",
            "Many older homes from before 1980 (City of Victoria news item on its Old Town Residential district). Double-check.",
            "About 17 miles and roughly 30 minutes from Delano via County Road 11 (a distance calculator). Double-check against your own drive.",
            "Job photos taken near downtown Victoria (photo GPS); the house number above the garage in the top photo is blurred.",
            "Pollen and cobwebs near woods and water, big houses having glass on every level, and older windows having storms or divided panes are general descriptions, not sourced facts.",
        ],
    },
    {
        "slug": "chanhassen",
        "city": "Chanhassen",
        "county": "Carver County",
        "live": True,
        "title": "Window Cleaning in Chanhassen, MN",
        "desc": "Window cleaning in Chanhassen, MN for lake homes and wooded lots: upper glass from the ground, screens, and spots from very hard water. Free quotes.",
        "hero_sub": "Window cleaning for Chanhassen homes, from the shores of Lake Minnewashta and Lotus Lake to wooded neighborhoods across town. Fully insured, and the work carries our 100% satisfaction guarantee.",
        "why_heading": "Twelve lakes and a name from the sugar maple",
        "why_intro": [
            "Chanhassen sits about 15 miles southwest of Minneapolis, and its name comes from Dakota words for the sugar maple, the tree with sweet sap. The city has 12 lakes, the largest being 680-acre Lake Minnewashta, with a Carver County regional park on its shore, and Lake Ann is where the fireworks go up during the three-day Fourth of July celebration, which draws more than 70,000 people.",
            "The 2020 census counted 25,947 people here, most of them in detached single-family homes, and census-based estimates put the median home&rsquo;s build year in the early 1990s. Paisley Park, Prince&rsquo;s home and studio complex, opened as a museum in 2016, and Chanhassen Dinner Theatres has been staging shows since 1968.",
        ],
        "why_points": [
            ("What comes out of Chanhassen&rsquo;s wells",
             "Chanhassen&rsquo;s deep wells are high in iron and manganese, which left orange and brown stains for years until the city began filtering them out. Hardness is another matter: the city lists its water at 21 grains per gallon, which is very hard, so sprinkler or hose water that dries on glass leaves white mineral spots. On upper panes, our water-fed poles run purified water and leave no new spots, and set-in spots get a separate hard-water stain removal treatment, quoted after we look at the glass."),
            ("Houses that look out on the water",
             "Homes around Lake Minnewashta, along Lotus Lake and on Chanhassen&rsquo;s end of Christmas Lake tend to put their biggest windows on the lake side: patio doors on a walkout level and wide panes above. We clean the walkout glass by hand and squeegee it dry, work the upper panes from the lawn with water-fed poles, and use a ladder for anything the poles can&rsquo;t reach."),
            ("Trees the city means to keep",
             "Chanhassen has tightened its tree rules as emerald ash borer, confirmed here in 2021, has spread, including a Heritage Tree Ordinance for trees at least 25 inches across. In wooded neighborhoods like those on the east side of Lotus Lake, pollen, seeds and leaf bits collect in window screens over a season. Our screen cleaning add-on takes each screen out for a hand wash on both sides, frame and all, then puts it back in its own window."),
        ],
        "hero": "assets/img/jobs/chanhassen-patio-and-upper-windows.jpg",
        "hero_pos": "45%",
        "jobs": [
            {"photo": "assets/img/jobs/chanhassen-front-windows-ladder.jpg",
             "label": "Front windows, ladder to the second floor",
             "alt": "Barta crew member cleaning by the front door of a Chanhassen home, with an extension ladder set against the second-floor windows"},
            {"photo": "assets/img/jobs/chanhassen-window-over-the-pool.jpg",
             "label": "Poolside window, freshly cleaned",
             "alt": "A freshly cleaned window on a Chanhassen home, with the backyard pool in view"},
        ],
        "faqs": [
            ("When in the year should a Chanhassen home get its windows cleaned?",
             "Late spring and early fall, at the least: that&rsquo;s the two-visit minimum we recommend. For windows that stay consistently clean all year, we suggest four cleanings, one each season."),
            ("Our house is in the part of Chanhassen that&rsquo;s in Hennepin County. Is it in your service area?",
             "Yes. Most of Chanhassen is in Carver County, but a small part of the city extends east into Hennepin County, and every Chanhassen address, on either side of the county line, is in our service area."),
            ("Our home was built in the early &rsquo;90s, and a few windows look foggy even after cleaning. Can you fix that?",
             "Not if the fog is between the panes. On a double-pane window, that usually means the seal has failed and moisture has gotten inside, where no cleaning can reach, so it&rsquo;s a job for a window repair or replacement company. Haze on a surface you can touch, inside or out, is something on the glass, and we can clean it or tell you what it will take."),
            ("Can we find out what it will cost before we commit to anything?",
             "Yes. Phone us at (763) 314-3400 or use the quote form; the quote costs nothing, and you decide afterward whether to go ahead. Three things set the price: the size of the house, its number of windows and how easy the glass is to get to. Before any work starts, you&rsquo;ll have a clear price with everything included."),
        ],
        "verify": [
            "About 15 miles southwest of Minneapolis; mostly in Carver County, with a small part in Hennepin County (Wikipedia; Census Reporter).",
            "Name from Dakota words for the sugar maple, 'the tree with sweet sap' (City of Chanhassen history page; Wikipedia).",
            "12 lakes (City of Chanhassen, Lakes page); Lake Minnewashta 680 acres (City of Chanhassen) with Carver County's Lake Minnewashta Regional Park on its shore. 'Largest' is inferred from the city's lake sizes.",
            "Fireworks over Lake Ann during the three-day Fourth of July celebration, more than 70,000 people (City of Chanhassen). Double-check.",
            "25,947 people at the 2020 census (Census via Wikipedia); mostly detached single-family homes (Chanhassen 2040 Comprehensive Plan).",
            "Median build year in the early 1990s (third-party summaries of Census ACS: 1993 to 1994). Double-check.",
            "Paisley Park opened as a museum in 2016 (Wikipedia); Chanhassen Dinner Theatres opened in 1968 (Chanhassen Dinner Theatres).",
            "Deep wells high in iron and manganese that stained until the city began filtering them (City of Chanhassen, Water Treatment); water at 21 grains per gallon (City of Chanhassen, Sewer and Water FAQ).",
            "Lake Minnewashta, Lotus Lake and Christmas Lake homes; Christmas Lake lies mostly in Shorewood with part in Chanhassen (Wikipedia). Double-check.",
            "Emerald ash borer confirmed in 2021; Heritage Tree Ordinance for trees at least 25 inches across (City of Chanhassen EAB page; 2026 council recaps). Double-check the adopted wording.",
            "Job photos taken in central Chanhassen (photo GPS); the house number beside the front door is blurred.",
            "Lake-side glass on walkout homes, pollen and leaves in screens, and fog between panes meaning a failed seal are general descriptions, not sourced facts.",
        ],
    },
]

# Directory-style path for a city page ("window-cleaning-wayzata-mn/"); the
# file inside is index.html, so the URL needs no rewrite rule on any host.
def city_page_path(c):
    return f"window-cleaning-{c['slug']}-mn/"

LIVE_CITY_PAGES = [c for c in CITY_PAGES if c.get("live")]
