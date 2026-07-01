"""
Barta Window Washing — site data & shared components.
Single source of truth for NAP, services, areas, plans, icons, and HTML partials.
"""

# ---------------------------------------------------------------------------
# Business identity (NAP) — edit here to update site-wide
# ---------------------------------------------------------------------------
BIZ = {
    "name": "Barta Window Washing",
    "short": "Barta",
    "tagline": "Delano's Premium Exterior Cleaning Company",
    "phone_display": "(763) 555-0142",
    "phone_href": "+17635550142",
    "email": "hello@bartawindowwashing.com",
    "street": "1 Bridge Avenue",
    "city": "Delano",
    "state": "MN",
    "zip": "55328",
    "lat": "45.0419",
    "lng": "-93.7891",
    "hours": "Mon–Sat 7:00am – 7:00pm",
    "founded": "2014",
    "rating": "5.0",
    "review_count": "100",
    "domain": "https://www.bartawindowwashing.com",
    "facebook": "https://www.facebook.com/bartawindowwashing",
    "instagram": "https://www.instagram.com/bartawindowwashing",
    "tiktok": "https://www.tiktok.com/@bartawindowwashing",
    "google": "https://www.google.com/search?q=bartawindowwashing#lrd=0x52b4a9e4856ebf2f:0x384cc062f9b0d3f9,1,,,,",
}

# ---------------------------------------------------------------------------
# Services — each drives a full service page + nav + cards
# ---------------------------------------------------------------------------
SERVICES = [
    {
        "slug": "window-cleaning",
        "name": "Window Cleaning",
        "icon": "window",
        "image": "assets/img/window-cleaning-main.jpg",
        "short": "Streak-free, spot-free glass inside and out using pure-water and traditional methods.",
        "hero_sub": "Crystal-clear, streak-free windows that flood your home with light — inside, outside, screens, sills, and tracks.",
        "kw": "window cleaning Delano MN",
        "kw2": ["residential window cleaning", "professional window washers", "interior and exterior window cleaning", "streak-free window cleaning"],
        "benefits": [
            ("Streak-free guarantee", "We don't leave until every pane is spotless — or we come back free."),
            ("Inside &amp; out", "Glass, frames, screens, sills, and tracks are detailed on every visit."),
            ("Pure-water technology", "Deionized water rinses glass cleaner and keeps it clearer, longer."),
            ("Hard-water removal", "We treat mineral spots and stains traditional cleaning leaves behind."),
        ],
        "intro": "Windows are the first thing guests notice and the last thing most homeowners have time to clean. Barta's window cleaning service brings back that just-built sparkle — without ladders in your flower beds or streaks in the afternoon sun. We hand-detail interior glass, use pure-water poles for exterior panes up high, and finish every screen, sill, and track so the whole window looks new.",
        "includes": [
            "Interior &amp; exterior glass hand-cleaned and squeegeed",
            "Window screens removed, washed, and reinstalled",
            "Sills, tracks, and frames wiped down",
            "Pure-water pole cleaning for second-story and hard-to-reach glass",
            "Spot treatment for light hard-water and mineral marks",
            "Full cleanup — we leave your home tidier than we found it",
        ],
        "process_note": "Most homes are completed in 2–4 hours with a two-person crew.",
    },
    {
        "slug": "gutter-cleaning",
        "name": "Gutter Cleaning",
        "icon": "gutter",
        "short": "Hand-cleared gutters and downspouts that protect your foundation, roof, and siding.",
        "hero_sub": "Clogged gutters cause rot, leaks, and foundation damage. We clear them by hand and flush every downspout.",
        "kw": "gutter cleaning Delano MN",
        "kw2": ["gutter cleaning near me", "downspout cleaning", "gutter clearing service", "residential gutter cleaning"],
        "benefits": [
            ("Protect your foundation", "Free-flowing gutters route water away from your home, not into it."),
            ("Hand-cleared, not blown around", "We bag debris and haul it away — no mess left behind."),
            ("Downspouts flushed", "We confirm water flows freely from gutter to ground."),
            ("Free roof &amp; gutter check", "We flag loose hangers, leaks, or damage before they grow."),
        ],
        "intro": "Minnesota's freeze-thaw cycles, maple seeds, and autumn leaves turn gutters into clogged troughs that send water where it doesn't belong. Barta clears every gutter and downspout by hand, bags the debris, and flushes the system to confirm proper flow — protecting your fascia, foundation, and landscaping season after season.",
        "includes": [
            "All gutters cleared of leaves, seeds, and debris by hand",
            "Downspouts flushed and tested for proper flow",
            "Debris bagged and hauled away — no piles left behind",
            "Gutters wiped down at the waterline where needed",
            "Free visual inspection of hangers, seams, and roof edge",
            "Photo report of anything that needs attention",
        ],
        "process_note": "Ask about gutter guards and recurring plans to keep them clear year-round.",
    },
    {
        "slug": "pressure-washing",
        "name": "Pressure Washing",
        "icon": "pressure",
        "short": "Restore driveways, patios, walkways, and decks to like-new with controlled high-pressure cleaning.",
        "hero_sub": "Blast away years of dirt, oil, algae, and grime from concrete, pavers, brick, and wood.",
        "kw": "pressure washing Delano MN",
        "kw2": ["power washing near me", "driveway cleaning", "concrete pressure washing", "patio cleaning service"],
        "benefits": [
            ("Like-new surfaces", "Driveways, patios, and walkways come back to their original color."),
            ("Surface-safe pressure", "We dial pressure and nozzles to each material — no etching or gouging."),
            ("Oil &amp; rust treatment", "Targeted pre-treatment lifts stains pressure alone can't."),
            ("Curb appeal that lasts", "Clean hardscapes instantly lift the look and value of your home."),
        ],
        "intro": "Concrete, brick, and pavers collect oil, tire marks, algae, and embedded grime that make even a well-kept home look tired. Barta's pressure washing uses commercial equipment and the right pressure for each surface — plus surface cleaners that leave wide, even, stripe-free results across driveways, patios, sidewalks, and pool decks.",
        "includes": [
            "Driveways, walkways, patios, and pool decks",
            "Pre-treatment for oil, rust, and organic staining",
            "Flat-surface cleaner for even, stripe-free results",
            "Steps, curbs, and retaining walls",
            "Post-rinse and debris cleanup",
            "Optional sealing recommendations to protect your investment",
        ],
        "process_note": "Pair with house washing for a complete exterior refresh and bundle savings.",
    },
    {
        "slug": "house-washing",
        "name": "House Washing",
        "icon": "house",
        "short": "Gentle, thorough exterior washing that removes algae, mildew, and dirt from siding.",
        "hero_sub": "A clean exterior makes your whole home look newer. We safely wash siding, soffits, and trim.",
        "kw": "house washing Delano MN",
        "kw2": ["exterior house washing", "vinyl siding cleaning", "house soft wash", "siding cleaning near me"],
        "benefits": [
            ("Whole-home refresh", "Siding, soffits, fascia, trim, and eaves cleaned top to bottom."),
            ("Safe for every surface", "Low-pressure soft washing protects siding, paint, and landscaping."),
            ("Kills the green, not just rinses", "Our solution treats algae and mildew at the root."),
            ("Boost curb appeal &amp; value", "The single highest-impact exterior upgrade you can make."),
        ],
        "intro": "That green and gray film creeping across the north side of your home is living algae — and rinsing it off only hides it for a few weeks. Barta's house washing combines low-pressure soft washing with professional-grade, plant-safe solutions that kill organic growth at the source, so your siding stays cleaner far longer and looks years younger.",
        "includes": [
            "Vinyl, fiber-cement, stucco, brick, and painted siding",
            "Soffits, fascia, gutters' exterior face, and trim",
            "Plant-safe, biodegradable cleaning solution",
            "Low-pressure soft wash — safe for your home and landscaping",
            "Spider webs, wasp nests, and surface debris removed",
            "Pre-wash plant protection and post-wash rinse",
        ],
        "process_note": "Most homes are washed in a single visit with no disruption to your day.",
    },
    {
        "slug": "soft-washing",
        "name": "Soft Washing",
        "icon": "soft",
        "short": "Low-pressure cleaning for delicate surfaces — roofs, stucco, and painted exteriors.",
        "hero_sub": "The safe way to clean roofs and delicate surfaces — low pressure, smart chemistry, lasting results.",
        "kw": "soft washing Delano MN",
        "kw2": ["soft wash roof cleaning", "low pressure house wash", "soft washing service", "algae removal soft wash"],
        "benefits": [
            ("Damage-free cleaning", "Low pressure means no etched stucco, stripped paint, or lifted shingles."),
            ("Lasts up to 4–6× longer", "Killing growth at the root keeps surfaces cleaner far longer."),
            ("Right chemistry, right surface", "Solutions tuned to each material and the organism we're treating."),
            ("Eco-conscious", "Biodegradable detergents and careful plant protection."),
        ],
        "intro": "High pressure has no place on roofs, stucco, screens, or painted surfaces. Soft washing applies specially formulated, biodegradable solutions at low pressure to dissolve algae, mold, mildew, and bacteria — then gently rinses everything clean. It's the method roofing and siding manufacturers actually recommend, and it keeps surfaces cleaner up to six times longer than pressure alone.",
        "includes": [
            "Roofs, stucco, EIFS, and delicate painted surfaces",
            "Algae, mold, mildew, lichen, and moss treatment",
            "Biodegradable, surface-specific cleaning solutions",
            "Low-pressure application and gentle rinse",
            "Landscaping protection before and after",
            "Long-lasting results that resist regrowth",
        ],
        "process_note": "The trusted method for any surface that high pressure could damage.",
    },
    {
        "slug": "roof-cleaning",
        "name": "Roof Cleaning",
        "icon": "roof",
        "short": "Remove black streaks, moss, and lichen safely with soft washing — no shingle damage.",
        "hero_sub": "Those black streaks are algae eating your shingles. We remove them safely and extend your roof's life.",
        "kw": "roof cleaning Delano MN",
        "kw2": ["roof moss removal", "black streak removal roof", "soft wash roof cleaning", "shingle cleaning service"],
        "benefits": [
            ("Extend roof life", "Removing algae and moss can add years to your shingles."),
            ("No pressure on shingles", "Soft washing only — we never blast or walk-damage your roof."),
            ("Restore curb appeal", "Streak-free shingles make the whole house look maintained."),
            ("Protect your warranty", "We use the manufacturer-recommended cleaning method."),
        ],
        "intro": "Those dark streaks running down your roof are Gloeocapsa magma — algae that feeds on shingle limestone and shortens roof life. Pressure washing a roof voids warranties and tears off granules. Barta uses ARMA-recommended soft washing to dissolve algae, moss, and lichen at the source, restoring your roof's appearance and protecting the biggest investment on your home.",
        "includes": [
            "Asphalt, architectural, and tile roofs",
            "Black-streak (algae), moss, and lichen removal",
            "Manufacturer-recommended soft wash method",
            "Gutter and downspout protection during cleaning",
            "Landscaping pre-wet and post-rinse protection",
            "Optional zinc/copper strip recommendations to slow regrowth",
        ],
        "process_note": "Roof work is quoted on-site after a free, no-obligation inspection.",
    },
    {
        "slug": "solar-panel-cleaning",
        "name": "Solar Panel Cleaning",
        "icon": "solar",
        "short": "Dust, pollen, and grime cut solar output — we restore peak efficiency safely.",
        "hero_sub": "Dirty panels can lose 15–25% of their output. We clean them safely to restore your energy savings.",
        "kw": "solar panel cleaning Delano MN",
        "kw2": ["solar panel cleaning service", "solar panel washing", "clean solar panels near me", "solar maintenance"],
        "benefits": [
            ("Recover lost output", "Clean panels can restore 15–25% of lost production."),
            ("Manufacturer-safe methods", "Pure water and soft tools protect panels and coatings."),
            ("Protect your ROI", "Maximize the return on your solar investment."),
            ("Safe, insured access", "Trained, fully insured technicians handle the height."),
        ],
        "intro": "Solar panels are an investment in lower energy bills — but pollen, dust, bird droppings, and Minnesota winter grime form a film that quietly steals output. Barta cleans panels with pure, deionized water and soft, non-abrasive tools that protect the glass and anti-reflective coating, restoring efficiency without scratches or harsh chemicals.",
        "includes": [
            "Residential and commercial solar arrays",
            "Pure-water, spot-free cleaning",
            "Soft, non-abrasive tools safe for panel coatings",
            "Removal of pollen, dust, droppings, and film",
            "Safe, insured roof and array access",
            "Recommended cleaning schedule for your system",
        ],
        "process_note": "Ask about seasonal cleaning plans to keep production at its peak.",
    },
    {
        "slug": "screen-cleaning",
        "name": "Screen Cleaning",
        "icon": "screen",
        "image": "assets/img/screen-cleaning-main.jpg",
        "short": "Hand-washed window and patio screens that breathe better and look brand new.",
        "hero_sub": "Dingy screens dull your view and your windows. We hand-wash every screen for a clear, fresh finish.",
        "kw": "window screen cleaning Delano MN",
        "kw2": ["screen cleaning service", "window screen washing", "patio screen cleaning", "screen repair near me"],
        "benefits": [
            ("Clearer views", "Clean screens let in more light and a crisper view."),
            ("Better airflow", "Dust and pollen come out of the mesh, not into your home."),
            ("Hand-washed, not just brushed", "Each screen is washed, rinsed, and dried by hand."),
            ("Pairs with window cleaning", "The perfect finishing touch on freshly cleaned glass."),
        ],
        "intro": "There's no point cleaning your glass and reinstalling dusty screens over it. Barta removes, labels, and hand-washes every window and patio screen — clearing the mesh of pollen, dust, and cobwebs — then reinstalls each one exactly where it belongs. The result is brighter rooms, better airflow, and windows that truly look finished.",
        "includes": [
            "Window and patio/porch screens",
            "Removed, labeled, and hand-washed",
            "Frames and mesh cleaned and rinsed",
            "Dried and reinstalled in the correct opening",
            "Light tears and damage flagged for repair",
            "Add-on to any window cleaning service",
        ],
        "process_note": "Screen cleaning is included with most window cleaning packages.",
    },
    {
        "slug": "hard-water-stain-removal",
        "name": "Hard Water Stain Removal",
        "icon": "drop",
        "short": "Remove cloudy mineral stains from glass that ordinary cleaning can't touch.",
        "hero_sub": "Sprinkler overspray and mineral buildup etch glass. We safely restore clarity ordinary cleaning can't.",
        "kw": "hard water stain removal Delano MN",
        "kw2": ["hard water stain removal glass", "mineral stain removal windows", "water spot removal", "glass restoration service"],
        "benefits": [
            ("Restore clear glass", "Remove the cloudy haze sprinklers and minerals leave behind."),
            ("Save the windows", "Far cheaper than replacing etched or stained glass."),
            ("Specialized process", "Professional compounds and technique, not guesswork."),
            ("Protective options", "Ask about coatings that help repel future spotting."),
        ],
        "intro": "Sprinkler overspray, runoff, and Minnesota's hard water leave behind mineral deposits that bond to glass and fog it permanently if ignored. Barta uses professional restoration compounds and proven technique to dissolve and lift these deposits — bringing back clarity that standard window cleaning simply cannot — and we can apply a protective treatment to slow future buildup.",
        "includes": [
            "Windows, glass doors, and shower glass",
            "Assessment of stain severity and etching",
            "Professional mineral-dissolving restoration process",
            "Multi-stage treatment for heavy deposits",
            "Optional protective glass coating",
            "Prevention tips to keep glass clearer",
        ],
        "process_note": "Severity varies — we provide an honest assessment before any work begins.",
    },
    {
        "slug": "christmas-light-installation",
        "name": "Christmas Light Installation",
        "icon": "lights",
        "short": "Professional, custom holiday lighting — design, install, maintain, and take down.",
        "hero_sub": "Skip the cold ladder. We design, hang, maintain, and remove premium holiday lighting for you.",
        "kw": "Christmas light installation Delano MN",
        "kw2": ["holiday light installation", "Christmas light hanging service", "professional holiday lighting", "outdoor Christmas lights installation"],
        "benefits": [
            ("Custom design", "A lighting plan tailored to your roofline, trees, and style."),
            ("Premium commercial-grade lights", "Brighter, more durable bulbs that last season after season."),
            ("Full-service", "We design, install, maintain, take down, and store."),
            ("Safe &amp; insured", "No icy ladders, no risk — our insured crew handles it all."),
        ],
        "intro": "The magic of a beautifully lit home — without a single trip up a frozen ladder. Barta designs a custom holiday display for your rooflines, walkways, trees, and shrubs, installs premium commercial-grade lighting, and keeps it shining all season. When the holidays end, we take everything down and store it for next year. You enjoy the lights; we handle everything else.",
        "includes": [
            "Free custom lighting design consultation",
            "Premium, commercial-grade LED lights and greenery",
            "Professional installation on rooflines, trees, and walkways",
            "In-season maintenance — burnt-out bulbs replaced free",
            "Post-season takedown",
            "Optional storage of lights between seasons",
        ],
        "process_note": "Books up fast — reserve your install in early fall for best availability.",
    },
]

# ---------------------------------------------------------------------------
# Header "Our Services" dropdown — exact list as offered, mapped to pages.
# (label, target page relative to site root)
# ---------------------------------------------------------------------------
DROPDOWN_SERVICES = [
    ("Exterior Window Cleaning", "services/window-cleaning.html"),
    ("Interior Window Cleaning", "services/window-cleaning.html"),
    ("Screen Cleaning Services", "services/screen-cleaning.html"),
    ("Track Detailing", "services/window-cleaning.html"),
    ("Solar Panel Cleaning", "services/solar-panel-cleaning.html"),
    ("Gutter Cleaning", "services/gutter-cleaning.html"),
    ("Soft Washing", "services/soft-washing.html"),
    ("Pressure Washing", "services/pressure-washing.html"),
    ("Christmas Light Installation", "services/christmas-light-installation.html"),
]

# Homepage "Our Services" picture-box grid (first two are featured/large).
HOME_SERVICES = [
    {"label": "Exterior Window Cleaning", "target": "services/window-cleaning.html", "icon": "window", "featured": True,
     "desc": "Streak-free exterior glass that makes your whole home shine."},
    {"label": "Interior Window Cleaning", "target": "services/window-cleaning.html", "icon": "window", "featured": True,
     "desc": "Spotless interior glass for brighter, sun-filled rooms."},
    {"label": "Screen Cleaning Services", "target": "services/screen-cleaning.html", "icon": "screen",
     "desc": "Hand-washed screens for clearer views and better airflow."},
    {"label": "Track Detailing", "target": "services/window-cleaning.html", "icon": "wrench",
     "desc": "Deep-cleaned window tracks and sills, free of built-up grime."},
    {"label": "Solar Panel Cleaning", "target": "services/solar-panel-cleaning.html", "icon": "solar",
     "desc": "Restore lost output with safe, spot-free panel cleaning."},
    {"label": "Gutter Cleaning", "target": "services/gutter-cleaning.html", "icon": "gutter",
     "desc": "Hand-cleared gutters and flushed downspouts that protect your home."},
    {"label": "Soft Washing", "target": "services/soft-washing.html", "icon": "soft",
     "desc": "Gentle, low-pressure cleaning that kills algae and mildew."},
    {"label": "Pressure Washing", "target": "services/pressure-washing.html", "icon": "pressure",
     "desc": "Restore driveways, patios, and walkways to like-new."},
    {"label": "Commercial Cleaning", "target": "commercial.html", "icon": "building",
     "desc": "Reliable, scheduled exterior cleaning for your business."},
    {"label": "Christmas Light Installation", "target": "services/christmas-light-installation.html", "icon": "lights",
     "desc": "Custom holiday lighting — we design, hang, maintain, and take it down."},
]

# ---------------------------------------------------------------------------
# Service areas — each drives a local landing page
# ---------------------------------------------------------------------------
AREAS = [
    {"slug": "delano", "city": "Delano", "neighborhoods": ["Downtown Delano", "Lake Ridge", "Crow River", "Bartholomew"], "note": "our home base"},
    {"slug": "maple-grove", "city": "Maple Grove", "neighborhoods": ["Rush Creek", "Fish Lake", "Weaver Lake", "Arbor Lakes"], "note": ""},
    {"slug": "plymouth", "city": "Plymouth", "neighborhoods": ["Bass Lake", "Medicine Lake", "Greenwood", "Kingsview"], "note": ""},
    {"slug": "wayzata", "city": "Wayzata", "neighborhoods": ["Ferndale", "Holdridge", "Lake Effect", "Downtown Wayzata"], "note": ""},
    {"slug": "minnetonka", "city": "Minnetonka", "neighborhoods": ["Glen Lake", "Deephaven border", "Opus", "Groveland"], "note": ""},
    {"slug": "buffalo", "city": "Buffalo", "neighborhoods": ["Buffalo Lake", "Sturges Park", "Montrose border", "Griffing"], "note": ""},
    {"slug": "rockford", "city": "Rockford", "neighborhoods": ["River Edge", "Greenfield border", "Rockford Township"], "note": ""},
    {"slug": "waconia", "city": "Waconia", "neighborhoods": ["Lake Waconia", "Downtown Waconia", "Coney Island"], "note": ""},
    {"slug": "chanhassen", "city": "Chanhassen", "neighborhoods": ["Lake Minnewashta", "Lotus Lake", "Longacres"], "note": ""},
    {"slug": "medina", "city": "Medina", "neighborhoods": ["Hamel", "Independence Beach border", "Loretto border"], "note": ""},
    {"slug": "corcoran", "city": "Corcoran", "neighborhoods": ["Hackamore", "Rush Creek", "Pioneer"], "note": ""},
    {"slug": "watertown", "city": "Watertown", "neighborhoods": ["Downtown Watertown", "Mayer border", "Crow River"], "note": ""},
]

# ---------------------------------------------------------------------------
# Membership plans
# ---------------------------------------------------------------------------
PLANS = [
    {
        "name": "Clear View",
        "tag": "Essential exterior care for a home that always looks its best.",
        "monthly": "49",
        "annual": "529",
        "annual_save": "Save $59 vs monthly",
        "featured": False,
        "discount": "10%",
        "incl": [
            "2 exterior window cleanings per year",
            "1 gutter cleaning per year",
            "10% member discount on all add-on services",
            "Priority scheduling ahead of non-members",
            "Annual exterior inspection &amp; photo report",
            "Automatic seasonal reminders",
        ],
    },
    {
        "name": "Crystal Plus",
        "tag": "Our most popular plan — comprehensive, hands-off home maintenance.",
        "monthly": "89",
        "annual": "959",
        "annual_save": "Save $109 vs monthly",
        "featured": True,
        "discount": "15%",
        "incl": [
            "2 full (in &amp; out) window cleanings per year",
            "2 gutter cleanings per year (spring &amp; fall)",
            "1 house soft wash per year",
            "15% member discount on all add-on services",
            "Top-priority scheduling &amp; flexible rebooking",
            "Free annual roof &amp; exterior inspection",
            "Screen cleaning included with every window visit",
        ],
    },
    {
        "name": "Signature Estate",
        "tag": "White-glove, year-round care for larger and luxury homes.",
        "monthly": "159",
        "annual": "1,719",
        "annual_save": "Save $189 vs monthly",
        "featured": False,
        "discount": "20%",
        "incl": [
            "Quarterly full window cleanings (4 per year)",
            "2 gutter cleanings + downspout flush per year",
            "1 house soft wash + 1 pressure wash per year",
            "Annual roof soft wash assessment",
            "20% member discount on all add-on services",
            "Dedicated account manager &amp; first-call priority",
            "Holiday lighting design consultation included",
        ],
    },
]

# ---------------------------------------------------------------------------
# Testimonials
# ---------------------------------------------------------------------------
REVIEWS = [
    ("The crew was on time, polite, and unbelievably thorough. Our windows haven't looked this clear since the house was built. The before-and-after is honestly shocking.", "Jennifer M.", "Delano, MN", "JM"),
    ("Barta cleaned years of black streaks off our roof and washed the whole house in an afternoon. Neighbors keep asking if we got new siding. Worth every penny.", "David & Karen R.", "Maple Grove, MN", "DR"),
    ("I'm on the Crystal Plus plan and it's the best home decision we've made. They just show up on schedule and everything stays spotless. Zero hassle.", "Priya S.", "Plymouth, MN", "PS"),
    ("Professional from the quote to the cleanup. They protected our landscaping, explained everything, and the gutters are flowing perfectly again.", "Tom B.", "Wayzata, MN", "TB"),
    ("Booked the holiday lighting package and our house was the talk of the street. Design, install, and takedown all handled — we didn't lift a finger.", "The Hendersons", "Minnetonka, MN", "HH"),
    ("Removed hard water stains from our lakeside windows that two other companies said couldn't be fixed. These folks know what they're doing.", "Mark L.", "Waconia, MN", "ML"),
]

# ---------------------------------------------------------------------------
# Team
# ---------------------------------------------------------------------------
TEAM = [
    ("Ryan Barta", "Founder &amp; Owner", "RB", "Born and raised in Delano, Ryan started Barta with one ladder and a promise: treat every home like his own. He still personally reviews quality on major jobs."),
    ("Megan Barta", "Operations &amp; Client Care", "MB", "Megan makes scheduling effortless and is the friendly voice behind every quote, reminder, and follow-up. Your experience is her job."),
    ("Carlos Reyes", "Lead Technician", "CR", "Ten years in exterior cleaning and our resident soft-wash expert. Carlos trains every new crew member on safety and detail."),
    ("Sam Whitfield", "Crew Lead", "SW", "Detail-obsessed and ladder-certified, Sam leads our residential window and gutter teams across the western metro."),
    ("Aisha Nemec", "Crew Lead", "AN", "Aisha runs our house and roof soft-wash crew and is known for landscaping protection that leaves yards spotless."),
    ("Derek Olson", "Holiday Lighting Designer", "DO", "Off-season window pro, on-season lighting artist. Derek designs the displays that light up the neighborhood."),
]

# ---------------------------------------------------------------------------
# Blog posts
# ---------------------------------------------------------------------------
POSTS = [
    {
        "slug": "how-often-clean-windows-minnesota",
        "title": "How Often Should You Clean Your Windows in Minnesota?",
        "excerpt": "Pollen in spring, dust in summer, and ice in winter all take a toll. Here's the realistic cleaning schedule we recommend for Minnesota homes.",
        "date": "2026-05-18",
        "read": "5 min",
        "cat": "Window Cleaning",
    },
    {
        "slug": "soft-washing-vs-pressure-washing",
        "title": "Soft Washing vs. Pressure Washing: Which Does Your Home Need?",
        "excerpt": "Using the wrong method can damage siding, roofs, and paint. Here's how to tell which approach is right for each surface on your home.",
        "date": "2026-04-29",
        "read": "6 min",
        "cat": "House Washing",
    },
    {
        "slug": "remove-roof-black-streaks",
        "title": "What Those Black Streaks on Your Roof Really Are (and How to Remove Them)",
        "excerpt": "Spoiler: it's alive. Learn what causes roof streaks, why pressure washing makes it worse, and the safe way to restore your roof.",
        "date": "2026-04-10",
        "read": "4 min",
        "cat": "Roof Cleaning",
    },
    {
        "slug": "gutter-cleaning-checklist-fall",
        "title": "The Minnesota Fall Gutter-Cleaning Checklist",
        "excerpt": "Before the first freeze, run through these steps to protect your foundation, fascia, and roof through winter.",
        "date": "2026-03-22",
        "read": "5 min",
        "cat": "Gutter Cleaning",
    },
]

# ---------------------------------------------------------------------------
# FAQs (general)
# ---------------------------------------------------------------------------
FAQS = [
    ("Are you licensed and insured?", "Absolutely. Barta Window Washing is fully licensed and carries comprehensive liability and workers' compensation insurance. We're happy to provide a certificate of insurance before any job — your home and our team are both protected."),
    ("How do I get a free quote?", "Three easy ways: request a quote online through any form on this site, call us at " + BIZ["phone_display"] + ", or schedule online. Most quotes are returned the same day, and many can be priced without an in-person visit."),
    ("Do I need to be home during the service?", "Not for most exterior work. As long as we have access to the areas being cleaned and any gates are unlocked, you don't need to be home. For interior window cleaning, we'll coordinate a time that works for you."),
    ("What if I'm not satisfied?", "Every Barta service is backed by our 100% Satisfaction Guarantee. If anything isn't right, call us within 48 hours and we'll make it right — re-cleaning at no charge. We don't consider a job done until you're thrilled."),
    ("How is pricing determined?", "Pricing is based on the size of your home, number and accessibility of windows or surfaces, and the services you choose. We give clear, upfront, all-in quotes — no hidden fees and no surprises on the invoice."),
    ("Are your cleaning products safe for kids, pets, and plants?", "Yes. We use professional-grade, biodegradable solutions and pre-wet and rinse landscaping on every soft-wash job. Our methods are safe for your family, pets, and yard."),
    ("How far in advance should I book?", "We recommend 1–2 weeks for standard services, and earlier in peak spring and fall seasons. Holiday lighting books up by early fall. Members always get priority scheduling ahead of non-members."),
    ("Do you offer recurring maintenance plans?", "We do — and they're our most popular option. Our membership plans bundle your essential exterior cleanings at a discount, with priority scheduling, free inspections, and automatic reminders. See our Service Plans page for details."),
]

# ---------------------------------------------------------------------------
# Trust badges
# ---------------------------------------------------------------------------
BADGES = [
    ("shield", "Licensed &amp; Insured"),
    ("home", "Locally &amp; Family Owned"),
    ("star", BIZ["rating"] + "★ Rated (" + BIZ["review_count"] + " reviews)"),
    ("check", "100% Satisfaction Guarantee"),
    ("leaf", "Safe, Eco-Friendly Methods"),
    ("clock", "Since " + BIZ["founded"]),
]
