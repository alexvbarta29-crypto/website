// Door to door on a technician's Today, for a tech an owner turned it on
// for (canvass:use): one big way to the knock map (they have no Menu tab).
// Not on the office's Home: there it's Menu → Sales → Door to door.

import { html, icon } from "../../core/ui.js";

export default {
  load() { return {}; },
  render() {
    return html`<div class="links"><a class="tile" href="#/knock">${icon("map")}<span>Door to door: the knock map</span></a></div>`;
  },
};
