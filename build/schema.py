"""JSON-LD schema builders for SEO."""
from sitedata import BIZ, AREAS

def local_business(reviews=None):
    """reviews: optional list of (text, name, location, initials) tuples
    (as in sitedata.REVIEWS) to embed as Review nodes. Only pass this on
    the page where those exact curated cards are actually rendered, so
    structured data matches visible content — never on pages using the
    3rd-party widget instead."""
    biz = {
        "@context": "https://schema.org",
        "@type": "HomeAndConstructionBusiness",
        "@id": BIZ["domain"] + "/#business",
        "name": BIZ["name"],
        "description": "Premium residential and commercial exterior cleaning — window cleaning, gutter cleaning, pressure washing, house & roof soft washing, and holiday lighting in Delano, MN and the western Twin Cities metro.",
        "url": BIZ["domain"],
        "telephone": BIZ["phone_display"],
        "email": BIZ["email"],
        "priceRange": "$$",
        "image": BIZ["domain"] + "/assets/img/og-cover.svg",
        "logo": BIZ["domain"] + "/assets/img/favicon.svg",
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
        "openingHoursSpecification": [{
            "@type": "OpeningHoursSpecification",
            "dayOfWeek": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
            "opens": "07:00", "closes": "19:00",
        }],
        "areaServed": [{"@type": "City", "name": a["city"] + ", MN"} for a in AREAS],
        "sameAs": [BIZ["facebook"], BIZ["instagram"], BIZ["google"]],
        "aggregateRating": {
            "@type": "AggregateRating",
            "ratingValue": BIZ["rating"],
            "reviewCount": BIZ["review_count"],
            "bestRating": "5",
        },
        "makesOffer": {"@type": "Offer", "name": "Free Exterior Cleaning Quote", "price": "0", "priceCurrency": "USD"},
    }
    if reviews:
        biz["review"] = [{
            "@type": "Review",
            "reviewRating": {"@type": "Rating", "ratingValue": "5", "bestRating": "5"},
            "author": {"@type": "Person", "name": name},
            "reviewBody": _strip(text),
        } for text, name, location, initials in reviews]
    return biz

def organization():
    return {
        "@context": "https://schema.org",
        "@type": "Organization",
        "@id": BIZ["domain"] + "/#org",
        "name": BIZ["name"],
        "url": BIZ["domain"],
        "logo": BIZ["domain"] + "/assets/img/favicon.svg",
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
        "name": svc["name"] + " in " + BIZ["city"] + ", MN",
        "description": svc["short"],
        "provider": {"@id": BIZ["domain"] + "/#business"},
        "areaServed": [{"@type": "City", "name": a["city"] + ", MN"} for a in AREAS],
        "url": BIZ["domain"] + "/services/" + svc["slug"] + ".html",
        "offers": {"@type": "Offer", "priceCurrency": "USD", "availability": "https://schema.org/InStock"},
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

def contact_page():
    return {
        "@context": "https://schema.org",
        "@type": "ContactPage",
        "@id": BIZ["domain"] + "/contact.html#contactpage",
        "url": BIZ["domain"] + "/contact.html",
        "name": f"Contact {BIZ['name']}",
        "about": {"@id": BIZ["domain"] + "/#business"},
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
