import { scenario } from "../scenario.ts";
import { say, user } from "../transcript.ts";

/** A grid with fine text, so a zoom is visible in a screenshot. */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
<rect width="800" height="600" fill="#1e2a38"/>
<g stroke="#3b5068" stroke-width="1">${Array.from({ length: 19 }, (_, i) => `<line x1="${(i + 1) * 40}" y1="0" x2="${(i + 1) * 40}" y2="600"/>`).join("")}${Array.from({ length: 14 }, (_, i) => `<line x1="0" y1="${(i + 1) * 40}" x2="800" y2="${(i + 1) * 40}"/>`).join("")}</g>
<circle cx="400" cy="300" r="120" fill="#e0a040"/>
<text x="400" y="306" font-size="10" text-anchor="middle" fill="#111" font-family="sans-serif">pinch to read this</text>
</svg>`;

const IMAGE = `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`;

export default scenario("images", {
  description: "A transcript with an inline image, for the lightbox and pinch zoom.",
  active: "sbx-images",
  sessions: [
    {
      id: "sbx-images",
      name: "screens",
      entries: [user("Show me the chart."), say(`Here it is:\n\n![chart](${IMAGE})\n\nTap it to open.`)],
    },
  ],
});
