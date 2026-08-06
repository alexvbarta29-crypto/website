"""SVG icon library — stroke-based, 24x24, currentColor. Inline for zero requests."""

def _svg(inner, fill=False):
    attrs = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
    if fill:
        attrs = 'viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"'
    return f'<svg {attrs}>{inner}</svg>'

ICONS = {
    "slashes": '<svg viewBox="0 0 132 100" fill="currentColor" aria-hidden="true"><path d="M42 5 H68 L34 95 H8 Z"/><path d="M88 5 H114 L80 95 H54 Z"/></svg>',
    "window": _svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M3 12h18"/>'),
    "gutter": _svg('<path d="M3 7h18l-1.5 6.5a3 3 0 0 1-3 2.3H7.5a3 3 0 0 1-3-2.3L3 7Z"/><path d="M9 16v3M15 16v3"/>'),
    "pressure": _svg('<path d="M14 4h3v3M21 3l-6 6M11 13a4 4 0 1 1-5.6 5.6A4 4 0 0 1 11 13Z"/><path d="M9.5 14.5 13 11"/>'),
    "house": _svg('<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9"/><path d="M9.5 20v-5h5v5"/>'),
    "soft": _svg('<path d="M12 3c3 3.5 5 6.3 5 9a5 5 0 0 1-10 0c0-2.7 2-5.5 5-9Z"/>'),
    "roof": _svg('<path d="M2 12 12 4l10 8"/><path d="M5 11v8h14v-8"/><path d="M9 19v-4h6v4"/>'),
    "solar": _svg('<rect x="3" y="4" width="18" height="11" rx="1"/><path d="M3 8h18M9 4v11M15 4v11M10 19h4M12 15v4"/>'),
    "screen": _svg('<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M8 4v16M12 4v16M16 4v16M4 8h16M4 12h16M4 16h16"/>'),
    "drop": _svg('<path d="M12 3c3 3.5 5 6.3 5 9a5 5 0 0 1-10 0c0-2.7 2-5.5 5-9Z"/><path d="M10 13a2 2 0 0 0 2 2"/>'),
    "lights": _svg('<path d="M3 5c3 3 6 3 9 0s6-3 9 0"/><path d="M6 6.5 5 10M12 6.5 11 10M18 6.5 17 10"/><circle cx="5" cy="11" r="1.6"/><circle cx="11" cy="11" r="1.6"/><circle cx="17" cy="11" r="1.6"/>'),
    "check": _svg('<path d="M20 6 9 17l-5-5"/>'),
    "check-circle": _svg('<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'),
    "shield": _svg('<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>'),
    "star": _svg('<path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19.2l1-5.8L3.5 9.2l5.9-.9L12 3Z"/>', fill=True),
    "leaf": _svg('<path d="M5 19c0-8 6-14 14-14 0 8-6 14-14 14Z"/><path d="M5 19c2-4 5-7 9-9"/>'),
    "clock": _svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    # Deliberately not the classic tilted-handset glyph — that shape reads
    # bottom-heavy (the big outer curve sits at the bottom). A plain phone
    # silhouette keeps equal visual weight top to bottom.
    "phone": _svg('<rect x="7" y="2.4" width="10" height="19.2" rx="2.6"/>'),
    "mail": _svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
    "pin": _svg('<path d="M12 21s7-5.5 7-11a7 7 0 0 0-14 0c0 5.5 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>'),
    "arrow": _svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    "chevron": _svg('<path d="m6 9 6 6 6-6"/>'),
    "plus": _svg('<path d="M12 5v14M5 12h14"/>'),
    "x": _svg('<path d="M6 6 18 18M18 6 6 18"/>'),
    "menu": _svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    "calendar": _svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/>'),
    "clipboard": _svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="M9 12h6M9 16h4"/>'),
    "sparkle": _svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>'),
    "users": _svg('<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 6a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.7"/>'),
    "user": _svg('<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>'),
    "building": _svg('<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2M10 21v-3h4v3"/>'),
    "tag": _svg('<path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9Z"/><circle cx="8" cy="8" r="1.3"/>'),
    "heart": _svg('<path d="M12 20S4 14.5 4 9a4 4 0 0 1 8-1 4 4 0 0 1 8 1c0 5.5-8 11-8 11Z"/>'),
    "dollar": _svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v10M14.5 9.5A2.5 2.5 0 0 0 12 8h-.5a2 2 0 0 0 0 4h1a2 2 0 0 1 0 4H12a2.5 2.5 0 0 1-2.5-1.5"/>'),
    "bolt": _svg('<path d="M13 3 4 14h6l-1 7 9-11h-6l1-7Z"/>'),
    "award": _svg('<circle cx="12" cy="9" r="5"/><path d="m8.5 13-1.5 8 5-3 5 3-1.5-8"/>'),
    "compare": _svg('<path d="M12 3v18M8 7 4 11l4 4M16 7l4 4-4 4"/>'),
    "facebook": _svg('<path d="M14 8h2V5h-2a3 3 0 0 0-3 3v2H9v3h2v6h3v-6h2l1-3h-3V8a1 1 0 0 1 1-1Z"/>', fill=True),
    "instagram": _svg('<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17" cy="7" r="1.2" fill="currentColor" stroke="none"/>'),
    "tiktok": _svg('<path d="M16.6 5.82s.51.5 0 0A4.278 4.278 0 0 1 15.54 3h-3.09v12.4a2.592 2.592 0 0 1-2.59 2.5c-1.42 0-2.6-1.16-2.6-2.6c0-1.72 1.66-3.01 3.37-2.48V9.66c-3.45-.46-6.47 2.22-6.47 5.64c0 3.33 2.76 5.7 5.69 5.7c3.14 0 5.69-2.55 5.69-5.7V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3s-1.88.09-3.24-1.48z"/>', fill=True),
    "play": _svg('<circle cx="12" cy="12" r="9"/><path d="m10 9 5 3-5 3V9Z" fill="currentColor" stroke="none"/>'),
    "wrench": _svg('<path d="M15 6a4 4 0 0 0-5 5L4 17l3 3 6-6a4 4 0 0 0 5-5l-2.5 2.5L13 8.5 15 6Z"/>'),
    "image": _svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/>'),
    "thumbs": _svg('<path d="M7 11v9H4v-9h3Zm0 0 4-7a2 2 0 0 1 2 2v3h5a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 16 20H7"/>'),
    "route": _svg('<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h6a4 4 0 0 1 0 8H8a4 4 0 0 0 0 8"/>'),
    "money": _svg('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>'),
    "headset": _svg('<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><path d="M4 13a2 2 0 0 1 2 2v2a2 2 0 0 1-4 0v-2a2 2 0 0 1 2-2ZM20 13a2 2 0 0 0-2 2v2a2 2 0 0 0 4 0v-2a2 2 0 0 0-2-2Z"/><path d="M18 19a4 4 0 0 1-4 3h-2"/>'),
    "snowflake": _svg('<path d="M12 2v20M4 6.5l16 11M20 6.5 4 17.5"/><path d="m9 3.5 3 2.5 3-2.5M9 20.5l3-2.5 3 2.5M5.7 9l.6-3.3 3.2-1M18.3 9l-.6-3.3-3.2-1M5.7 15l.6 3.3 3.2 1M18.3 15l-.6 3.3-3.2 1"/>'),
    "gift": _svg('<rect x="3" y="9" width="18" height="12" rx="1.5"/><path d="M3 9h18v4H3zM12 9v12"/><path d="M12 9C9 9 7 7.8 7 5.8 7 4.3 8.1 3 9.5 3 11.5 3 12 6.5 12 9ZM12 9c3 0 5-1.2 5-3.2C17 4.3 15.9 3 14.5 3 12.5 3 12 6.5 12 9Z"/>'),
}

def icon(name):
    return ICONS.get(name, ICONS["check"])
