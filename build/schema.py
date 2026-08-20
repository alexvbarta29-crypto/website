"""JSON-LD schema builders for SEO."""
from sitedata import BIZ, AREAS

def local_business():
    """Core LocalBusiness node. Deliberately omits aggregateRating/review , 
    self-published review structured data on your own LocalBusiness isn't
    eligible for Google's review-star rich results anyway, and publishing
    an unverified rating/count is a real trust and policy risk. Genuine
    reviews are surfaced on-page via the Google-reviews widget instead
    (see reviews.html / config/google-reviews-embed*.html)."""
    biz = {
        "@context": "https://schema.org",
        "@type": "HomeAndConstructionBusiness",
        "@id": BIZ["domain"] + "/#business",
        "name": BIZ["name"],
        "legalName": BIZ["legal_name"],
        "description": "Premium residential and commercial exterior cleaning, window cleaning, gutter cleaning, screen cleaning, solar panel cleaning, and holiday lighting in Delano, MN and the western Twin Cities metro.",
        "url": BIZ["domain"],
        "telephone": BIZ["phone_display"],
        "email": BIZ["email"],
        "priceRange": "$$",
        # Real photographs, not the generic share card. Google surfaces these
        # in local results, and its guidance is to offer several aspect ratios
        # so it can pick one per layout rather than crop whatever it's given.
        "image": [
            BIZ["domain"] + "/assets/img/hero-home-1200w.jpg",
            BIZ["domain"] + "/assets/img/svc-exterior-window-cleaning-1200w.jpg",
            BIZ["domain"] + "/assets/img/svc-cta-squeegee-1200w.jpg",
        ],
        # A raster logo, not favicon.svg, that's a 0.2 KB browser-tab icon,
        # too small to serve as the brand mark Google renders.
        "logo": BIZ["domain"] + "/assets/img/logo-bww.png",
        "foundingDate": BIZ["founded"],
        "address": {
            "@type": "PostalAddress",
            "streetAddress": BIZ["street"],
            "addressLocality": BIZ["city"],
            "addressRegion": BIZ["state"],
            "postalCode": BIZ["zip"],
            "addressCountry": "US",
        },
        "geo": {"@type": "GeoCoordinates", "latitude": BIZ["lat"], "longitude": BIZ["lng"]},
        "openingHoursSpecification": [
            {
                "@type": "OpeningHoursSpecification",
            # Must stay in step with BIZ["hours"], which is the text visitors
            # see in the footer, Google cross-checks the two, and they have
            # drifted apart before. Owner-confirmed hours: weekdays 8am–6pm,
            # Saturday 8am–5pm, Sunday closed.
                "dayOfWeek": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
                "opens": "08:00", "closes": "18:00",
            },
            {
                "@type": "OpeningHoursSpecification",
                "dayOfWeek": ["Saturday"],
                "opens": "08:00", "closes": "17:00",
            },
        ],
        "areaServed": [{"@type": "City", "name": a["city"] + ", MN"} for a in AREAS],
        "sameAs": [BIZ["facebook"], BIZ["instagram"], BIZ["google"]],
        # Deliberately no "makesOffer": a $0-priced Offer reads as "the
        # service costs $0," not "quotes are free", the visible CTAs already
        # make the free-quote offer clear without a misleading schema price.
    }
    return biz

def organization():
    return {
        "@context": "https://schema.org",
        "@type": "Organization",
        "@id": BIZ["domain"] + "/#org",
        "name": BIZ["name"],
        "url": BIZ["domain"],
        # Same raster logo the LocalBusiness entity uses, this is the one
        # Google reads for the Organization brand mark.
        "logo": BIZ["domain"] + "/assets/img/logo-bww.png",
        "telephone": BIZ["phone_display"],
        "sameAs": [BIZ["facebook"], BIZ["instagram"], BIZ["google"]],
    }

def website():
    return {
        "@context": "https://schema.org",
        "@type": "WebSite",
        "@id": BIZ["domain"] + "/#website",
        "url": BIZ["domain"],
        "name": BIZ["name"],
        "publisher": {"@id": BIZ["domain"] + "/#org"},
    }

def service_schema(svc):
    return {
        "@context": "https://schema.org",
        "@type": "Service",
        "serviceType": svc["name"],
        "name": svc.get("schema_name") or (svc["name"] + " in " + BIZ["city"] + ", MN"),
        "description": svc["short"],
        "provider": {"@id": BIZ["domain"] + "/#business"},
        "areaServed": [{"@type": "City", "name": a["city"] + ", MN"} for a in AREAS],
        "url": BIZ["domain"] + "/services/" + svc["slug"] + ".html",
        # The page's own hero photo, so the Service entity has a declared
        # visual instead of inheriting nothing.
        "image": BIZ["domain"] + "/" + (svc.get("image") or "assets/img/hero-home.jpg"),
        # Deliberately no "offers" block: there's no real price to publish,
        # and "availability: InStock" is a product-catalog concept that adds
        # no accurate signal for a quoted local service.
    }

def faq_schema(items):
    return {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [{
            "@type": "Question", "name": _strip(q),
            "acceptedAnswer": {"@type": "Answer", "text": _strip(a)},
        } for q, a in items],
    }

def breadcrumb(items):
    """items = [(name, url), ...]"""
    return {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [{
            "@type": "ListItem", "position": i + 1, "name": name, "item": url,
        } for i, (name, url) in enumerate(items)],
    }

def _strip(s):
    return (s.replace("&amp;", "&").replace("&rsquo;", "'").replace("&nbsp;", " ")
             .replace("<br>", " ").replace("&ldquo;", '"').replace("&rdquo;", '"'))
