# Repository artwork

The cover set uses Vallkey’s existing mark, dark surface palette and violet accents. Each package gets a consistent identity with its own transport description and setup command. Covers are 1280 × 640 PNGs with editable SVG sources in [covers](covers).

The mark and Vallkey name identify the project; the code license does not grant trademark rights. The artwork does not imply certification or endorsement by the referenced runtime projects.

To regenerate the PNGs, install Inter, JetBrains Mono and `rsvg-convert`, then run `npm run covers`. SVG files retain text elements for editing. Font substitution can change spacing; inspect regenerated images before committing them.

GitHub README banners use the committed PNGs. GitHub’s repository social-preview upload is a separate setting and is not changed by adding these files.
