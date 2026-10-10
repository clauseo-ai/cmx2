/* regenerates every svg in assets/. run: bun assets/src/build.ts */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { architecture, sequence } from "./diagrams.ts";
import { hero, heroTall } from "./hero.ts";
import { dark, light, type Theme } from "./theme.ts";

const OUT = join(import.meta.dir, "..");
const write = (name: string, svg: string) => {
  writeFileSync(join(OUT, name), svg);
  console.log(`${name} ${(svg.length / 1024).toFixed(1)} KB`);
};

const both = (name: string, draw: (t: Theme) => string) => {
  write(`${name}.svg`, draw(light));
  write(`${name}-dark.svg`, draw(dark));
};

both("hero", hero);
both("hero-tall", heroTall);
both("architecture", (t) => architecture(t, false));
both("turn", sequence);
both("architecture-detail", (t) => architecture(t, true));
