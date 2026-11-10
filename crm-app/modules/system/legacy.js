// Customers (the Contacts tab until M2a, design §3.15): the first slice's
// list from the Rotor export, shown unchanged in a frame under the CRM's
// own header and tab bar. Owners and office only (contacts:read_all); the
// page itself checks again on the server.

import { html } from "../../core/ui.js";

export default {
  title: "Customers",
  flush: true,
  load() { return {}; },
  render() {
    return html`<div class="frame-wrap"><iframe title="Customers" src="/crm/legacy"></iframe></div>`;
  },
};
