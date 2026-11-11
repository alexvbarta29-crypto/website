// Plans module: the six agreement drafts (design §5.4 "Agreements",
// decision D10) and the module's message templates (§5.7.3).
//
// The drafts are written from barta-rules §2.3 and the MiNT plan agreement
// structure (scheduling, reminders and rescheduling, payments, skipped
// visits, cancelling inside and after the first term), in Barta's voice:
// plain, friendly, no em dashes, "insured" (never "licensed"), the
// satisfaction guarantee is a free re-clean (for lights: we come back and
// fix it). The Biannual text lists no perks (barta-rules §13 #2).
//
// Every term that differs between plans comes from the plan itself, never
// from fixed words: what each visit includes and costs ({{price_details}},
// {{per_visit_price}}), how often ({{visit_schedule}}), renewal
// ({{renewal_terms}}), billing and autopay ({{billing_terms}}), and the
// early-cancel payback ({{clawback_terms}}: the plan discount the first visit
// actually got). Lines starting "## " are headings and "- " list items;
// blank lines split paragraphs.
//
// Lines starting ">> Owner check:" mark wording that is a guess (business
// terms nobody has confirmed yet). A draft can't be approved while one is
// left (agreements.mjs approveTemplate): the owner keeps, changes or removes
// the line it points at and then deletes the check. Seeded as drafts; none
// can be sent, or shown on a quote, until an owner approves it (D10).

export const OWNER_CHECK = ">> Owner check:";

const OPEN = `## {{plan_name}} service agreement

This agreement is between {{legal_name}} ("{{company_name}}", "we", "us") and {{full_name}} ("you").

${OWNER_CHECK} confirm the legal name (Settings, Company) is exactly the business's registered name.`;

const GUARANTEE = `- Our 100% satisfaction guarantee: if anything isn't right, tell us and we'll come back and re-clean it for free.`;

const PRICE = `## Your price

{{price_details}}

Your price: {{per_visit_price}}, locked in for the first {{term_months}} months.{{addon_note}}`;

const LATE_FEE_CHECK = `${OWNER_CHECK} the late-cancel fee (Settings, Plans catalog & perks) isn't on the public website's terms yet. Keep it, change it, or take the fee sentence out.`;

const REMINDERS = `## Reminders and rescheduling

We text or email you about 2 weeks and again 2 days before each visit. We give you an arrival window, not an exact time.

Need to move a visit? Just let us know at least 24 hours ahead. A cancel or reschedule with less than 24 hours' notice, or a visit where we can't get in and weren't told, may have a {{late_cancel_fee}} fee. There's never a fee when we're the ones moving a visit (rain, for example).

${LATE_FEE_CHECK}`;

const PAYMENTS = `## Payments

{{billing_terms}} We don't charge sales tax.`;

const SKIPS = `## Skipped visits

You can skip a visit. Skipping doesn't cancel your plan, and a skipped visit doesn't turn into a credit.`;

const TERM = (extraCheck = "") => `## Term and renewal

Your plan starts with a {{term_months}}-month term at the price above. {{renewal_terms}} If your price ever changes after the first {{term_months}} months, we'll tell you in writing at least 30 days before.

## Cancelling in the first {{term_months}} months

Give us {{notice_days}} days' notice in writing (a text or email is fine). {{clawback_terms}}${extraCheck ? `\n\n${extraCheck}` : ""}

## Cancelling after the first {{term_months}} months

Cancel any time. It takes effect at the end of your current renewal term, and visits until then still happen and are billed.`;

const FINE = `## The fine print

We're fully insured. You don't need to be home for exterior work as long as gates are unlocked; we set up interior visits with you. We're not responsible for damage that was already there, or for old or defective windows, frames, screens or seals.

Questions? Call or text us at {{company_phone}}. Thanks for trusting us with your home!`;

const PERKS_CHECK = `${OWNER_CHECK} say what each perk covers (what a touch-up includes, how much hard water removal is included), or keep the names only.`;

const WINDOWS = (perks) => `## What you get

- Window cleaning {{visit_schedule}}, with the services listed under Your price.
${perks ? "- Plan perks: {{perks_list}}.\n" : ""}${GUARANTEE}${perks ? `\n\n${PERKS_CHECK}` : ""}`;

const SCHEDULING = (extra = "") => `## Scheduling

We book each visit with you ahead of time and confirm it by text.${extra}`;

export const AGREEMENT_DRAFTS = Object.freeze([
  {
    key: "biannual", name: "Biannual plan agreement", applies_to: { catalog_keys: ["biannual"], service_types: ["Residential Window Cleaning"] },
    body_md: [OPEN, WINDOWS(false), PRICE, SCHEDULING(), REMINDERS, PAYMENTS, SKIPS, TERM(), FINE].join("\n\n"),
  },
  {
    key: "quarterly", name: "Quarterly plan agreement", applies_to: { catalog_keys: ["quarterly"], service_types: ["Residential Window Cleaning"] },
    body_md: [OPEN, WINDOWS(true), PRICE, SCHEDULING(" Interior visits are always set up with you."), REMINDERS, PAYMENTS, SKIPS, TERM(), FINE].join("\n\n"),
  },
  {
    key: "monthly", name: "Monthly plan agreement", applies_to: { catalog_keys: ["monthly"], service_types: ["Residential Window Cleaning"] },
    body_md: [OPEN, WINDOWS(true), PRICE, SCHEDULING(), REMINDERS, PAYMENTS, SKIPS,
      TERM(`${OWNER_CHECK} paying back the first visit's plan discount on a Monthly plan follows the Biannual and Quarterly rule; it isn't confirmed for Monthly yet.`), FINE].join("\n\n"),
  },
  {
    key: "custom", name: "Custom plan agreement", applies_to: { catalog_keys: ["custom"], service_types: ["Residential Window Cleaning"] },
    body_md: [OPEN, WINDOWS(false), PRICE, SCHEDULING(), REMINDERS, PAYMENTS, SKIPS, TERM(), FINE].join("\n\n"),
  },
  {
    key: "lights", name: "Christmas light installation agreement", applies_to: { catalog_keys: ["lights_annual"], service_types: ["Christmas Lights"] },
    body_md: [OPEN, `## What you get

- We supply commercial-grade C9 LED lights and hang them on your home each season.
- In-season care: if a bulb or clip goes out during the season, we fix it for free.
- After the holidays we take everything down and store it in our shop until next season. Takedown and storage are included in your price.
- Our 100% satisfaction guarantee: if anything isn't right with your lights, tell us and we'll come back and fix it for free.`, `## Your price

{{price_details}}

Your price: {{per_visit_price}}.{{addon_note}}

${OWNER_CHECK} for a 3-year contract, confirm the price of seasons 2 and 3 (shown above without the first-season discounts and materials) and what happens if a customer stops before the 3 seasons are up.`, `## Scheduling

We text you to set up your install date. Takedown happens in January; we'll text you before we come.`, `## Payments

{{billing_terms}} We don't charge sales tax.`, `## Term and renewal

{{renewal_terms}}`, `## Late cancels

A cancel or reschedule of an install or takedown with less than 24 hours' notice may have a {{late_cancel_fee}} fee. There's never a fee when we're the ones moving a visit.

${LATE_FEE_CHECK}`, `## The fine print

We're fully insured. We hang your lights with clips along your roofline and gutters. We're not responsible for damage that was already there, or for old or loose gutters, shingles or trim.

${OWNER_CHECK} confirm how the crew attaches the lights and what we take responsibility for, so this paragraph matches what we do.

Questions? Call or text us at {{company_phone}}. Thanks for trusting us with your home!`].join("\n\n"),
  },
  {
    key: "one_time", name: "One-time service agreement", applies_to: { catalog_keys: [], service_types: ["Residential Window Cleaning"] },
    body_md: [`## Service agreement

This agreement is between {{legal_name}} ("{{company_name}}", "we", "us") and {{full_name}} ("you") for a one-time service.

${OWNER_CHECK} confirm the legal name (Settings, Company) is exactly the business's registered name.

## What you get

- The services on your quote, at the price on your quote.
${GUARANTEE}`, `## Scheduling and reminders

We book your visit with you and text you a reminder before we come. We give you an arrival window, not an exact time. A cancel or reschedule with less than 24 hours' notice may have a {{late_cancel_fee}} fee. There's never a fee when we're the ones moving the visit.

${LATE_FEE_CHECK}`, `## Payment

Payment is due when the work is done. We don't charge sales tax.`, FINE].join("\n\n"),
  },
]);

// The sha256 of every earlier seeded body, by key: an untouched seeded text
// is upgraded to the draft above (a new version the owner approves again);
// a text an owner edited is never overwritten (agreements.mjs).
export const PREVIOUS_DRAFT_SHAS = Object.freeze({
  biannual: ["6fe1b07643226d032641213707fe0db6806f4f9632331045b54e503899ec51be"],
  quarterly: ["1ca8eb0f4ced507e8f41bfa1173c2511498dd82a9a553d643f0a08b120910e02"],
  monthly: ["498ee549c7625a8e51127f00fdd4995a9423638b1a5e6da38eb809f83706fa6a"],
  lights: ["c4c7a91d9b21438bd46e7768fc132dda2352fe43e34de111796620f8cd703953"],
  one_time: ["925cf3c1a4a7eb60d11dd7244f09f0eadad3293e0638732a1e6fa41b30d94d29"],
});
// Message templates whose first body read wrong ("a visit" twice): the
// built-in copy is replaced when it was never edited.
export const PREVIOUS_TEMPLATE_BODIES = Object.freeze({
  plan_price_change: ["Hi {{first_name|there}}, a heads up from {{company_name}}: starting {{expires_on}}, your {{plan_name|plan}} price will be {{per_visit_price}} a visit. Questions? Call us at {{company_phone}}."],
});

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
  { key: "plan_price_change", name: "Plan price change notice (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, a heads up from {{company_name}}: starting {{expires_on}}, your {{plan_name|plan}} price will be {{per_visit_price}}. Questions? Call us at {{company_phone}}." },
  { key: "plan_paused", name: "Plan paused (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, your {{plan_name|plan}} with {{company_name}} is on pause, so we took your upcoming visit off the schedule. Call us at {{company_phone}} whenever you're ready to pick it back up." },
  { key: "lights_rebook", name: "Christmas lights rebook (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, it's {{sender_first_name|Alex}} with {{company_name}}! Christmas lights season is almost here. Want us to hang your lights again for {{season_year}}? Just reply here or call {{company_phone}} and we'll get you on the list." },
  { key: "lights_confirm", name: "Christmas lights: we'll be out again (text)", channel: "sms", category: "service", body: "Hi {{first_name|there}}, {{company_name}} here. Your Christmas lights are on our list for {{season_year}} as part of your 3-year plan. We'll text you soon to set up your install date." },
  { key: "portal_login", name: "Customer portal link (text)", channel: "sms", category: "service", body: "Here's your {{company_name}} link: {{portal_link}} It shows your visits, plan and anything to sign. It works for 30 days." },
]);
