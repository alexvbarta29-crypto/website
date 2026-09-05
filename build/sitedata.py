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
        "hero_pos": "35%",
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
        "hero_pos": "32%",
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
        "hero_pos": "80%",
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
        "hero_pos": "16%",
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
        "hero_pos": "30%",
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
        "hero_pos": "48%",
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

# How far we travel from Delano. Every city below is inside this, and the
# Service Areas hub says so in as many words.
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
# one is closed: our home county, drawn as an outline. No pin on the shop —
# the question the map answers is "do you come out my way?", not "where are
# you?". The radius is stated in words beside it, since a keyless embed
# cannot draw a circle.
SERVICE_AREA_VIEW = dict(COUNTIES[0], label=COUNTIES[0]["name"])

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

# ZIP codes served, shown on the Service Areas hub page for local SEO.
ZIP_CODES = [
    "55305", "55311", "55317", "55328", "55331", "55340", "55341", "55343",
    "55345", "55356", "55357", "55359", "55363", "55364", "55369", "55373",
    "55374", "55375", "55376", "55384", "55386", "55387", "55390", "55391",
    "55446", "55447",
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
