// Single source of truth for the referral program's numbers and text on the
// serverless side (docs/REFERRAL-PROGRAM.md). REFERRAL in build/sitedata.py
// is the mirror that drives every number printed on the pages — change both
// together, or the pages will promise one thing and the texts another.
//
// Everything here is public information (it is printed on the site); the
// secrets (ROTOR_API_KEY, REFERRAL_ADMIN_KEY, Twilio) are read from the
// environment at call time by the modules that need them.

export const REWARDS = Object.freeze({
  friend_discount: 25,      // $ off the referred friend's first service
  referrer_credit: 50,      // $ account credit per friend who books...
  referrer_gift_card: 25,   // ...or a $ gift card instead (referrer's choice)
  code_prefix: "BARTA",     // share codes look like BARTA-7K3XQ
  max_friends: 10,          // per submission
});

// Netlify Blobs store name. Site-scoped so the data survives deploys.
export const STORE_NAME = "referrals";

// Where the program lives: on the website. On Netlify the URL variable is
// the site's primary URL, so links come out right in every deploy context
// (production, branch deploys, deploy previews); SITE_URL overrides it.
export const DEFAULT_SITE_URL = "https://www.bartawindowwashing.com";
// BIZ.phone_display in build/sitedata.py — printed in the friend's text.
export const OFFICE_PHONE_DISPLAY = "(763) 314-3400";

// Pipeline order. "completed" = the friend's first job is finished and paid,
// which unlocks the referrer's reward: they pick credit or gift card on their
// tracking page, and the office issues it ("rewarded").
export const STATUSES = Object.freeze(
  ["new", "contacted", "quoted", "booked", "completed", "rewarded", "declined"]);
// new/contacted/quoted are "pending" on the referrer's dashboard; booked,
// completed and rewarded all count as booked there.
export const PENDING_STATUSES = Object.freeze(["new", "contacted", "quoted"]);
export const BOOKED_STATUSES = Object.freeze(["booked", "completed", "rewarded"]);
export const REWARD_TYPES = Object.freeze(["credit", "giftcard"]);

// Trailing slashes are stripped so the links below never come out as
// https://host//r/CODE.
export const siteUrl = () =>
  (process.env.SITE_URL || process.env.URL || DEFAULT_SITE_URL).trim().replace(/\/+$/, "");
export const shareUrl = (code) => `${siteUrl()}/r/${code}`;
// /referral is a Netlify rewrite of referral.html (the query string travels
// with it), so a tracking link reads cleanly in a text message.
export const statusUrl = (token) => `${siteUrl()}/referral?t=${token}`;
export const adminUrl = () => `${siteUrl()}/admin/referrals.html`;

export const rewardAmount = (type) =>
  type === "giftcard" ? REWARDS.referrer_gift_card : REWARDS.referrer_credit;
// "$50 credit" / "$25 gift card" — used in texts, CRM notes, and history.
export const rewardLabel = (type) =>
  type === "giftcard" ? `$${REWARDS.referrer_gift_card} gift card`
                      : `$${REWARDS.referrer_credit} credit`;

// Text message templates, verbatim from docs/REFERRAL-PROGRAM.md. The
// dashboard's one-tap sms: links use the same wording, so a manual text and
// an automatic one read identically to the customer.
export const SMS = Object.freeze({
  friend: ({ friend_first, referrer_first, referrer_last_initial, share_url }) => {
    // A referrer who gave no last name would otherwise read "Alex . referred".
    const who = referrer_last_initial
      ? `${referrer_first} ${referrer_last_initial}.` : referrer_first;
    return `Hi ${friend_first}! ${who} referred you to Barta Window Washing, `
      + `so your first service is $${REWARDS.friend_discount} off. `
      + `Claim it here: ${share_url} or call ${OFFICE_PHONE_DISPLAY}. `
      + "Reply STOP to opt out.";
  },
  referrer: ({ n, status_url }) =>
    `Thanks for referring ${n} friend(s) to Barta Window Washing! `
    + `You earn a $${REWARDS.referrer_credit} credit (or a $${REWARDS.referrer_gift_card} gift card) `
    + `for each one who books. Track your referrals: ${status_url}`,
  // Sent when the office marks the friend's job complete: the referrer picks.
  rewardReady: ({ friend_first, status_url }) =>
    `Great news from Barta Window Washing: ${friend_first}'s first service is complete, `
    + `so your reward is ready! Pick a $${REWARDS.referrer_credit} account credit or a `
    + `$${REWARDS.referrer_gift_card} gift card here: ${status_url}`,
  // Sent (by hand, from the dashboard) once the office has issued it.
  reward: ({ friend_first, reward }) =>
    `Great news from Barta Window Washing: your ${reward} for referring ${friend_first} `
    + "has been issued. Thanks for spreading the word!",
  office: ({ referrer_name, referrer_phone, friend_name, friend_phone, code, site }) =>
    `New referral: ${referrer_name} (${referrer_phone}) referred ${friend_name} (${friend_phone}). `
    + `Code ${code}. ${site}/admin/referrals.html`,
});
