// Plans module: the five agreement drafts (design §5.4 "Agreements",
// decision D10) and the module's message templates (§5.7.3).
//
// The drafts are written from barta-rules §2.3 and the MiNT plan agreement
// structure (scheduling, reminders and rescheduling, payments, skipped
// visits, cancelling inside and after the first 12 months), in Barta's
// voice: plain, friendly, no em dashes, "insured" (never "licensed"), the
// satisfaction guarantee is a free re-clean. The Biannual text lists no
// perks (barta-rules §13 #2). They are seeded as drafts and cannot be sent,
// or shown on a quote, until an owner approves them (D10).
//
// Agreement bodies use the closed variable set (core/templates.mjs):
// {{legal_name}}, {{company_name}}, {{full_name}}, {{plan_name}},
// {{per_visit_price}}, {{visits_per_year}}, {{term_months}},
// {{perks_list}}, {{clawback_amount}}, {{notice_days}},
// {{late_cancel_fee}}, {{company_phone}}. Lines starting "## " are
// headings and "- " list items; blank lines split paragraphs.

const OPEN = `## {{plan_name}} service agreement

This agreement is between {{legal_name}} ("{{company_name}}", "we", "us") and {{full_name}} ("you").`;

const GUARANTEE = `- Our 100% satisfaction guarantee: if anything isn't right, tell us and we'll come back and re-clean it for free.`;

const REMINDERS = `## Reminders and rescheduling

We text or email you about 2 weeks and again 2 days before each visit. We give you an arrival window, not an exact time.

Need to move a visit? Just let us know at least 24 hours ahead. A cancel or reschedule with less than 24 hours' notice, or a visit where we can't get in and weren't told, may have a {{late_cancel_fee}} fee. There's never a fee when we're the ones moving a visit (rain, for example).`;

const PAYMENTS = `## Payments

Keep a card or bank account on file for your plan. Your first visit is charged after it's done. After that, each visit is charged on the 1st of the month it's scheduled in. We don't charge sales tax.`;

const SKIPS = `## Skipped visits

You can skip a visit. Skipping doesn't cancel your plan, and a skipped visit doesn't turn into a credit.`;

const CANCEL = (renew) => `## Term and renewal

Your plan starts with a {{term_months}}-month term at the price above. After that it renews every ${renew} until you cancel. If your price ever changes after the first {{term_months}} months, we'll tell you in writing at least 30 days before.

## Cancelling in the first {{term_months}} months

Give us {{notice_days}} days' notice in writing (a text or email is fine). If your first visit is done, you pay back that visit's plan discount of {{clawback_amount}}. That's it.

## Cancelling after the first {{term_months}} months

Cancel any time. It takes effect at the end of your current renewal term, and visits until then still happen and are billed.`;

const FINE = `## The fine print

We're fully insured. You don't need to be home for exterior work as long as gates are unlocked; we set up interior visits with you. We're not responsible for damage that was already there, or for old or defective windows, frames, screens or seals.

Questions? Call or text us at {{company_phone}}. Thanks for trusting us with your home!`;

const WINDOWS = (visits, perks) => `## What you get

- Exterior window cleaning ${visits}.
- Your price: {{per_visit_price}} a visit, locked in for the first {{term_months}} months.
${perks ? "- Plan perks: {{perks_list}}.\n" : ""}${GUARANTEE}`;

export const AGREEMENT_DRAFTS = Object.freeze([
  {
    key: "biannual", name: "Biannual plan agreement", applies_to: { catalog_keys: ["biannual", "custom"], service_types: ["Residential Window Cleaning"] },
    body_md: [OPEN, WINDOWS("twice a year, about every 6 months", false), `## Scheduling

We come out about every 6 months. We book each visit with you ahead of time and confirm it by text.`, REMINDERS, PAYMENTS, SKIPS, CANCEL("6 months"), FINE].join("\n\n"),
  },
  {
    key: "quarterly", name: "Quarterly plan agreement", applies_to: { catalog_keys: ["quarterly"], service_types: ["Residential Window Cleaning"] },
    body_md: [OPEN, `## What you get

- {{visits_per_year}} visits a year: 3 exterior cleanings and 1 interior cleaning (your 2nd visit of the year).
- Your price: {{per_visit_price}}, locked in for the first {{term_months}} months.
- Plan perks: {{perks_list}}.
${GUARANTEE}`, `## Scheduling

We come out about every 3 months. We book each visit with you ahead of time and confirm it by text. Interior visits are always set up with you.`, REMINDERS, PAYMENTS, SKIPS, CANCEL("3 months"), FINE].join("\n\n"),
  },
  {
    key: "monthly", name: "Monthly plan agreement", applies_to: { catalog_keys: ["monthly"], service_types: ["Residential Window Cleaning"] },
    body_md: [OPEN, WINDOWS("every month, 12 times a year", true), `## Scheduling

We come out once a month. We book your visits ahead of time and confirm each one by text.`, REMINDERS, PAYMENTS, SKIPS, CANCEL("month"), FINE].join("\n\n"),
  },
  {
    key: "lights", name: "Christmas light installation agreement", applies_to: { catalog_keys: ["lights_annual"], service_types: ["Christmas Lights"] },
    body_md: [OPEN, `## What you get

- We supply commercial-grade C9 LED lights and hang them on your home each season.
- In-season care: if a bulb or clip goes out during the season, we fix it for free.
- After the holidays we take everything down and store it in our shop until next season. Takedown and storage are included in your price.
- Your price for this season: {{per_visit_price}}.
${GUARANTEE}`, `## Scheduling

We text you to set up your install date. Takedown happens in January; we'll text you before we come.`, `## Payments

Your install is billed after it's done. We don't charge sales tax.`, `## Term and renewal

Your plan renews every year so your lights go back up each season without the hassle. Each September we text you to confirm your install for the coming season. Want to skip a season or stop? Just tell us then. If your plan is a 3-year contract, the 3-year discount is part of your price and your plan runs for 3 seasons.`, `## Late cancels

A cancel or reschedule of an install or takedown with less than 24 hours' notice may have a {{late_cancel_fee}} fee. There's never a fee when we're the ones moving a visit.`, FINE].join("\n\n"),
  },
  {
    key: "one_time", name: "One-time service agreement", applies_to: { catalog_keys: [], service_types: ["Residential Window Cleaning"] },
    body_md: [`## Service agreement

This agreement is between {{legal_name}} ("{{company_name}}", "we", "us") and {{full_name}} ("you") for a one-time service.

## What you get

- The services on your quote, at the price on your quote.
${GUARANTEE}`, `## Scheduling and reminders

We book your visit with you and text you a reminder before we come. We give you an arrival window, not an exact time. A cancel or reschedule with less than 24 hours' notice may have a {{late_cancel_fee}} fee. There's never a fee when we're the ones moving the visit.`, `## Payment

Payment is due when the work is done. We don't charge sales tax.`, FINE].join("\n\n"),
  },
]);

// The module's message templates (category service; the sender adds the
// opt-out footer, so none of them says STOP).
export const TEMPLATES = Object.freeze([
  { key: "agreement_sent", name: "Agreement to sign (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, here's your {{plan_name|service}} agreement from {{company_name}}: {{agreement_link}} You can read it and sign right on your phone. Questions? Call us at {{company_phone}}." },
  {
    key: "agreement_sent_email", name: "Agreement to sign (email)", channel: "email", category: "service", subject: "Your {{plan_name|service}} agreement from {{company_name}}",
    body: "Hi {{first_name|there}},\n\nThanks for signing up with us! Your {{plan_name|service}} agreement is ready. Tap below to read it and sign it right on your phone.\n\n{{agreement_link}}\n\nQuestions? Just reply or call us at {{company_phone}}.\n\n{{sender_first_name}} with {{company_name}}",
  },
  { key: "agreement_unsigned", name: "Agreement reminder (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, a quick reminder to sign your {{plan_name|plan}} agreement when you get a minute: {{agreement_link}} Thanks! {{sender_first_name}} with {{company_name}}" },
  { key: "plan_renewal_notice", name: "Plan renewal notice (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, a heads up from {{company_name}}: your {{plan_name|plan}} renews on {{due_date}} at the same price. Nothing to do if you'd like to keep it going. Questions? Call us at {{company_phone}}." },
  {
    key: "plan_renewal_notice_email", name: "Plan renewal notice (email)", channel: "email", category: "service", subject: "Your {{plan_name|plan}} renews on {{due_date}}",
    body: "Hi {{first_name|there}},\n\nYour {{plan_name|plan}} with {{company_name}} renews on {{due_date}} at the same price. There's nothing you need to do to keep it going.\n\nWant to change something? Just reply or call us at {{company_phone}}.\n\nThanks for being a plan member!\n\n{{sender_first_name}} with {{company_name}}",
  },
  { key: "plan_price_change", name: "Plan price change notice (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, a heads up from {{company_name}}: starting {{expires_on}}, your {{plan_name|plan}} price will be {{per_visit_price}} a visit. Questions? Call us at {{company_phone}}." },
  { key: "plan_paused", name: "Plan paused (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, your {{plan_name|plan}} with {{company_name}} is on pause, so we took your upcoming visit off the schedule. Call us at {{company_phone}} whenever you're ready to pick it back up." },
  { key: "lights_rebook", name: "Christmas lights rebook (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, it's {{sender_first_name|Alex}} with {{company_name}}! Christmas lights season is almost here. Want us to hang your lights again for {{season_year}}? Just reply here or call {{company_phone}} and we'll get you on the list." },
  { key: "lights_confirm", name: "Christmas lights: we'll be out again (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, {{company_name}} here. Your Christmas lights are on our list for {{season_year}} as part of your 3-year plan. We'll text you soon to set up your install date." },
  { key: "portal_login", name: "Customer portal link (text)", channel: "sms", category: "service", body: "Here's your {{company_name}} link: {{portal_link}} It shows your visits, plan and anything to sign. It works for 30 days." },
]);
